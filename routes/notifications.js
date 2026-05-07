// routes/notifications.js — リベシティ風 通知API（Phase 1）
//
// マウント: server.js で `app.use('/api/notifications', require('./routes/notifications'))`
// 設計参照: docs/notification/notification_API_SPEC.md
//
// エンドポイント:
//   GET    /                  自分宛通知一覧（配信済みのみ。未配信の予約は出さない）
//   GET    /unread-count      未読件数
//   PATCH  /:id/read          個別既読化
//   PATCH  /read-all          全件 or 種別ごと既読化
//   POST   /global            全体通知発火（送信モード: immediate / scheduled 対応）
//   GET    /global/preview-count  全体通知の対象人数プレビュー
//   GET    /scheduled         自分が送った未配信予約一覧（差出人視点）
//   PATCH  /:id/cancel        未配信予約をキャンセル
//   PATCH  /:id/reschedule    未配信予約の時刻変更
//
// スコープ A（人が能動的に出す通知）の予約配信に対応。
// システム自動通知（ball_returned, post_reaction 等）は send_mode='immediate' のままで挙動変更なし。

const express = require('express');
const router = express.Router();
const supabase = require('../supabase');
const { requireAuth, requireRole } = require('../auth');
const { createBulkNotifications, nextActiveSlot } = require('../utils/notification');
const { getUserRoleCodes } = require('../utils/roles');

// dual-read 期間: user_roles 経由でロール集合を取得し、空なら req.user.role を fallback。
// 'producer_director' を持つユーザーは producer / director の両方を持つ扱いにする。
async function getRequesterRoleCodes(req) {
  if (!req || !req.user) return [];
  const codes = await getUserRoleCodes(req.user.id);
  if (codes.length > 0) return codes;
  const legacy = req.user.role;
  if (!legacy) return [];
  if (legacy === 'producer_director') return ['producer', 'director'];
  return [legacy];
}

async function requesterHasAnyRole(req, codes) {
  const myCodes = await getRequesterRoleCodes(req);
  return myCodes.some(c => codes.includes(c));
}

// 全エンドポイント共通: ログイン必須
router.use(requireAuth);

// 受信者向けクエリ共通フィルタ: 「配信済み・未キャンセル」のみ
//   予約中（delivered_at IS NULL）の通知は受信者にはまだ存在しないことにする。
function applyDeliveredFilter(q) {
  return q.not('delivered_at', 'is', null).is('cancelled_at', null);
}

// ============================================================
// post_reaction の集約: 同一受信者・同一送信者で 24h 以内のリアクション通知を 1 カードに束ねる。
//
// 戻り値: 集約済み通知配列（時系列降順）。集約された通知は次の追加フィールドを持つ:
//   aggregated:        true
//   aggregated_ids:    [string]    元 notification_logs.id の集合
//   aggregated_count:  number       元行数
//   reaction_emojis:   [string]    発生した絵文字（unique 順序保持）
//   tweet_ids:         [string]    関わったつぶやき ID の集合（unique）
//   latest_tweet_id:   string|null 最新つぶやき ID（クリック先）
//
// 集約条件:
//   - notification_type === 'post_reaction'
//   - sender_id が同一
//   - 連続する 2 行が 24 時間以内（最新側との差分で判定）
//   - 既存のソート（created_at DESC）を維持し、グループ全体を最新行の位置に置く
//
// 既読判定: グループ内の全行が is_read=true のときだけ既読バッジ。1 つでも未読なら未読扱い。
// ============================================================
const REACTION_EMOJI_MAP = {
  good: '👍', heart: '❤️', clap: '👏', smile: '😊', surprised: '😳',
};
const REACTION_AGGREGATE_WINDOW_MS = 24 * 60 * 60 * 1000;

