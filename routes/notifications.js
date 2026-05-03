// routes/notifications.js — リベシティ風 通知API（Phase 1 段階1）
//
// マウント: server.js で `app.use('/api/notifications', require('./routes/notifications'))`
// 設計参照: docs/notification/notification_API_SPEC.md
//
// 5 エンドポイント:
//   GET    /                  自分宛通知一覧（limit/offset/unread_only/type 対応）
//   GET    /unread-count      未読件数（バッジ用に超軽量）
//   PATCH  /:id/read          個別既読化（本人以外403）
//   PATCH  /read-all          全件 or 種別ごと既読化
//   POST   /global            全体通知発火（admin/secretary/producer/producer_director の4ロール）
//
// 認証: 既存の requireAuth ミドルウェア（Passport セッション）を採用。
//       Supabase auth.uid() による RLS は service_role キー利用時バイパスされるが、
//       アプリ層で req.user.id によるオーナーシップチェックを行うので二重防御になる。

const express = require('express');
const router = express.Router();
const supabase = require('../supabase');
const { requireAuth, requireRole } = require('../auth');
const { createBulkNotifications } = require('../utils/notification');

// 全エンドポイント共通: ログイン必須
router.use(requireAuth);

// ============================================================
// GET /api/notifications
//   自分宛の通知を時系列降順で返す。
//   sender_name は users テーブルから別取得して付与する（PostgREST FK が無くても動くように手動 JOIN）。
// ============================================================
router.get('/', async (req, res) => {
  const userId = req.user.id;
  const limit  = Math.min(Math.max(parseInt(req.query.limit, 10)  || 20, 1), 100);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const unreadOnly = req.query.unread_only === 'true' || req.query.unread_only === '1';
  const type = req.query.type ? String(req.query.type) : null;

  let q = supabase
    .from('notification_logs')
    .select('*', { count: 'exact' })
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);
  if (unreadOnly) q = q.eq('is_read', false);
  if (type)       q = q.eq('notification_type', type);

  const { data, error, count } = await q;
  if (error) return res.status(500).json({ error: error.message });

  // 送信者名を一括取得して付与（N+1 回避）
  const senderIds = Array.from(new Set((data || []).map(n => n.sender_id).filter(Boolean)));
  const senderNameById = new Map();
  if (senderIds.length) {
    const { data: senders } = await supabase
      .from('users').select('id, full_name, nickname').in('id', senderIds);
    (senders || []).forEach(u => senderNameById.set(u.id, u.nickname || u.full_name || ''));
  }

  const notifications = (data || []).map(n => ({
    ...n,
    sender_name: n.sender_id ? (senderNameById.get(n.sender_id) || null) : null,
  }));

  const total = count ?? notifications.length;
  const has_more = (offset + notifications.length) < total;

  res.json({ notifications, total, has_more });
});

// ============================================================
// GET /api/notifications/unread-count
//   ベルバッジ用に未読件数のみ返す軽量エンドポイント。
// ============================================================
router.get('/unread-count', async (req, res) => {
  const userId = req.user.id;
  const { count, error } = await supabase
    .from('notification_logs')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('is_read', false);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ unread_count: count || 0 });
});

// ============================================================
// PATCH /api/notifications/:id/read
//   指定通知を既読化。本人以外は 403。
//   既に既読の場合 read_at は上書きしない（初回既読時刻を保持）。
// ============================================================
router.patch('/:id/read', async (req, res) => {
  const userId = req.user.id;
  const id = req.params.id;

  const { data: target, error: fetchErr } = await supabase
    .from('notification_logs')
    .select('id, user_id, is_read, read_at')
    .eq('id', id)
    .maybeSingle();
  if (fetchErr) return res.status(500).json({ error: fetchErr.message });
  if (!target)  return res.status(404).json({ error: '通知が見つかりません' });
  if (target.user_id !== userId) return res.status(403).json({ error: 'この通知を既読化する権限がありません' });

  if (target.is_read) {
    // 既読済みは何もしない（read_at を保持）
    return res.json({ id: target.id, is_read: true, read_at: target.read_at });
  }

  const { data: updated, error: updErr } = await supabase
    .from('notification_logs')
    .update({ is_read: true, read_at: new Date().toISOString() })
    .eq('id', id)
    .select('id, is_read, read_at')
    .single();
  if (updErr) return res.status(500).json({ error: updErr.message });
  res.json(updated);
});