function aggregatePostReactionNotifications(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  // rows は created_at DESC 前提
  const result = [];
  let i = 0;
  while (i < rows.length) {
    const row = rows[i];
    if (row.notification_type !== 'post_reaction' || !row.sender_id) {
      result.push(row);
      i += 1;
      continue;
    }
    // 同 sender_id・post_reaction を 24h 以内まで取り込む
    const group = [row];
    let j = i + 1;
    const headTime = new Date(row.created_at).getTime();
    while (j < rows.length) {
      const cand = rows[j];
      if (cand.notification_type !== 'post_reaction') break;
      if (cand.sender_id !== row.sender_id) break;
      const candTime = new Date(cand.created_at).getTime();
      if (Number.isFinite(headTime) && Number.isFinite(candTime) &&
          headTime - candTime > REACTION_AGGREGATE_WINDOW_MS) break;
      group.push(cand);
      j += 1;
    }
    if (group.length === 1) {
      result.push(row);
    } else {
      // 集約カードを生成
      const emojis = [];
      const seenEmoji = new Set();
      const tweetIds = [];
      const seenTweet = new Set();
      let anyUnread = false;
      let earliestReadAt = null;
      for (const g of group) {
        const rt = g.meta?.reaction_type;
        const emoji = REACTION_EMOJI_MAP[rt];
        if (emoji && !seenEmoji.has(emoji)) {
          seenEmoji.add(emoji);
          emojis.push(emoji);
        }
        const tId = g.meta?.tweet_id;
        if (tId && !seenTweet.has(tId)) {
          seenTweet.add(tId);
          tweetIds.push(tId);
        }
        if (!g.is_read) anyUnread = true;
        if (g.read_at) {
          if (!earliestReadAt || g.read_at < earliestReadAt) earliestReadAt = g.read_at;
        }
      }
      const head = group[0]; // 最新行
      const latestTweetId = head.meta?.tweet_id || (tweetIds[0] || null);
      const senderLabel = head.meta?.sender_name || null;
      const aggregatedTitle = senderLabel
        ? `${senderLabel}さんが あなたのつぶやきにリアクション (${group.length}件)`
        : `あなたのつぶやきへのリアクション (${group.length}件)`;
      result.push({
        ...head,
        // 表示用に title / body を上書き（元の単一行用文言から差し替え）
        title: aggregatedTitle,
        body: emojis.join(' '),
        is_read: !anyUnread,
        read_at: anyUnread ? null : (earliestReadAt || head.read_at || null),
        link_url: latestTweetId ? `/haruka.html?tweet=${latestTweetId}` : head.link_url,
        aggregated: true,
        aggregated_ids: group.map(g => g.id),
        aggregated_count: group.length,
        reaction_emojis: emojis,
        tweet_ids: tweetIds,
        latest_tweet_id: latestTweetId,
      });
    }
    i = j;
  }
  return result;
}

// ============================================================
// GET /api/notifications
//   自分宛の通知を時系列降順で返す。配信済みのみ。
//   post_reaction はクライアント表示用に sender_id 単位で集約する（DB は変更しない）。
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
  q = applyDeliveredFilter(q);
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

  const enriched = (data || []).map(n => ({
    ...n,
    sender_name: n.sender_id ? (senderNameById.get(n.sender_id) || null) : null,
  }));

  // post_reaction を集約（DB は変更しない・レスポンス時集約のみ）
  const notifications = aggregatePostReactionNotifications(enriched);

  // total / has_more はページング用なので元行数ベース（集約前）で返す。
  // 集約は同ページ内の表示崩しを抑える目的で、ページ境界をまたぐ集約は行わない。
  const total = count ?? enriched.length;
  const has_more = (offset + enriched.length) < total;

  res.json({ notifications, total, has_more });
});

// ============================================================
// GET /api/notifications/unread-count
// ============================================================
router.get('/unread-count', async (req, res) => {
  const userId = req.user.id;
  let q = supabase
    .from('notification_logs')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('is_read', false);
  q = applyDeliveredFilter(q);
  const { count, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ unread_count: count || 0 });
});