// ============================================================
// PATCH /api/notifications/read-all
//   自分宛の未読通知をすべて既読化。
//   body.type を指定すれば、その種別のみ既読化（例: ball_returned だけまとめて既読）。
// ============================================================
router.patch('/read-all', async (req, res) => {
  const userId = req.user.id;
  const type = req.body?.type ? String(req.body.type) : null;

  let q = supabase
    .from('notification_logs')
    .update({ is_read: true, read_at: new Date().toISOString() })
    .eq('user_id', userId)
    .eq('is_read', false)
    .select('id');
  if (type) q = q.eq('notification_type', type);

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ updated_count: (data || []).length });
});

// ============================================================
// 共通ヘルパー: target_role 文字列に応じて users SELECT クエリを組み立てる
//   POST /global と GET /global/preview-count で使い回し、絞り込みロジックの二重実装を避ける。
//   戻り値: { query }（呼び出し側で .select('id') 済み）または { error: '...' }
// ============================================================
function buildTargetRoleQuery(targetRole) {
  let q = supabase.from('users').select('id', { count: 'exact', head: true }).eq('is_active', true);
  if (targetRole === 'all' || targetRole == null) {
    return { query: q };
  }
  if (targetRole === 'directors_above') {
    return { query: q.in('role', ['director', 'producer_director', 'producer', 'admin']) };
  }
  if (targetRole === 'editors_only') {
    return { query: q.eq('role', 'editor') };
  }
  if (targetRole === 'designers_only') {
    return { query: q.eq('role', 'designer') };
  }
  return { error: 'target_role が不正です' };
}

// ============================================================
// GET /api/notifications/global/preview-count?target_role=all
//   全体通知の送信前に「対象人数」を返す軽量エンドポイント。
//   フロントの確認ダイアログ「対象 N名 に送信します。よろしいですか？」で利用する。
//   権限は POST /global と同じ4ロール。
// ============================================================
router.get(
  '/global/preview-count',
  requireRole('admin', 'secretary', 'producer', 'producer_director'),
  async (req, res) => {
    const targetRole = req.query.target_role ? String(req.query.target_role) : 'all';
    const { query, error: roleErr } = buildTargetRoleQuery(targetRole);
    if (roleErr) return res.status(400).json({ error: roleErr });
    const { count, error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    res.json({ count: count || 0, target_role: targetRole });
  }
);

// ============================================================
// POST /api/notifications/global
//   全体通知。target_role に応じて users SELECT → bulk insert。
//   権限: admin / secretary / producer / producer_director の4ロール。
//   body: { title, body?, link_url?, target_role?, meta? }
//   target_role:
//     all              全アクティブメンバー
//     directors_above  director / producer_director / producer / admin
//     editors_only     editor のみ
//     designers_only   designer のみ
// ============================================================
router.post(
  '/global',
  requireRole('admin', 'secretary', 'producer', 'producer_director'),
  async (req, res) => {
    const { title, body = null, link_url = null, target_role = 'all', meta = {} } = req.body || {};
    if (!title || !String(title).trim()) {
      return res.status(400).json({ error: 'title は必須です' });
    }

    // 対象ユーザー絞り込み
    let userQ = supabase.from('users').select('id').eq('is_active', true);
    if (target_role === 'directors_above') {
      userQ = userQ.in('role', ['director', 'producer_director', 'producer', 'admin']);
    } else if (target_role === 'editors_only') {
      userQ = userQ.eq('role', 'editor');
    } else if (target_role === 'designers_only') {
      userQ = userQ.eq('role', 'designer');
    } else if (target_role !== 'all') {
      return res.status(400).json({ error: 'target_role が不正です' });
    }
    const { data: users, error: usersErr } = await userQ;
    if (usersErr) return res.status(500).json({ error: usersErr.message });
    if (!users || users.length === 0) {
      return res.json({ notification_count: 0, global_id: null });
    }

    // 全員に同じ内容の通知を bulk INSERT。global_id は meta に同一UUIDを入れて
    // 「同じ通知の系列」を後から追えるようにする（Realtime の重複排除 / 既読同期で活きる）。
    const { v4: uuidv4 } = require('uuid');
    const globalId = uuidv4();
    const senderId = req.user?.id || null;
    const rows = users.map(u => ({
      user_id: u.id,
      notification_type: 'global',
      title,
      body,
      link_url,
      meta: { ...meta, global_notification_id: globalId },
      sender_id: senderId,
    }));

    const inserted = await createBulkNotifications(rows);
    res.json({ notification_count: inserted.length, global_id: globalId });
  }
);

module.exports = router;