// ============================================================
// PATCH /api/notifications/:id/read
// ============================================================
router.patch('/:id/read', async (req, res) => {
  const userId = req.user.id;
  const id = req.params.id;

  const { data: target, error: fetchErr } = await supabase
    .from('notification_logs')
    .select('id, user_id, is_read, read_at, delivered_at, cancelled_at')
    .eq('id', id)
    .maybeSingle();
  if (fetchErr) return res.status(500).json({ error: fetchErr.message });
  if (!target)  return res.status(404).json({ error: '通知が見つかりません' });
  if (target.user_id !== userId) return res.status(403).json({ error: 'この通知を既読化する権限がありません' });
  if (!target.delivered_at || target.cancelled_at) {
    return res.status(404).json({ error: '通知が見つかりません' });
  }

  if (target.is_read) {
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
// PATCH /api/notifications/bulk-read
//   集約カード用: ID 配列をまとめて既読化する。
//   body: { ids: [string, ...] }
//
//   集約カードクリック時、含まれる元 notification_logs.id を全部既読化するために使う。
// ============================================================
router.patch('/bulk-read', async (req, res) => {
  const userId = req.user.id;
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : null;
  if (!ids || ids.length === 0) {
    return res.status(400).json({ error: 'ids は必須です（空でない配列）' });
  }
  if (ids.length > 200) {
    return res.status(400).json({ error: 'ids は最大 200 件まで' });
  }
  // 自分宛・配信済み・未キャンセルのみを既読化（権限漏れ防止）
  const { data, error } = await supabase
    .from('notification_logs')
    .update({ is_read: true, read_at: new Date().toISOString() })
    .in('id', ids)
    .eq('user_id', userId)
    .eq('is_read', false)
    .not('delivered_at', 'is', null)
    .is('cancelled_at', null)
    .select('id');
  if (error) return res.status(500).json({ error: error.message });
  res.json({ updated_count: (data || []).length });
});

// ============================================================
// PATCH /api/notifications/read-all
// ============================================================
router.patch('/read-all', async (req, res) => {
  const userId = req.user.id;
  const type = req.body?.type ? String(req.body.type) : null;

  let q = supabase
    .from('notification_logs')
    .update({ is_read: true, read_at: new Date().toISOString() })
    .eq('user_id', userId)
    .eq('is_read', false)
    .not('delivered_at', 'is', null)
    .is('cancelled_at', null)
    .select('id');
  if (type) q = q.eq('notification_type', type);

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ updated_count: (data || []).length });
});

// ============================================================
// 共通ヘルパー: target_role 文字列を user_roles JOIN ベースの user_id 集合に解決する。
// dual-read 期間: user_roles JOIN roles と、旧 users.role IN (...) を並走で読み、
// その和集合を返す（user_roles 未反映ユーザーをカバー）。
// 戻り値:
//   { error?: string, ids?: string[] | null }
//   ids が null の場合は「絞り込みなし（target_role='all'）」を意味する。
// ============================================================
const TARGET_ROLE_TO_CODES = {
  directors_above: ['director', 'producer_director', 'producer', 'admin'],
  editors_only: ['editor'],
  designers_only: ['designer'],
};

async function resolveTargetRoleUserIds(targetRole) {
  if (targetRole === 'all' || targetRole == null) return { ids: null };
  const wantedCodes = TARGET_ROLE_TO_CODES[targetRole];
  if (!wantedCodes) return { error: 'target_role が不正です' };

  // user_roles 経由（合成値 'producer_director' は roles マスタに無いため除外して引く）
  const codesForJoin = wantedCodes.filter(c => c !== 'producer_director');
  const idSet = new Set();
  if (codesForJoin.length > 0) {
    const { data: ur, error: urErr } = await supabase
      .from('user_roles').select('user_id, roles(code)').in('roles.code', codesForJoin);
    if (urErr) return { error: urErr.message };
    (ur || []).forEach(r => { if (r.roles) idSet.add(r.user_id); });
  }

  // dual-read: 旧 users.role 列も拾う（'producer_director' を含む全コード）
  const { data: legacy, error: legErr } = await supabase
    .from('users').select('id').in('role', wantedCodes);
  if (legErr) return { error: legErr.message };
  (legacy || []).forEach(u => idSet.add(u.id));

  return { ids: Array.from(idSet) };
}

// 後方互換: count head クエリを組み立てる薄いラッパ。
async function buildTargetRoleQuery(targetRole) {
  const resolved = await resolveTargetRoleUserIds(targetRole);
  if (resolved.error) return { error: resolved.error };
  let q = supabase.from('users').select('id', { count: 'exact', head: true }).eq('is_active', true);
  if (resolved.ids === null) return { query: q };
  if (resolved.ids.length === 0) {
    // 該当ユーザーがいない場合、count=0 を確実に返すために絶対 false な条件を入れる
    return { query: q.in('id', ['00000000-0000-0000-0000-000000000000']) };
  }
  return { query: q.in('id', resolved.ids) };
}

// ============================================================
// GET /api/notifications/global/preview-count
// ============================================================
router.get(
  '/global/preview-count',
  requireRole('admin', 'secretary', 'producer', 'producer_director'),
  async (req, res) => {
    const targetRole = req.query.target_role ? String(req.query.target_role) : 'all';
    const { query, error: roleErr } = await buildTargetRoleQuery(targetRole);
    if (roleErr) return res.status(400).json({ error: roleErr });
    const { count, error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    res.json({ count: count || 0, target_role: targetRole });
  }
);

// ============================================================
// POST /api/notifications/global
//   送信モード対応:
//     send_mode='immediate'（既定）: 既存挙動。即時配信。
//     send_mode='scheduled':
//       scheduled_send_at が指定されていれば全員共通でその時刻に配信
//       省略時は受信者ごとの活動枠（nextActiveSlot）に個別配信
//
//   body: { title, body?, link_url?, target_role?, meta?, send_mode?, scheduled_send_at? }
// ============================================================
router.post(
  '/global',
  requireRole('admin', 'secretary', 'producer', 'producer_director'),
  async (req, res) => {
    const {
      title, body = null, link_url = null, target_role = 'all', meta = {},
      send_mode = 'immediate', scheduled_send_at = null,
    } = req.body || {};
    if (!title || !String(title).trim()) {
      return res.status(400).json({ error: 'title は必須です' });
    }
    if (!['immediate', 'scheduled'].includes(send_mode)) {
      return res.status(400).json({ error: 'send_mode が不正です' });
    }

    // 明示指定された scheduled_send_at は過去でないことを確認（現在時刻より1分以上前なら拒否）
    let parsedScheduledAt = null;
    if (send_mode === 'scheduled' && scheduled_send_at) {
      const d = new Date(scheduled_send_at);
      if (!Number.isFinite(d.getTime())) {
        return res.status(400).json({ error: 'scheduled_send_at の形式が不正です' });
      }
      if (d.getTime() < Date.now() - 60_000) {
        return res.status(400).json({ error: 'scheduled_send_at は現在時刻より後を指定してください' });
      }
      parsedScheduledAt = d;
    }

    // 対象ユーザー絞り込み（user_roles + 旧 users.role の dual-read 和集合）
    const resolved = await resolveTargetRoleUserIds(target_role);
    if (resolved.error) return res.status(400).json({ error: resolved.error });
    let userQ = supabase.from('users').select('id').eq('is_active', true);
    if (resolved.ids !== null) {
      if (resolved.ids.length === 0) {
        return res.json({ notification_count: 0, global_id: null, send_mode });
      }
      userQ = userQ.in('id', resolved.ids);
    }
    const { data: users, error: usersErr } = await userQ;
    if (usersErr) return res.status(500).json({ error: usersErr.message });
    if (!users || users.length === 0) {
      return res.json({ notification_count: 0, global_id: null, send_mode });
    }

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

    const inserted = await createBulkNotifications(rows, {
      sendMode: send_mode,
      scheduledSendAt: parsedScheduledAt,
    });
    res.json({
      notification_count: inserted.length,
      global_id: globalId,
      send_mode,
      // 全員共通の予約時刻が確定していればそれを返す（個別計算ケースは null）
      scheduled_send_at: parsedScheduledAt ? parsedScheduledAt.toISOString() : null,
    });
  }
);

// ============================================================
// GET /api/notifications/scheduled
//   自分が送った「未配信」予約一覧。差出人視点。
//   global_notification_id 単位でグルーピングして返す（同じ全体連絡を1件として扱う）。
//
//   レスポンス: [{
//     id,                          代表行のID（最古）
//     global_notification_id,      meta.global_notification_id（ある場合）
//     title, body,
//     recipients_count,            予約中の受信者数
//     scheduled_send_at,           最も早い配信予定時刻（ISO）
//     scheduled_send_at_max,       最も遅い配信予定時刻（個別計算なら値が違う）
//     send_mode,
//     created_at,
//   }]
// ============================================================
router.get('/scheduled', async (req, res) => {
  const userId = req.user.id;
  const isPrivileged = await requesterHasAnyRole(req, ['admin', 'secretary']);

  // 差出人本人 + admin/secretary は全員の予約を見られる
  let q = supabase
    .from('notification_logs')
    .select('id, sender_id, notification_type, title, body, link_url, meta, scheduled_send_at, send_mode, created_at')
    .is('delivered_at', null)
    .is('cancelled_at', null)
    .eq('send_mode', 'scheduled')
    .order('scheduled_send_at', { ascending: true })
    .limit(1000);
  if (!isPrivileged) {
    q = q.eq('sender_id', userId);
  }

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });

  // global_notification_id 単位でグルーピング。なければ個別IDをキーに。
  const groups = new Map();
  for (const row of (data || [])) {
    const key = row.meta?.global_notification_id || `single:${row.id}`;
    if (!groups.has(key)) {
      groups.set(key, {
        id: row.id,
        global_notification_id: row.meta?.global_notification_id || null,
        title: row.title,
        body: row.body,
        link_url: row.link_url,
        sender_id: row.sender_id,
        send_mode: row.send_mode,
        created_at: row.created_at,
        scheduled_send_at: row.scheduled_send_at,
        scheduled_send_at_max: row.scheduled_send_at,
        recipients_count: 1,
      });
    } else {
      const g = groups.get(key);
      g.recipients_count += 1;
      if (row.scheduled_send_at && row.scheduled_send_at < g.scheduled_send_at) {
        g.scheduled_send_at = row.scheduled_send_at;
      }
      if (row.scheduled_send_at && row.scheduled_send_at > g.scheduled_send_at_max) {
        g.scheduled_send_at_max = row.scheduled_send_at;
      }
    }
  }

  res.json({ scheduled: Array.from(groups.values()) });
});

// ============================================================
// PATCH /api/notifications/:id/cancel
//   未配信予約をキャンセルする。
//   id は単一行ID または global_notification_id（meta.global_notification_id）
//   どちらでも受け付ける（id は UUID なので両方を試す）。
//
//   権限: 差出人本人 + admin/secretary
//   配信済み(delivered_at IS NOT NULL)はキャンセル不可
// ============================================================
router.patch('/:id/cancel', async (req, res) => {
  const userId = req.user.id;
  const isPrivileged = await requesterHasAnyRole(req, ['admin', 'secretary']);
  const id = req.params.id;

  // 1) まず id を notification_logs.id として検索
  const { data: byId } = await supabase
    .from('notification_logs')
    .select('id, sender_id, delivered_at, cancelled_at, meta, send_mode')
    .eq('id', id)
    .maybeSingle();

  // 2) 見つからなければ global_notification_id として検索
  let targets = [];
  if (byId) {
    // 同じ global_notification_id があるなら一括で取得（全員分キャンセル）
    const globalId = byId.meta?.global_notification_id;
    if (globalId) {
      const { data: siblings } = await supabase
        .from('notification_logs')
        .select('id, sender_id, delivered_at, cancelled_at, send_mode')
        .eq('meta->>global_notification_id', globalId)
        .is('delivered_at', null)
        .is('cancelled_at', null);
      targets = siblings || [byId];
    } else {
      targets = [byId];
    }
  } else {
    // global_notification_id として検索
    const { data: byGlobal } = await supabase
      .from('notification_logs')
      .select('id, sender_id, delivered_at, cancelled_at, send_mode')
      .eq('meta->>global_notification_id', id)
      .is('delivered_at', null)
      .is('cancelled_at', null);
    targets = byGlobal || [];
  }

  if (targets.length === 0) {
    return res.status(404).json({ error: '対象の予約が見つかりません（既に配信済み or キャンセル済みの可能性）' });
  }

  // 権限: 差出人本人 or admin/secretary
  const ownerIds = Array.from(new Set(targets.map(t => t.sender_id)));
  if (!isPrivileged && (ownerIds.length !== 1 || ownerIds[0] !== userId)) {
    return res.status(403).json({ error: 'この予約をキャンセルする権限がありません' });
  }

  // 配信済みは弾く（既にフィルタしてるが念のため）
  const cancellable = targets.filter(t => !t.delivered_at && !t.cancelled_at);
  if (cancellable.length === 0) {
    return res.status(400).json({ error: '配信済み or キャンセル済みのためキャンセルできません' });
  }

  const ids = cancellable.map(t => t.id);
  const { data, error } = await supabase
    .from('notification_logs')
    .update({ cancelled_at: new Date().toISOString(), cancelled_by: userId })
    .in('id', ids)
    .select('id');
  if (error) return res.status(500).json({ error: error.message });

  res.json({ cancelled_count: (data || []).length });
});

// ============================================================
// PATCH /api/notifications/:id/reschedule
//   未配信予約の時刻を変更。
//   body: { scheduled_send_at: ISO文字列 }  必須
//   id 解決ロジックは /cancel と同じ（単一行 or global_notification_id）
// ============================================================
router.patch('/:id/reschedule', async (req, res) => {
  const userId = req.user.id;
  const isPrivileged = await requesterHasAnyRole(req, ['admin', 'secretary']);
  const id = req.params.id;
  const { scheduled_send_at } = req.body || {};

  if (!scheduled_send_at) {
    return res.status(400).json({ error: 'scheduled_send_at は必須です' });
  }
  const d = new Date(scheduled_send_at);
  if (!Number.isFinite(d.getTime())) {
    return res.status(400).json({ error: 'scheduled_send_at の形式が不正です' });
  }
  if (d.getTime() < Date.now() - 60_000) {
    return res.status(400).json({ error: 'scheduled_send_at は現在時刻より後を指定してください' });
  }

  const { data: byId } = await supabase
    .from('notification_logs')
    .select('id, sender_id, delivered_at, cancelled_at, meta')
    .eq('id', id)
    .maybeSingle();

  let targets = [];
  if (byId) {
    const globalId = byId.meta?.global_notification_id;
    if (globalId) {
      const { data: siblings } = await supabase
        .from('notification_logs')
        .select('id, sender_id, delivered_at, cancelled_at')
        .eq('meta->>global_notification_id', globalId)
        .is('delivered_at', null)
        .is('cancelled_at', null);
      targets = siblings || [byId];
    } else {
      targets = [byId];
    }
  } else {
    const { data: byGlobal } = await supabase
      .from('notification_logs')
      .select('id, sender_id, delivered_at, cancelled_at')
      .eq('meta->>global_notification_id', id)
      .is('delivered_at', null)
      .is('cancelled_at', null);
    targets = byGlobal || [];
  }

  if (targets.length === 0) {
    return res.status(404).json({ error: '対象の予約が見つかりません' });
  }
  const ownerIds = Array.from(new Set(targets.map(t => t.sender_id)));
  if (!isPrivileged && (ownerIds.length !== 1 || ownerIds[0] !== userId)) {
    return res.status(403).json({ error: 'この予約を変更する権限がありません' });
  }
  const reschedulable = targets.filter(t => !t.delivered_at && !t.cancelled_at);
  if (reschedulable.length === 0) {
    return res.status(400).json({ error: '配信済み or キャンセル済みのため変更できません' });
  }

  const ids = reschedulable.map(t => t.id);
  const { data, error } = await supabase
    .from('notification_logs')
    .update({ scheduled_send_at: d.toISOString() })
    .in('id', ids)
    .select('id');
  if (error) return res.status(500).json({ error: error.message });

  res.json({ updated_count: (data || []).length, scheduled_send_at: d.toISOString() });
});

module.exports = router;
