// routes/haruka.js — HARUKA FILM SYSTEM API
const express = require('express');
const router = express.Router();
const supabase = require('../supabase');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const { requireAuth, requireRole, requireLevel, requirePermission, requireSuperAdmin, isSuperAdminUser, userHasPermission, getEffectiveRole, getEffectiveRoleCodes, invalidatePermissionsCache } = require('../auth');
const { google } = require('googleapis');
const { Readable } = require('stream');
const { createSheetWithData, extractSpreadsheetId, readSheetData } = require('../sheets');
const { generateFaststart, isVideoCandidate: faststartIsVideoCandidate, isEnabled: faststartIsEnabled } = require('../lib/faststart');
const { shareForClientReview } = require('../lib/drive-share');
const { createNotification, extractMentions } = require('../utils/notification');
const { renderFilename } = require('../utils/filename');
const {
  getUserRoleCodes,
  userHasRole,
  getUsersRolesMap,
  invalidateRolesCache,
} = require('../utils/roles');
const {
  BUILTIN_FIELDS,
  BUILTIN_FIELD_LABELS,
  isBuiltinField,
  isAllowedCustomType,
} = require('../utils/category-fields');

// ==================== ロール判定ヘルパー（dual-read 期間用） ====================
// Stage 0 / Step 2 (ADR 003): authorization 経路の role 判定はこのヘルパー経由で行う。
// user_roles を読み、空ならフォールバックで users.role を 1 要素として扱う。
// 'producer_director' を持つユーザーは producer / director の両方を持つ扱いにする。
async function getRequesterRoleCodes(req) {
  if (!req || !req.user) return [];
  const codes = await getUserRoleCodes(req.user.id);
  if (codes.length > 0) return codes;
  // dual-read fallback: 旧 users.role
  const legacy = req.user.role;
  if (!legacy) return [];
  if (legacy === 'producer_director') return ['producer', 'director'];
  return [legacy];
}

async function requesterHasAnyRole(req, codes) {
  const myCodes = await getRequesterRoleCodes(req);
  if (myCodes.length === 0) return false;
  for (const c of codes) {
    if (myCodes.includes(c)) return true;
  }
  return false;
}

// 'admin' / 'secretary' のいずれかを保有しているか（多くのスタッフ判定で使う）
async function isStaffRequester(req) {
  return requesterHasAnyRole(req, ['admin', 'secretary']);
}

// 与えられた user_id が admin/secretary を持つかを user_roles 経由で確認。
// dual-read fallback: user_roles が空なら users.role を読む。
async function userIsStaff(userId) {
  if (!userId) return false;
  const codes = await getUserRoleCodes(userId);
  if (codes.includes('admin') || codes.includes('secretary')) return true;
  if (codes.length === 0) {
    const { data } = await supabase.from('users').select('role').eq('id', userId).maybeSingle();
    const r = data?.role;
    return r === 'admin' || r === 'secretary';
  }
  return false;
}

// users.role を更新する際に user_roles も同期更新する（dual-write）。
// - 'producer_director' は user_roles に producer + director の 2 行
// - それ以外は roles.code を引いて 1 行
// - 既存行は DELETE → INSERT で再構築
// 失敗時はログのみで握り潰す（users.role の更新は既に完了している前提）。
async function syncUserRolesForLegacyRole(userId, legacyRole) {
  if (!userId) return;
  if (!legacyRole) return; // 不変扱い
  try {
    // 期待するロールコード集合
    let expected;
    if (legacyRole === 'producer_director') expected = ['producer', 'director'];
    else expected = [legacyRole];

    // roles マスタから ID を引く
    const { data: rolesData, error: rolesErr } = await supabase
      .from('roles').select('id, code').in('code', expected);
    if (rolesErr) {
      console.warn('[user_roles sync] roles 取得失敗:', rolesErr.message);
      return;
    }
    const idByCode = new Map((rolesData || []).map(r => [r.code, r.id]));
    const rows = expected
      .map(code => idByCode.get(code))
      .filter(Boolean)
      .map(roleId => ({ user_id: userId, role_id: roleId }));

    // 既存行を全消去（scope_type/scope_id を扱わず、user_id 単位で一括再構築）
    const { error: delErr } = await supabase
      .from('user_roles').delete().eq('user_id', userId);
    if (delErr) {
      console.warn('[user_roles sync] 既存行削除失敗:', delErr.message);
      return;
    }
    if (rows.length === 0) return;
    const { error: insErr } = await supabase.from('user_roles').insert(rows);
    if (insErr) {
      console.warn('[user_roles sync] insert 失敗:', insErr.message);
    }
  } catch (e) {
    console.warn('[user_roles sync] 例外:', e.message);
  }
}

// FFmpeg（画質変換用）
let ffmpegPath, ffmpeg;
try {
  ffmpegPath = require('ffmpeg-static');
  ffmpeg     = require('fluent-ffmpeg');
  ffmpeg.setFfmpegPath(ffmpegPath);
} catch(e) { /* ffmpeg-static 未インストール時はスキップ */ }

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 500 * 1024 * 1024 } });

// 動画再生高速化（faststart re-mux）対象判定。
// MP4/MOV/M4V のみ：moov atom を先頭に移動可能。
// WebM/MKV/AVI 等は対象外（コンテナ仕様が違う）。
function shouldFaststart(mimeType, fileName) {
  if (!ffmpeg) return false;
  if (!mimeType || !mimeType.startsWith('video/')) return false;
  return /\.(mp4|mov|m4v)$/i.test(fileName || '');
}

// 旧 processFaststartAsync は lib/faststart.js の generateFaststart に統合済み。
// 呼び出し: generateFaststart({ creativeFileId }) — DB id だけで完結する fire-and-forget。

// アップロードログリングバッファ（最新100件）
const _uploadLogs = [];
function driveLog(level, msg, extra = {}) {
  const entry = { ts: new Date().toISOString(), level, msg, ...extra };
  _uploadLogs.push(entry);
  if (_uploadLogs.length > 100) _uploadLogs.shift();
  const tag = level === 'error' ? '❌' : level === 'warn' ? '⚠️' : '✅';
  console.log(`[DRIVE ${tag}] ${msg}`, Object.keys(extra).length ? JSON.stringify(extra) : '');
}

// ==================== 認証ガード ====================
// /workspace のみ公開（ログインページで使用）、それ以外は全て認証必須
router.use((req, res, next) => {
  if (req.path === '/workspace') return next();
  requireAuth(req, res, next);
});

// ==================== ワークスペース情報 ====================
router.get('/workspace', (_req, res) => {
  res.json({
    workspace_number : parseInt(process.env.WORKSPACE_NUMBER || '1'),
    name             : process.env.WORKSPACE_NAME  || 'HARUKA FILM',
    slug             : process.env.WORKSPACE_SLUG  || 'haruka-film',
    primary_color    : process.env.PRIMARY_COLOR   || '#3ECFCA',
  });
});

// ログイン中ユーザー情報
router.get('/me', (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'ログインが必要です' });
  const { id, email, full_name, role, rank, team_id, avatar_url, workspace_id } = req.user;
  res.json({ id, email, full_name, role, rank, team_id, avatar_url, workspace_id });
});

// ログ取得エンドポイント
router.get('/upload-logs', requireAuth, (_req, res) => {
  res.json({ logs: [..._uploadLogs].reverse() });
});

// Google Drive サービスアカウント認証
async function getDriveService() {
  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!keyJson) throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY が設定されていません');
  const credentials = JSON.parse(keyJson);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/drive']
  });
  return google.drive({ version: 'v3', auth });
}

// フォルダを取得または作成
async function getOrCreateFolder(drive, parentId, name) {
  const safeName = name.replace(/'/g, "\\'");
  const res = await drive.files.list({
    q: `name='${safeName}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id, name)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  if (res.data.files.length > 0) return res.data.files[0].id;
  const folder = await drive.files.create({
    requestBody: { name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] },
    fields: 'id',
    supportsAllDrives: true,
  });
  return folder.data.id;
}

// Drive フォルダURLからフォルダIDを抽出
function extractFolderIdFromUrl(url) {
  const m = url.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}

// ==================== クライアント ====================

// クライアント一覧取得
router.get('/clients', async (req, res) => {
  const { data, error } = await supabase
    .from('clients')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });

  // client_teams を別途取得して team_ids として merge
  const { data: links, error: linksErr } = await supabase
    .from('client_teams')
    .select('client_id, team_id, sort_order')
    .order('sort_order');
  if (linksErr) console.error('[GET /clients client_teams]', linksErr);
  const teamsByClient = new Map();
  (links || []).forEach(l => {
    if (!teamsByClient.has(l.client_id)) teamsByClient.set(l.client_id, []);
    teamsByClient.get(l.client_id).push(l.team_id);
  });
  const enriched = (data || []).map(c => ({ ...c, team_ids: teamsByClient.get(c.id) || [] }));
  res.json(enriched);
});

const LINK_FIELDS = ['website_url','twitter_url','instagram_url','facebook_url','youtube_url','tiktok_url','line_url','other_url'];

// 適格請求書発行事業者 登録番号 のバリデーション・正規化。
//   - undefined  → 「未指定」を表す sentinel `undefined` を返す（updateData に入れない）
//   - null / ''  → null として保存（登録解除）
//   - 'T' + 半角数字13桁 → 大文字化して保存
//   - それ以外  → { error: '...' }
// 全角数字や記号混入はユーザー誤入力としてエラーにする（請求書上に印字される正式番号のため厳格化）。
function normalizeInvoiceRegistrationNumber(raw) {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== 'string') return { error: '登録番号は文字列で指定してください' };
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  // 'T1234567890123' 形式（先頭 T 大文字小文字許容、その後ろは半角数字13桁）
  const m = trimmed.match(/^[Tt](\d{13})$/);
  if (!m) {
    return { error: '登録番号は「T + 半角数字13桁」の形式で入力してください（例: T1234567890123）' };
  }
  return 'T' + m[1];
}

// クライアント-チーム紐付けを sync するヘルパ
async function syncClientTeams(clientId, teamIds) {
  if (!Array.isArray(teamIds)) return;
  const { error: delErr } = await supabase.from('client_teams').delete().eq('client_id', clientId);
  if (delErr) console.error('[syncClientTeams delete]', delErr);
  if (teamIds.length === 0) return;
  const rows = teamIds
    .filter(t => !!t)
    .map((teamId, idx) => ({ client_id: clientId, team_id: teamId, sort_order: idx }));
  if (!rows.length) return;
  const { error } = await supabase.from('client_teams').insert(rows);
  if (error) console.error('[syncClientTeams insert]', error);
}

// クライアント作成
router.post('/clients', requireAuth, requirePermission('project.create_edit'), async (req, res) => {
  const { name, client_code, note, sales_start_date, status, persona, slack_channel_url, chatwork_room_id, invoice_registration_number } = req.body;
  if (!name) return res.status(400).json({ error: 'クライアント名は必須です' });
  const code = client_code ? client_code.toUpperCase().slice(0, 3) : null;
  const insertData = { name, client_code: code, note, sales_start_date: sales_start_date || null, status: status || '提案中', persona: persona || null };
  if (slack_channel_url !== undefined) insertData.slack_channel_url = slack_channel_url || null;
  if (chatwork_room_id !== undefined) insertData.chatwork_room_id = chatwork_room_id || null;
  // 適格請求書発行事業者 登録番号（インボイス制度）
  if ('invoice_registration_number' in req.body) {
    const v = normalizeInvoiceRegistrationNumber(req.body.invoice_registration_number);
    if (v && typeof v === 'object' && v.error) return res.status(400).json({ error: v.error });
    if (v !== undefined) insertData.invoice_registration_number = v;
  }
  LINK_FIELDS.forEach(f => { if (req.body[f] !== undefined) insertData[f] = req.body[f] || null; });
  // 列未反映環境（migration 未適用）でも 500 にせずグレースフルにフォールバック
  let attempt = { ...insertData };
  let { data, error } = await supabase
    .from('clients')
    .insert(attempt)
    .select()
    .single();
  if (error && /invoice_registration_number/.test(error.message || '')) {
    console.warn('[clients:create] invoice_registration_number 列未反映のためフォールバック保存:', error.message);
    delete attempt.invoice_registration_number;
    ({ data, error } = await supabase.from('clients').insert(attempt).select().single());
  }
  if (error) return res.status(500).json({ error: error.message });
  if (data && req.body.team_ids !== undefined) {
    await syncClientTeams(data.id, req.body.team_ids);
  }
  res.json({ ...data, team_ids: Array.isArray(req.body.team_ids) ? req.body.team_ids : [] });
});

// クライアント更新
router.put('/clients/:id', requireAuth, requirePermission('project.create_edit'), async (req, res) => {
  const { name, client_code, note, sales_start_date, status, persona, slack_channel_url, chatwork_room_id, invoice_registration_number } = req.body;
  const code = client_code ? client_code.toUpperCase().slice(0, 3) : null;
  const updateData = { name, client_code: code, note, sales_start_date: sales_start_date || null, status: status || '提案中', persona: persona || null, updated_at: new Date().toISOString() };
  if (slack_channel_url !== undefined) updateData.slack_channel_url = slack_channel_url || null;
  if (chatwork_room_id !== undefined) updateData.chatwork_room_id = chatwork_room_id || null;
  // 適格請求書発行事業者 登録番号（インボイス制度）
  if ('invoice_registration_number' in req.body) {
    const v = normalizeInvoiceRegistrationNumber(req.body.invoice_registration_number);
    if (v && typeof v === 'object' && v.error) return res.status(400).json({ error: v.error });
    if (v !== undefined) updateData.invoice_registration_number = v;
  }
  LINK_FIELDS.forEach(f => { if (req.body[f] !== undefined) updateData[f] = req.body[f] || null; });
  // 列未反映環境（migration 未適用）でも 500 にせずグレースフルにフォールバック
  let attempt = { ...updateData };
  let { data, error } = await supabase
    .from('clients')
    .update(attempt)
    .eq('id', req.params.id)
    .select()
    .single();
  if (error && /invoice_registration_number/.test(error.message || '')) {
    console.warn('[clients:update] invoice_registration_number 列未反映のためフォールバック保存:', error.message);
    delete attempt.invoice_registration_number;
    ({ data, error } = await supabase.from('clients').update(attempt).eq('id', req.params.id).select().single());
  }
  if (error) return res.status(500).json({ error: error.message });
  if (req.body.team_ids !== undefined) {
    await syncClientTeams(req.params.id, req.body.team_ids);
  }
  // 最新の team_ids を取得して返却
  const { data: links } = await supabase
    .from('client_teams')
    .select('team_id, sort_order')
    .eq('client_id', req.params.id)
    .order('sort_order');
  const team_ids = (links || []).map(l => l.team_id);
  res.json({ ...data, team_ids });
});

// クライアント削除（admin / secretary のみ）
// 監査ログ (client_deletion_logs) に必ず INSERT してから clients を削除する。
// 削除理由は必須（5文字以上推奨／空欄は400）。
// 関連レコード (projects / client_teams 等) は既存FKに従いカスケード or NULL化される。
// 注意: 本実装は requireRole('admin','secretary') でハードコード判定（要件: 秘書まで限定）。
router.delete('/clients/:id', requireAuth, requireRole('admin','secretary'), async (req, res) => {
  const clientId = req.params.id;
  const reason = (req.body?.reason ?? '').toString().trim();
  if (!reason) {
    return res.status(400).json({ error: '削除理由は必須です' });
  }

  // 対象クライアントの基本情報（スナップショット用）
  const { data: client, error: cliErr } = await supabase
    .from('clients')
    .select('id, name, client_code')
    .eq('id', clientId)
    .maybeSingle();
  if (cliErr) return res.status(500).json({ error: cliErr.message });
  if (!client) return res.status(404).json({ error: 'クライアントが見つかりません' });

  // 関連案件件数（監査ログ用に取得）
  const { count: relCount, error: cntErr } = await supabase
    .from('projects')
    .select('id', { count: 'exact', head: true })
    .eq('client_id', clientId);
  if (cntErr) return res.status(500).json({ error: cntErr.message });

  // 監査ログ INSERT （削除前に記録）
  const { error: logErr } = await supabase
    .from('client_deletion_logs')
    .insert({
      client_id: client.id,
      client_name: client.name,
      client_short: client.client_code || null,
      reason,
      deleted_by: req.user?.id || null,
      deleted_by_name: req.user?.full_name || req.user?.email || null,
      related_projects_count: relCount || 0,
    });
  if (logErr) {
    // 監査ログに残せない場合は削除を中断（誤削除→記録なしを防ぐ）
    return res.status(500).json({ error: '監査ログの記録に失敗したため削除を中止しました: ' + logErr.message });
  }

  // 本体削除
  const { error: delErr } = await supabase.from('clients').delete().eq('id', clientId);
  if (delErr) return res.status(500).json({ error: delErr.message });

  res.json({ ok: true, related_projects_count: relCount || 0 });
});

// ==================== 案件 ====================

// サブディレクター（複数）正規化ヘルパー
// - 入力: 任意の値（配列でない / null / undefined / 不正値含む）
// - 出力: { ids: 正規化済みUUID配列, dropped: 弾かれた件数 }
// 仕様（v2: クライアントチーム制約撤廃）:
//   1. 配列でなければ空配列扱い
//   2. 文字列のみ採用、UUIDフォーマットの簡易チェック（36文字 + ハイフン4個）
//   3. 重複除去（先勝ち）
//   4. director_id 本人は除外（自分自身をサブに登録する意味がないため）
//   5. users テーブルに存在し is_active !== false のユーザーのみ採用
//      （存在しないUUID / 退職メンバーは弾く）
// clientId は API 互換のため引数に残すが、チーム判定には使わない。
async function normalizeSubDirectorIds(rawIds, { clientId, directorId } = {}) {
  if (!Array.isArray(rawIds)) return { ids: [], dropped: 0 };
  // 1) 形式チェック + 重複除去 + ディレクター本人除外
  const seen = new Set();
  const cleaned = [];
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  for (const v of rawIds) {
    if (typeof v !== 'string') continue;
    const id = v.trim();
    if (!uuidRe.test(id)) continue;
    if (id === directorId) continue; // ディレクター本人は除外
    if (seen.has(id)) continue;
    seen.add(id);
    cleaned.push(id);
  }
  if (!cleaned.length) return { ids: [], dropped: 0 };
  // 2) users 存在確認 + is_active=false 除外
  const { data: users, error } = await supabase
    .from('users')
    .select('id, is_active')
    .in('id', cleaned);
  if (error) {
    // フェイルセーフ: 検証失敗時は cleaned をそのまま返す（チェック厳しすぎて消えるより安全）
    return { ids: cleaned, dropped: 0 };
  }
  const allowed = new Set(
    (users || []).filter(u => u && u.is_active !== false).map(u => u.id)
  );
  const filtered = cleaned.filter(id => allowed.has(id));
  return { ids: filtered, dropped: cleaned.length - filtered.length };
}

// 案件一覧取得
// has_rates / has_estimates は「単価設定済み」「見積作成済み」の判定フラグ。
// UI 側で「単価」「見積」ボタンに設定済みかどうかを示すために返す。
//
// クエリパラメータ（任意）:
//   - tags : '急ぎ,季節モノ' のようなカンマ区切り。複数 AND 絞り込み
//            （指定したタグを「全部」持つ案件のみ）。
//
// レスポンスには各案件の tags: string[] を含める（N+1 回避のため一括取得）。
router.get('/projects', async (req, res) => {
  // --- クエリ正規化 ---
  const tagsParam  = (req.query.tags  || '').toString().trim();
  const wantedTags = tagsParam
    ? Array.from(new Set(tagsParam.split(',').map(s => s.trim()).filter(Boolean)))
    : [];

  // --- 案件本体 ---
  // primary_category_id は Stage A で追加。テーブル/列が無い環境では select で落ちる可能性が
  // あるため、まず join 付きで試し、失敗したら join 無しでリトライする。
  const baseSelect = `
    *,
    clients(id, name),
    producer:users!projects_producer_id_fkey(id, full_name),
    director:users!projects_director_id_fkey(id, full_name)
  `;
  const query = supabase
    .from('projects')
    .select(baseSelect)
    .order('created_at', { ascending: false });

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  let projects = data || [];

  // --- タグ AND 絞り込み（指定があれば project_id を絞ってからリスト適用）---
  // project_tags は (project_id, tag) PK なので、tag IN (...) を引いて
  // 「全タグを保持する project_id」を JS 側で集計する（タグ数 ≦ 数十程度を想定）。
  if (wantedTags.length && projects.length) {
    const { data: tagRows, error: tagErr } = await supabase
      .from('project_tags')
      .select('project_id, tag')
      .in('tag', wantedTags);
    if (tagErr) return res.status(500).json({ error: tagErr.message });
    const countMap = new Map(); // project_id -> Set<tag>
    for (const r of (tagRows || [])) {
      let s = countMap.get(r.project_id);
      if (!s) { s = new Set(); countMap.set(r.project_id, s); }
      s.add(r.tag);
    }
    const okSet = new Set();
    for (const [pid, s] of countMap) {
      if (wantedTags.every(t => s.has(t))) okSet.add(pid);
    }
    projects = projects.filter(p => okSet.has(p.id));
  }

  if (!projects.length) return res.json([]);

  // --- 単価・見積・全タグ・カテゴリを一括取得（N+1 回避）---
  // ADR 002 後: has_rates は project_estimate_lines の存在で判定する。
  // 旧 project_rates テーブルは Stage 6 で DROP 予定。
  const projectIds = projects.map(p => p.id);
  const [ratesRes, estRes, allTagsRes, catsRes] = await Promise.all([
    supabase.from('project_estimate_lines').select('project_id').in('project_id', projectIds),
    supabase.from('project_estimates').select('project_id').in('project_id', projectIds),
    supabase.from('project_tags').select('project_id, tag').in('project_id', projectIds),
    // creative_categories: 一覧で全カテゴリを引き、JS 側で id → meta 変換。
    // テーブル未作成（Stage A migration 未適用）時は silent skip。
    supabase.from('creative_categories').select('id, code, name, color, render_kind'),
  ]);
  const ratesSet = new Set((ratesRes.data || []).map(r => r.project_id));
  const estSet   = new Set((estRes.data   || []).map(r => r.project_id));
  const tagsMap = new Map(); // project_id -> string[]
  for (const r of (allTagsRes.data || [])) {
    let arr = tagsMap.get(r.project_id);
    if (!arr) { arr = []; tagsMap.set(r.project_id, arr); }
    arr.push(r.tag);
  }
  // タグはアルファベット順で安定化（UI 安定 / chip 並びの一貫性）
  for (const arr of tagsMap.values()) arr.sort((a,b) => a.localeCompare(b));

  // カテゴリ map（テーブル未作成時は空 Map）
  const catMap = new Map();
  if (!catsRes.error) {
    for (const c of (catsRes.data || [])) catMap.set(c.id, c);
  }

  const enriched = projects.map(p => ({
    ...p,
    has_rates: ratesSet.has(p.id),
    has_estimates: estSet.has(p.id),
    tags: tagsMap.get(p.id) || [],
    primary_category: p.primary_category_id ? (catMap.get(p.primary_category_id) || null) : null,
  }));
  res.json(enriched);
});

// 案件タグの候補（既存タグ distinct）。オートコンプリート用。
// 上位 50 件まで返す。使用回数の多い順。
router.get('/projects/tag-suggestions', async (req, res) => {
  const { data, error } = await supabase
    .from('project_tags')
    .select('tag');
  if (error) return res.status(500).json({ error: error.message });
  const counts = new Map();
  for (const r of (data || [])) {
    counts.set(r.tag, (counts.get(r.tag) || 0) + 1);
  }
  const list = Array.from(counts.entries())
    .sort((a,b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 50)
    .map(([tag, count]) => ({ tag, count }));
  res.json(list);
});

// 案件詳細取得
//
// ADR 002 後: project_rates(*) / director_rates(*) を embed していた箇所は
// project_estimate_lines(*, project_estimate_line_costs(*, role:roles(code,label))) に置換。
// クライアント側はこのレスポンスから単価モーダル等の表示を構築する。
router.get('/projects/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('projects')
    .select(`
      *,
      clients(id, name),
      producer:users!projects_producer_id_fkey(id, full_name),
      director:users!projects_director_id_fkey(id, full_name),
      project_estimate_lines(
        id, project_id, category_id, name, planned_count, client_unit_price,
        sort_order, status, status_changed_at, currency, tax_included, created_at,
        project_estimate_line_costs(
          id, line_id, role_id, user_id, unit_price, currency,
          pricing_type, percentage, actual_hours, created_at,
          role:roles(id, code, label)
        )
      )
    `)
    .eq('id', req.params.id)
    .single();
  if (error) return res.status(500).json({ error: error.message });

  // primary_category 情報を別クエリで補完（FK join に依存しないフォールバック）
  let primary_category = null;
  if (data?.primary_category_id) {
    const catRes = await supabase
      .from('creative_categories')
      .select('id, code, name, color, render_kind')
      .eq('id', data.primary_category_id)
      .maybeSingle();
    if (!catRes.error) primary_category = catRes.data || null;
  }
  res.json({ ...(data || {}), primary_category });
});

// タグ配列を正規化: 文字列化 → trim → 空除去 → 重複除去 → 長さ上限 32
function normalizeTags(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of input) {
    if (typeof raw !== 'string') continue;
    const t = raw.trim().slice(0, 32);
    if (!t) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

// 案件のタグを差分適用（delete-all → bulk insert のシンプル方式）。
// project_tags テーブル未デプロイ時は silent skip（schema-sync 失敗の保険）。
async function replaceProjectTags(projectId, tags) {
  if (!projectId) return { error: null };
  const list = Array.isArray(tags) ? tags : [];
  // delete 全件
  const delRes = await supabase.from('project_tags').delete().eq('project_id', projectId);
  if (delRes.error) {
    if (/project_tags/i.test(delRes.error.message || '') && /does not exist|relation/i.test(delRes.error.message || '')) {
      return { error: null }; // 本番未適用時のフォールバック
    }
    return { error: delRes.error };
  }
  if (!list.length) return { error: null };
  const rows = list.map(tag => ({ project_id: projectId, tag }));
  const insRes = await supabase.from('project_tags').insert(rows);
  if (insRes.error) {
    if (/project_tags/i.test(insRes.error.message || '') && /does not exist|relation/i.test(insRes.error.message || '')) {
      return { error: null };
    }
    return { error: insRes.error };
  }
  return { error: null };
}

// 案件作成
router.post('/projects', requireAuth, requirePermission('project.create_edit'), async (req, res) => {
  const {
    client_id, name, status, producer_id, director_id,
    sheet_url, regulation_url, admin_note, start_date, end_date,
    chatwork_room_id,
    slack_channel_url,
    deadline_unit, deadline_weekday,
    primary_category_id,
    sub_director_ids,
    tags,
    filename_template_id, filename_token_overrides
  } = req.body;
  if (!client_id || !name) return res.status(400).json({ error: 'クライアントと案件名は必須です' });
  const normalizedTags = normalizeTags(tags);
  // サブディレクター: 形式チェック + ユーザー存在/有効チェック（チーム制約は撤廃）
  const { ids: subIds } = await normalizeSubDirectorIds(sub_director_ids, {
    clientId: client_id,
    directorId: director_id || null,
  });
  const insertPayload = {
    client_id, name,
    status: status || '提案中',
    producer_id: producer_id || null,
    director_id: director_id || null,
    sheet_url: sheet_url || null,
    regulation_url: regulation_url || null,
    admin_note: admin_note || null,
    start_date: start_date || null,
    end_date: end_date || null,
    chatwork_room_id: chatwork_room_id || null,
    slack_channel_url: slack_channel_url || null,
    is_hidden: false,
    deadline_unit: deadline_unit || 'monthly',
    deadline_weekday: deadline_weekday ?? null,
    primary_category_id: primary_category_id || null,
    sub_director_ids: subIds,
  };
  // ADR 007: ファイル名テンプレ（明示時のみ反映。未指定なら DB default が使われる）
  if (filename_template_id !== undefined && filename_template_id !== null && filename_template_id !== '') {
    insertPayload.filename_template_id = filename_template_id;
  }
  if (filename_token_overrides !== undefined) {
    insertPayload.filename_token_overrides = filename_token_overrides && typeof filename_token_overrides === 'object'
      ? filename_token_overrides
      : {};
  }
  let { data, error } = await supabase
    .from('projects')
    .insert(insertPayload)
    .select()
    .single();
  // schema-sync 失敗で sub_director_ids 列が本番にまだ無い場合のフォールバック
  if (error && /sub_director_ids/i.test(error.message || '')) {
    const { sub_director_ids: _omit, ...fallback } = insertPayload;
    const retry = await supabase.from('projects').insert(fallback).select().single();
    data = retry.data; error = retry.error;
  }
  // schema-sync 失敗で primary_category_id 列がまだ無い場合のフォールバック（Stage A migration 未適用）
  if (error && /primary_category_id/i.test(error.message || '')) {
    const { primary_category_id: _omit2, ...fallback2 } = insertPayload;
    const retry2 = await supabase.from('projects').insert(fallback2).select().single();
    data = retry2.data; error = retry2.error;
  }
  // ADR 007 Stage 1 migration 未適用ガード
  if (error && /filename_template_id|filename_token_overrides/i.test(error.message || '')) {
    const { filename_template_id: _o3a, filename_token_overrides: _o3b, ...fallback3 } = insertPayload;
    const retry3 = await supabase.from('projects').insert(fallback3).select().single();
    data = retry3.data; error = retry3.error;
  }
  if (error) return res.status(500).json({ error: error.message });
  // タグ保存（delete-all → insert）。本番テーブル未適用時は silent skip。
  if (data?.id) {
    const tagRes = await replaceProjectTags(data.id, normalizedTags);
    if (tagRes.error) return res.status(500).json({ error: tagRes.error.message });
  }
  res.json({ ...(data || {}), tags: normalizedTags });
});

// 案件更新
router.put('/projects/:id', requireAuth, requirePermission('project.create_edit'), async (req, res) => {
  const {
    name, status, producer_id, director_id,
    sheet_url, regulation_url, admin_note, start_date, end_date,
    chatwork_room_id, is_hidden,
    slack_channel_url,
    sync_products, sync_appeal_axes,
    deadline_unit, deadline_weekday,
    primary_category_id,
    sub_director_ids,
    tags,
    filename_template_id, filename_token_overrides,
    scheduled_start_date, active_phase_template_id,
    // ADR 008 Phase 1: クリエイティブ管理シート同期先 URL
    creatives_export_sheet_url,
    // ADR 008 Phase 4: ファイル名連番カスタマイズ
    next_filename_serial, serial_digits
  } = req.body;
  // ADR 010 Phase 1b: 工程表セクションだけが値を送る部分更新（schedule 列のみ）
  // のときは name/status を強制 NULL 化してしまわないよう、最小 UPDATE で済ませる
  {
    const _scheduleOnlyKeys = ['scheduled_start_date', 'active_phase_template_id'];
    const _bodyKeys = Object.keys(req.body || {});
    const isPartialScheduleOnly =
      _bodyKeys.length > 0 &&
      _bodyKeys.every(k => _scheduleOnlyKeys.includes(k));
    if (isPartialScheduleOnly) {
      const partial = { updated_at: new Date().toISOString() };
      if (Object.prototype.hasOwnProperty.call(req.body, 'scheduled_start_date')) {
        partial.scheduled_start_date = scheduled_start_date || null;
      }
      if (Object.prototype.hasOwnProperty.call(req.body, 'active_phase_template_id')) {
        partial.active_phase_template_id = active_phase_template_id || null;
      }
      const { data: pdata, error: perror } = await supabase
        .from('projects')
        .update(partial)
        .eq('id', req.params.id)
        .select()
        .single();
      if (perror) {
        if (/column .+ does not exist/i.test(perror.message || '')) {
          console.warn('[projects PUT partial schedule] 列未適用:', perror.message);
          return res.status(400).json({ error: 'projects.scheduled_start_date / active_phase_template_id 列が未適用です' });
        }
        return res.status(500).json({ error: perror.message });
      }
      return res.json(pdata);
    }
  }
  const updateData = {
    name, status,
    producer_id: producer_id || null,
    director_id: director_id || null,
    sheet_url: sheet_url || null,
    regulation_url: regulation_url || null,
    admin_note: admin_note || null,
    start_date: start_date || null,
    end_date: end_date || null,
    chatwork_room_id: chatwork_room_id || null,
    slack_channel_url: slack_channel_url || null,
    is_hidden: is_hidden ?? false,
    updated_at: new Date().toISOString(),
    deadline_unit: deadline_unit || 'monthly',
    deadline_weekday: deadline_weekday ?? null
  };
  if (sync_products !== undefined) updateData.sync_products = sync_products;
  if (sync_appeal_axes !== undefined) updateData.sync_appeal_axes = sync_appeal_axes;
  // ADR 010 Phase 1b: 工程表の開始日 / 適用テンプレ（明示時のみ反映）
  if (scheduled_start_date !== undefined) updateData.scheduled_start_date = scheduled_start_date || null;
  if (active_phase_template_id !== undefined) updateData.active_phase_template_id = active_phase_template_id || null;
  // ADR 007: ファイル名テンプレ選択 + custom トークン上書き（部分更新で巻き込み消失しないよう、明示時のみ反映）
  if (filename_template_id !== undefined) {
    updateData.filename_template_id = filename_template_id || null;
  }
  if (filename_token_overrides !== undefined) {
    // 受け取った値をそのまま JSONB として保存（{} 等を含めても問題なし）
    updateData.filename_token_overrides = filename_token_overrides && typeof filename_token_overrides === 'object'
      ? filename_token_overrides
      : {};
  }
  // ADR 008 Phase 4: 次のファイル名連番（任意上書き） / 連番桁数
  if (next_filename_serial !== undefined) {
    const n = Number(next_filename_serial);
    if (Number.isFinite(n) && n >= 1 && n <= 1_000_000) {
      updateData.next_filename_serial = Math.floor(n);
    }
  }
  if (serial_digits !== undefined) {
    const d = Number(serial_digits);
    if (Number.isInteger(d) && d >= 1 && d <= 10) {
      updateData.serial_digits = d;
    }
  }
  // primary_category_id: 明示的に渡された時のみ反映（部分更新で巻き込み消失しないよう）。
  if (primary_category_id !== undefined) {
    updateData.primary_category_id = primary_category_id || null;
  }
  // ADR 008 Phase 1: クリエイティブ管理シート同期先 URL（明示時のみ反映）
  if (creatives_export_sheet_url !== undefined) {
    updateData.creatives_export_sheet_url = creatives_export_sheet_url || null;
  }
  // サブディレクター: 部分更新リクエスト（is_hidden だけ送る等）に影響を与えないよう
  // フィールドが渡ってきた時のみ正規化して反映する。
  if (sub_director_ids !== undefined) {
    // client_id は projects 側を引いて取得（クライアント変更は別経路では起きないが念のため）
    const { data: cur } = await supabase
      .from('projects')
      .select('client_id, director_id')
      .eq('id', req.params.id)
      .single();
    const effectiveDirectorId = (director_id !== undefined ? director_id : cur?.director_id) || null;
    const { ids: subIds } = await normalizeSubDirectorIds(sub_director_ids, {
      clientId: cur?.client_id || null,
      directorId: effectiveDirectorId,
    });
    updateData.sub_director_ids = subIds;
  }
  let { data, error } = await supabase
    .from('projects')
    .update(updateData)
    .eq('id', req.params.id)
    .select()
    .single();
  // schema-sync 失敗で sub_director_ids 列が本番にまだ無い場合のフォールバック
  if (error && /sub_director_ids/i.test(error.message || '') && updateData.sub_director_ids !== undefined) {
    const { sub_director_ids: _omit, ...fallback } = updateData;
    const retry = await supabase.from('projects').update(fallback).eq('id', req.params.id).select().single();
    data = retry.data; error = retry.error;
  }
  // schema-sync 失敗で primary_category_id 列がまだ無い場合のフォールバック（Stage A migration 未適用）
  if (error && /primary_category_id/i.test(error.message || '') && updateData.primary_category_id !== undefined) {
    const { primary_category_id: _omit2, ...fallback2 } = updateData;
    const retry2 = await supabase.from('projects').update(fallback2).eq('id', req.params.id).select().single();
    data = retry2.data; error = retry2.error;
  }
  // ADR 007 Stage 1 migration 未適用ガード
  if (error && /filename_template_id|filename_token_overrides/i.test(error.message || '')) {
    const { filename_template_id: _o3a, filename_token_overrides: _o3b, ...fallback3 } = updateData;
    const retry3 = await supabase.from('projects').update(fallback3).eq('id', req.params.id).select().single();
    data = retry3.data; error = retry3.error;
  }
  // ADR 008 Phase 1 migration 未適用ガード
  if (error && /creatives_export_sheet_url/i.test(error.message || '')) {
    const { creatives_export_sheet_url: _oExp, ...fallbackExp } = updateData;
    const retryExp = await supabase.from('projects').update(fallbackExp).eq('id', req.params.id).select().single();
    data = retryExp.data; error = retryExp.error;
  }
  // ADR 010 Phase 1 migration 未適用ガード（schema-sync 失敗時）
  if (error && /scheduled_start_date|active_phase_template_id/i.test(error.message || '')) {
    const { scheduled_start_date: _o4a, active_phase_template_id: _o4b, ...fallback4 } = updateData;
    const retry4 = await supabase.from('projects').update(fallback4).eq('id', req.params.id).select().single();
    data = retry4.data; error = retry4.error;
  }
  // ADR 008 Phase 4 migration 未適用ガード（schema-sync 失敗時）
  if (error && /next_filename_serial|serial_digits/i.test(error.message || '')) {
    const { next_filename_serial: _o5a, serial_digits: _o5b, ...fallback5 } = updateData;
    const retry5 = await supabase.from('projects').update(fallback5).eq('id', req.params.id).select().single();
    data = retry5.data; error = retry5.error;
  }
  if (error) return res.status(500).json({ error: error.message });

  // タグ更新は tags が明示的に渡されたときのみ実行（部分更新で巻き込み消失しないよう）
  let resolvedTags;
  if (tags !== undefined) {
    const normalizedTags = normalizeTags(tags);
    const tagRes = await replaceProjectTags(req.params.id, normalizedTags);
    if (tagRes.error) return res.status(500).json({ error: tagRes.error.message });
    resolvedTags = normalizedTags;
  }
  res.json(resolvedTags !== undefined ? { ...(data || {}), tags: resolvedTags } : data);
});

// ==================== ADR 008 Phase 1: クリエイティブ管理シート同期 ====================
// 案件単位で creatives + creative_versions を Google Sheets に片方向同期する。
// 同期先 URL が未設定なら system_settings.creatives_export_master_template_url を
// コピーして自動で割り当てる。マッピングは system_settings.creatives_export_mapping_json
// で上書き可能（未設定なら DEFAULT_MAPPING）。
router.post('/projects/:id/sync-sheet', requireAuth, requirePermission('project.create_edit'), async (req, res) => {
  try {
    const { syncToSheet } = require('../utils/sheets-export');
    const result = await syncToSheet(req.params.id, req.user?.id);
    res.json(result);
  } catch (e) {
    console.error('[POST /projects/:id/sync-sheet]', e);
    res.status(500).json({ error: e.message || String(e) });
  }
});

// 案件削除（admin/secretary/producer/PD のみ）
// 紐づく請求書がある場合は安全のためブロック。
// その他の関連データ（クリエイティブ・サイクル・商材・訴求軸・チェックリスト等）は
// FK ON DELETE CASCADE により自動で削除される。
// 監査ログ (project_deletion_logs) に必ず INSERT してから projects を削除する。
// 削除理由は必須（5文字以上推奨／空欄は400）。
router.delete('/projects/:id', requireAuth, requirePermission('project.delete'), async (req, res) => {
  const projectId = req.params.id;
  const reason = (req.body?.reason ?? '').toString().trim();
  if (!reason) {
    return res.status(400).json({ error: '削除理由は必須です' });
  }

  // 請求書の存在チェック (invoices.project_id は CASCADE 無し)
  // 既存ガード: 請求書が紐づいている場合は監査ログも残さず 400 で中断
  const { data: invs, error: invErr } = await supabase
    .from('invoices').select('id').eq('project_id', projectId).limit(1);
  if (invErr) return res.status(500).json({ error: invErr.message });
  if (invs && invs.length > 0) {
    return res.status(400).json({
      error: 'この案件には請求書が紐づいているため削除できません。先に該当する請求書を削除してください。',
    });
  }

  // 対象案件の基本情報（スナップショット用）
  // clients(name) で外部結合してクライアント名スナップショットを取得
  const { data: project, error: projErr } = await supabase
    .from('projects')
    .select('id, name, client_id, clients(name)')
    .eq('id', projectId)
    .maybeSingle();
  if (projErr) return res.status(500).json({ error: projErr.message });
  if (!project) return res.status(404).json({ error: '案件が見つかりません' });

  // 関連クリエイティブ件数（監査ログ用に取得）
  const { count: relCount, error: cntErr } = await supabase
    .from('creatives')
    .select('id', { count: 'exact', head: true })
    .eq('project_id', projectId);
  if (cntErr) return res.status(500).json({ error: cntErr.message });

  // 監査ログ INSERT （削除前に記録）
  const { error: logErr } = await supabase
    .from('project_deletion_logs')
    .insert({
      project_id: project.id,
      project_name: project.name,
      client_id: project.client_id || null,
      client_name: project.clients?.name || null,
      reason,
      deleted_by: req.user?.id || null,
      deleted_by_name: req.user?.full_name || req.user?.email || null,
      related_creatives_count: relCount || 0,
    });
  if (logErr) {
    // 監査ログに残せない場合は削除を中断（誤削除→記録なしを防ぐ）
    return res.status(500).json({ error: '監査ログの記録に失敗したため削除を中止しました: ' + logErr.message });
  }

  // 本体削除
  const { error } = await supabase.from('projects').delete().eq('id', projectId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, related_creatives_count: relCount || 0 });
});

// ==================== 月次サイクル ====================

// サイクル一覧取得
router.get('/projects/:id/cycles', async (req, res) => {
  const { data, error } = await supabase
    .from('project_cycles')
    .select('*')
    .eq('project_id', req.params.id)
    .order('year', { ascending: false })
    .order('month', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// サイクル作成
router.post('/projects/:id/cycles', requireAuth, requirePermission('project.create_edit'), async (req, res) => {
  const { year, month, planned_video_count, planned_design_count, deadline, material_received_date } = req.body;
  if (!year || !month) return res.status(400).json({ error: '年・月は必須です' });
  const { data, error } = await supabase
    .from('project_cycles')
    .insert({
      project_id: req.params.id,
      year, month,
      planned_video_count: planned_video_count || 0,
      planned_design_count: planned_design_count || 0,
      deadline,
      material_received_date
    })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ==================== カテゴリマスタ (Stage A) ====================
// マスタテーブル creative_categories を駆動して、案件・クリエイティブの
// 種別をハードコード分岐ではなくレコード追加だけで増やせるようにする。
//
// 既存の creative_type / RATE_CREATIVE_TYPES は Stage C-3 で削除予定。
// projects.project_type は Stage C-2 でコード参照を削除済み（DB 列は Step 2 で DROP）。
//
// schema-sync 失敗で本番に creative_categories テーブルが無い場合は、
// 200/空配列で安全フォールバックする（読み出し時のみ）。
const isMissingCategoriesTable = (err) =>
  err && /relation .*creative_categories.* does not exist|could not find the table/i.test(err.message || '');

// GET /api/categories
//   一覧取得。?include_inactive=1 で is_active=false も返す。
//   render_kind / color / sort_order / default_status_template_id を含む。
//   sort_order 昇順（同値時は name 昇順）。
router.get('/categories', async (req, res) => {
  const includeInactive = String(req.query.include_inactive || '') === '1';
  let query = supabase
    .from('creative_categories')
    .select('*')
    .order('sort_order', { ascending: true })
    .order('name', { ascending: true });
  if (!includeInactive) query = query.eq('is_active', true);
  const { data, error } = await query;
  if (error) {
    if (isMissingCategoriesTable(error)) {
      console.warn('[categories] creative_categories table missing. Apply migrations/2026-05-05_creative_categories.sql');
      return res.json([]);
    }
    return res.status(500).json({ error: error.message });
  }
  res.json(data || []);
});

// GET /api/categories/:id  単件取得
router.get('/categories/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('creative_categories')
    .select('*')
    .eq('id', req.params.id)
    .maybeSingle();
  if (error) {
    if (isMissingCategoriesTable(error)) return res.json(null);
    return res.status(500).json({ error: error.message });
  }
  res.json(data || null);
});

// POST /api/categories  新規作成（admin/secretary 権限想定）
const ALLOWED_RENDER_KINDS = new Set(['video','image','longpage','iframe','pdf']);
router.post('/categories', requireAuth, requirePermission('master.page'), async (req, res) => {
  const { code, name, render_kind, sort_order, color, is_active } = req.body || {};
  if (!code || !name || !render_kind) {
    return res.status(400).json({ error: 'code / name / render_kind は必須です' });
  }
  if (!ALLOWED_RENDER_KINDS.has(render_kind)) {
    return res.status(400).json({ error: 'render_kind は video/image/longpage/iframe/pdf のいずれかで指定してください' });
  }
  const insert = {
    code: String(code).trim(),
    name: String(name).trim(),
    render_kind,
    sort_order: Number.isFinite(parseInt(sort_order, 10)) ? parseInt(sort_order, 10) : 0,
    color: color || null,
    is_active: is_active === false ? false : true,
  };
  const { data, error } = await supabase
    .from('creative_categories')
    .insert(insert)
    .select()
    .single();
  if (error) {
    if (isMissingCategoriesTable(error)) {
      return res.status(503).json({ error: 'creative_categories テーブルが未作成です。migrations/2026-05-05_creative_categories.sql を本番Supabaseに適用してください。' });
    }
    return res.status(500).json({ error: error.message });
  }
  res.json(data);
});

// PUT /api/categories/:id  更新
router.put('/categories/:id', requireAuth, requirePermission('master.page'), async (req, res) => {
  const { code, name, render_kind, sort_order, color, is_active, default_status_template_id } = req.body || {};
  const update = { updated_at: new Date().toISOString() };
  if (code !== undefined) update.code = String(code).trim();
  if (name !== undefined) update.name = String(name).trim();
  if (render_kind !== undefined) {
    if (!ALLOWED_RENDER_KINDS.has(render_kind)) {
      return res.status(400).json({ error: 'render_kind は video/image/longpage/iframe/pdf のいずれかで指定してください' });
    }
    update.render_kind = render_kind;
  }
  if (sort_order !== undefined) update.sort_order = parseInt(sort_order, 10) || 0;
  if (color !== undefined) update.color = color || null;
  if (is_active !== undefined) update.is_active = !!is_active;
  if (default_status_template_id !== undefined) update.default_status_template_id = default_status_template_id || null;

  const { data, error } = await supabase
    .from('creative_categories')
    .update(update)
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) {
    if (isMissingCategoriesTable(error)) {
      return res.status(503).json({ error: 'creative_categories テーブルが未作成です。migration を適用してください。' });
    }
    return res.status(500).json({ error: error.message });
  }
  res.json(data);
});

// DELETE /api/categories/:id  削除
//   FK でぶら下がる projects.primary_category_id / creatives.category_id がある場合は
//   ON DELETE が SET NULL ではないため、参照中の場合はサーバー側で 409 を返す。
router.delete('/categories/:id', requireAuth, requirePermission('master.page'), async (req, res) => {
  const id = req.params.id;
  // 参照チェック（projects / creatives）
  const [projUseRes, crUseRes] = await Promise.all([
    supabase.from('projects').select('id', { count: 'exact', head: true }).eq('primary_category_id', id),
    supabase.from('creatives').select('id', { count: 'exact', head: true }).eq('category_id', id),
  ]);
  const projUse = projUseRes.count || 0;
  const crUse   = crUseRes.count   || 0;
  if (projUse > 0 || crUse > 0) {
    return res.status(409).json({
      error: `このカテゴリは案件 ${projUse} 件 / クリエイティブ ${crUse} 件 で使用中のため削除できません。先に他カテゴリへ振り替えるか、is_active=false で非表示化してください。`
    });
  }
  const { error } = await supabase.from('creative_categories').delete().eq('id', id);
  if (error) {
    if (isMissingCategoriesTable(error)) {
      return res.status(503).json({ error: 'creative_categories テーブルが未作成です。' });
    }
    return res.status(500).json({ error: error.message });
  }
  res.json({ ok: true });
});

// ==================== creative_category_fields (ADR 012) ====================
// カテゴリ × フィールドの可視性 / 並び順 / ラベル / 必須 / カスタム項目を管理。
// 詳細モーダル（modal-creative-detail）が openCreativeDetail 時にここを引き、
// builtin DOM の visibility と custom フィールドの動的生成を行う。
//
// schema-sync 失敗で本番に creative_category_fields テーブルが無い場合は、
// 200 / 空配列で安全フォールバックする（読み出し時のみ）。
const isMissingCategoryFieldsTable = (err) =>
  err && /relation .*creative_category_fields.* does not exist|could not find the table/i.test(err.message || '');
const isMissingCustomFieldValuesTable = (err) =>
  err && /relation .*creative_custom_field_values.* does not exist|could not find the table/i.test(err.message || '');

// GET /api/categories/:id/fields
//   カテゴリのフィールド設定一覧を返す。sort_order 昇順。
//   フォールバック: テーブル未作成 → builtin の既定値（全部 visible=true）を返す
router.get('/categories/:id/fields', async (req, res) => {
  const cid = req.params.id;
  const { data, error } = await supabase
    .from('creative_category_fields')
    .select('*')
    .eq('category_id', cid)
    .order('sort_order', { ascending: true });
  if (error) {
    if (isMissingCategoryFieldsTable(error)) {
      // フェイルセーフ: builtin 全表示の既定値を返す
      const fallback = BUILTIN_FIELDS.map((key, i) => ({
        category_id: cid,
        field_key: key,
        field_kind: 'builtin',
        visible: true,
        sort_order: (i + 1) * 10,
        label: BUILTIN_FIELD_LABELS[key] || key,
        required: false,
      }));
      return res.json(fallback);
    }
    return res.status(500).json({ error: error.message });
  }
  res.json(data || []);
});

// PUT /api/categories/:id/fields
//   フィールド設定を一括更新（upsert + 削除）。
//   request body: { fields: [ { field_key, field_kind, custom_type, custom_options,
//                               visible, sort_order, label, required } ... ] }
//   送られなかった field_key の行は削除される（custom 削除に使う）。
//   builtin フィールドの行は削除されても、フロントは BUILTIN_FIELDS のフォールバックで描画されるので問題なし。
router.put('/categories/:id/fields', requireAuth, requirePermission('master.page'), async (req, res) => {
  const cid = req.params.id;
  const fields = Array.isArray(req.body?.fields) ? req.body.fields : null;
  if (!fields) {
    return res.status(400).json({ error: 'fields 配列が必要です' });
  }

  // バリデーション
  const seenKeys = new Set();
  for (const f of fields) {
    if (!f.field_key || typeof f.field_key !== 'string') {
      return res.status(400).json({ error: 'field_key は必須です' });
    }
    if (seenKeys.has(f.field_key)) {
      return res.status(400).json({ error: `field_key が重複しています: ${f.field_key}` });
    }
    seenKeys.add(f.field_key);
    const kind = f.field_kind || 'builtin';
    if (kind !== 'builtin' && kind !== 'custom') {
      return res.status(400).json({ error: 'field_kind は builtin または custom' });
    }
    if (kind === 'builtin' && !isBuiltinField(f.field_key)) {
      return res.status(400).json({ error: `builtin フィールドではありません: ${f.field_key}` });
    }
    if (kind === 'custom') {
      if (!isAllowedCustomType(f.custom_type)) {
        return res.status(400).json({ error: `custom_type は text/textarea/url/select` });
      }
      // builtin と同じ field_key は禁止（衝突回避）
      if (isBuiltinField(f.field_key)) {
        return res.status(400).json({ error: `field_key '${f.field_key}' は builtin と衝突します` });
      }
    }
  }

  // 1) 既存行のうち、送られなかった field_key を削除
  const incomingKeys = fields.map(f => f.field_key);
  if (incomingKeys.length > 0) {
    const { error: delErr } = await supabase
      .from('creative_category_fields')
      .delete()
      .eq('category_id', cid)
      .not('field_key', 'in', `(${incomingKeys.map(k => `"${k}"`).join(',')})`);
    if (delErr && !isMissingCategoryFieldsTable(delErr)) {
      return res.status(500).json({ error: delErr.message });
    }
  } else {
    const { error: delErr } = await supabase
      .from('creative_category_fields')
      .delete()
      .eq('category_id', cid);
    if (delErr && !isMissingCategoryFieldsTable(delErr)) {
      return res.status(500).json({ error: delErr.message });
    }
  }

  // 2) upsert（カラム数を絞る）
  const rows = fields.map(f => ({
    category_id:    cid,
    field_key:      f.field_key,
    field_kind:     f.field_kind || 'builtin',
    custom_type:    f.field_kind === 'custom' ? (f.custom_type || null) : null,
    custom_options: f.field_kind === 'custom' ? (f.custom_options || null) : null,
    visible:        f.visible !== false,
    sort_order:     Number.isFinite(parseInt(f.sort_order, 10)) ? parseInt(f.sort_order, 10) : 100,
    label:          (f.label === undefined || f.label === null) ? null : String(f.label),
    required:       !!f.required,
    updated_at:     new Date().toISOString(),
  }));

  if (rows.length === 0) {
    return res.json({ ok: true, fields: [] });
  }

  const { data, error } = await supabase
    .from('creative_category_fields')
    .upsert(rows, { onConflict: 'category_id,field_key' })
    .select();
  if (error) {
    if (isMissingCategoryFieldsTable(error)) {
      return res.status(503).json({ error: 'creative_category_fields テーブルが未作成です。migrations/2026-05-10_creative_category_fields.sql を本番Supabaseに適用してください。' });
    }
    return res.status(500).json({ error: error.message });
  }
  res.json({ ok: true, fields: data || [] });
});

// GET /api/creatives/:id/custom-fields
//   クリエイティブのカスタム値一覧 [{ field_key, value }, ...]
router.get('/creatives/:id/custom-fields', requireAuth, async (req, res) => {
  const cid = req.params.id;
  const { data, error } = await supabase
    .from('creative_custom_field_values')
    .select('field_key, value')
    .eq('creative_id', cid);
  if (error) {
    if (isMissingCustomFieldValuesTable(error)) {
      return res.json([]);
    }
    return res.status(500).json({ error: error.message });
  }
  res.json(data || []);
});

// PUT /api/creatives/:id/custom-fields
//   request body: { values: [ { field_key, value } ... ] }
//   送られなかった field_key の行は削除される。
router.put('/creatives/:id/custom-fields', requireAuth, async (req, res) => {
  const cid = req.params.id;
  const values = Array.isArray(req.body?.values) ? req.body.values : null;
  if (!values) {
    return res.status(400).json({ error: 'values 配列が必要です' });
  }
  // バリデーション
  for (const v of values) {
    if (!v.field_key || typeof v.field_key !== 'string') {
      return res.status(400).json({ error: 'field_key は必須' });
    }
    if (isBuiltinField(v.field_key)) {
      return res.status(400).json({ error: `builtin フィールド '${v.field_key}' は creatives 本体に保存してください（custom-fields ではない）` });
    }
  }

  // 1) 不要になった行を削除
  const incomingKeys = values.map(v => v.field_key);
  if (incomingKeys.length > 0) {
    const { error: delErr } = await supabase
      .from('creative_custom_field_values')
      .delete()
      .eq('creative_id', cid)
      .not('field_key', 'in', `(${incomingKeys.map(k => `"${k}"`).join(',')})`);
    if (delErr && !isMissingCustomFieldValuesTable(delErr)) {
      return res.status(500).json({ error: delErr.message });
    }
  } else {
    const { error: delErr } = await supabase
      .from('creative_custom_field_values')
      .delete()
      .eq('creative_id', cid);
    if (delErr && !isMissingCustomFieldValuesTable(delErr)) {
      return res.status(500).json({ error: delErr.message });
    }
  }

  // 2) upsert
  const rows = values.map(v => ({
    creative_id: cid,
    field_key:   v.field_key,
    value:       (v.value === undefined || v.value === null) ? null : String(v.value),
    updated_at:  new Date().toISOString(),
  }));
  if (rows.length === 0) {
    return res.json({ ok: true, values: [] });
  }
  const { data, error } = await supabase
    .from('creative_custom_field_values')
    .upsert(rows, { onConflict: 'creative_id,field_key' })
    .select('field_key, value');
  if (error) {
    if (isMissingCustomFieldValuesTable(error)) {
      return res.status(503).json({ error: 'creative_custom_field_values テーブルが未作成です。migration を本番に適用してください。' });
    }
    return res.status(500).json({ error: error.message });
  }
  res.json({ ok: true, values: data || [] });
});

// ==================== filename_templates (ADR 007 Stage 1) ====================
// 案件別ファイル名テンプレ。設定タブで管理（CRUD）し、Stage 2 で案件モーダル
// と routes/haruka.js の bulk-preview / bulk / 個別作成からテンプレ参照に
// 切り替える。Stage 1 では「マスタ管理 + 列追加」のみ。
//
// schema-sync 失敗で本番に filename_templates テーブルが無い場合は、
// 200/空配列で安全フォールバックする（読み出し時のみ）。
const isMissingFilenameTemplatesTable = (err) =>
  err && /relation .*filename_templates.* does not exist|could not find the table/i.test(err.message || '');

// flag トークンの source ホワイトリスト（v1 は talent_flag のみ）。
// 増やす際は creatives テーブル側に対応する boolean 列があり、buildFilenameTokenValues / フロントUI も追従する必要あり。
const ALLOWED_FILENAME_FLAG_SOURCES = new Set(['talent_flag']);

// tokens のサーバー側バリデーション（DB CHECK と二重）
//   - 配列で要素が 1 件以上
//   - serial / project_name / version の3キーが含まれる
//   - serial が配列の先頭
//   - 各要素は { kind: "system"|"custom"|"flag", key, ... } の形
//   - flag は { source: ALLOWED_FILENAME_FLAG_SOURCES, on_value: string, off_value: string }
//   - 同一 source の flag トークンは1テンプレに1個まで
function validateFilenameTemplateTokens(tokens) {
  if (!Array.isArray(tokens) || tokens.length === 0) {
    return { ok: false, error: 'tokens は 1 件以上の配列で指定してください' };
  }
  const flagSourcesSeen = new Set();
  for (const t of tokens) {
    if (!t || typeof t !== 'object') {
      return { ok: false, error: 'tokens の各要素はオブジェクトである必要があります' };
    }
    if (t.kind !== 'system' && t.kind !== 'custom' && t.kind !== 'flag') {
      return { ok: false, error: `tokens.kind は "system" / "custom" / "flag" のいずれか（受信: ${t.kind}）` };
    }
    if (typeof t.key !== 'string' || !t.key.trim()) {
      return { ok: false, error: 'tokens.key は必須の文字列です' };
    }
    if (t.kind === 'flag') {
      if (typeof t.source !== 'string' || !ALLOWED_FILENAME_FLAG_SOURCES.has(t.source)) {
        return { ok: false, error: `flag トークンの source は ${[...ALLOWED_FILENAME_FLAG_SOURCES].map(s => `"${s}"`).join(' / ')} のみ対応しています（受信: ${t.source}）` };
      }
      if (typeof t.on_value !== 'string' || typeof t.off_value !== 'string') {
        return { ok: false, error: 'flag トークンには on_value / off_value（文字列）が必須です' };
      }
      if (flagSourcesSeen.has(t.source)) {
        return { ok: false, error: `同一の flag source "${t.source}" を持つトークンは1テンプレに1個までです` };
      }
      flagSourcesSeen.add(t.source);
    }
  }
  const keys = tokens.map(t => t.key);
  // key の重複チェック（custom / flag は自動採番されるが、手動指定時の事故防止）
  const keySet = new Set();
  for (const k of keys) {
    if (keySet.has(k)) {
      return { ok: false, error: `tokens.key "${k}" が重複しています` };
    }
    keySet.add(k);
  }
  for (const required of ['serial', 'project_name', 'version']) {
    if (!keys.includes(required)) {
      return { ok: false, error: `必須トークン "${required}" が含まれていません` };
    }
  }
  if (keys[0] !== 'serial') {
    return { ok: false, error: '"serial" は配列の先頭でなければなりません' };
  }
  return { ok: true };
}

// 区切り文字の許可リスト（UI でも同じ選択肢を出す）
const ALLOWED_FILENAME_SEPARATORS = new Set(['_', '-', '']);

// GET /api/filename-templates  一覧（is_default が先頭、その後 name 昇順）
router.get('/filename-templates', async (_req, res) => {
  const { data, error } = await supabase
    .from('filename_templates')
    .select('*')
    .order('is_default', { ascending: false })
    .order('name', { ascending: true });
  if (error) {
    if (isMissingFilenameTemplatesTable(error)) {
      console.warn('[filename-templates] filename_templates table missing. Apply migrations/2026-05-07_filename_templates.sql');
      return res.json([]);
    }
    return res.status(500).json({ error: error.message });
  }
  res.json(data || []);
});

// GET /api/filename-templates/:id  単件
router.get('/filename-templates/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('filename_templates')
    .select('*')
    .eq('id', req.params.id)
    .maybeSingle();
  if (error) {
    if (isMissingFilenameTemplatesTable(error)) return res.json(null);
    return res.status(500).json({ error: error.message });
  }
  res.json(data || null);
});

// POST /api/filename-templates  新規（admin/secretary 権限想定）
router.post('/filename-templates', requireAuth, requirePermission('master.page'), async (req, res) => {
  const { name, separator, tokens, is_default } = req.body || {};
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'name は必須です' });
  }
  const sep = (separator === undefined || separator === null) ? '_' : String(separator);
  if (!ALLOWED_FILENAME_SEPARATORS.has(sep)) {
    return res.status(400).json({ error: 'separator は "_" / "-" / "" のいずれかで指定してください' });
  }
  const v = validateFilenameTemplateTokens(tokens);
  if (!v.ok) return res.status(400).json({ error: v.error });

  const insert = {
    name: name.trim(),
    separator: sep,
    tokens,
    is_default: !!is_default,
  };
  const { data, error } = await supabase
    .from('filename_templates')
    .insert(insert)
    .select()
    .single();
  if (error) {
    if (isMissingFilenameTemplatesTable(error)) {
      return res.status(503).json({ error: 'filename_templates テーブルが未作成です。migrations/2026-05-07_filename_templates.sql を本番Supabaseに適用してください。' });
    }
    return res.status(500).json({ error: error.message });
  }
  res.json(data);
});

// PUT /api/filename-templates/:id  更新
router.put('/filename-templates/:id', requireAuth, requirePermission('master.page'), async (req, res) => {
  const { name, separator, tokens, is_default } = req.body || {};
  const update = {};
  if (name !== undefined) {
    if (typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'name は空にできません' });
    }
    update.name = name.trim();
  }
  if (separator !== undefined) {
    const sep = String(separator);
    if (!ALLOWED_FILENAME_SEPARATORS.has(sep)) {
      return res.status(400).json({ error: 'separator は "_" / "-" / "" のいずれかで指定してください' });
    }
    update.separator = sep;
  }
  if (tokens !== undefined) {
    const v = validateFilenameTemplateTokens(tokens);
    if (!v.ok) return res.status(400).json({ error: v.error });
    update.tokens = tokens;
  }
  if (is_default !== undefined) update.is_default = !!is_default;
  if (Object.keys(update).length === 0) {
    return res.status(400).json({ error: '更新するフィールドがありません' });
  }
  // updated_at はトリガで自動更新される

  const { data, error } = await supabase
    .from('filename_templates')
    .update(update)
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) {
    if (isMissingFilenameTemplatesTable(error)) {
      return res.status(503).json({ error: 'filename_templates テーブルが未作成です。migration を適用してください。' });
    }
    return res.status(500).json({ error: error.message });
  }
  res.json(data);
});

// DELETE /api/filename-templates/:id
//   - is_default のテンプレは削除不可
//   - projects.filename_template_id で参照中の場合は 409
router.delete('/filename-templates/:id', requireAuth, requirePermission('master.page'), async (req, res) => {
  const id = req.params.id;
  // 自身が default かチェック
  const { data: target, error: getErr } = await supabase
    .from('filename_templates')
    .select('id, is_default, name')
    .eq('id', id)
    .maybeSingle();
  if (getErr) {
    if (isMissingFilenameTemplatesTable(getErr)) {
      return res.status(503).json({ error: 'filename_templates テーブルが未作成です。' });
    }
    return res.status(500).json({ error: getErr.message });
  }
  if (!target) return res.status(404).json({ error: 'テンプレートが見つかりません' });
  if (target.is_default) {
    return res.status(409).json({ error: 'デフォルトテンプレートは削除できません。先に別テンプレを is_default=true に設定してください。' });
  }
  // 参照チェック（projects）
  const { count: usedCount, error: refErr } = await supabase
    .from('projects')
    .select('id', { count: 'exact', head: true })
    .eq('filename_template_id', id);
  if (refErr && !/column .*filename_template_id.* does not exist/i.test(refErr.message || '')) {
    return res.status(500).json({ error: refErr.message });
  }
  if ((usedCount || 0) > 0) {
    return res.status(409).json({
      error: `このテンプレートは案件 ${usedCount} 件で使用中のため削除できません。先に他テンプレへ振り替えてください。`
    });
  }
  const { error } = await supabase.from('filename_templates').delete().eq('id', id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ---- Stage 2: テンプレ解決ヘルパ ----
// project から filename_template_id / filename_token_overrides を読み出し、
// 紐づく filename_templates レコードを返す。テンプレ未設定なら is_default=true を引く。
// 取得失敗時は null を返し、呼び出し側でハードコードフォールバックする。
//
// 戻り値: { template, overrides } | null
async function resolveProjectFilenameTemplate(project) {
  if (!project) return null;
  // schema-sync 失敗で列が無い場合に備え、両方とも optional として扱う
  const overrides = (project.filename_token_overrides && typeof project.filename_token_overrides === 'object')
    ? project.filename_token_overrides
    : {};
  let template = null;
  if (project.filename_template_id) {
    const { data, error } = await supabase
      .from('filename_templates')
      .select('*')
      .eq('id', project.filename_template_id)
      .maybeSingle();
    if (!error && data) template = data;
    if (error && isMissingFilenameTemplatesTable(error)) return null;
  }
  if (!template) {
    const { data, error } = await supabase
      .from('filename_templates')
      .select('*')
      .eq('is_default', true)
      .order('created_at', { ascending: true })
      .limit(1);
    if (error && isMissingFilenameTemplatesTable(error)) return null;
    if (!error && data && data.length) template = data[0];
  }
  if (!template) return null;
  return { template, overrides };
}

// system トークンの値マップを組み立てる（bulk-preview / bulk / generate-filename 共通）
// seqStr7 / dateStr / version / etc. は呼び出し側で計算済みのものを渡す
// flag トークン用に '__flag__<source>': boolean も同じ map に詰める。
//   - bulk-preview / bulk: req.body.talent_flag
//   - 個別 generate-filename: req.body.talent_flag（個別作成は creative 側で持つ）
function buildFilenameTokenValues({ project, appealType, body, seqStr7, dateStr, version }) {
  const productCode = body?.product_code || null;
  const mediaCode   = body?.media_code   || null;
  const fmtCode     = body?.creative_fmt || null;
  const sizeCode    = body?.creative_size || null;
  return {
    serial:       seqStr7 || '',
    project_name: project?.name || '',
    version:      version || '',
    date_yymmdd:  dateStr || '',
    client_code:  project?.clients?.client_code || '',
    product:      productCode || '',
    appeal_axis:  appealType?.code || '',
    size:         sizeCode || '',
    format:       fmtCode || '',
    media:        mediaCode || '',
    // flag 値（v1: talent_flag のみ）
    __flag__talent_flag: !!(body && body.talent_flag === true),
  };
}

// GET /api/status-templates?category_id=...
//   工程テンプレ一覧（指定カテゴリ）。template_items も同梱で返す。
router.get('/status-templates', async (req, res) => {
  const { category_id } = req.query;
  let query = supabase
    .from('creative_status_templates')
    .select('*, items:creative_status_template_items(*)')
    .order('is_default', { ascending: false })
    .order('name', { ascending: true });
  if (category_id) query = query.eq('category_id', category_id);
  const { data, error } = await query;
  if (error) {
    if (isMissingCategoriesTable(error) || /relation .*creative_status_templates.* does not exist/i.test(error.message || '')) {
      return res.json([]);
    }
    return res.status(500).json({ error: error.message });
  }
  // items を sort_order 昇順に整列して返す
  const out = (data || []).map(t => ({
    ...t,
    items: (t.items || []).slice().sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0)),
  }));
  res.json(out);
});

// ==================== 見積行 / 成果物グループ（project_estimate_lines）Stage 4a ====================
// ADR 002 (見積行統合) + ADR 005 (status ライフサイクル) に基づく lines CRUD。
// 旧 rates 系（rates / director-rates / producer-rates / client-fee / rate-extras）の
// 書き込み endpoint と UI は Stage 4d で削除済み、read 経路も Stage 5 (PR #TBD) で
// invoices flow から完全撤去した。残るは Stage 6 での旧テーブル DROP のみ。
//
// 権限: 案件編集と同じ project.create_edit を使う（lines は「成果物グループの構造を
// 編集する」性質のため、案件本体の編集権限と揃える方が直感に合う）。
//
// schema-sync 失敗で本番に project_estimate_lines が無い場合のフォールバックは
// Stage 4a 時点では行わない（PR #316 で適用済み）。

const LINE_STATUSES = new Set([
  'draft', 'estimated', 'contracted', 'in_progress', 'delivered', 'cancelled', 'rejected'
]);

const isMissingPelTable = (err) =>
  err && /relation .*project_estimate_lines.* does not exist|could not find the table/i.test(err.message || '');

// GET /api/projects/:project_id/lines  一覧取得
// embed: creative_categories(code, name) を一緒に返す（フロントで category 表示するため）
router.get('/projects/:project_id/lines', requireAuth, async (req, res) => {
  const projectId = req.params.project_id;
  const { data, error } = await supabase
    .from('project_estimate_lines')
    .select('id, project_id, category_id, name, planned_count, client_unit_price, sort_order, currency, tax_included, status, status_changed_at, created_at, category:creative_categories(id, code, name, color)')
    .eq('project_id', projectId)
    .order('sort_order', { ascending: true, nullsFirst: false })
    .order('created_at', { ascending: true });
  if (error) {
    if (isMissingPelTable(error)) {
      console.warn('[lines] project_estimate_lines table missing. Apply migrations/2026-05-06_estimate_lines_and_fixed_items.sql');
      return res.json([]);
    }
    return res.status(500).json({ error: error.message });
  }
  res.json(data || []);
});

// POST /api/projects/:project_id/lines  新規作成
router.post('/projects/:project_id/lines', requireAuth, requirePermission('project.create_edit'), async (req, res) => {
  const projectId = req.params.project_id;
  const {
    category_id,
    name,
    planned_count,
    client_unit_price,
    status,
    sort_order,
    currency,
    tax_included
  } = req.body || {};

  // バリデーション
  const plannedCount = Math.max(0, parseInt(planned_count, 10) || 0);
  const unitPrice = Math.max(0, parseInt(client_unit_price, 10) || 0);
  const lineStatus = status || 'draft';
  if (!LINE_STATUSES.has(lineStatus)) {
    return res.status(400).json({ error: `status は ${[...LINE_STATUSES].join(' / ')} のいずれかで指定してください` });
  }

  // category_id 存在チェック（指定された場合のみ）
  if (category_id) {
    const { data: cat, error: catErr } = await supabase
      .from('creative_categories')
      .select('id')
      .eq('id', category_id)
      .maybeSingle();
    if (catErr) return res.status(500).json({ error: catErr.message });
    if (!cat) return res.status(400).json({ error: '指定された category_id がマスタに存在しません' });
  }

  // sort_order 自動付番（省略時は既存最大 + 10）
  let resolvedSortOrder = (sort_order === null || sort_order === undefined || sort_order === '')
    ? null
    : parseInt(sort_order, 10);
  if (resolvedSortOrder === null || Number.isNaN(resolvedSortOrder)) {
    const { data: maxRow } = await supabase
      .from('project_estimate_lines')
      .select('sort_order')
      .eq('project_id', projectId)
      .order('sort_order', { ascending: false, nullsFirst: false })
      .limit(1);
    const currentMax = (maxRow && maxRow[0] && Number.isFinite(maxRow[0].sort_order)) ? maxRow[0].sort_order : 0;
    resolvedSortOrder = currentMax + 10;
  }

  const insertRow = {
    project_id: projectId,
    category_id: category_id || null,
    name: (typeof name === 'string' && name.trim()) ? name.trim() : null,
    planned_count: plannedCount,
    client_unit_price: unitPrice,
    sort_order: resolvedSortOrder,
    currency: (typeof currency === 'string' && currency.trim()) ? currency.trim().toUpperCase() : 'JPY',
    tax_included: tax_included === false ? false : true,
    status: lineStatus,
    status_changed_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from('project_estimate_lines')
    .insert(insertRow)
    .select('id, project_id, category_id, name, planned_count, client_unit_price, sort_order, currency, tax_included, status, status_changed_at, created_at, category:creative_categories(id, code, name, color)')
    .single();
  if (error) {
    if (isMissingPelTable(error)) {
      return res.status(503).json({ error: 'project_estimate_lines テーブルが未作成です。migrations/2026-05-06_estimate_lines_and_fixed_items.sql を本番Supabaseに適用してください。' });
    }
    return res.status(500).json({ error: error.message });
  }
  res.json(data);
});

// PUT /api/projects/:project_id/lines/:line_id  部分更新
router.put('/projects/:project_id/lines/:line_id', requireAuth, requirePermission('project.create_edit'), async (req, res) => {
  const { project_id: projectId, line_id: lineId } = req.params;
  const body = req.body || {};

  // 既存 line 取得 + project_id 一致チェック
  const { data: existing, error: getErr } = await supabase
    .from('project_estimate_lines')
    .select('id, project_id, status')
    .eq('id', lineId)
    .maybeSingle();
  if (getErr) return res.status(500).json({ error: getErr.message });
  if (!existing) return res.status(404).json({ error: 'line が見つかりません' });
  if (existing.project_id !== projectId) {
    return res.status(400).json({ error: 'project_id と line_id が一致しません' });
  }

  // 部分更新: 送られたフィールドのみ反映
  const updates = {};
  if (Object.prototype.hasOwnProperty.call(body, 'category_id')) {
    if (body.category_id) {
      const { data: cat, error: catErr } = await supabase
        .from('creative_categories')
        .select('id')
        .eq('id', body.category_id)
        .maybeSingle();
      if (catErr) return res.status(500).json({ error: catErr.message });
      if (!cat) return res.status(400).json({ error: '指定された category_id がマスタに存在しません' });
    }
    updates.category_id = body.category_id || null;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'name')) {
    updates.name = (typeof body.name === 'string' && body.name.trim()) ? body.name.trim() : null;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'planned_count')) {
    updates.planned_count = Math.max(0, parseInt(body.planned_count, 10) || 0);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'client_unit_price')) {
    updates.client_unit_price = Math.max(0, parseInt(body.client_unit_price, 10) || 0);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'sort_order')) {
    const so = parseInt(body.sort_order, 10);
    updates.sort_order = Number.isNaN(so) ? null : so;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'currency')) {
    updates.currency = (typeof body.currency === 'string' && body.currency.trim()) ? body.currency.trim().toUpperCase() : 'JPY';
  }
  if (Object.prototype.hasOwnProperty.call(body, 'tax_included')) {
    updates.tax_included = body.tax_included === false ? false : true;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'status')) {
    if (!LINE_STATUSES.has(body.status)) {
      return res.status(400).json({ error: `status は ${[...LINE_STATUSES].join(' / ')} のいずれかで指定してください` });
    }
    if (body.status !== existing.status) {
      updates.status = body.status;
      updates.status_changed_at = new Date().toISOString();
    }
  }

  if (Object.keys(updates).length === 0) {
    // no-op: 既存をそのまま返す（フロントの fetch 再実行と整合性を保つ）
    const { data: row } = await supabase
      .from('project_estimate_lines')
      .select('id, project_id, category_id, name, planned_count, client_unit_price, sort_order, currency, tax_included, status, status_changed_at, created_at, category:creative_categories(id, code, name, color)')
      .eq('id', lineId)
      .single();
    return res.json(row);
  }

  const { data, error } = await supabase
    .from('project_estimate_lines')
    .update(updates)
    .eq('id', lineId)
    .select('id, project_id, category_id, name, planned_count, client_unit_price, sort_order, currency, tax_included, status, status_changed_at, created_at, category:creative_categories(id, code, name, color)')
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// DELETE /api/projects/:project_id/lines/:line_id  削除
// 紐付く creatives.line_id がある場合は 409 で防ぐ（line_costs は CASCADE で消える）
router.delete('/projects/:project_id/lines/:line_id', requireAuth, requirePermission('project.create_edit'), async (req, res) => {
  const { project_id: projectId, line_id: lineId } = req.params;

  const { data: existing, error: getErr } = await supabase
    .from('project_estimate_lines')
    .select('id, project_id')
    .eq('id', lineId)
    .maybeSingle();
  if (getErr) return res.status(500).json({ error: getErr.message });
  if (!existing) return res.status(404).json({ error: 'line が見つかりません' });
  if (existing.project_id !== projectId) {
    return res.status(400).json({ error: 'project_id と line_id が一致しません' });
  }

  // 紐付く creatives 件数チェック
  const { count: creativeCount, error: cntErr } = await supabase
    .from('creatives')
    .select('id', { count: 'exact', head: true })
    .eq('line_id', lineId);
  if (cntErr) return res.status(500).json({ error: cntErr.message });
  if ((creativeCount || 0) > 0) {
    return res.status(409).json({
      error: `この成果物グループには ${creativeCount} 件のクリエイティブが紐付いているため削除できません。先にクリエイティブを別グループへ移すか削除してください。`,
      creative_count: creativeCount
    });
  }

  const { error: delErr } = await supabase
    .from('project_estimate_lines')
    .delete()
    .eq('id', lineId);
  if (delErr) return res.status(500).json({ error: delErr.message });
  res.json({ ok: true });
});

// PATCH /api/projects/:project_id/lines/reorder  一括並び替え
// body: { ids: [<line_id_1>, <line_id_2>, ...] } の順で sort_order を 10, 20, 30, ... に再付番
router.patch('/projects/:project_id/lines/reorder', requireAuth, requirePermission('project.create_edit'), async (req, res) => {
  const projectId = req.params.project_id;
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter(x => typeof x === 'string' && x) : [];
  if (!ids.length) return res.status(400).json({ error: 'ids 配列が必要です' });

  // 案件内の既存 line を取得して、ids がすべて該当案件のものかバリデーション
  const { data: lines, error: getErr } = await supabase
    .from('project_estimate_lines')
    .select('id, project_id')
    .eq('project_id', projectId);
  if (getErr) return res.status(500).json({ error: getErr.message });
  const validIdSet = new Set((lines || []).map(l => l.id));
  const invalid = ids.find(id => !validIdSet.has(id));
  if (invalid) return res.status(400).json({ error: `line_id ${invalid} はこの案件に属していません` });

  // 1件ずつ update（並び替えは件数少なめのはずなので allow）
  // 大量行が想定されるようになったら upsert か RPC に移行
  const errors = [];
  await Promise.all(ids.map((id, idx) =>
    supabase
      .from('project_estimate_lines')
      .update({ sort_order: (idx + 1) * 10 })
      .eq('id', id)
      .then(({ error }) => { if (error) errors.push(error.message); })
  ));
  if (errors.length) return res.status(500).json({ error: errors.join(' / ') });

  // 更新後の一覧を返す
  const { data: updated, error: refErr } = await supabase
    .from('project_estimate_lines')
    .select('id, project_id, category_id, name, planned_count, client_unit_price, sort_order, currency, tax_included, status, status_changed_at, created_at, category:creative_categories(id, code, name, color)')
    .eq('project_id', projectId)
    .order('sort_order', { ascending: true, nullsFirst: false })
    .order('created_at', { ascending: true });
  if (refErr) return res.status(500).json({ error: refErr.message });
  res.json(updated || []);
});

// ==================== 案件固定費・追加収入（project_fixed_items）Stage 4c ====================
// ADR 006 (案件固定費) に基づく fixed_items CRUD。
// スタジオ/機材/出張/ロケ地代等の本数非依存の費用 (item_type='expense')、
// および別料金収入 (item_type='revenue') を扱う。
//
// 権限: lines と同じ project.create_edit を使う（案件本体の編集権限と統一）。
//
// schema-sync 失敗で本番に project_fixed_items が無い場合のフォールバックは
// PR #316 で適用済みなので Stage 4c 時点では行わない。

const FIXED_ITEM_TYPES = new Set(['expense', 'revenue']);
const FIXED_ITEM_CATEGORIES = new Set(['studio', 'equipment', 'travel', 'location', 'other']);
const FIXED_ITEM_STATUSES = new Set(['planned', 'committed', 'incurred', 'cancelled']);

const isMissingPfiTable = (err) =>
  err && /relation .*project_fixed_items.* does not exist|could not find the table/i.test(err.message || '');

const FIXED_ITEM_SELECT_COLS = 'id, project_id, item_type, category, name, amount, currency, occurred_on, paid_to, paid_to_user_id, status, notes, created_at, created_by';

// GET /api/projects/:project_id/fixed-items  一覧取得
// status != 'cancelled' を優先表示するため status='cancelled' を最後にソート
router.get('/projects/:project_id/fixed-items', requireAuth, async (req, res) => {
  const projectId = req.params.project_id;
  const { data, error } = await supabase
    .from('project_fixed_items')
    .select(FIXED_ITEM_SELECT_COLS)
    .eq('project_id', projectId)
    .order('created_at', { ascending: true });
  if (error) {
    if (isMissingPfiTable(error)) {
      console.warn('[fixed-items] project_fixed_items table missing. Apply migrations/2026-05-06_estimate_lines_and_fixed_items.sql');
      return res.json([]);
    }
    return res.status(500).json({ error: error.message });
  }
  // cancelled を末尾、それ以外は created_at 昇順
  const rows = data || [];
  rows.sort((a, b) => {
    const aCancel = a.status === 'cancelled' ? 1 : 0;
    const bCancel = b.status === 'cancelled' ? 1 : 0;
    if (aCancel !== bCancel) return aCancel - bCancel;
    const aT = a.created_at ? Date.parse(a.created_at) : 0;
    const bT = b.created_at ? Date.parse(b.created_at) : 0;
    return aT - bT;
  });
  res.json(rows);
});

// POST /api/projects/:project_id/fixed-items  新規作成
router.post('/projects/:project_id/fixed-items', requireAuth, requirePermission('project.create_edit'), async (req, res) => {
  const projectId = req.params.project_id;
  const {
    item_type,
    category,
    name,
    amount,
    currency,
    occurred_on,
    paid_to,
    paid_to_user_id,
    status,
    notes
  } = req.body || {};

  // バリデーション
  if (!FIXED_ITEM_TYPES.has(item_type)) {
    return res.status(400).json({ error: `item_type は ${[...FIXED_ITEM_TYPES].join(' / ')} のいずれかで指定してください` });
  }
  const trimmedName = (typeof name === 'string') ? name.trim() : '';
  if (!trimmedName) {
    return res.status(400).json({ error: 'name は必須です' });
  }
  if (category && !FIXED_ITEM_CATEGORIES.has(category)) {
    return res.status(400).json({ error: `category は ${[...FIXED_ITEM_CATEGORIES].join(' / ')} のいずれかで指定してください` });
  }
  const amt = Math.max(0, parseInt(amount, 10) || 0);
  const fiStatus = status || 'planned';
  if (!FIXED_ITEM_STATUSES.has(fiStatus)) {
    return res.status(400).json({ error: `status は ${[...FIXED_ITEM_STATUSES].join(' / ')} のいずれかで指定してください` });
  }

  // paid_to_user_id 存在チェック
  if (paid_to_user_id) {
    const { data: u, error: uErr } = await supabase
      .from('users')
      .select('id')
      .eq('id', paid_to_user_id)
      .maybeSingle();
    if (uErr) return res.status(500).json({ error: uErr.message });
    if (!u) return res.status(400).json({ error: '指定された paid_to_user_id がユーザーに存在しません' });
  }

  // occurred_on 簡易バリデーション (YYYY-MM-DD or null)
  let occurredOn = null;
  if (occurred_on) {
    if (typeof occurred_on === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(occurred_on)) {
      occurredOn = occurred_on;
    } else {
      return res.status(400).json({ error: 'occurred_on は YYYY-MM-DD 形式で指定してください' });
    }
  }

  const insertRow = {
    project_id: projectId,
    item_type,
    category: category || null,
    name: trimmedName,
    amount: amt,
    currency: (typeof currency === 'string' && currency.trim()) ? currency.trim().toUpperCase() : 'JPY',
    occurred_on: occurredOn,
    paid_to: (typeof paid_to === 'string' && paid_to.trim()) ? paid_to.trim() : null,
    paid_to_user_id: paid_to_user_id || null,
    status: fiStatus,
    notes: (typeof notes === 'string' && notes.trim()) ? notes.trim() : null,
    created_by: req.user?.id || null,
  };

  const { data, error } = await supabase
    .from('project_fixed_items')
    .insert(insertRow)
    .select(FIXED_ITEM_SELECT_COLS)
    .single();
  if (error) {
    if (isMissingPfiTable(error)) {
      return res.status(503).json({ error: 'project_fixed_items テーブルが未作成です。migrations/2026-05-06_estimate_lines_and_fixed_items.sql を本番Supabaseに適用してください。' });
    }
    return res.status(500).json({ error: error.message });
  }
  res.json(data);
});

// PUT /api/projects/:project_id/fixed-items/:item_id  部分更新
router.put('/projects/:project_id/fixed-items/:item_id', requireAuth, requirePermission('project.create_edit'), async (req, res) => {
  const { project_id: projectId, item_id: itemId } = req.params;
  const body = req.body || {};

  // 既存行の取得 + project_id 一致チェック
  const { data: existing, error: getErr } = await supabase
    .from('project_fixed_items')
    .select('id, project_id')
    .eq('id', itemId)
    .maybeSingle();
  if (getErr) return res.status(500).json({ error: getErr.message });
  if (!existing) return res.status(404).json({ error: 'fixed_item が見つかりません' });
  if (existing.project_id !== projectId) {
    return res.status(400).json({ error: 'project_id と item_id が一致しません' });
  }

  const updates = {};
  if (Object.prototype.hasOwnProperty.call(body, 'item_type')) {
    if (!FIXED_ITEM_TYPES.has(body.item_type)) {
      return res.status(400).json({ error: `item_type は ${[...FIXED_ITEM_TYPES].join(' / ')} のいずれかで指定してください` });
    }
    updates.item_type = body.item_type;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'category')) {
    if (body.category && !FIXED_ITEM_CATEGORIES.has(body.category)) {
      return res.status(400).json({ error: `category は ${[...FIXED_ITEM_CATEGORIES].join(' / ')} のいずれかで指定してください` });
    }
    updates.category = body.category || null;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'name')) {
    const t = (typeof body.name === 'string') ? body.name.trim() : '';
    if (!t) return res.status(400).json({ error: 'name は空にできません' });
    updates.name = t;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'amount')) {
    updates.amount = Math.max(0, parseInt(body.amount, 10) || 0);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'currency')) {
    updates.currency = (typeof body.currency === 'string' && body.currency.trim()) ? body.currency.trim().toUpperCase() : 'JPY';
  }
  if (Object.prototype.hasOwnProperty.call(body, 'occurred_on')) {
    if (body.occurred_on === null || body.occurred_on === '') {
      updates.occurred_on = null;
    } else if (typeof body.occurred_on === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.occurred_on)) {
      updates.occurred_on = body.occurred_on;
    } else {
      return res.status(400).json({ error: 'occurred_on は YYYY-MM-DD 形式で指定してください' });
    }
  }
  if (Object.prototype.hasOwnProperty.call(body, 'paid_to')) {
    updates.paid_to = (typeof body.paid_to === 'string' && body.paid_to.trim()) ? body.paid_to.trim() : null;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'paid_to_user_id')) {
    if (body.paid_to_user_id) {
      const { data: u, error: uErr } = await supabase
        .from('users')
        .select('id')
        .eq('id', body.paid_to_user_id)
        .maybeSingle();
      if (uErr) return res.status(500).json({ error: uErr.message });
      if (!u) return res.status(400).json({ error: '指定された paid_to_user_id がユーザーに存在しません' });
    }
    updates.paid_to_user_id = body.paid_to_user_id || null;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'status')) {
    if (!FIXED_ITEM_STATUSES.has(body.status)) {
      return res.status(400).json({ error: `status は ${[...FIXED_ITEM_STATUSES].join(' / ')} のいずれかで指定してください` });
    }
    updates.status = body.status;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'notes')) {
    updates.notes = (typeof body.notes === 'string' && body.notes.trim()) ? body.notes.trim() : null;
  }

  if (Object.keys(updates).length === 0) {
    const { data: row } = await supabase
      .from('project_fixed_items')
      .select(FIXED_ITEM_SELECT_COLS)
      .eq('id', itemId)
      .single();
    return res.json(row);
  }

  const { data, error } = await supabase
    .from('project_fixed_items')
    .update(updates)
    .eq('id', itemId)
    .select(FIXED_ITEM_SELECT_COLS)
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// DELETE /api/projects/:project_id/fixed-items/:item_id  物理削除
router.delete('/projects/:project_id/fixed-items/:item_id', requireAuth, requirePermission('project.create_edit'), async (req, res) => {
  const { project_id: projectId, item_id: itemId } = req.params;

  const { data: existing, error: getErr } = await supabase
    .from('project_fixed_items')
    .select('id, project_id')
    .eq('id', itemId)
    .maybeSingle();
  if (getErr) return res.status(500).json({ error: getErr.message });
  if (!existing) return res.status(404).json({ error: 'fixed_item が見つかりません' });
  if (existing.project_id !== projectId) {
    return res.status(400).json({ error: 'project_id と item_id が一致しません' });
  }

  const { error: delErr } = await supabase
    .from('project_fixed_items')
    .delete()
    .eq('id', itemId);
  if (delErr) return res.status(500).json({ error: delErr.message });
  res.json({ ok: true });
});

// ==================== 案件スケジュール / フェーズ・タスク（ADR 010 Phase 1b）====================
// ADR 010 (案件スケジュール / フェーズ・タスク管理) に基づく project_tasks /
// project_phase_templates / project_phase_template_items の API。
//
// migration: migrations/2026-05-09_project_schedule_phase1.sql (本番適用済み PR #413)
// 関連列: projects.scheduled_start_date, projects.active_phase_template_id
//
// 権限: タスクの編集は project.create_edit を使う（案件本体と同じ）。

const TASK_ASSIGNEE_TYPES = new Set(['us', 'client', 'meeting', 'milestone']);
const TASK_PRIORITIES = new Set(['low', 'normal', 'high']);

const isMissingTasksTable = (err) =>
  err && /relation .*project_tasks.* does not exist|could not find the table/i.test(err.message || '');
const isMissingPhaseTemplateTable = (err) =>
  err && /relation .*project_phase_template.* does not exist|could not find the table/i.test(err.message || '');

const TASK_SELECT_COLS = [
  'id, project_id, parent_task_id, is_phase_header, title,',
  'start_date, original_end_date, current_end_date,',
  'assignee_type, assignee_user_id, is_milestone, is_done, done_at,',
  'priority, note, sort_order, template_item_id, created_at, updated_at,',
  'assignee:users!project_tasks_assignee_user_id_fkey(id, full_name, nickname, avatar_url)'
].join(' ');

// GET /api/phase-templates?category_id=:id  カテゴリのアクティブなテンプレ一覧
router.get('/phase-templates', requireAuth, async (req, res) => {
  const { category_id } = req.query;
  let query = supabase
    .from('project_phase_templates')
    .select('id, category_id, name, description, is_default, is_active, created_at, updated_at')
    .eq('is_active', true)
    .order('is_default', { ascending: false })
    .order('name', { ascending: true });
  if (category_id) query = query.eq('category_id', category_id);
  const { data, error } = await query;
  if (error) {
    if (isMissingPhaseTemplateTable(error)) {
      console.warn('[phase-templates] project_phase_templates table missing. Apply migrations/2026-05-09_project_schedule_phase1.sql');
      return res.json([]);
    }
    return res.status(500).json({ error: error.message });
  }
  res.json(data || []);
});

// GET /api/phase-templates/:template_id/items  雛形のタスク項目（sort_order 順）
router.get('/phase-templates/:template_id/items', requireAuth, async (req, res) => {
  const { template_id: templateId } = req.params;
  const { data, error } = await supabase
    .from('project_phase_template_items')
    .select('id, template_id, parent_item_id, is_phase_header, title, default_offset_days_from_start, default_duration_days, default_assignee_type, is_milestone, default_priority, default_note, sort_order')
    .eq('template_id', templateId)
    .order('sort_order', { ascending: true });
  if (error) {
    if (isMissingPhaseTemplateTable(error)) return res.json([]);
    return res.status(500).json({ error: error.message });
  }
  res.json(data || []);
});

// GET /api/projects/:project_id/tasks  案件タスク一覧（sort_order 順）
router.get('/projects/:project_id/tasks', requireAuth, async (req, res) => {
  const projectId = req.params.project_id;
  const { data, error } = await supabase
    .from('project_tasks')
    .select(TASK_SELECT_COLS)
    .eq('project_id', projectId)
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true });
  if (error) {
    if (isMissingTasksTable(error)) {
      console.warn('[tasks] project_tasks table missing. Apply migrations/2026-05-09_project_schedule_phase1.sql');
      return res.json([]);
    }
    return res.status(500).json({ error: error.message });
  }
  res.json(data || []);
});

// 内部ヘルパ: タスク本体のバリデーション（POST/PATCH 共通）
function _validateTaskFields(body, partial = false) {
  const out = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
  if (!partial || has('title')) {
    const t = (typeof body.title === 'string' ? body.title : '').trim();
    if (!t) return { error: 'title は必須です' };
    out.title = t;
  }
  if (has('is_phase_header')) out.is_phase_header = !!body.is_phase_header;
  if (has('parent_task_id')) out.parent_task_id = body.parent_task_id || null;
  if (has('start_date')) out.start_date = body.start_date || null;
  if (has('current_end_date')) out.current_end_date = body.current_end_date || null;
  if (has('original_end_date')) out.original_end_date = body.original_end_date || null;
  if (has('assignee_type')) {
    const at = body.assignee_type || 'us';
    if (!TASK_ASSIGNEE_TYPES.has(at)) {
      return { error: `assignee_type は ${[...TASK_ASSIGNEE_TYPES].join(' / ')} のいずれか` };
    }
    out.assignee_type = at;
  }
  if (has('assignee_user_id')) out.assignee_user_id = body.assignee_user_id || null;
  if (has('is_milestone')) out.is_milestone = !!body.is_milestone;
  if (has('priority')) {
    const pr = body.priority || 'normal';
    if (!TASK_PRIORITIES.has(pr)) {
      return { error: `priority は ${[...TASK_PRIORITIES].join(' / ')} のいずれか` };
    }
    out.priority = pr;
  }
  if (has('note')) out.note = body.note || null;
  if (has('sort_order')) {
    const so = parseInt(body.sort_order, 10);
    if (!Number.isNaN(so)) out.sort_order = so;
  }
  return { values: out };
}

// POST /api/projects/:project_id/tasks  単発追加
router.post('/projects/:project_id/tasks', requireAuth, requirePermission('project.create_edit'), async (req, res) => {
  const projectId = req.params.project_id;
  const v = _validateTaskFields(req.body || {}, false);
  if (v.error) return res.status(400).json({ error: v.error });

  let sortOrder = v.values.sort_order;
  if (sortOrder === undefined || sortOrder === null || Number.isNaN(sortOrder)) {
    const { data: maxRow } = await supabase
      .from('project_tasks')
      .select('sort_order')
      .eq('project_id', projectId)
      .order('sort_order', { ascending: false })
      .limit(1)
      .maybeSingle();
    sortOrder = ((maxRow && maxRow.sort_order) || 0) + 10;
  }

  const insert = {
    project_id: projectId,
    is_phase_header: v.values.is_phase_header || false,
    parent_task_id: v.values.parent_task_id || null,
    title: v.values.title,
    start_date: v.values.start_date || null,
    current_end_date: v.values.current_end_date || null,
    original_end_date: v.values.original_end_date || null,
    assignee_type: v.values.assignee_type || 'us',
    assignee_user_id: v.values.assignee_user_id || null,
    is_milestone: v.values.is_milestone || false,
    priority: v.values.priority || 'normal',
    note: v.values.note || null,
    sort_order: sortOrder,
  };

  const { data, error } = await supabase
    .from('project_tasks')
    .insert(insert)
    .select(TASK_SELECT_COLS)
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

// PATCH /api/projects/:project_id/tasks/reorder  並び替え（一括 UPDATE）
router.patch('/projects/:project_id/tasks/reorder', requireAuth, requirePermission('project.create_edit'), async (req, res) => {
  const projectId = req.params.project_id;
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter(x => typeof x === 'string' && x) : [];
  if (!ids.length) return res.status(400).json({ error: 'ids 配列が必要です' });

  const { data: tasks, error: getErr } = await supabase
    .from('project_tasks')
    .select('id, project_id')
    .eq('project_id', projectId);
  if (getErr) return res.status(500).json({ error: getErr.message });
  const validIds = new Set((tasks || []).map(t => t.id));
  const invalid = ids.find(id => !validIds.has(id));
  if (invalid) return res.status(400).json({ error: `task_id ${invalid} はこの案件に属していません` });

  const errors = [];
  await Promise.all(ids.map((id, idx) =>
    supabase
      .from('project_tasks')
      .update({ sort_order: (idx + 1) * 10, updated_at: new Date().toISOString() })
      .eq('id', id)
      .then(({ error }) => { if (error) errors.push(error.message); })
  ));
  if (errors.length) return res.status(500).json({ error: errors.join(' / ') });
  res.json({ ok: true });
});

// PATCH /api/projects/:project_id/tasks/:task_id  インライン編集
// is_done を true に変える時 done_at を now() に、false に戻す時 NULL に。
// current_end_date 変更時、original_end_date が NULL なら現在値を保存。
router.patch('/projects/:project_id/tasks/:task_id', requireAuth, requirePermission('project.create_edit'), async (req, res) => {
  const { project_id: projectId, task_id: taskId } = req.params;

  const { data: existing, error: getErr } = await supabase
    .from('project_tasks')
    .select('id, project_id, current_end_date, original_end_date, is_done')
    .eq('id', taskId)
    .maybeSingle();
  if (getErr) return res.status(500).json({ error: getErr.message });
  if (!existing) return res.status(404).json({ error: 'task が見つかりません' });
  if (existing.project_id !== projectId) {
    return res.status(400).json({ error: 'project_id と task_id が一致しません' });
  }

  const v = _validateTaskFields(req.body || {}, true);
  if (v.error) return res.status(400).json({ error: v.error });

  const update = { ...v.values, updated_at: new Date().toISOString() };

  const body = req.body || {};
  if (Object.prototype.hasOwnProperty.call(body, 'is_done')) {
    const newDone = !!body.is_done;
    update.is_done = newDone;
    if (newDone && !existing.is_done) {
      update.done_at = new Date().toISOString();
    } else if (!newDone && existing.is_done) {
      update.done_at = null;
    }
  }

  if (Object.prototype.hasOwnProperty.call(body, 'current_end_date')) {
    const newCurr = body.current_end_date || null;
    const prevCurr = existing.current_end_date || null;
    if (prevCurr && newCurr !== prevCurr && !existing.original_end_date) {
      if (!Object.prototype.hasOwnProperty.call(body, 'original_end_date')) {
        update.original_end_date = prevCurr;
      }
    }
  }

  const { data, error } = await supabase
    .from('project_tasks')
    .update(update)
    .eq('id', taskId)
    .select(TASK_SELECT_COLS)
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// DELETE /api/projects/:project_id/tasks/:task_id  削除（CASCADE で子も消える）
router.delete('/projects/:project_id/tasks/:task_id', requireAuth, requirePermission('project.create_edit'), async (req, res) => {
  const { project_id: projectId, task_id: taskId } = req.params;
  const { data: existing, error: getErr } = await supabase
    .from('project_tasks')
    .select('id, project_id')
    .eq('id', taskId)
    .maybeSingle();
  if (getErr) return res.status(500).json({ error: getErr.message });
  if (!existing) return res.status(404).json({ error: 'task が見つかりません' });
  if (existing.project_id !== projectId) {
    return res.status(400).json({ error: 'project_id と task_id が一致しません' });
  }
  const { error: delErr } = await supabase
    .from('project_tasks')
    .delete()
    .eq('id', taskId);
  if (delErr) return res.status(500).json({ error: delErr.message });
  res.json({ ok: true });
});

// POST /api/projects/:project_id/tasks/from-template  テンプレからタスク一括生成
// body: { template_id, start_date }
// 既存タスクは温存（追記モード）。一括 INSERT で N+1 を回避。
router.post('/projects/:project_id/tasks/from-template', requireAuth, requirePermission('project.create_edit'), async (req, res) => {
  const projectId = req.params.project_id;
  const { template_id: templateId, start_date: startDate } = req.body || {};
  if (!templateId) return res.status(400).json({ error: 'template_id が必要です' });

  const { data: items, error: itemsErr } = await supabase
    .from('project_phase_template_items')
    .select('id, template_id, parent_item_id, is_phase_header, title, default_offset_days_from_start, default_duration_days, default_assignee_type, is_milestone, default_priority, default_note, sort_order')
    .eq('template_id', templateId)
    .order('sort_order', { ascending: true });
  if (itemsErr) return res.status(500).json({ error: itemsErr.message });
  if (!items || items.length === 0) {
    return res.status(404).json({ error: 'テンプレが見つからないか、items が空です' });
  }

  const { data: maxRow } = await supabase
    .from('project_tasks')
    .select('sort_order')
    .eq('project_id', projectId)
    .order('sort_order', { ascending: false })
    .limit(1)
    .maybeSingle();
  const baseSort = ((maxRow && maxRow.sort_order) || 0);

  const computeDate = (offsetDays) => {
    if (!startDate || offsetDays === null || offsetDays === undefined) return null;
    const d = new Date(startDate + 'T00:00:00');
    if (Number.isNaN(d.getTime())) return null;
    d.setDate(d.getDate() + Number(offsetDays));
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };

  const rows = items.map((it, idx) => {
    const offset = it.default_offset_days_from_start;
    const duration = it.default_duration_days;
    const sStart = computeDate(offset);
    const sEnd = (sStart && duration !== null && duration !== undefined)
      ? computeDate(Number(offset || 0) + Number(duration || 0))
      : sStart;
    return {
      project_id: projectId,
      parent_task_id: null,
      is_phase_header: !!it.is_phase_header,
      title: it.title,
      start_date: sStart,
      current_end_date: sEnd,
      original_end_date: null,
      assignee_type: it.default_assignee_type || 'us',
      is_milestone: !!it.is_milestone,
      priority: it.default_priority || 'normal',
      note: it.default_note || null,
      sort_order: baseSort + (idx + 1) * 10,
      template_item_id: it.id,
    };
  });

  // 一括 INSERT（PostgREST は配列 INSERT に対応 / N+1 解消）
  const { data: inserted, error: insErr } = await supabase
    .from('project_tasks')
    .insert(rows)
    .select('id, template_item_id');
  if (insErr) return res.status(500).json({ error: insErr.message });

  const itemIdToTaskId = new Map();
  (inserted || []).forEach(r => {
    if (r.template_item_id) itemIdToTaskId.set(r.template_item_id, r.id);
  });

  const childUpdates = items
    .filter(it => it.parent_item_id)
    .map(it => ({
      taskId: itemIdToTaskId.get(it.id),
      parentTaskId: itemIdToTaskId.get(it.parent_item_id),
    }))
    .filter(x => x.taskId && x.parentTaskId);

  if (childUpdates.length) {
    const errs = [];
    await Promise.all(childUpdates.map(({ taskId, parentTaskId }) =>
      supabase
        .from('project_tasks')
        .update({ parent_task_id: parentTaskId, updated_at: new Date().toISOString() })
        .eq('id', taskId)
        .then(({ error }) => { if (error) errs.push(error.message); })
    ));
    if (errs.length) return res.status(500).json({ error: errs.join(' / ') });
  }

  const projectUpdate = { active_phase_template_id: templateId };
  if (startDate) projectUpdate.scheduled_start_date = startDate;
  const { error: projUpdErr } = await supabase
    .from('projects')
    .update(projectUpdate)
    .eq('id', projectId);
  if (projUpdErr) {
    if (/column .+ does not exist/i.test(projUpdErr.message || '')) {
      console.warn('[tasks/from-template] projects 列未適用。タスク生成は成功。', projUpdErr.message);
    } else {
      console.warn('[tasks/from-template] project update failed:', projUpdErr.message);
    }
  }

  res.status(201).json({ ok: true, inserted_count: rows.length });
});

// GET /api/projects/schedule-overview  全案件マイルストーンガント用集計（L2）
// 各案件の id, name, primary_category_id, scheduled_start_date, milestones[], min/max date
// query: status (default 'in_progress'), category (csv, code)
router.get('/projects/schedule-overview', requireAuth, async (req, res) => {
  const statusParam = (req.query.status || 'in_progress').toString();
  let projQuery = supabase
    .from('projects')
    .select('id, name, status, client_id, primary_category_id, scheduled_start_date, active_phase_template_id, is_hidden')
    .eq('is_hidden', false);
  if (statusParam !== 'all') {
    projQuery = projQuery.eq('status', '進行中');
  }
  const { data: projects, error: projErr } = await projQuery;
  if (projErr) {
    if (/column .+ does not exist/i.test(projErr.message || '')) {
      console.warn('[schedule-overview] projects 列未適用:', projErr.message);
      return res.json([]);
    }
    return res.status(500).json({ error: projErr.message });
  }

  let projs = projects || [];

  const categoryParam = req.query.category;
  if (categoryParam) {
    const codes = String(categoryParam).split(',').map(s => s.trim()).filter(Boolean);
    if (codes.length) {
      const { data: cats } = await supabase
        .from('creative_categories')
        .select('id, code')
        .in('code', codes);
      const allowedIds = new Set((cats || []).map(c => c.id));
      projs = projs.filter(p => allowedIds.has(p.primary_category_id));
    }
  }

  if (projs.length === 0) return res.json([]);

  // 全案件のタスクを 1 クエリで取得（N+1 解消）
  const projectIds = projs.map(p => p.id);
  const { data: tasks, error: tasksErr } = await supabase
    .from('project_tasks')
    .select('id, project_id, title, current_end_date, original_end_date, start_date, is_milestone, is_done, sort_order')
    .in('project_id', projectIds)
    .order('sort_order', { ascending: true });
  if (tasksErr) {
    if (isMissingTasksTable(tasksErr)) {
      return res.json(projs.map(p => ({ ...p, milestones: [], min_date: null, max_date: null, task_count: 0 })));
    }
    return res.status(500).json({ error: tasksErr.message });
  }

  const byProject = new Map();
  (tasks || []).forEach(t => {
    if (!byProject.has(t.project_id)) byProject.set(t.project_id, []);
    byProject.get(t.project_id).push(t);
  });

  const out = projs.map(p => {
    const ts = byProject.get(p.id) || [];
    const milestones = ts
      .filter(t => t.is_milestone && t.current_end_date)
      .map(t => ({
        id: t.id,
        title: t.title,
        current_end_date: t.current_end_date,
        original_end_date: t.original_end_date,
        is_done: t.is_done,
      }))
      .sort((a, b) => String(a.current_end_date).localeCompare(String(b.current_end_date)));

    const dates = [];
    ts.forEach(t => {
      if (t.start_date) dates.push(t.start_date);
      if (t.current_end_date) dates.push(t.current_end_date);
    });
    if (p.scheduled_start_date) dates.push(p.scheduled_start_date);
    dates.sort();
    const minDate = dates[0] || null;
    const maxDate = dates[dates.length - 1] || null;

    return {
      id: p.id,
      name: p.name,
      status: p.status,
      primary_category_id: p.primary_category_id,
      scheduled_start_date: p.scheduled_start_date,
      milestones,
      min_date: minDate,
      max_date: maxDate,
      task_count: ts.length,
    };
  });

  res.json(out);
});

// ==================== 案件スケジュール Phase 2 — ダッシュボード / マイタスク ====================
// ADR 010 Phase 2: L3「今週の山場」 / L4「マイタスク」用の集約 API。
// 既存の project_tasks インデックス（idx_project_tasks_milestone /
// idx_project_tasks_assignee_due）を活用し、N+1 を避けるため projects は 1 回だけ JOIN する。

// 共通ユーティリティ: YYYY-MM-DD の現地日付を返す（タイムゾーンずれ防止のため Asia/Tokyo 固定）。
function _todayStrJST() {
  const now = new Date();
  // toLocaleDateString("sv-SE") は "YYYY-MM-DD" 形式
  return now.toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
}

// 今週日曜日(その日の終わり)の YYYY-MM-DD を返す。週開始は月曜とし「今週」=「月〜日」。
function _thisSundayStrJST() {
  const todayStr = _todayStrJST();
  const today = new Date(`${todayStr}T00:00:00+09:00`);
  // getDay(): 0=Sun, 1=Mon, ... 6=Sat
  const dow = today.getDay();
  // 月曜起点: dow が日曜(0)なら今日が日曜＝当日、それ以外は (7 - dow) 日後
  const daysUntilSun = dow === 0 ? 0 : (7 - dow);
  const sun = new Date(today);
  sun.setDate(sun.getDate() + daysUntilSun);
  return sun.toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
}

// GET /api/dashboard/upcoming-milestones?days=14
// 今日〜+days 日の未完了マイルストーン + 遅延中マイルストーンを返す（全案件、経営視点）
router.get('/dashboard/upcoming-milestones', requireAuth, async (req, res) => {
  const daysParam = parseInt(req.query.days, 10);
  const days = Number.isFinite(daysParam) && daysParam > 0 && daysParam <= 90 ? daysParam : 14;

  const todayStr = _todayStrJST();
  const horizon = new Date(`${todayStr}T00:00:00+09:00`);
  horizon.setDate(horizon.getDate() + days);
  const horizonStr = horizon.toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });

  // 直近マイルストーン: today <= current_end_date <= today+days, NOT is_done, is_milestone
  const { data: upcomingTasks, error: upErr } = await supabase
    .from('project_tasks')
    .select('id, project_id, title, current_end_date, original_end_date, is_milestone, is_done, assignee_type, project:projects(id, name, is_hidden)')
    .eq('is_milestone', true)
    .eq('is_done', false)
    .gte('current_end_date', todayStr)
    .lte('current_end_date', horizonStr)
    .order('current_end_date', { ascending: true });
  if (upErr) {
    if (isMissingTasksTable(upErr)) {
      return res.json({ upcoming: [], overdue: [] });
    }
    return res.status(500).json({ error: upErr.message });
  }

  // 遅延中: current_end_date < today, NOT is_done, is_milestone
  const { data: overdueTasks, error: ovErr } = await supabase
    .from('project_tasks')
    .select('id, project_id, title, current_end_date, original_end_date, is_milestone, is_done, assignee_type, project:projects(id, name, is_hidden)')
    .eq('is_milestone', true)
    .eq('is_done', false)
    .lt('current_end_date', todayStr)
    .not('current_end_date', 'is', null)
    .order('current_end_date', { ascending: true });
  if (ovErr) {
    if (isMissingTasksTable(ovErr)) {
      return res.json({ upcoming: [], overdue: [] });
    }
    return res.status(500).json({ error: ovErr.message });
  }

  const shapeRow = (t, isOverdue) => ({
    task_id: t.id,
    project_id: t.project_id,
    project_name: t.project?.name || '',
    title: t.title,
    current_end_date: t.current_end_date,
    original_end_date: t.original_end_date,
    is_overdue: isOverdue,
    is_milestone: true,
    assignee_type: t.assignee_type,
  });

  // 非表示案件（is_hidden=true）は除外
  const upcoming = (upcomingTasks || [])
    .filter(t => t.project && !t.project.is_hidden)
    .map(t => shapeRow(t, false));
  const overdue = (overdueTasks || [])
    .filter(t => t.project && !t.project.is_hidden)
    .map(t => shapeRow(t, true));

  res.json({ upcoming, overdue });
});

// 内部ヘルパ: 自分のタスクを取得（my-tasks / my-tasks/count で共有）
async function _fetchMyOpenTasks(userId) {
  const { data, error } = await supabase
    .from('project_tasks')
    .select('id, project_id, title, current_end_date, original_end_date, assignee_type, is_milestone, is_done, sort_order, project:projects(id, name, is_hidden)')
    .eq('assignee_user_id', userId)
    .eq('is_done', false)
    .order('current_end_date', { ascending: true, nullsFirst: false });
  if (error) {
    if (isMissingTasksTable(error)) return { tasks: [] };
    return { error };
  }
  // 非表示案件は除外
  const tasks = (data || []).filter(t => t.project && !t.project.is_hidden);
  return { tasks };
}

// GET /api/my-tasks  認証ユーザー自身のタスクを 3 区分（today/thisWeek/later）で返す
router.get('/my-tasks', requireAuth, async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: '認証が必要です' });

  const { tasks, error } = await _fetchMyOpenTasks(userId);
  if (error) return res.status(500).json({ error: error.message });

  const todayStr = _todayStrJST();
  const sundayStr = _thisSundayStrJST();

  const today = [];
  const thisWeek = [];
  const later = [];

  const shape = (t) => ({
    task_id: t.id,
    project_id: t.project_id,
    project_name: t.project?.name || '',
    title: t.title,
    current_end_date: t.current_end_date,
    original_end_date: t.original_end_date,
    assignee_type: t.assignee_type,
    is_milestone: t.is_milestone,
  });

  for (const t of tasks) {
    const d = t.current_end_date;
    if (!d) {
      later.push(shape(t));
    } else if (d <= todayStr) {
      today.push(shape(t));
    } else if (d <= sundayStr) {
      thisWeek.push(shape(t));
    } else {
      later.push(shape(t));
    }
  }

  res.json({ today, thisWeek, later });
});

// GET /api/my-tasks/count  ヘッダーアイコンのバッジ用（軽量）
// today: 今日以前の期日かつ未完了 / overdue: 期日超過の未完了 / total: 全未完了
router.get('/my-tasks/count', requireAuth, async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: '認証が必要です' });

  const { tasks, error } = await _fetchMyOpenTasks(userId);
  if (error) return res.status(500).json({ error: error.message });

  const todayStr = _todayStrJST();
  let todayCount = 0;
  let overdueCount = 0;
  for (const t of tasks) {
    const d = t.current_end_date;
    if (!d) continue;
    if (d < todayStr) {
      overdueCount += 1;
      todayCount += 1; // overdue も「今日対応すべき」に含める
    } else if (d === todayStr) {
      todayCount += 1;
    }
  }
  res.json({ today: todayCount, overdue: overdueCount, total: tasks.length });
});

// PATCH /api/my-tasks/:task_id/done  自分のタスクの完了/未完了を切り替える（権限緩和ルート）
// 既存の /api/projects/:id/tasks/:tid PATCH は project.create_edit が必須で editor/designer
// が自タスクを完了できない問題があるため、assignee 本人に限り is_done のみトグル可能にする。
router.patch('/my-tasks/:task_id/done', requireAuth, async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: '認証が必要です' });
  const taskId = req.params.task_id;
  const newDone = !!(req.body && req.body.is_done);

  const { data: existing, error: getErr } = await supabase
    .from('project_tasks')
    .select('id, assignee_user_id, is_done')
    .eq('id', taskId)
    .maybeSingle();
  if (getErr) {
    if (isMissingTasksTable(getErr)) return res.status(404).json({ error: 'task が見つかりません' });
    return res.status(500).json({ error: getErr.message });
  }
  if (!existing) return res.status(404).json({ error: 'task が見つかりません' });
  if (existing.assignee_user_id !== userId) {
    return res.status(403).json({ error: '自分が担当のタスクのみ完了/未完了を変更できます' });
  }

  const update = {
    is_done: newDone,
    updated_at: new Date().toISOString(),
  };
  if (newDone && !existing.is_done) update.done_at = new Date().toISOString();
  if (!newDone && existing.is_done) update.done_at = null;

  const { data, error } = await supabase
    .from('project_tasks')
    .update(update)
    .eq('id', taskId)
    .select('id, is_done, done_at, updated_at')
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ==================== 見積行 × ロール別コスト（project_estimate_line_costs）Stage 4b ====================
// ADR 002 (見積行統合) + ADR 003 (roles マスタ) + ADR 004 (pricing_type) に基づく line_costs CRUD。
// 1 line に対して、複数のロール（プロデューサー/ディレクター/編集者…）のコスト行を縦持ちで保持する。
//
// 権限: lines / fixed-items と同じ project.create_edit を使う。
//
// 旧 rates 系（director-rates / producer-rates / client-fee）は Stage 4d (PR #TBD) で
// 削除済み。read 経路は invoices flow が Stage 6 まで参照する。

const PRICING_TYPES = new Set(['fixed_per_unit', 'percentage', 'hourly', 'fixed_total']);

const isMissingPelcTable = (err) =>
  err && /relation .*project_estimate_line_costs.* does not exist|could not find the table/i.test(err.message || '');

// PostgREST の UNIQUE 違反 (Supabase) は code '23505' で返る。
const isUniqueViolation = (err) => err && (err.code === '23505' || /duplicate key value/i.test(err.message || ''));

const LINE_COST_SELECT_COLS = [
  'id, line_id, role_id, user_id, unit_price, currency, pricing_type, percentage, actual_hours, created_at',
  'role:roles(id, code, label, category, is_creator, is_internal)',
  // users テーブルの表示名は full_name（schema 8行目）。`name` は存在せず、PostgREST embed が
  // `column users_1.name does not exist` で 500 を吐いていた（2026-05-07 22:42 観測）
  'user:users(id, full_name, email)'
].join(', ');

// 内部ヘルパ: line_id が指定 project_id に属するか確認
async function _verifyLineBelongsToProject(lineId, projectId) {
  const { data, error } = await supabase
    .from('project_estimate_lines')
    .select('id, project_id')
    .eq('id', lineId)
    .maybeSingle();
  if (error) return { error: { status: 500, message: error.message } };
  if (!data) return { error: { status: 404, message: 'line が見つかりません' } };
  if (data.project_id !== projectId) {
    return { error: { status: 400, message: 'project_id と line_id が一致しません' } };
  }
  return { line: data };
}

// 内部ヘルパ: pricing_type / percentage / actual_hours / unit_price のバリデーション
function _validatePricingFields(body, partial = false) {
  // partial=true は PUT 用。ボディに無いフィールドはチェックしない。
  const out = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
  if (!partial || has('pricing_type')) {
    const pt = body.pricing_type || 'fixed_per_unit';
    if (!PRICING_TYPES.has(pt)) {
      return { error: `pricing_type は ${[...PRICING_TYPES].join(' / ')} のいずれかで指定してください` };
    }
    out.pricing_type = pt;
  }
  if (!partial || has('unit_price')) {
    const up = parseInt(body.unit_price, 10);
    if (Number.isNaN(up) || up < 0) {
      return { error: 'unit_price は 0 以上の整数で指定してください' };
    }
    out.unit_price = up;
  }
  if (!partial || has('currency')) {
    const cur = (typeof body.currency === 'string' && body.currency.trim())
      ? body.currency.trim().toUpperCase()
      : 'JPY';
    out.currency = cur;
  }
  if (has('percentage')) {
    if (body.percentage === null || body.percentage === '') {
      out.percentage = null;
    } else {
      const p = Number(body.percentage);
      if (!Number.isFinite(p) || p < 0 || p > 100) {
        return { error: 'percentage は 0〜100 の数値で指定してください' };
      }
      out.percentage = p;
    }
  }
  if (has('actual_hours')) {
    if (body.actual_hours === null || body.actual_hours === '') {
      out.actual_hours = null;
    } else {
      const h = Number(body.actual_hours);
      if (!Number.isFinite(h) || h < 0) {
        return { error: 'actual_hours は 0 以上の数値で指定してください' };
      }
      out.actual_hours = h;
    }
  }
  // pricing_type 別の必須チェック（POST もしくは PUT で pricing_type を変更したとき）
  const effectivePt = out.pricing_type
    || (partial ? null : 'fixed_per_unit');
  if (effectivePt === 'percentage') {
    // percentage 必須
    const eff = has('percentage') ? out.percentage : (partial ? undefined : null);
    if (eff === undefined) {
      // partial で percentage を変更しない場合は許す（既存値を維持）
    } else if (eff === null || !Number.isFinite(eff)) {
      return { error: "pricing_type='percentage' のときは percentage (0-100) を指定してください" };
    }
  }
  if (effectivePt === 'hourly') {
    const eff = has('actual_hours') ? out.actual_hours : (partial ? undefined : null);
    if (eff === undefined) {
      // partial で変更しない場合は許す
    } else if (eff === null || !Number.isFinite(eff)) {
      return { error: "pricing_type='hourly' のときは actual_hours (>=0) を指定してください" };
    }
  }
  return { values: out };
}

// GET /api/projects/:project_id/lines/:line_id/costs  一覧取得
// embed: roles(id, code, label, category, is_creator, is_internal), users(id, full_name, email)
router.get('/projects/:project_id/lines/:line_id/costs', requireAuth, async (req, res) => {
  const { project_id: projectId, line_id: lineId } = req.params;
  const verify = await _verifyLineBelongsToProject(lineId, projectId);
  if (verify.error) return res.status(verify.error.status).json({ error: verify.error.message });

  const { data, error } = await supabase
    .from('project_estimate_line_costs')
    .select(LINE_COST_SELECT_COLS)
    .eq('line_id', lineId)
    .order('created_at', { ascending: true });
  if (error) {
    if (isMissingPelcTable(error)) {
      console.warn('[line-costs] project_estimate_line_costs table missing. Apply migrations/2026-05-06_estimate_lines_and_fixed_items.sql');
      return res.json([]);
    }
    return res.status(500).json({ error: error.message });
  }
  res.json(data || []);
});

// POST /api/projects/:project_id/lines/:line_id/costs  新規作成
// body: { role_id, user_id, unit_price, currency, pricing_type, percentage, actual_hours }
router.post('/projects/:project_id/lines/:line_id/costs', requireAuth, requirePermission('project.create_edit'), async (req, res) => {
  const { project_id: projectId, line_id: lineId } = req.params;
  const verify = await _verifyLineBelongsToProject(lineId, projectId);
  if (verify.error) return res.status(verify.error.status).json({ error: verify.error.message });

  const body = req.body || {};
  const { role_id, user_id } = body;

  if (!role_id) return res.status(400).json({ error: 'role_id は必須です' });

  // role_id が roles マスタに存在するか
  const { data: role, error: roleErr } = await supabase
    .from('roles')
    .select('id')
    .eq('id', role_id)
    .maybeSingle();
  if (roleErr) return res.status(500).json({ error: roleErr.message });
  if (!role) return res.status(400).json({ error: '指定された role_id がマスタに存在しません' });

  // user_id が users に存在するか（指定された場合のみ）
  if (user_id) {
    const { data: u, error: uErr } = await supabase
      .from('users')
      .select('id')
      .eq('id', user_id)
      .maybeSingle();
    if (uErr) return res.status(500).json({ error: uErr.message });
    if (!u) return res.status(400).json({ error: '指定された user_id がユーザーに存在しません' });
  }

  const v = _validatePricingFields(body, false);
  if (v.error) return res.status(400).json({ error: v.error });

  const insertRow = {
    line_id: lineId,
    role_id,
    user_id: user_id || null,
    unit_price: v.values.unit_price ?? 0,
    currency: v.values.currency || 'JPY',
    pricing_type: v.values.pricing_type || 'fixed_per_unit',
    percentage: Object.prototype.hasOwnProperty.call(v.values, 'percentage') ? v.values.percentage : null,
    actual_hours: Object.prototype.hasOwnProperty.call(v.values, 'actual_hours') ? v.values.actual_hours : null,
  };

  const { data, error } = await supabase
    .from('project_estimate_line_costs')
    .insert(insertRow)
    .select(LINE_COST_SELECT_COLS)
    .single();
  if (error) {
    if (isMissingPelcTable(error)) {
      return res.status(503).json({ error: 'project_estimate_line_costs テーブルが未作成です。migrations/2026-05-06_estimate_lines_and_fixed_items.sql を本番Supabaseに適用してください。' });
    }
    if (isUniqueViolation(error)) {
      return res.status(409).json({ error: '同じロール×担当者の組み合わせは既に登録されています' });
    }
    return res.status(500).json({ error: error.message });
  }
  res.json(data);
});

// PUT /api/projects/:project_id/lines/:line_id/costs/:cost_id  部分更新
router.put('/projects/:project_id/lines/:line_id/costs/:cost_id', requireAuth, requirePermission('project.create_edit'), async (req, res) => {
  const { project_id: projectId, line_id: lineId, cost_id: costId } = req.params;
  const verify = await _verifyLineBelongsToProject(lineId, projectId);
  if (verify.error) return res.status(verify.error.status).json({ error: verify.error.message });

  // 既存 cost 取得 + line_id 一致チェック
  const { data: existing, error: getErr } = await supabase
    .from('project_estimate_line_costs')
    .select('id, line_id, role_id, user_id, pricing_type, percentage, actual_hours')
    .eq('id', costId)
    .maybeSingle();
  if (getErr) return res.status(500).json({ error: getErr.message });
  if (!existing) return res.status(404).json({ error: 'cost が見つかりません' });
  if (existing.line_id !== lineId) {
    return res.status(400).json({ error: 'line_id と cost_id が一致しません' });
  }

  const body = req.body || {};
  const updates = {};

  if (Object.prototype.hasOwnProperty.call(body, 'role_id')) {
    if (!body.role_id) return res.status(400).json({ error: 'role_id は空にできません' });
    const { data: role, error: roleErr } = await supabase
      .from('roles')
      .select('id')
      .eq('id', body.role_id)
      .maybeSingle();
    if (roleErr) return res.status(500).json({ error: roleErr.message });
    if (!role) return res.status(400).json({ error: '指定された role_id がマスタに存在しません' });
    updates.role_id = body.role_id;
  }

  if (Object.prototype.hasOwnProperty.call(body, 'user_id')) {
    if (body.user_id) {
      const { data: u, error: uErr } = await supabase
        .from('users')
        .select('id')
        .eq('id', body.user_id)
        .maybeSingle();
      if (uErr) return res.status(500).json({ error: uErr.message });
      if (!u) return res.status(400).json({ error: '指定された user_id がユーザーに存在しません' });
    }
    updates.user_id = body.user_id || null;
  }

  // pricing 関連バリデーション（partial）
  // pricing_type を変更しても percentage/actual_hours は明示的に渡されたときのみ更新する。
  // 既存の必須チェックは「新 pricing_type に対する既存値が NULL」のとき警告したいので
  // 既存値とマージしてから判定する。
  const merged = {
    pricing_type: Object.prototype.hasOwnProperty.call(body, 'pricing_type') ? body.pricing_type : existing.pricing_type,
    percentage:   Object.prototype.hasOwnProperty.call(body, 'percentage')   ? body.percentage   : existing.percentage,
    actual_hours: Object.prototype.hasOwnProperty.call(body, 'actual_hours') ? body.actual_hours : existing.actual_hours,
    unit_price:   Object.prototype.hasOwnProperty.call(body, 'unit_price')   ? body.unit_price   : undefined,
    currency:     Object.prototype.hasOwnProperty.call(body, 'currency')     ? body.currency     : undefined,
  };
  // pricing_type='percentage' で percentage が NULL/未定義になる更新を防ぐ
  if (merged.pricing_type === 'percentage') {
    const p = Number(merged.percentage);
    if (!Number.isFinite(p) || p < 0 || p > 100) {
      return res.status(400).json({ error: "pricing_type='percentage' のときは percentage (0-100) を指定してください" });
    }
  }
  if (merged.pricing_type === 'hourly') {
    const h = Number(merged.actual_hours);
    if (!Number.isFinite(h) || h < 0) {
      return res.status(400).json({ error: "pricing_type='hourly' のときは actual_hours (>=0) を指定してください" });
    }
  }
  if (!PRICING_TYPES.has(merged.pricing_type)) {
    return res.status(400).json({ error: `pricing_type は ${[...PRICING_TYPES].join(' / ')} のいずれかで指定してください` });
  }

  if (Object.prototype.hasOwnProperty.call(body, 'pricing_type')) {
    updates.pricing_type = body.pricing_type;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'unit_price')) {
    const up = parseInt(body.unit_price, 10);
    if (Number.isNaN(up) || up < 0) {
      return res.status(400).json({ error: 'unit_price は 0 以上の整数で指定してください' });
    }
    updates.unit_price = up;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'currency')) {
    updates.currency = (typeof body.currency === 'string' && body.currency.trim())
      ? body.currency.trim().toUpperCase()
      : 'JPY';
  }
  if (Object.prototype.hasOwnProperty.call(body, 'percentage')) {
    if (body.percentage === null || body.percentage === '') {
      updates.percentage = null;
    } else {
      const p = Number(body.percentage);
      if (!Number.isFinite(p) || p < 0 || p > 100) {
        return res.status(400).json({ error: 'percentage は 0〜100 の数値で指定してください' });
      }
      updates.percentage = p;
    }
  }
  if (Object.prototype.hasOwnProperty.call(body, 'actual_hours')) {
    if (body.actual_hours === null || body.actual_hours === '') {
      updates.actual_hours = null;
    } else {
      const h = Number(body.actual_hours);
      if (!Number.isFinite(h) || h < 0) {
        return res.status(400).json({ error: 'actual_hours は 0 以上の数値で指定してください' });
      }
      updates.actual_hours = h;
    }
  }

  if (Object.keys(updates).length === 0) {
    const { data: row } = await supabase
      .from('project_estimate_line_costs')
      .select(LINE_COST_SELECT_COLS)
      .eq('id', costId)
      .single();
    return res.json(row);
  }

  const { data, error } = await supabase
    .from('project_estimate_line_costs')
    .update(updates)
    .eq('id', costId)
    .select(LINE_COST_SELECT_COLS)
    .single();
  if (error) {
    if (isUniqueViolation(error)) {
      return res.status(409).json({ error: '同じロール×担当者の組み合わせは既に登録されています' });
    }
    return res.status(500).json({ error: error.message });
  }
  res.json(data);
});

// DELETE /api/projects/:project_id/lines/:line_id/costs/:cost_id  物理削除
router.delete('/projects/:project_id/lines/:line_id/costs/:cost_id', requireAuth, requirePermission('project.create_edit'), async (req, res) => {
  const { project_id: projectId, line_id: lineId, cost_id: costId } = req.params;
  const verify = await _verifyLineBelongsToProject(lineId, projectId);
  if (verify.error) return res.status(verify.error.status).json({ error: verify.error.message });

  const { data: existing, error: getErr } = await supabase
    .from('project_estimate_line_costs')
    .select('id, line_id')
    .eq('id', costId)
    .maybeSingle();
  if (getErr) return res.status(500).json({ error: getErr.message });
  if (!existing) return res.status(404).json({ error: 'cost が見つかりません' });
  if (existing.line_id !== lineId) {
    return res.status(400).json({ error: 'line_id と cost_id が一致しません' });
  }

  const { error: delErr } = await supabase
    .from('project_estimate_line_costs')
    .delete()
    .eq('id', costId);
  if (delErr) return res.status(500).json({ error: delErr.message });
  res.json({ ok: true });
});

// 旧 client-fee CRUD endpoint (project_client_fees) は Stage 4d で削除済み。
// 後継: project_estimate_lines.client_unit_price + project_fixed_items(item_type='revenue')

// ダッシュボード用：今月の案件売上サマリー（ADR 002+005+006 ベース）
//
// 計算式:
//   plannedRevenue   = SUM( line.client_unit_price × line.planned_count )
//                      where line.id IN (今月納期 creatives.line_id) AND status active
//                    + SUM( fixed_items.amount where item_type='revenue' AND status<>'cancelled' )
//   actualRevenue    = plannedRevenue のうち、line に紐付く全 creatives が status='納品' のもの
//                      （line 単位でカウント。creative 単位ではない）
//   totalCreatives   = 今月納期の creatives 件数（line_id を問わず）
//   completedCreatives = 同上 status='納品' の件数
router.get('/dashboard/revenue-summary', async (req, res) => {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59).toISOString();

  // 今月納期のクリエイティブを取得
  const { data: creatives, error: cErr } = await supabase
    .from('creatives')
    .select('id, project_id, status, creative_type, final_deadline, line_id')
    .gte('final_deadline', startOfMonth)
    .lte('final_deadline', endOfMonth);
  if (cErr) return res.status(500).json({ error: cErr.message });

  const totalCreatives = (creatives || []).length;
  const completedCreatives = (creatives || []).filter(c => c.status === '納品').length;

  // 今月納期 creatives に紐付く line を一括取得
  const lineIds = Array.from(new Set((creatives || []).map(c => c.line_id).filter(Boolean)));
  const projectIds = Array.from(new Set((creatives || []).map(c => c.project_id).filter(Boolean)));

  let plannedRevenue = 0;
  let actualRevenue  = 0;

  // line 単位で planned / actual を計算
  const { calculateLineEconomics, ACTIVE_LINE_STATUSES } = require('../utils/pricing');
  if (lineIds.length) {
    const { data: lines } = await supabase
      .from('project_estimate_lines')
      .select('id, project_id, planned_count, client_unit_price, status')
      .in('id', lineIds);
    const activeStatuses = new Set(ACTIVE_LINE_STATUSES);

    // line ごとの「全 creatives が納品済か」判定用
    const creativesByLine = new Map();
    for (const c of (creatives || [])) {
      if (!c.line_id) continue;
      if (!creativesByLine.has(c.line_id)) creativesByLine.set(c.line_id, []);
      creativesByLine.get(c.line_id).push(c);
    }

    for (const line of (lines || [])) {
      if (!activeStatuses.has(line.status)) continue;
      const econ = calculateLineEconomics(line, []); // 売上だけ見るので line_costs 不要
      plannedRevenue += econ.revenue;
      const list = creativesByLine.get(line.id) || [];
      const allDone = list.length > 0 && list.every(c => c.status === '納品');
      if (allDone) actualRevenue += econ.revenue;
    }
  }

  // line_id NULL の creative を per-unit 単価で救済（同 project 同 creative_type の代表 line を借りる）
  const nullLineCreatives = (creatives || []).filter(c => !c.line_id);
  if (nullLineCreatives.length) {
    const rescueProjectIds = Array.from(new Set(nullLineCreatives.map(c => c.project_id).filter(Boolean)));
    const [linesAllRes, catsRes] = await Promise.all([
      supabase
        .from('project_estimate_lines')
        .select('id, project_id, category_id, planned_count, client_unit_price, status')
        .in('project_id', rescueProjectIds),
      supabase.from('creative_categories').select('id, code, name'),
    ]);
    const allLines = linesAllRes.data || [];
    const catCodeById = new Map();
    for (const cc of (catsRes.data || [])) catCodeById.set(cc.id, cc.code || cc.name || '');

    const isVideoCategory  = (code) => /video|short|long|cut/i.test(code || '');
    const isDesignCategory = (code) => /design|image|static/i.test(code || '');
    const creativeTypeBucket = (ct) => {
      if (!ct) return 'video';
      if (ct.startsWith('design') || ct.includes('デザイン')) return 'design';
      return 'video';
    };

    const activeStatuses2 = new Set(ACTIVE_LINE_STATUSES);
    const repByKey = new Map();
    for (const line of allLines) {
      if (!activeStatuses2.has(line.status)) continue;
      const code = catCodeById.get(line.category_id) || '';
      const type = isVideoCategory(code) ? 'video' : isDesignCategory(code) ? 'design' : null;
      if (!type) continue;
      const key = `${line.project_id}|${type}`;
      if (repByKey.has(key)) continue;
      repByKey.set(key, Number(line.client_unit_price) || 0);
    }

    for (const c of nullLineCreatives) {
      const type = creativeTypeBucket(c.creative_type);
      const rev  = repByKey.get(`${c.project_id}|${type}`) || 0;
      if (!rev) continue;
      plannedRevenue += rev;
      if (c.status === '納品') actualRevenue += rev;
    }
  }

  // project_fixed_items(item_type='revenue') を加算（ADR 006）
  if (projectIds.length) {
    const { data: fixedItems } = await supabase
      .from('project_fixed_items')
      .select('project_id, item_type, amount, status')
      .in('project_id', projectIds)
      .eq('item_type', 'revenue');
    for (const fi of (fixedItems || [])) {
      if (fi.status === 'cancelled') continue;
      const amt = Number(fi.amount) || 0;
      plannedRevenue += amt;
      // 「全 creatives 納品済の案件」は固定収入も実績にカウント
      const projCreatives = (creatives || []).filter(c => c.project_id === fi.project_id);
      const allDone = projCreatives.length > 0 && projCreatives.every(c => c.status === '納品');
      if (allDone) actualRevenue += amt;
    }
  }

  res.json({
    totalCreatives,
    completedCreatives,
    plannedRevenue,
    actualRevenue,
    month: `${now.getFullYear()}年${now.getMonth() + 1}月`
  });
});

// ダッシュボード: 誕生日一覧（今日〜30日先）
router.get('/dashboard/birthdays', requireAuth, async (req, res) => {
  // hide_birth_year 列が無い環境でも落ちないようフォールバックで再試行
  // (PG直の "column ... does not exist" と PostgREST の schema cache エラー両方を拾う)
  let { data, error } = await supabase
    .from('users')
    .select('id, full_name, birthday, avatar_url, role, hide_birth_year')
    .eq('is_active', true)
    .not('birthday', 'is', null);
  const _missingHideBirthYear = error && (
    /column .+ does not exist/.test(error.message || '') ||
    /Could not find the .+ column/.test(error.message || '') ||
    error.code === 'PGRST204'
  );
  if (_missingHideBirthYear) {
    ({ data, error } = await supabase
      .from('users')
      .select('id, full_name, birthday, avatar_url, role')
      .eq('is_active', true)
      .not('birthday', 'is', null));
  }
  if (error) return res.status(500).json({ error: error.message });

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayY = today.getFullYear();
  const todayM = today.getMonth() + 1;
  const todayD = today.getDate();
  const MS_PER_DAY = 1000 * 60 * 60 * 24;

  const list = (data || []).map(u => {
    if (!u.birthday) return null;
    const bd = String(u.birthday).slice(0, 10).split('-');
    const birthY = parseInt(bd[0], 10);
    const month = parseInt(bd[1], 10);
    const day = parseInt(bd[2], 10);
    if (!month || !day) return null;
    // 今年の誕生日。すでに過ぎていたら来年
    let next = new Date(todayY, month - 1, day);
    next.setHours(0, 0, 0, 0);
    let nextYear = todayY;
    if (next < today) {
      next = new Date(todayY + 1, month - 1, day);
      next.setHours(0, 0, 0, 0);
      nextYear = todayY + 1;
    }
    const days_until = Math.round((next - today) / MS_PER_DAY);
    const is_today = (month === todayM && day === todayD);
    const hideYear = !!u.hide_birth_year;
    // 年非表示のユーザーは年・年齢系は返さない（フロントへ漏らさない）
    const age_turning = (hideYear || !birthY) ? null : (nextYear - birthY);
    return {
      id: u.id,
      full_name: u.full_name,
      birthday: hideYear ? null : u.birthday, // 生年月日そのものも年非表示なら返さない
      month, day,
      days_until,
      is_today,
      hide_birth_year: hideYear,
      avatar_url: u.avatar_url || null,
      role: u.role,
      age_turning
    };
  }).filter(x => x && x.days_until <= 30);

  list.sort((a, b) => {
    if (a.is_today !== b.is_today) return a.is_today ? -1 : 1;
    return a.days_until - b.days_until;
  });

  res.json(list);
});

// ==================== 分析・集計 ====================
// 案件 × 担当者ごとのクリエイティブ作成本数（動画 / デザイン）を集計する共通関数
// GET（画面表示）と POST /export-sheet（Sheets出力）の両方から呼ばれる
async function aggregateCreativeByAssignee({ year, month, client_id, statusFilter }) {

  // 期間: 当月の 00:00:00 から 翌月 00:00:00 未満
  const startDate = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0));
  const endDate   = new Date(Date.UTC(year, month, 1, 0, 0, 0));

  // 集計対象は「いつのクリエイティブか」を、納品なら final_deadline、
  // 全件なら created_at で判定する（実態に近い）
  const dateColForFilter = statusFilter === 'delivered' ? 'final_deadline' : 'created_at';

  let query = supabase
    .from('creatives')
    .select(`
      id, file_name, status, creative_type, project_id,
      final_deadline, created_at,
      projects!inner(id, name, client_id, clients(id, name)),
      creative_assignments(role, users(id, full_name, nickname, role))
    `)
    .gte(dateColForFilter, startDate.toISOString())
    .lt(dateColForFilter, endDate.toISOString());
  if (statusFilter === 'delivered') query = query.eq('status', '納品');
  if (client_id) query = query.eq('projects.client_id', client_id);

  const { data, error } = await query;
  if (error) throw new Error(error.message);

  // 集計
  // matrix[projectKey][userId] = { video, design, total }
  const projectMap = new Map(); // projectId -> { id, name, client_name }
  const userMap    = new Map(); // userId -> { id, name, role }
  const cell       = new Map(); // `${pid}|${uid}` -> { video, design }

  for (const c of (data || [])) {
    const pid = c.project_id;
    if (!projectMap.has(pid)) {
      projectMap.set(pid, {
        id: pid,
        name: c.projects?.name || '(不明な案件)',
        client_name: c.projects?.clients?.name || '-',
      });
    }
    const isVideo = c.creative_type?.startsWith('video') || (!c.creative_type?.startsWith('design'));
    const assignees = (c.creative_assignments || [])
      .filter(a => a.users && ['editor','designer','director_as_editor'].includes(a.role))
      .map(a => a.users);
    if (assignees.length === 0) {
      // 担当者未設定はそのまま「(担当未設定)」として集計
      const key = `${pid}|__none__`;
      const ent = cell.get(key) || { video: 0, design: 0 };
      if (isVideo) ent.video++; else ent.design++;
      cell.set(key, ent);
      if (!userMap.has('__none__')) {
        userMap.set('__none__', { id: '__none__', name: '(担当未設定)', role: '-' });
      }
    } else {
      // 同一クリエイティブに複数担当者が居る場合、それぞれにカウント
      for (const u of assignees) {
        if (!userMap.has(u.id)) {
          userMap.set(u.id, { id: u.id, name: u.full_name, role: u.role });
        }
        const key = `${pid}|${u.id}`;
        const ent = cell.get(key) || { video: 0, design: 0 };
        if (isVideo) ent.video++; else ent.design++;
        cell.set(key, ent);
      }
    }
  }

  // 並び替え: クライアント名 → 案件名
  const projects = Array.from(projectMap.values())
    .sort((a, b) => a.client_name.localeCompare(b.client_name, 'ja') || a.name.localeCompare(b.name, 'ja'));
  // ユーザーは role（編集者/デザイナー）→ 名前
  const users = Array.from(userMap.values())
    .sort((a, b) => (a.role || '').localeCompare(b.role || '') || (a.name || '').localeCompare(b.name || '', 'ja'));

  const matrix = projects.map(p => {
    const row = { project: p, cells: {} };
    for (const u of users) {
      row.cells[u.id] = cell.get(`${p.id}|${u.id}`) || { video: 0, design: 0 };
    }
    return row;
  });

  // 合計
  const total = { video: 0, design: 0 };
  for (const c of cell.values()) { total.video += c.video; total.design += c.design; }

  return {
    year, month, client_id, status: statusFilter,
    projects, users, matrix, total,
    creatives_count: (data || []).length,
  };
}

// 画面表示用 GET（JSONを返す）
router.get('/analytics/creative-by-assignee', requireAuth, requirePermission('analytics.view'), async (req, res) => {
  const year  = parseInt(req.query.year, 10);
  const month = parseInt(req.query.month, 10);
  if (!year || !month || month < 1 || month > 12) {
    return res.status(400).json({ error: 'year, month は必須です（month は 1-12）' });
  }
  try {
    const result = await aggregateCreativeByAssignee({
      year, month,
      client_id: req.query.client_id || null,
      statusFilter: req.query.status === 'all' ? 'all' : 'delivered',
    });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message || '集計に失敗しました' });
  }
});

// 月次売上・粗利ダッシュボード（ADR 002+005 per-line 公式）
//
// 売上(確定):   invoice_type='client' の当月 invoices.total_amount 合計
// 原価(確定):   スタッフ請求書（invoice_type が NULL）の当月 total_amount 合計
// 売上(見込み): 当月納期で未納品 creatives → line_id → lines.client_unit_price × planned_count
// 原価(見込み): 同 line の line_costs を pricing_type に応じて合算
//
// 注意:
//   - 旧版は creative 1 件ごとに単価を加算していたが、ADR 002 では
//     line.planned_count に「予定本数」が入る設計のため line 単位で集計する。
//   - 同じ line を共有する複数 creatives がいる場合、二重計上を避けるため
//     line を 1 度しか加算しない（creative の重複排除）。
//   - status フィルタは ADR 005 の集計対象（contracted/in_progress/delivered）に従う。
//   - line_id IS NULL の creatives は集計から漏れる（Stage 4 UI で補正想定）。
async function aggregateMonthlyRevenue({ year, month }) {
  const { calculateLineEconomics, ACTIVE_LINE_STATUSES } = require('../utils/pricing');
  const startDate = new Date(Date.UTC(year, month - 1, 1));
  const endDate   = new Date(Date.UTC(year, month, 1));

  const revenueByClient = new Map();
  const ensureClient = (id, name) => {
    if (!revenueByClient.has(id)) {
      revenueByClient.set(id, { id, name: name || '(不明)', confirmed_revenue: 0, forecast_revenue: 0, confirmed_cost: 0, forecast_cost: 0 });
    }
    return revenueByClient.get(id);
  };

  // 確定売上: invoice_type='client' の当月分
  const { data: clientInvoices } = await supabase
    .from('invoices')
    .select('id, total_amount, recipient_client_id, project_id')
    .eq('invoice_type', 'client').eq('year', year).eq('month', month);
  const clientIds = Array.from(new Set((clientInvoices || []).map(i => i.recipient_client_id).filter(Boolean)));
  const clientNameById = new Map();
  if (clientIds.length) {
    const { data: cs } = await supabase.from('clients').select('id, name').in('id', clientIds);
    (cs || []).forEach(c => clientNameById.set(c.id, c.name));
  }
  let confirmedRevenue = 0;
  for (const inv of (clientInvoices || [])) {
    confirmedRevenue += inv.total_amount || 0;
    if (inv.recipient_client_id) ensureClient(inv.recipient_client_id, clientNameById.get(inv.recipient_client_id)).confirmed_revenue += inv.total_amount || 0;
  }

  // 確定原価: スタッフ請求書（invoice_type IS NULL）当月分
  const { data: staffNullInvoices } = await supabase
    .from('invoices')
    .select('id, total_amount, project_id')
    .is('invoice_type', null).eq('year', year).eq('month', month);
  const staffInvoicesAll = staffNullInvoices || [];

  // project_id → client_id
  const projIds = Array.from(new Set([
    ...(clientInvoices || []).map(i => i.project_id),
    ...staffInvoicesAll.map(i => i.project_id),
  ].filter(Boolean)));
  const projectClientMap = new Map();
  if (projIds.length) {
    const { data: ps } = await supabase.from('projects').select('id, client_id').in('id', projIds);
    (ps || []).forEach(p => projectClientMap.set(p.id, p.client_id));
  }

  let confirmedCost = 0;
  for (const inv of staffInvoicesAll) {
    confirmedCost += inv.total_amount || 0;
    const cid = inv.project_id ? projectClientMap.get(inv.project_id) : null;
    if (cid) ensureClient(cid, clientNameById.get(cid)).confirmed_cost += inv.total_amount || 0;
  }

  // 見込み: 当月納期で未納品 creatives（line_id を含めて取得）
  const { data: forecastCreatives } = await supabase
    .from('creatives')
    .select(`
      id, status, creative_type, project_id, final_deadline, line_id,
      projects!inner(id, client_id, clients(id, name))
    `)
    .gte('final_deadline', startDate.toISOString())
    .lt('final_deadline', endDate.toISOString())
    .neq('status', '納品');

  // line_id でユニーク化（同じ line に紐付く複数 creatives は 1 回しか集計しない）
  const lineIds = Array.from(new Set((forecastCreatives || [])
    .map(c => c.line_id)
    .filter(Boolean)));

  const lineClientMap = new Map(); // line_id -> client_id（売上を顧客別に振り分けるため）
  for (const c of (forecastCreatives || [])) {
    if (c.line_id && c.projects?.client_id && !lineClientMap.has(c.line_id)) {
      lineClientMap.set(c.line_id, { client_id: c.projects.client_id, client_name: c.projects?.clients?.name });
    }
  }

  let forecastRevenue = 0, forecastCost = 0;
  if (lineIds.length) {
    // lines + line_costs を一括取得（status フィルタは JS 側で適用）
    const [linesRes, lineCostsRes] = await Promise.all([
      supabase
        .from('project_estimate_lines')
        .select('id, project_id, planned_count, client_unit_price, status')
        .in('id', lineIds),
      supabase
        .from('project_estimate_line_costs')
        .select('id, line_id, unit_price, pricing_type, percentage, actual_hours')
        .in('line_id', lineIds),
    ]);
    if (linesRes.error)     console.warn('[aggregateMonthlyRevenue] lines load failed:', linesRes.error.message);
    if (lineCostsRes.error) console.warn('[aggregateMonthlyRevenue] line_costs load failed:', lineCostsRes.error.message);

    const lineCostsByLine = new Map();
    for (const lc of (lineCostsRes.data || [])) {
      if (!lineCostsByLine.has(lc.line_id)) lineCostsByLine.set(lc.line_id, []);
      lineCostsByLine.get(lc.line_id).push(lc);
    }

    const activeStatuses = new Set(ACTIVE_LINE_STATUSES);
    for (const line of (linesRes.data || [])) {
      // ADR 005: 集計対象 status のみ
      if (!activeStatuses.has(line.status)) continue;
      const econ = calculateLineEconomics(line, lineCostsByLine.get(line.id) || []);
      forecastRevenue += econ.revenue;
      forecastCost    += econ.costs;
      const meta = lineClientMap.get(line.id);
      if (meta?.client_id) {
        const bucket = ensureClient(meta.client_id, clientNameById.get(meta.client_id) || meta.client_name);
        bucket.forecast_revenue += econ.revenue;
        bucket.forecast_cost    += econ.costs;
      }
    }
  }

  // ========== line_id NULL の creative を救済（per-creative の代表単価で按分） ==========
  // 旧データや Stage 4 UI で line を埋めていない creative は line_id NULL のまま。
  // これらを silent drop すると見込み売上・原価が過小になるので、同じ project 内の
  // 同 creative_type の line を「代表 line」として per-unit の単価/原価を借用して加算する。
  const nullLineCreatives = (forecastCreatives || []).filter(c => !c.line_id);
  let rescued_count = 0, unrecovered_count = 0;
  if (nullLineCreatives.length) {
    const rescueProjectIds = Array.from(new Set(nullLineCreatives.map(c => c.project_id).filter(Boolean)));
    const [linesAllRes, catsRes] = await Promise.all([
      supabase
        .from('project_estimate_lines')
        .select('id, project_id, category_id, planned_count, client_unit_price, status')
        .in('project_id', rescueProjectIds),
      supabase.from('creative_categories').select('id, code, name'),
    ]);
    const allLines = linesAllRes.data || [];
    const allLineIds = allLines.map(l => l.id);
    let allLineCosts = [];
    if (allLineIds.length) {
      const lcRes = await supabase
        .from('project_estimate_line_costs')
        .select('id, line_id, unit_price, pricing_type, percentage, actual_hours')
        .in('line_id', allLineIds);
      allLineCosts = lcRes.data || [];
    }

    const catCodeById = new Map();
    for (const c of (catsRes.data || [])) catCodeById.set(c.id, c.code || c.name || '');

    const lineCostsByLineAll = new Map();
    for (const lc of allLineCosts) {
      if (!lineCostsByLineAll.has(lc.line_id)) lineCostsByLineAll.set(lc.line_id, []);
      lineCostsByLineAll.get(lc.line_id).push(lc);
    }

    // creative_type / category_code の文字列正規化（monthly-forecast と揃える）
    const isVideoCategory = (code) => /video|short|long|cut/i.test(code || '');
    const isDesignCategory = (code) => /design|image|static/i.test(code || '');
    const creativeTypeBucket = (ct) => {
      if (!ct) return 'video';
      if (ct.startsWith('design') || ct.includes('デザイン')) return 'design';
      return 'video';
    };

    // (project_id|type) → { revenue, cost } per unit（最初に見つかった active line を採用）
    const repByKey = new Map();
    const activeStatuses2 = new Set(ACTIVE_LINE_STATUSES);
    for (const line of allLines) {
      if (!activeStatuses2.has(line.status)) continue;
      const code = catCodeById.get(line.category_id) || '';
      const type = isVideoCategory(code) ? 'video' : isDesignCategory(code) ? 'design' : null;
      if (!type) continue;
      const key = `${line.project_id}|${type}`;
      if (repByKey.has(key)) continue;
      const revPerUnit = Number(line.client_unit_price) || 0;
      let costPerUnit = 0;
      for (const lc of lineCostsByLineAll.get(line.id) || []) {
        const pt = lc.pricing_type || 'fixed_per_unit';
        if (pt === 'fixed_per_unit') costPerUnit += Number(lc.unit_price) || 0;
        else if (pt === 'percentage') costPerUnit += revPerUnit * (Number(lc.percentage) || 0) / 100;
        // hourly / fixed_total は 1 件按分できないので捨てる（既存の line_id ありロジックも同じ姿勢）
      }
      repByKey.set(key, { revenue: revPerUnit, cost: costPerUnit });
    }

    for (const c of nullLineCreatives) {
      const type = creativeTypeBucket(c.creative_type);
      const key = `${c.project_id}|${type}`;
      const rep = repByKey.get(key);
      if (!rep) { unrecovered_count++; continue; }
      forecastRevenue += rep.revenue;
      forecastCost    += rep.cost;
      rescued_count++;
      const cid = c.projects?.client_id;
      if (cid) {
        const bucket = ensureClient(cid, clientNameById.get(cid) || c.projects?.clients?.name);
        bucket.forecast_revenue += rep.revenue;
        bucket.forecast_cost    += rep.cost;
      }
    }
  }

  const totalRevenue = confirmedRevenue + forecastRevenue;
  const totalCost    = confirmedCost + forecastCost;
  const grossProfit  = totalRevenue - totalCost;
  const grossMargin  = totalRevenue > 0 ? grossProfit / totalRevenue : 0;

  const byClient = Array.from(revenueByClient.values()).map(c => {
    const rev  = c.confirmed_revenue + c.forecast_revenue;
    const cost = c.confirmed_cost + c.forecast_cost;
    const profit = rev - cost;
    return { ...c, total_revenue: rev, total_cost: cost, gross_profit: profit, gross_margin: rev > 0 ? profit / rev : 0 };
  }).sort((a, b) => b.gross_profit - a.gross_profit);

  return {
    year, month,
    confirmed: { revenue: confirmedRevenue, cost: confirmedCost, gross_profit: confirmedRevenue - confirmedCost },
    forecast:  { revenue: forecastRevenue,  cost: forecastCost,  gross_profit: forecastRevenue - forecastCost },
    total:     { revenue: totalRevenue, cost: totalCost, gross_profit: grossProfit, gross_margin: grossMargin },
    by_client: byClient,
    forecast_rescue: {
      null_line_creatives: nullLineCreatives.length,
      rescued: rescued_count,
      unrecovered: unrecovered_count,
    },
  };
}

router.get('/analytics/monthly-revenue', requireAuth, requirePermission('analytics.view'), async (req, res) => {
  const year = parseInt(req.query.year, 10);
  const month = parseInt(req.query.month, 10);
  if (!year || !month || month < 1 || month > 12) return res.status(400).json({ error: 'year, month は必須です' });
  try {
    res.json(await aggregateMonthlyRevenue({ year, month }));
  } catch (e) { res.status(500).json({ error: e.message || '集計に失敗しました' }); }
});

router.post('/analytics/monthly-revenue/export-sheet', requireAuth, requirePermission('analytics.view'), async (req, res) => {
  const year = parseInt(req.body?.year ?? req.query.year, 10);
  const month = parseInt(req.body?.month ?? req.query.month, 10);
  if (!year || !month || month < 1 || month > 12) return res.status(400).json({ error: 'year, month は必須です' });
  try {
    const data = await aggregateMonthlyRevenue({ year, month });
    const headers = ['クライアント', '確定売上', '見込み売上', '売上合計', '確定原価', '見込み原価', '原価合計', '粗利', '粗利率(%)'];
    const dataRows = data.by_client.map(c => [
      c.name,
      c.confirmed_revenue, c.forecast_revenue, c.total_revenue,
      c.confirmed_cost, c.forecast_cost, c.total_cost,
      c.gross_profit,
      Math.round(c.gross_margin * 1000) / 10,
    ]);
    const totalRow = ['全体合計',
      data.confirmed.revenue, data.forecast.revenue, data.total.revenue,
      data.confirmed.cost, data.forecast.cost, data.total.cost,
      data.total.gross_profit,
      Math.round(data.total.gross_margin * 1000) / 10,
    ];
    const sheetRows = [
      [`HARUKA FILM 月次売上・粗利 (${year}年${month}月)`],
      [`売上 ¥${data.total.revenue.toLocaleString()} / 原価 ¥${data.total.cost.toLocaleString()} / 粗利 ¥${data.total.gross_profit.toLocaleString()} (粗利率 ${(data.total.gross_margin*100).toFixed(1)}%)`],
      [],
      headers, ...dataRows, totalRow,
    ];
    const title = `分析_月次売上粗利_${year}年${String(month).padStart(2,'0')}月`;
    const { url } = await createSheetWithData(title, sheetRows);
    res.json({ url, title, rows_count: dataRows.length });
  } catch (e) {
    console.error('[analytics/monthly-revenue/export-sheet]', e);
    res.status(500).json({ error: e.message || 'スプレッドシート作成に失敗しました' });
  }
});

// 単一の creative について、関わった各ユーザーごとの内訳を計算する純粋関数。
// /api/analytics/creator-summary（集計）と /api/analytics/creator-detail（明細）の
// 両方から呼び出すことで、ロジック分岐を撲滅する。
//
// 戻り値: Map<userId, {
//   user: { id, full_name, nickname, role, rank },
//   base_type: 'video' | 'design',
//   counted: { video: 0|1, design: 0|1, director: 0|1 },  // この creative での本数貢献（最大 1）
//   totals: { video_amount, design_amount, director_amount, producer_amount },
//   breakdown: Array<{ role_code, role_label, amount, pricing_type, source }>,
//   rate_unknown: boolean,                  // assignees / projects.director_id にはいるが
//                                           // line_cost で金額 credit されなかった
//   roles: string[]                          // この creative 上でこの user が credit された role_code 配列
// }>
//
// 引数:
//   creative          : { id, file_name, status, creative_type, project_id, line_id, projects, creative_assignments }
//   lineById          : Map<line_id, line>
//   lineCostsByLine   : Map<line_id, line_cost[]>
//   resolvePayee      : (lineCost, creative, assignees) => user | null
//                        (aggregateCreatorSummary の userById に依存するため、外側から渡す)
//   userById          : Map<user_id, user>
//                        director_id 等を user オブジェクトに展開するため。省略時は director 保険無効。
function computeCreatorCreativeBreakdown(creative, lineById, lineCostsByLine, resolvePayee, userById) {
  const baseType = creative.creative_type?.startsWith('video') ? 'video'
                 : creative.creative_type?.startsWith('design') ? 'design'
                 : (creative.creative_type || 'video');
  const isVideo = baseType === 'video';
  const assignees = (creative.creative_assignments || []).filter(a => a.users);
  const line = creative.line_id ? lineById.get(creative.line_id) : null;
  const lineCosts = creative.line_id ? (lineCostsByLine.get(creative.line_id) || []) : [];

  // user_id -> {...} を初期化するヘルパ
  const result = new Map();
  const ensure = (user) => {
    if (!user || !user.id) return null;
    if (!result.has(user.id)) {
      result.set(user.id, {
        user: {
          id: user.id,
          full_name: user.full_name || '(不明)',
          nickname: user.nickname || null,
          role: user.role || '-',
          rank: user.rank || null,
        },
        base_type: baseType,
        counted: { video: 0, design: 0, director: 0 },
        totals: { video_amount: 0, design_amount: 0, director_amount: 0, producer_amount: 0 },
        breakdown: [],
        rate_unknown: false,
        roles: [],
        _moneyCredited: { video: false, design: false, director: false },  // rate_unknown 判定用（外には出さない）
      });
    }
    return result.get(user.id);
  };

  // 1) 金額分配（line_costs ベース。fixed_per_unit / percentage のみ実額計上、
  //    hourly / fixed_total は creative 単位に按分できないので金額側のみ捨てる）
  for (const lc of lineCosts) {
    const pricingType = lc.pricing_type || 'fixed_per_unit';
    let perCreative = 0;
    if (pricingType === 'fixed_per_unit') {
      perCreative = Number(lc.unit_price) || 0;
    } else if (pricingType === 'percentage') {
      perCreative = (Number(line?.client_unit_price) || 0) * (Number(lc.percentage) || 0) / 100;
    } else {
      continue; // hourly / fixed_total
    }
    if (perCreative <= 0) continue;

    const payee = resolvePayee(lc, creative, assignees);
    if (!payee) continue;
    const slot = ensure(payee);
    if (!slot) continue;

    const code = lc.role?.code || '';
    const label = lc.role?.label || code || '-';
    if (!slot.roles.includes(code)) slot.roles.push(code);
    slot.breakdown.push({
      role_code: code,
      role_label: label,
      amount: perCreative,
      pricing_type: pricingType,
      source: 'line_cost',
    });

    if (code === 'director' || code === 'sub_director') {
      slot.totals.director_amount += perCreative;
      // 同 creative 内で同 user の director_count は最大 1
      slot.counted.director = 1;
      slot._moneyCredited.director = true;
    } else if (code === 'producer' || code === 'sub_producer') {
      slot.totals.producer_amount += perCreative;
      // producer_count は今回 UI に出さないが、本数フラグは将来用に立てておかない
      // （editor/designer の本数 +1 ロジックと混ぜないため）
    } else {
      // editor / designer / director_as_editor / その他 → 動画 or デザイン本数対象
      if (isVideo) {
        slot.totals.video_amount += perCreative;
        slot.counted.video = 1;
        slot._moneyCredited.video = true;
      } else {
        slot.totals.design_amount += perCreative;
        slot.counted.design = 1;
        slot._moneyCredited.design = true;
      }
    }
  }

  // 2) 本数カウントの保険: assignees に居るが上で金額 credit されなかった
  //    editor / designer / director_as_editor を本数だけ拾う（rate_unknown 付き）
  for (const a of assignees) {
    if (!['editor', 'designer', 'director_as_editor'].includes(a.role)) continue;
    const slot = ensure(a.users);
    if (!slot) continue;
    if (!slot.roles.includes(a.role)) slot.roles.push(a.role);
    const moneyKey = isVideo ? 'video' : 'design';
    if (!slot._moneyCredited[moneyKey]) {
      // line_cost で credit されていない → 本数だけ +1、rate_unknown を立てる
      if (isVideo) slot.counted.video = 1;
      else         slot.counted.design = 1;
      slot.rate_unknown = true;
    }
  }

  // 3) ディレクション本数の保険:
  //    line_cost に director / sub_director 行が登録されておらず金額 credit が走らなかった
  //    case でも、projects.director_id が設定されていれば director_count を +1 する。
  //    金額は不明なので加算しない（rate_unknown を立てて UI で「単価未設定」を示す）。
  //    ユーザー要望: 「単価未設定でも納品済の業務量はカウントしたい」
  //    ※ 同じ仕組みで producer 用も将来追加可能（producer_id ベース・今回は対象外）。
  const directorId = creative.projects?.director_id;
  if (directorId && userById) {
    const dirUser = userById.get(directorId);
    if (dirUser) {
      const slot = ensure(dirUser);
      if (slot && !slot._moneyCredited.director) {
        slot.counted.director = 1;
        slot.rate_unknown = true;
        if (!slot.roles.includes('director')) slot.roles.push('director');
        // 明細モーダルで「ここでディレクション計上された」と分かるよう
        // inferred の breakdown 行を 1 件足す（金額 0）
        slot.breakdown.push({
          role_code: 'director',
          role_label: 'ディレクター(単価未設定)',
          amount: 0,
          pricing_type: null,
          source: 'inferred',
        });
      }
    }
  }

  // 内部用フィールドは public 戻り値から外す
  for (const slot of result.values()) {
    delete slot._moneyCredited;
  }
  return result;
}

// クリエイター別作成本数 + 単価 + 合計金額の集計（ADR 002+003+004 対応）
//
// 新方式（per-line / line_costs.user_id ベース）:
//   - 各 creative の line_id を辿って line_costs を取得
//   - line_costs ごとに 1 件あたりのコスト（pricing_type に応じて計算）を算出し、
//     受取人（user_id が指定されていればその人、無ければロールに応じて
//     project.director_id / producer_id へ）に加算する
//   - 同じ creative の中で複数の line_costs が存在する場合は、それぞれのロールに対応する
//     受取人にフルカウント加算（旧版の挙動: 編集者/ディレクター/プロデューサーを別々に加算）
//
// 既知の制約:
//   - line_id IS NULL の creative は集計から漏れる（移行スクリプト未対応分）。
//     Stage 4 UI で line を補正することで自動的に拾えるようになる。
//   - line_costs の user_id が NULL かつロール解決もできない場合、その金額は捨てられる
//     （旧版の director_id/producer_id 参照と同じセマンティクスを保つため）。
async function aggregateCreatorSummary({ year, month, statusFilter }) {
  const { calculateLineCost } = require('../utils/pricing');
  const startDate = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0));
  const endDate   = new Date(Date.UTC(year, month, 1, 0, 0, 0));
  const dateColForFilter = statusFilter === 'delivered' ? 'final_deadline' : 'created_at';

  let q = supabase
    .from('creatives')
    .select(`
      id, file_name, status, creative_type, project_id, line_id,
      final_deadline, created_at,
      projects!inner(id, name, client_id, director_id, producer_id, clients(id, name)),
      creative_assignments(role, rank_applied, users(id, full_name, nickname, role, rank))
    `)
    .gte(dateColForFilter, startDate.toISOString())
    .lt(dateColForFilter, endDate.toISOString());
  if (statusFilter === 'delivered') q = q.eq('status', '納品');

  const { data: creatives, error } = await q;
  if (error) throw new Error(error.message);

  // line_id ⇒ line + line_costs を一括取得
  const lineIds = Array.from(new Set((creatives || []).map(c => c.line_id).filter(Boolean)));
  const lineById = new Map();             // line_id -> line
  const lineCostsByLine = new Map();      // line_id -> line_costs[]
  if (lineIds.length) {
    const [linesRes, lineCostsRes] = await Promise.all([
      supabase
        .from('project_estimate_lines')
        .select('id, project_id, planned_count, client_unit_price, status')
        .in('id', lineIds),
      supabase
        .from('project_estimate_line_costs')
        .select('id, line_id, role_id, user_id, unit_price, pricing_type, percentage, actual_hours, role:roles(id, code, label)')
        .in('line_id', lineIds),
    ]);
    if (linesRes.error)     console.warn('[aggregateCreatorSummary] lines load failed:', linesRes.error.message);
    if (lineCostsRes.error) console.warn('[aggregateCreatorSummary] line_costs load failed:', lineCostsRes.error.message);
    for (const l of (linesRes.data || [])) lineById.set(l.id, l);
    for (const lc of (lineCostsRes.data || [])) {
      if (!lineCostsByLine.has(lc.line_id)) lineCostsByLine.set(lc.line_id, []);
      lineCostsByLine.get(lc.line_id).push(lc);
    }
  }

  // assignees に居ないディレクター/プロデューサー、line_costs.user_id を救うため
  // 必要 user 情報を一括取得
  const neededUserIds = new Set();
  for (const c of (creatives || [])) {
    if (c.projects?.director_id) neededUserIds.add(c.projects.director_id);
    if (c.projects?.producer_id) neededUserIds.add(c.projects.producer_id);
  }
  for (const arr of lineCostsByLine.values()) {
    for (const lc of arr) if (lc.user_id) neededUserIds.add(lc.user_id);
  }
  const userById = new Map();
  if (neededUserIds.size) {
    const { data: us } = await supabase
      .from('users').select('id, full_name, nickname, role, rank')
      .in('id', Array.from(neededUserIds));
    (us || []).forEach(u => userById.set(u.id, u));
  }

  // ユーザーごとに集計
  const userMap = new Map();
  const ensureUser = (u) => {
    if (!u || !u.id) return null;
    if (!userMap.has(u.id)) {
      userMap.set(u.id, {
        id: u.id,
        full_name: u.full_name || '(不明)',
        nickname: u.nickname || null,
        role: u.role || '-',
        rank: u.rank || null,
        video_count: 0,
        design_count: 0,
        director_count: 0,
        video_total: 0,
        design_total: 0,
        director_total: 0,
        producer_total: 0,
        grand_total: 0,
        rate_unknown_count: 0,
      });
    }
    return userMap.get(u.id);
  };

  // ロール code から「creative の中で対応する受取人」を解決する。
  //   1) line_cost.user_id が指定 → その user
  //   2) ロールが editor/designer/director_as_editor → assignees の中から該当ロールの user
  //   3) ロールが director → projects.director_id
  //   4) ロールが producer → projects.producer_id
  //   5) いずれも解決できなければ null（金額は捨てる）
  const resolvePayee = (lineCost, creative, assignees) => {
    if (lineCost.user_id) return userById.get(lineCost.user_id) || null;
    const code = lineCost.role?.code || '';
    if (!code) return null;
    if (['editor', 'designer', 'director_as_editor'].includes(code)) {
      const a = assignees.find(x => x.role === code);
      return a?.users || null;
    }
    if (code === 'director' || code === 'sub_director') {
      const did = creative.projects?.director_id;
      return did ? (userById.get(did) || null) : null;
    }
    if (code === 'producer' || code === 'sub_producer') {
      const pid = creative.projects?.producer_id;
      return pid ? (userById.get(pid) || null) : null;
    }
    // その他のロールは assignees に同 code がいればそれに、いなければ捨てる
    const a = assignees.find(x => x.role === code);
    return a?.users || null;
  };

  // 集計ロジックの設計（PR #TBD で silent skip 撲滅）:
  //   - **本数カウント** は creative_assignments を正とする。
  //     editor / designer / director_as_editor 1 ロールあたり creative 1 件で +1。
  //     line_id が NULL / line が見つからない / line_costs が hourly や fixed_total しか
  //     無い、といった理由で「金額が確定できない」場合でも本数だけは確実に拾う。
  //   - **金額分配** は従来通り line_costs ベース。fixed_per_unit / percentage 以外は
  //     1 件あたりに按分できないので金額側だけ捨てる（本数は捨てない）。
  //   - 同一 (creative, user) を複数の line_cost が credit しても本数は +1 まで。
  //     これにより「2 つの editor 系 line_cost」で本数が水増しされる過去バグを抑止。
  //   - 編集者/デザイナーが line_cost / assignees のどちらでも見つかった場合、本数は
  //     1 件・金額は line_cost を加算。assignees にしか居ないなら rate_unknown を立てる。
  //
  // 単一の creative に対する 1 ユーザーあたりの内訳算出は
  // computeCreatorCreativeBreakdown() に切り出している（/creator-detail と共有）。
  for (const c of (creatives || [])) {
    const perUser = computeCreatorCreativeBreakdown(c, lineById, lineCostsByLine, resolvePayee, userById);
    for (const b of perUser.values()) {
      const u = ensureUser(b.user);
      if (!u) continue;
      // 金額加算
      u.video_total    += b.totals.video_amount;
      u.design_total   += b.totals.design_amount;
      u.director_total += b.totals.director_amount;
      u.producer_total += b.totals.producer_amount;
      u.grand_total    += b.totals.video_amount + b.totals.design_amount
                       +  b.totals.director_amount + b.totals.producer_amount;
      // 本数加算（1 creative × 1 user で最大 +1）
      if (b.counted.video)    u.video_count++;
      if (b.counted.design)   u.design_count++;
      if (b.counted.director) u.director_count++;
      if (b.rate_unknown)     u.rate_unknown_count++;
    }
  }

  const summary = Array.from(userMap.values())
    .sort((a, b) => b.grand_total - a.grand_total
      || (b.video_count + b.design_count) - (a.video_count + a.design_count)
      || (a.full_name || '').localeCompare(b.full_name || '', 'ja'));

  const total = summary.reduce((acc, u) => {
    acc.video_count += u.video_count;
    acc.design_count += u.design_count;
    acc.director_count += u.director_count || 0;
    acc.video_total  += u.video_total;
    acc.design_total += u.design_total;
    acc.director_total += u.director_total || 0;
    acc.producer_total += u.producer_total || 0;
    acc.grand_total  += u.grand_total;
    return acc;
  }, { video_count: 0, design_count: 0, director_count: 0, video_total: 0, design_total: 0, director_total: 0, producer_total: 0, grand_total: 0 });

  // calculateLineCost を参照保持（将来の拡張時に使う想定）
  void calculateLineCost;

  return { year, month, status: statusFilter, summary, total, creatives_count: (creatives || []).length };
}

// 画面表示用 GET
router.get('/analytics/creator-summary', requireAuth, requirePermission('analytics.view'), async (req, res) => {
  const year = parseInt(req.query.year, 10);
  const month = parseInt(req.query.month, 10);
  if (!year || !month || month < 1 || month > 12) {
    return res.status(400).json({ error: 'year, month は必須です' });
  }
  try {
    const result = await aggregateCreatorSummary({
      year, month,
      statusFilter: req.query.status === 'all' ? 'all' : 'delivered',
    });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message || '集計に失敗しました' });
  }
});

// 1 ユーザーが特定の年月に関わった creative の明細
// （/creator-summary 表で行クリック時に展開する内訳モーダル用）
//
// データロード部は aggregateCreatorSummary とほぼ同じ。
// computeCreatorCreativeBreakdown を共有することで「集計値 = 明細合計」が自動的に保証される。
async function aggregateCreatorDetail({ year, month, statusFilter, userId }) {
  const startDate = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0));
  const endDate   = new Date(Date.UTC(year, month, 1, 0, 0, 0));
  const dateColForFilter = statusFilter === 'delivered' ? 'final_deadline' : 'created_at';

  let q = supabase
    .from('creatives')
    .select(`
      id, file_name, status, creative_type, project_id, line_id,
      final_deadline, created_at,
      projects!inner(id, name, client_id, director_id, producer_id, clients(id, name)),
      creative_assignments(role, rank_applied, users(id, full_name, nickname, role, rank))
    `)
    .gte(dateColForFilter, startDate.toISOString())
    .lt(dateColForFilter, endDate.toISOString());
  if (statusFilter === 'delivered') q = q.eq('status', '納品');

  const { data: creatives, error } = await q;
  if (error) throw new Error(error.message);

  const lineIds = Array.from(new Set((creatives || []).map(c => c.line_id).filter(Boolean)));
  const lineById = new Map();
  const lineCostsByLine = new Map();
  if (lineIds.length) {
    const [linesRes, lineCostsRes] = await Promise.all([
      supabase
        .from('project_estimate_lines')
        .select('id, project_id, planned_count, client_unit_price, status')
        .in('id', lineIds),
      supabase
        .from('project_estimate_line_costs')
        .select('id, line_id, role_id, user_id, unit_price, pricing_type, percentage, actual_hours, role:roles(id, code, label)')
        .in('line_id', lineIds),
    ]);
    if (linesRes.error)     console.warn('[aggregateCreatorDetail] lines load failed:', linesRes.error.message);
    if (lineCostsRes.error) console.warn('[aggregateCreatorDetail] line_costs load failed:', lineCostsRes.error.message);
    for (const l of (linesRes.data || [])) lineById.set(l.id, l);
    for (const lc of (lineCostsRes.data || [])) {
      if (!lineCostsByLine.has(lc.line_id)) lineCostsByLine.set(lc.line_id, []);
      lineCostsByLine.get(lc.line_id).push(lc);
    }
  }

  const neededUserIds = new Set([userId]);
  for (const c of (creatives || [])) {
    if (c.projects?.director_id) neededUserIds.add(c.projects.director_id);
    if (c.projects?.producer_id) neededUserIds.add(c.projects.producer_id);
  }
  for (const arr of lineCostsByLine.values()) {
    for (const lc of arr) if (lc.user_id) neededUserIds.add(lc.user_id);
  }
  const userById = new Map();
  if (neededUserIds.size) {
    const { data: us } = await supabase
      .from('users').select('id, full_name, nickname, role, rank')
      .in('id', Array.from(neededUserIds));
    (us || []).forEach(u => userById.set(u.id, u));
  }

  const resolvePayee = (lineCost, creative, assignees) => {
    if (lineCost.user_id) return userById.get(lineCost.user_id) || null;
    const code = lineCost.role?.code || '';
    if (!code) return null;
    if (['editor', 'designer', 'director_as_editor'].includes(code)) {
      const a = assignees.find(x => x.role === code);
      return a?.users || null;
    }
    if (code === 'director' || code === 'sub_director') {
      const did = creative.projects?.director_id;
      return did ? (userById.get(did) || null) : null;
    }
    if (code === 'producer' || code === 'sub_producer') {
      const pid = creative.projects?.producer_id;
      return pid ? (userById.get(pid) || null) : null;
    }
    const a = assignees.find(x => x.role === code);
    return a?.users || null;
  };

  const items = [];
  const totals = {
    video_count: 0, design_count: 0, director_count: 0,
    video_total: 0, design_total: 0, director_total: 0,
    grand_total: 0,
  };

  for (const c of (creatives || [])) {
    const perUser = computeCreatorCreativeBreakdown(c, lineById, lineCostsByLine, resolvePayee, userById);
    const slot = perUser.get(userId);
    if (!slot) continue;

    const rowAmount = slot.totals.video_amount + slot.totals.design_amount
                    + slot.totals.director_amount + slot.totals.producer_amount;

    items.push({
      creative_id: c.id,
      file_name: c.file_name || '(無題)',
      creative_type: c.creative_type || null,
      base_type: slot.base_type,
      status: c.status || null,
      final_deadline: c.final_deadline || null,
      project: {
        id: c.projects?.id || null,
        name: c.projects?.name || '(不明)',
        client_id: c.projects?.client_id || null,
        client_name: c.projects?.clients?.name || '(不明)',
      },
      roles: slot.roles,
      breakdown: slot.breakdown,
      rate_unknown: slot.rate_unknown,
      counted: slot.counted,
      row_total: rowAmount,
    });

    totals.video_total    += slot.totals.video_amount;
    totals.design_total   += slot.totals.design_amount;
    totals.director_total += slot.totals.director_amount;
    totals.grand_total    += rowAmount;
    if (slot.counted.video)    totals.video_count++;
    if (slot.counted.design)   totals.design_count++;
    if (slot.counted.director) totals.director_count++;
  }

  // 案件名 → final_deadline → file_name の昇順
  items.sort((a, b) => {
    const pcmp = (a.project.name || '').localeCompare(b.project.name || '', 'ja');
    if (pcmp !== 0) return pcmp;
    const da = a.final_deadline || '';
    const db = b.final_deadline || '';
    if (da !== db) return da < db ? -1 : 1;
    return (a.file_name || '').localeCompare(b.file_name || '', 'ja');
  });

  const userBase = userById.get(userId) || null;

  return {
    user: userBase ? {
      id: userBase.id,
      full_name: userBase.full_name || '(不明)',
      nickname: userBase.nickname || null,
      role: userBase.role || '-',
      rank: userBase.rank || null,
    } : { id: userId, full_name: '(不明)', nickname: null, role: '-', rank: null },
    year, month,
    status: statusFilter,
    status_label: statusFilter === 'delivered' ? '納品のみ' : '全件',
    items,
    totals,
  };
}

// クリエイター明細 GET（クリエイター行クリックで開く内訳モーダル用）
router.get('/analytics/creator-detail', requireAuth, requirePermission('analytics.view'), async (req, res) => {
  const year = parseInt(req.query.year, 10);
  const month = parseInt(req.query.month, 10);
  const userId = (req.query.user_id || '').toString().trim();
  if (!year || !month || month < 1 || month > 12) {
    return res.status(400).json({ error: 'year, month は必須です' });
  }
  if (!userId) {
    return res.status(400).json({ error: 'user_id は必須です' });
  }
  try {
    const result = await aggregateCreatorDetail({
      year, month,
      statusFilter: req.query.status === 'all' ? 'all' : 'delivered',
      userId,
    });
    res.json(result);
  } catch (e) {
    console.error('[analytics/creator-detail]', e);
    res.status(500).json({ error: e.message || '明細の取得に失敗しました' });
  }
});

// スプレッドシート出力
router.post('/analytics/creator-summary/export-sheet', requireAuth, requirePermission('analytics.view'), async (req, res) => {
  const year = parseInt(req.body?.year ?? req.query.year, 10);
  const month = parseInt(req.body?.month ?? req.query.month, 10);
  if (!year || !month || month < 1 || month > 12) {
    return res.status(400).json({ error: 'year, month は必須です' });
  }
  try {
    const data = await aggregateCreatorSummary({
      year, month,
      statusFilter: (req.body?.status ?? req.query.status) === 'all' ? 'all' : 'delivered',
    });
    const statusLabel = data.status === 'delivered' ? '納品のみ' : '全件';
    const headers = ['クリエイター', '役割', 'ランク', '動画本数', '動画金額', 'デザイン枚数', 'デザイン金額', 'ディレクション本数', 'ディレクション金額', '合計金額'];
    const dataRows = data.summary.map(u => [
      u.full_name + (u.nickname ? ` (${u.nickname})` : ''),
      u.role || '-',
      u.rank || '-',
      u.video_count,
      u.video_total,
      u.design_count,
      u.design_total,
      u.director_count || 0,
      u.director_total || 0,
      u.grand_total,
    ]);
    const totalRow = ['合計', '', '',
      data.total.video_count, data.total.video_total,
      data.total.design_count, data.total.design_total,
      data.total.director_count || 0, data.total.director_total || 0,
      data.total.grand_total];
    const sheetRows = [
      [`HARUKA FILM 分析: クリエイター別作成本数 (${year}年${month}月 / ${statusLabel})`],
      [`動画合計 ${data.total.video_count}本 / デザイン合計 ${data.total.design_count}枚 / ディレクション ${data.total.director_count || 0}件 / 合計金額 ¥${data.total.grand_total.toLocaleString()}`],
      [],
      headers,
      ...dataRows,
      totalRow,
    ];
    const title = `分析_クリエイター別_${year}年${String(month).padStart(2,'0')}月_${statusLabel}`;
    const { url } = await createSheetWithData(title, sheetRows);
    res.json({ url, title, rows_count: dataRows.length });
  } catch (e) {
    console.error('[analytics/creator-summary/export-sheet]', e);
    res.status(500).json({ error: e.message || 'スプレッドシート作成に失敗しました' });
  }
});

// スプレッドシート出力（CSV ではなく Sheets を基本とする方針）
router.post('/analytics/creative-by-assignee/export-sheet', requireAuth, requirePermission('analytics.view'), async (req, res) => {
  const year  = parseInt(req.body?.year ?? req.query.year, 10);
  const month = parseInt(req.body?.month ?? req.query.month, 10);
  if (!year || !month || month < 1 || month > 12) {
    return res.status(400).json({ error: 'year, month は必須です（month は 1-12）' });
  }
  try {
    const data = await aggregateCreativeByAssignee({
      year, month,
      client_id: (req.body?.client_id ?? req.query.client_id) || null,
      statusFilter: (req.body?.status ?? req.query.status) === 'all' ? 'all' : 'delivered',
    });

    // シート行を組み立てる
    const userHeader = data.users.flatMap(u => [`${u.name}(動画)`, `${u.name}(デザイン)`]);
    const headers = ['クライアント', '案件名', ...userHeader, '行計(動画)', '行計(デザイン)'];
    const rows = data.matrix.map(row => {
      const out = [row.project.client_name, row.project.name];
      let rv = 0, rd = 0;
      for (const u of data.users) {
        const c = row.cells[u.id] || { video: 0, design: 0 };
        out.push(c.video, c.design);
        rv += c.video; rd += c.design;
      }
      out.push(rv, rd);
      return out;
    });
    // 列計の最終行
    const colTotalRow = ['', '列計'];
    for (const u of data.users) {
      let v = 0, d = 0;
      for (const r of data.matrix) {
        const c = r.cells[u.id] || { video: 0, design: 0 };
        v += c.video; d += c.design;
      }
      colTotalRow.push(v, d);
    }
    colTotalRow.push(data.total.video, data.total.design);

    const statusLabel = data.status === 'delivered' ? '納品のみ' : '全件';
    const title = `分析_案件×担当者_${year}年${String(month).padStart(2,'0')}月_${statusLabel}`;

    const sheetRows = [
      [`HARUKA FILM 分析: 案件 × 担当者 (${year}年${month}月 / ${statusLabel})`],
      [`動画合計: ${data.total.video} 本 / デザイン合計: ${data.total.design} 枚 / 集計件数: ${data.creatives_count} 件`],
      [],
      headers,
      ...rows,
      colTotalRow,
    ];

    const { url } = await createSheetWithData(title, sheetRows);
    res.json({ url, title, rows_count: rows.length });
  } catch (e) {
    console.error('[analytics/export-sheet]', e);
    res.status(500).json({ error: e.message || 'スプレッドシート作成に失敗しました' });
  }
});

// ==================== 単価未設定チェッカー ====================
// GET /api/analytics/cost-coverage
// 役割: project_estimate_lines のうち、director / editor / designer のロール単価行 (line_cost)
// が一度も登録されていない line を一覧化する。請求書と集計のズレ（PR #416 で発覚した
// director_count = 0 件問題）を月初に潰すための管理画面用 API。
//
// 判定:
//   - 対象 line: status IN ('contracted','in_progress','delivered')
//   - director 欠落: line_costs に role.code IN ('director','sub_director') が 0 行
//                    AND projects.director_id IS NOT NULL
//   - editor  欠落: line.category.render_kind === 'video'  AND line_costs に
//                    role.code IN ('editor','director_as_editor') が 0 行
//   - designer 欠落: line.category.render_kind IN ('image','longpage','iframe','pdf')
//                     AND line_costs に role.code === 'designer' が 0 行
//
// 並び順: recent_delivered_count DESC NULLS LAST, last_delivered DESC NULLS LAST
// パフォーマンス: lines / line_costs / projects / creatives を一括取得し JS 側で結合（N+1 回避）。
//
// TODO: 将来的に producer / sub_producer も同じ仕組みで追加可能（projects.producer_id ベース）。
router.get('/analytics/cost-coverage', requireAuth, requirePermission('analytics.view'), async (req, res) => {
  try {
    // 1) 対象 line を一括取得（active 系 status のみ）
    const ACTIVE_LINE_STATUSES = ['contracted', 'in_progress', 'delivered'];
    const { data: lines, error: linesErr } = await supabase
      .from('project_estimate_lines')
      .select(`
        id, project_id, name, planned_count, client_unit_price, status,
        category:creative_categories(id, code, name, render_kind),
        project:projects!inner(
          id, name, status, director_id, is_hidden,
          client:clients(id, name)
        )
      `)
      .in('status', ACTIVE_LINE_STATUSES);
    if (linesErr) {
      if (isMissingPelTable && isMissingPelTable(linesErr)) {
        return res.json({ missing: { director: [], editor: [], designer: [] },
          summary: { total_active_lines: 0, director_missing: 0, editor_missing: 0, designer_missing: 0 } });
      }
      return res.status(500).json({ error: linesErr.message });
    }

    // 非表示案件は除外（hidden な案件で警告を出しても直す動機が無い）
    const filteredLines = (lines || []).filter(l => l.project && l.project.is_hidden !== true);
    const lineIds = filteredLines.map(l => l.id);

    // 2) line_costs を一括取得（role embed 込み）
    let costsByLine = new Map();
    if (lineIds.length) {
      const { data: costs, error: costsErr } = await supabase
        .from('project_estimate_line_costs')
        .select('id, line_id, role_id, role:roles(id, code, label)')
        .in('line_id', lineIds);
      if (costsErr) {
        console.warn('[cost-coverage] line_costs load failed:', costsErr.message);
      } else {
        for (const c of (costs || [])) {
          if (!costsByLine.has(c.line_id)) costsByLine.set(c.line_id, []);
          costsByLine.get(c.line_id).push(c);
        }
      }
    }

    // 3) director_id の名前解決
    const directorIds = Array.from(new Set(filteredLines
      .map(l => l.project?.director_id).filter(Boolean)));
    const userById = new Map();
    if (directorIds.length) {
      const { data: us } = await supabase
        .from('users').select('id, full_name, nickname')
        .in('id', directorIds);
      (us || []).forEach(u => userById.set(u.id, u));
    }

    // 4) 直近3ヶ月の納品 creative を line ごとに集計（優先度ソート用）
    //    final_deadline ベース（statusFilter='delivered' と整合）
    const now = new Date();
    const threeMonthsAgo = new Date(now);
    threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
    const recentByLine = new Map(); // line_id -> { count, last_delivered }
    if (lineIds.length) {
      const { data: creatives, error: creErr } = await supabase
        .from('creatives')
        .select('id, line_id, final_deadline, status')
        .in('line_id', lineIds)
        .eq('status', '納品')
        .gte('final_deadline', threeMonthsAgo.toISOString().slice(0, 10));
      if (creErr) {
        console.warn('[cost-coverage] creatives load failed:', creErr.message);
      } else {
        for (const c of (creatives || [])) {
          if (!c.line_id) continue;
          const slot = recentByLine.get(c.line_id) || { count: 0, last_delivered: null };
          slot.count += 1;
          if (!slot.last_delivered || (c.final_deadline && c.final_deadline > slot.last_delivered)) {
            slot.last_delivered = c.final_deadline;
          }
          recentByLine.set(c.line_id, slot);
        }
      }
    }

    // 5) 各 line を判定して 3 つのバケツに振り分け
    const missing = { director: [], editor: [], designer: [] };
    const VIDEO_KIND = new Set(['video']);
    const DESIGN_KIND = new Set(['image', 'longpage', 'iframe', 'pdf']);

    for (const line of filteredLines) {
      const costs = costsByLine.get(line.id) || [];
      const codes = new Set(costs.map(c => c.role?.code).filter(Boolean));
      const recent = recentByLine.get(line.id) || { count: 0, last_delivered: null };
      const renderKind = line.category?.render_kind || null;

      const baseRow = {
        line_id: line.id,
        project_id: line.project?.id || null,
        project_name: line.project?.name || '(不明)',
        client_name: line.project?.client?.name || '(不明)',
        client_id: line.project?.client?.id || null,
        line_name: line.name || null,
        line_unit_price: Number(line.client_unit_price) || 0,
        line_status: line.status,
        line_category: line.category?.name || null,
        line_render_kind: renderKind,
        recent_delivered_count: recent.count,
        last_delivered: recent.last_delivered,
      };

      // director 欠落判定
      const directorId = line.project?.director_id;
      if (directorId) {
        const hasDirector = codes.has('director') || codes.has('sub_director');
        if (!hasDirector) {
          const dUser = userById.get(directorId);
          missing.director.push({
            ...baseRow,
            director_name: dUser ? (dUser.full_name || dUser.nickname || null) : null,
          });
        }
      }

      // editor / designer 欠落判定（render_kind ベース。render_kind 未設定の line は判定対象外）
      if (renderKind && VIDEO_KIND.has(renderKind)) {
        const hasEditor = codes.has('editor') || codes.has('director_as_editor');
        if (!hasEditor) {
          missing.editor.push({ ...baseRow, director_name: null });
        }
      } else if (renderKind && DESIGN_KIND.has(renderKind)) {
        const hasDesigner = codes.has('designer');
        if (!hasDesigner) {
          missing.designer.push({ ...baseRow, director_name: null });
        }
      }
    }

    // 6) 並び順: recent_delivered_count DESC NULLS LAST, last_delivered DESC NULLS LAST
    const sorter = (a, b) => {
      const ac = a.recent_delivered_count || 0;
      const bc = b.recent_delivered_count || 0;
      if (ac !== bc) return bc - ac;
      const ad = a.last_delivered || '';
      const bd = b.last_delivered || '';
      if (ad !== bd) return ad < bd ? 1 : -1;
      return (a.client_name || '').localeCompare(b.client_name || '', 'ja');
    };
    missing.director.sort(sorter);
    missing.editor.sort(sorter);
    missing.designer.sort(sorter);

    res.json({
      missing,
      summary: {
        total_active_lines: filteredLines.length,
        director_missing: missing.director.length,
        editor_missing: missing.editor.length,
        designer_missing: missing.designer.length,
      },
    });
  } catch (e) {
    console.error('[analytics/cost-coverage]', e);
    res.status(500).json({ error: e.message || '単価未設定チェックに失敗しました' });
  }
});

// ==================== バグ報告件数（月次） ====================
// 対象月に作成された bug_reports を「報告者」ごとにグルーピングして集計する。
//
// 用語整理（PR #493 のリネーム以後）:
//   - 報告者 = assignee_user_id (フォームのドロップダウンで選ばれた、実際にバグに気づいた人)
//   - 入力者 = reporter_user_id (保存ボタンを押したログインユーザー。代理入力されたケースを区別する)
// 統計は「誰が一番バグを見つけているか」を可視化したいので assignee_user_id でグルーピング。
//
// 匿名報告は __anonymous__ キーで集約し、誰の報告かは特定しない。
// 匿名は元々「入力者を隠す」フラグだが、現状は報告者表示にも使い回している
// （TODO: 入力者と報告者で別個の匿名フラグが必要か別件で再検討）。
// 各報告には改善済みフラグ（improved_at）と 紐付いた Verup（version_logs.revision_no）も含める。
async function aggregateBugReports({ year, month }) {
  const startDate = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0));
  const endDate   = new Date(Date.UTC(year, month, 1, 0, 0, 0));

  const { data: rows, error } = await supabase
    .from('bug_reports')
    .select(`
      id, title, severity, status, is_anonymous, created_at,
      reporter_user_id, assignee_user_id,
      improved_at, improved_by_user_id, improvement_version_log_id,
      duplicate_of_id,
      assignee:assignee_user_id ( id, full_name, nickname ),
      improvement_log:improvement_version_log_id ( id, revision_no, screen, feature ),
      duplicate_parent:duplicate_of_id ( id, title )
    `)
    .gte('created_at', startDate.toISOString())
    .lt('created_at', endDate.toISOString())
    .order('created_at', { ascending: true });
  if (error) throw new Error(error.message);

  const groups = new Map();
  const byStatus = { open: 0, in_progress: 0, implemented: 0, resolved: 0, wont_fix: 0, duplicate: 0 };
  let total = 0;
  let totalImproved = 0;
  let totalDuplicate = 0;

  for (const r of (rows || [])) {
    total++;
    if (byStatus[r.status] != null) byStatus[r.status]++;
    // 重複は「先勝ちノーカウント」運用。改善カウントには含めない
    const isDup = r.status === 'duplicate' || !!r.duplicate_of_id;
    if (isDup) totalDuplicate++;
    if (r.improved_at && !isDup) totalImproved++;

    const isAnon = !!r.is_anonymous;
    // 報告者(assignee_user_id) でグルーピング。null なら __unspecified__
    const key = isAnon ? '__anonymous__' : (r.assignee_user_id || '__unspecified__');
    if (!groups.has(key)) {
      const label = isAnon
        ? '🕵️ 匿名（集約）'
        : (r.assignee_user_id
            ? (r.assignee?.nickname || r.assignee?.full_name || '— 不明 —')
            : '— 報告者未指定 —');
      groups.set(key, {
        // フロント互換のため key 名は reporter_user_id のまま維持（中身は assignee_user_id 値）
        reporter_user_id: isAnon ? null : r.assignee_user_id,
        is_anonymous: isAnon,
        label,
        count: 0,
        improved_count: 0,
        reports: [],
      });
    }
    const g = groups.get(key);
    // 重複(ノーカウント)は count / improved_count に加算しない。reports リストには含める
    if (!isDup) {
      g.count++;
      if (r.improved_at) g.improved_count++;
    }
    g.reports.push({
      id: r.id,
      short_id: String(r.id).replace(/-/g, '').slice(0, 8),
      title: r.title,
      severity: r.severity,
      status: r.status,
      created_at: r.created_at,
      is_improved: !!r.improved_at,
      improved_at: r.improved_at,
      // 重複情報（フロント側で「ノーカウント」バッジを出す）
      is_duplicate: isDup,
      duplicate_of_id: r.duplicate_of_id || null,
      duplicate_of_title: r.duplicate_parent?.title || null,
      improvement_revision_no: r.improvement_log?.revision_no || null,
      improvement_screen: r.improvement_log?.screen || null,
      improvement_feature: r.improvement_log?.feature || null,
      improvement_version_log_id: r.improvement_version_log_id || null,
    });
  }

  // 件数降順、匿名は最後
  const by_reporter = Array.from(groups.values()).sort((a, b) => {
    if (a.is_anonymous !== b.is_anonymous) return a.is_anonymous ? 1 : -1;
    if (b.count !== a.count) return b.count - a.count;
    return (a.label || '').localeCompare(b.label || '', 'ja');
  });

  // 重複は「先勝ちノーカウント」のため、改善率の母数からも除外して計算する
  const totalCounted = total - totalDuplicate;

  return {
    year, month,
    total,
    total_counted: totalCounted,
    total_duplicate: totalDuplicate,
    total_improved: totalImproved,
    total_unimproved: totalCounted - totalImproved,
    by_status: byStatus,
    by_reporter,
  };
}

router.get('/analytics/bug-reports', requireAuth, requirePermission('analytics.bug_reports.view'), async (req, res) => {
  const year = parseInt(req.query.year, 10);
  const month = parseInt(req.query.month, 10);
  if (!year || !month || month < 1 || month > 12) return res.status(400).json({ error: 'year, month は必須です' });
  try {
    res.json(await aggregateBugReports({ year, month }));
  } catch (e) { res.status(500).json({ error: e.message || '集計に失敗しました' }); }
});

router.post('/analytics/bug-reports/export-sheet', requireAuth, requirePermission('analytics.bug_reports.view'), async (req, res) => {
  const year = parseInt(req.body?.year ?? req.query.year, 10);
  const month = parseInt(req.body?.month ?? req.query.month, 10);
  if (!year || !month || month < 1 || month > 12) return res.status(400).json({ error: 'year, month は必須です' });
  try {
    const data = await aggregateBugReports({ year, month });
    const sevLabel = { low: '低', normal: '通常', high: '高', critical: '致命的' };
    const stLabel = { open: '未対応', in_progress: '対応中', resolved: '解決', wont_fix: '対応しない', duplicate: '重複' };

    // シート1: 詳細
    const headers = ['報告者', '番号', 'タイトル', '重要度', '状態', '報告日時', '改善済み', '対応Verup#'];
    const dataRows = [];
    for (const g of data.by_reporter) {
      for (const r of g.reports) {
        const dateStr = new Date(r.created_at).toLocaleString('ja-JP');
        dataRows.push([
          g.label, '#' + r.short_id, r.title || '',
          sevLabel[r.severity] || r.severity || '',
          stLabel[r.status] || r.status || '',
          dateStr,
          r.is_improved ? '✅' : '',
          r.improvement_revision_no ? `#${r.improvement_revision_no}` : '',
        ]);
      }
    }
    // シート1: 報告者別サマリ
    const summaryHeaders = ['報告者', '報告件数', '改善件数', '改善率(%)'];
    const summaryDataRows = data.by_reporter.map(g => [
      g.label, g.count, g.improved_count,
      g.count > 0 ? Math.round((g.improved_count / g.count) * 1000) / 10 : 0,
    ]);
    const totalRate = data.total > 0 ? Math.round((data.total_improved / data.total) * 1000) / 10 : 0;
    const summaryRow = [
      `報告総数 ${data.total} / 改善済み ${data.total_improved} / 未改善 ${data.total_unimproved} / 改善率 ${totalRate}%`,
    ];
    const sheetRows = [
      [`HARUKA FILM バグ報告件数 (${year}年${month}月)`],
      summaryRow,
      [],
      ['【報告者別サマリ】'],
      summaryHeaders, ...summaryDataRows,
      [],
      ['【内訳】'],
      headers, ...dataRows,
    ];
    const title = `分析_バグ報告件数_${year}年${String(month).padStart(2,'0')}月`;
    const { url } = await createSheetWithData(title, sheetRows);
    res.json({ url, title, rows_count: dataRows.length });
  } catch (e) {
    console.error('[analytics/bug-reports/export-sheet]', e);
    res.status(500).json({ error: e.message || 'スプレッドシート作成に失敗しました' });
  }
});

// ==================== クリエイティブ ====================

// クリエイティブ一覧取得
// 一覧専用の軽量レスポンス: 必要列のみ select し、limit/offset/各種フィルタを DB 側で適用
// レスポンス: { data, total, limit, offset }
router.get('/creatives', async (req, res) => {
  const {
    project_id, cycle_id, status, ball_holder,
    client_id, assignee_id, q, include_done,
  } = req.query;

  // ページング (default 50 / max 500)
  // max 200 → 500 に拡張: フロントは allCreatives を「全件」前提でサイドバー警告/ダッシュボード/案件詳細件数 を集計しているため、
  // page 2 以降にこぼれた遅延が silent に集計から消える事故が起きる（#347/#355/#359）。
  // active が 500 を超えるケースは現状想定外、超えたら server side aggregate endpoint へ移行する。
  const limit  = Math.min(Math.max(parseInt(req.query.limit, 10)  || 50, 1), 500);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

  // タブフィルタ: creative_type の prefix で粗く絞り込む
  //   tab=video  → creative_type LIKE 'video_%'
  //   tab=design → creative_type LIKE 'design_%'
  //   tab=all / 未指定 → フィルタなし
  // フロント側のページネーション「次の50件を読み込む」が
  // タブ別の総件数を正しく扱うために必要（ボタンの「残り N 件」を正確化）
  const tabRaw = (req.query.tab || '').toString().toLowerCase();
  const tabFilter = (tabRaw === 'video' || tabRaw === 'design') ? tabRaw : null;

  // assignee_id フィルタは PostgREST の埋め込み JOIN で絞り込めないので、
  // 先に creative_assignments から該当 creative_id 集合を取得し .in() で絞る
  // 複数選択対応: カンマ区切り → in() で OR 検索、単一値はそのまま eq()
  let assigneeCreativeIds = null;
  if (assignee_id) {
    const userIds = String(assignee_id).split(',').map(s => s.trim()).filter(Boolean);
    if (userIds.length > 0) {
      let caQuery = supabase.from('creative_assignments').select('creative_id');
      caQuery = (userIds.length > 1) ? caQuery.in('user_id', userIds) : caQuery.eq('user_id', userIds[0]);
      const { data: caRows, error: caErr } = await caQuery;
      if (caErr) return res.status(500).json({ error: caErr.message });
      assigneeCreativeIds = Array.from(new Set((caRows || []).map(r => r.creative_id))).filter(Boolean);
      // ヒット 0 件なら以降の本体クエリ自体スキップ
      if (assigneeCreativeIds.length === 0) {
        return res.json({ data: [], total: 0, limit, offset });
      }
    }
  }

  // フリーワード検索（q）の事前処理:
  //  - カッコは「削除」する（スペースに置換すると複数スペースで意図しない ilike パターンになる）
  //  - 連続スペース→1つに圧縮
  //  - file_name / memo に加えて、ユーザー名 / ニックネームも検索対象に含める
  //    （ユーザー名は creative_assignments → users の JOIN 経由で creative_id 集合化）
  let qPat = '';
  let userMatchCreativeIds = null;
  if (req.query.q && req.query.q.trim()) {
    const qTerm = req.query.q.replace(/[,()]/g, '').replace(/\s+/g, ' ').trim();
    if (qTerm) {
      qPat = `%${qTerm}%`;
      // users.full_name / users.nickname にヒットする creative_assignments を取り、creative_id を集める
      const { data: assignMatches, error: amErr } = await supabase
        .from('creative_assignments')
        .select('creative_id, users!inner(full_name, nickname)')
        .or(`full_name.ilike.${qPat},nickname.ilike.${qPat}`, { foreignTable: 'users' });
      if (amErr) return res.status(500).json({ error: amErr.message });
      userMatchCreativeIds = Array.from(new Set((assignMatches || []).map(a => a.creative_id))).filter(Boolean);
    }
  }

  // 一覧描画に必要な列のみ。teams は別取得で stitch
  // client_id フィルタを foreignTable 経由で効かせるため projects は inner join
  const projectsRel = client_id ? 'projects!inner' : 'projects';
  // 後から追加された列（schema-sync が失敗していると本番に存在しない可能性がある）
  const OPTIONAL_COLS = ['force_delivered', 'force_delivered_reason', 'force_delivered_at'];
  const buildSelect = (includeOptional) => `
    id, file_name, status, draft_deadline, final_deadline,
    internal_code, help_flag, talent_flag, special_payable_by, memo,
    creative_type, team_id, project_id, created_at, updated_at${includeOptional ? ',\n    ' + OPTIONAL_COLS.join(', ') : ''},
    ${projectsRel}(id, name, client_id, producer_id, director_id, sheet_url, regulation_url, clients(id, name, status)),
    project_cycles(id, year, month),
    creative_assignments(
      id, role, rank_applied, created_at,
      users(id, full_name, nickname, role, rank, team_id, avatar_url)
    )
  `;

  // フィルタ条件を共通化して、optional 込み → 失敗時 optional 抜きで再試行できるようにする
  const buildAndApply = (includeOptional) => {
    let q = supabase
      .from('creatives')
      .select(buildSelect(includeOptional), { count: 'exact' })
      .order('final_deadline', { ascending: true, nullsFirst: false });
    if (project_id) q = q.eq('project_id', project_id);
    if (cycle_id)   q = q.eq('cycle_id', cycle_id);
    if (status)     q = q.eq('status', status);
    if (tabFilter === 'video') {
      q = q.like('creative_type', 'video_%');
    } else if (tabFilter === 'design') {
      // design_% に加えて lp / hp / line（プレフィックス無し）も含める
      q = q.or('creative_type.like.design_%,creative_type.eq.lp,creative_type.eq.hp,creative_type.eq.line');
    }
    if (!(include_done === '1' || include_done === 'true')) q = q.neq('status', '納品');
    if (client_id) {
      // 複数選択対応: カンマ区切り → in() で OR 検索、単一値はそのまま eq()
      const ids = String(client_id).split(',').map(s => s.trim()).filter(Boolean);
      if (ids.length > 1) q = q.in('projects.client_id', ids);
      else if (ids.length === 1) q = q.eq('projects.client_id', ids[0]);
    }
    if (qPat) {
      // file_name OR memo OR (users.full_name / nickname にヒットした creative_id 集合) のいずれか
      const orConds = [`file_name.ilike.${qPat}`, `memo.ilike.${qPat}`];
      if (userMatchCreativeIds && userMatchCreativeIds.length > 0) {
        // PostgREST の OR 表現: id.in.(uuid1,uuid2,...)
        orConds.push(`id.in.(${userMatchCreativeIds.join(',')})`);
      }
      q = q.or(orConds.join(','));
    }
    if (assigneeCreativeIds) q = q.in('id', assigneeCreativeIds);
    q = q.range(offset, offset + limit - 1);
    return q;
  };

  // teams を別クエリで取得（PostgREST の FK 推論に依存しない: 本番DBに FK が無くても動作させるため）
  let { data, error, count } = await buildAndApply(true);
  // schema-sync が失敗していて optional 列が本番DBに存在しない場合、optional を外して再試行する
  if (error && /column .+ does not exist/.test(error.message || '')) {
    console.warn('[creatives] optional列なし → fallback で再取得:', error.message);
    ({ data, error, count } = await buildAndApply(false));
  }
  const { data: teamsRaw } = await supabase.from('teams').select('id, team_code, team_name, director_id, director:director_id(full_name), team_members(user_id)');
  if (error) return res.status(500).json({ error: error.message });

  // チーム逆引きMap（ディレクター名/ID 解決用 + teams 埋め込み代替用）
  const directorByTeamId    = new Map();
  const directorByUserId    = new Map();
  const directorIdByTeamId  = new Map();
  const directorIdByUserId  = new Map();
  const teamById            = new Map();
  (teamsRaw || []).forEach(t => {
    const name = t.director?.full_name || '';
    if (t.director_id) {
      directorByTeamId.set(t.id, name);
      directorIdByTeamId.set(t.id, t.director_id);
    }
    (t.team_members || []).forEach(tm => {
      if (tm.user_id && !directorByUserId.has(tm.user_id)) {
        directorByUserId.set(tm.user_id, name);
        directorIdByUserId.set(tm.user_id, t.director_id || null);
      }
    });
    teamById.set(t.id, { id: t.id, team_code: t.team_code, team_name: t.team_name });
  });

  // 案件専用ディレクター解決用に projects.director_id 集合を一括取得
  const projDirIds = Array.from(new Set(
    (data || []).map(c => c.projects?.director_id).filter(Boolean)
  ));
  const userById = new Map();
  if (projDirIds.length) {
    const { data: dirUsers } = await supabase
      .from('users').select('id, full_name').in('id', projDirIds);
    (dirUsers || []).forEach(u => userById.set(u.id, u));
  }

  // ボール保持者と teams を付与（teams は FK 不要の手動 stitch）
  const withBall = (data || []).map(c => {
    const projectDirector = c.projects?.director_id ? userById.get(c.projects.director_id) || null : null;
    return {
      ...c,
      teams: c.team_id ? (teamById.get(c.team_id) || null) : null,
      ball_holder: getBallHolder(
        c.status, c.creative_assignments,
        directorByTeamId, directorByUserId, directorIdByTeamId, directorIdByUserId,
        projectDirector
      ),
    };
  });

  res.json({ data: withBall, total: count ?? withBall.length, limit, offset });
});

// 種別タブのカウンタ専用エンドポイント
//   GET /api/creatives/counts
//   返り値: { all, video, design }
//
// /api/creatives と同じフィルタ群（client_id / assignee_id / q / project_id /
// cycle_id / status / include_done / ball_holder）を受けるが、`tab` は無視する。
// 共通(=all)・動画(=video_*)・デザイン(=design_*) の3カウントを並列で取得。
//
// 背景: PR #237 でサーバー側 tab フィルタを導入したため、クライアントの
// allCreatives は現在表示中のタブの行しか含まなくなり、
// 「allCreatives.filter(...).length」で計算していたタブカウンタが
// 共通(44) / 動画編集(44) / デザイン(0) のように壊れていた。
router.get('/creatives/counts', async (req, res) => {
  const {
    project_id, cycle_id, status,
    client_id, assignee_id, q, include_done,
  } = req.query;

  // assignee_id フィルタは creative_assignments → creative_id 集合化
  // 複数選択対応: カンマ区切り → in() で OR 検索、単一値はそのまま eq()
  let assigneeCreativeIds = null;
  if (assignee_id) {
    const userIds = String(assignee_id).split(',').map(s => s.trim()).filter(Boolean);
    if (userIds.length > 0) {
      let caQuery = supabase.from('creative_assignments').select('creative_id');
      caQuery = (userIds.length > 1) ? caQuery.in('user_id', userIds) : caQuery.eq('user_id', userIds[0]);
      const { data: caRows, error: caErr } = await caQuery;
      if (caErr) return res.status(500).json({ error: caErr.message });
      assigneeCreativeIds = Array.from(new Set((caRows || []).map(r => r.creative_id))).filter(Boolean);
      if (assigneeCreativeIds.length === 0) {
        return res.json({ all: 0, video: 0, design: 0 });
      }
    }
  }

  // q（フリーワード）処理は /api/creatives と揃える
  let qPat = '';
  let userMatchCreativeIds = null;
  if (q && q.trim()) {
    const qTerm = q.replace(/[,()]/g, '').replace(/\s+/g, ' ').trim();
    if (qTerm) {
      qPat = `%${qTerm}%`;
      const { data: assignMatches, error: amErr } = await supabase
        .from('creative_assignments')
        .select('creative_id, users!inner(full_name, nickname)')
        .or(`full_name.ilike.${qPat},nickname.ilike.${qPat}`, { foreignTable: 'users' });
      if (amErr) return res.status(500).json({ error: amErr.message });
      userMatchCreativeIds = Array.from(new Set((assignMatches || []).map(a => a.creative_id))).filter(Boolean);
    }
  }

  // count: exact + head: true で行は返さずにカウントだけ取得（軽量化）
  // client_id を効かせるために projects!inner を select 句に含める必要がある。
  const buildCountQuery = (typePrefix) => {
    const projectsRel = client_id ? 'projects!inner(client_id)' : null;
    const selectExpr = projectsRel ? `id, ${projectsRel}` : 'id';
    let q2 = supabase
      .from('creatives')
      .select(selectExpr, { count: 'exact', head: true });
    if (project_id) q2 = q2.eq('project_id', project_id);
    if (cycle_id)   q2 = q2.eq('cycle_id', cycle_id);
    if (status)     q2 = q2.eq('status', status);
    if (typePrefix === 'video') {
      q2 = q2.like('creative_type', 'video_%');
    } else if (typePrefix === 'design') {
      // design_% に加えて lp / hp / line（プレフィックス無し）も含める
      q2 = q2.or('creative_type.like.design_%,creative_type.eq.lp,creative_type.eq.hp,creative_type.eq.line');
    } else if (typePrefix) {
      q2 = q2.like('creative_type', `${typePrefix}_%`);
    }
    if (!(include_done === '1' || include_done === 'true')) q2 = q2.neq('status', '納品');
    if (client_id) {
      const ids = String(client_id).split(',').map(s => s.trim()).filter(Boolean);
      if (ids.length > 1) q2 = q2.in('projects.client_id', ids);
      else if (ids.length === 1) q2 = q2.eq('projects.client_id', ids[0]);
    }
    if (qPat) {
      const orConds = [`file_name.ilike.${qPat}`, `memo.ilike.${qPat}`];
      if (userMatchCreativeIds && userMatchCreativeIds.length > 0) {
        orConds.push(`id.in.(${userMatchCreativeIds.join(',')})`);
      }
      q2 = q2.or(orConds.join(','));
    }
    if (assigneeCreativeIds) q2 = q2.in('id', assigneeCreativeIds);
    return q2;
  };

  try {
    const [allRes, videoRes, designRes] = await Promise.all([
      buildCountQuery(null),
      buildCountQuery('video'),
      buildCountQuery('design'),
    ]);
    if (allRes.error)    return res.status(500).json({ error: allRes.error.message });
    if (videoRes.error)  return res.status(500).json({ error: videoRes.error.message });
    if (designRes.error) return res.status(500).json({ error: designRes.error.message });
    res.json({
      all:    allRes.count    ?? 0,
      video:  videoRes.count  ?? 0,
      design: designRes.count ?? 0,
    });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

// クリエイティブ単体取得
//
// パフォーマンス最適化（PR claude/feat-creatives-detail-perf-and-loading）:
//   旧: 主取得後に「カテゴリ→status_template→teams(own)→projects.sub_director_ids→
//       projects.sub_producer_ids→sub_users→client_teams→teams(全件)」を
//       直列に await していたため、本番環境で 8〜9 RTT を要していた。
//   新: 主取得が終わったら、互いに依存しない 5 ブロックを Promise.all で並列に走らせる。
//       ロジックそのものは変えていない（出力 JSON 形状も完全一致）。
router.get('/creatives/:id', async (req, res) => {
  const creativeId = req.params.id;
  const { data, error } = await supabase
    .from('creatives')
    .select(`
      *,
      projects(
        id, name, producer_id, director_id, regulation_url, primary_category_id,
        director:director_id(id, full_name, nickname, role, rank, team_id, avatar_url, is_active),
        producer:producer_id(id, full_name, nickname, role, rank, team_id, avatar_url, is_active),
        clients(id, name, client_code, status)
      ),
      project_cycles(id, year, month),
      creative_assignments(
        id, role, rank_applied,
        users(id, full_name, nickname, role, team_id, avatar_url)
      )
    `)
    .eq('id', creativeId)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) {
    return res.status(404).json({ error: 'このクリエイティブは見つかりません（削除されている可能性があります）' });
  }

  // ─── 並列実行する 5 ブロック ─────────────────────────────────
  const projectId = data.projects?.id || null;
  const primaryCategoryId = data.projects?.primary_category_id || null;
  const clientId = data.projects?.clients?.id || null;

  // (A) primary_category + status_template_items
  const taskCategory = (async () => {
    if (!primaryCategoryId) return { primary_category: null, status_template: null };
    try {
      const { data: catData } = await supabase
        .from('creative_categories')
        .select('id, code, name, color')
        .eq('id', primaryCategoryId)
        .maybeSingle();
      const code = catData?.code;
      let status_template = null;
      if (code && ['lp', 'hp', 'line'].includes(code)) {
        const { data: tpls } = await supabase
          .from('creative_status_templates')
          .select('id, name, is_default, items:creative_status_template_items(code, label, sort_order, is_milestone)')
          .eq('category_id', catData.id)
          .order('is_default', { ascending: false })
          .order('name', { ascending: true });
        const tpl = (tpls || []).find(t => t.is_default) || (tpls || [])[0] || null;
        if (tpl) {
          const items = (tpl.items || []).slice().sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
          status_template = { id: tpl.id, items };
        } else {
          status_template = { id: null, items: [] };
        }
      }
      return { primary_category: catData || null, status_template };
    } catch (e) {
      console.warn('[creatives/:id] primary_category / status_template embed 失敗:', e.message);
      return { primary_category: null, status_template: { id: null, items: [] } };
    }
  })();

  // (B) creatives.teams（自身の team_id 紐付け）
  const taskOwnTeam = (async () => {
    if (!data.team_id) return null;
    try {
      const { data: teamData } = await supabase
        .from('teams')
        .select('id, team_code, team_name')
        .eq('id', data.team_id)
        .maybeSingle();
      return teamData || null;
    } catch (_) {
      return null;
    }
  })();

  // (C) projects.sub_director_ids + sub_producer_ids + サブD/Pユーザー情報
  // sub_*_ids 2列を1クエリで取得し、和集合のユーザーも1クエリで取得（N+1解消継続）。
  const taskSubDP = (async () => {
    if (!projectId) return { sub_director_ids: [], sub_producer_ids: [], sub_directors: [], sub_producers: [] };
    let subDIds = [], subPIds = [];
    // 2列を一括取得。列欠損 (migration 未適用) でも try/catch でフォールバック。
    try {
      const { data: projExt, error: projExtErr } = await supabase
        .from('projects')
        .select('sub_director_ids, sub_producer_ids')
        .eq('id', projectId)
        .maybeSingle();
      if (!projExtErr && projExt) {
        subDIds = Array.isArray(projExt.sub_director_ids) ? projExt.sub_director_ids : [];
        subPIds = Array.isArray(projExt.sub_producer_ids) ? projExt.sub_producer_ids : [];
      }
    } catch (_) {
      // 両方とも欠損している可能性 → 個別 select でフォールバック
      try {
        const { data: projD } = await supabase
          .from('projects').select('sub_director_ids').eq('id', projectId).maybeSingle();
        subDIds = Array.isArray(projD?.sub_director_ids) ? projD.sub_director_ids : [];
      } catch (_) {}
      try {
        const { data: projP } = await supabase
          .from('projects').select('sub_producer_ids').eq('id', projectId).maybeSingle();
        subPIds = Array.isArray(projP?.sub_producer_ids) ? projP.sub_producer_ids : [];
      } catch (_) {}
    }
    const allSubIds = [...new Set([...subDIds, ...subPIds].filter(Boolean))];
    let userById = new Map();
    if (allSubIds.length) {
      try {
        const { data: subUsers, error: subErr } = await supabase
          .from('users')
          .select('id, full_name, nickname, role, rank, team_id, avatar_url, is_active')
          .in('id', allSubIds);
        if (!subErr && Array.isArray(subUsers)) {
          userById = new Map(subUsers.map(u => [u.id, u]));
        }
      } catch (_) {}
    }
    return {
      sub_director_ids: subDIds,
      sub_producer_ids: subPIds,
      sub_directors: subDIds.map(id => userById.get(id)).filter(Boolean),
      sub_producers: subPIds.map(id => userById.get(id)).filter(Boolean),
    };
  })();

  // (D) client_teams（Dチェック担当者選択用）
  const taskClientTeams = (async () => {
    if (!clientId) return [];
    try {
      const { data: ctRows } = await supabase
        .from('client_teams')
        .select('team_id')
        .eq('client_id', clientId);
      return (ctRows || []).map(r => ({ team_id: r.team_id })).filter(r => r.team_id);
    } catch (_) {
      return [];
    }
  })();

  // (E) ball_holder 計算用 teams 全件 + team_members
  // （一覧 /creatives と完全一致させるため getBallHolder() に渡す Map を作る）
  const taskBallHolder = (async () => {
    try {
      const { data: teamsRaw } = await supabase
        .from('teams')
        .select('id, director_id, director:director_id(full_name), team_members(user_id)');
      return teamsRaw || [];
    } catch (e) {
      console.warn('[creatives/:id] teams 取得失敗（ball_holder用）:', e.message);
      return null;
    }
  })();

  // ─── 並列実行 → 結果をマージ ─────────────────────────────────
  const [catRes, ownTeam, subDP, clientTeams, teamsRaw] = await Promise.all([
    taskCategory, taskOwnTeam, taskSubDP, taskClientTeams, taskBallHolder,
  ]);

  // (A) primary_category + status_template_items
  if (data.projects && primaryCategoryId) {
    data.projects.primary_category = catRes.primary_category;
    if (catRes.status_template) {
      data.status_template_items = catRes.status_template.items || [];
      data.status_template_id = catRes.status_template.id || null;
      // status_code が NULL の場合は first item の code を表示用フォールバックとして埋める
      // （DB は触らず、レスポンス上のみ。Backfill migration で本体は埋まる）
      if (!data.status_code && (catRes.status_template.items || []).length) {
        data.status_code = catRes.status_template.items[0].code;
      }
    }
  }

  // (B) own team
  data.teams = ownTeam;

  // (C) sub D/P
  if (data.projects) {
    data.projects.sub_director_ids = subDP.sub_director_ids;
    data.projects.sub_producer_ids = subDP.sub_producer_ids;
    data.projects.sub_directors = subDP.sub_directors;
    data.projects.sub_producers = subDP.sub_producers;
  }

  // (D) client_teams
  if (data.projects) {
    data.projects.client_teams = clientTeams;
  }

  // (E) ball_holder
  try {
    if (teamsRaw === null) {
      data.ball_holder = null;
    } else {
      const directorByTeamId   = new Map();
      const directorByUserId   = new Map();
      const directorIdByTeamId = new Map();
      const directorIdByUserId = new Map();
      teamsRaw.forEach(t => {
        const name = t.director?.full_name || '';
        if (t.director_id) {
          directorByTeamId.set(t.id, name);
          directorIdByTeamId.set(t.id, t.director_id);
        }
        (t.team_members || []).forEach(tm => {
          if (tm.user_id && !directorByUserId.has(tm.user_id)) {
            directorByUserId.set(tm.user_id, name);
            directorIdByUserId.set(tm.user_id, t.director_id || null);
          }
        });
      });
      const projectDirector = data.projects?.director_id
        ? (data.projects.director || null)
        : null;
      data.ball_holder = getBallHolder(
        data.status,
        data.creative_assignments,
        directorByTeamId, directorByUserId, directorIdByTeamId, directorIdByUserId,
        projectDirector
      );
    }
  } catch (e) {
    console.warn('[creatives/:id] ball_holder 計算失敗:', e.message);
    data.ball_holder = null;
  }

  res.json(data);
});

// ADR 008 Phase 4: 案件の連番起点 / 桁数を読み出すヘルパ。
//   既存案件で migration 未適用 / 列欠損のときは null を返し、呼び出し側で旧仕様にフォールバック。
async function resolveProjectSerialConfig(project) {
  const startRaw = project?.next_filename_serial;
  const digitsRaw = project?.serial_digits;
  const start = Number.isFinite(Number(startRaw)) && Number(startRaw) >= 1 ? Math.floor(Number(startRaw)) : null;
  const digits = Number.isInteger(Number(digitsRaw)) && Number(digitsRaw) >= 1 && Number(digitsRaw) <= 10
    ? Number(digitsRaw)
    : null;
  return { start, digits };
}

// 一括登録プレビュー（DBには保存しない）
//
// ADR 008 Phase 4 (2026-05-09):
//   採番方式を「既存 internal_code/file_name から最小未使用番号を割り当て」→
//   「projects.next_filename_serial を起点に count 個進める」に変更。
//   - 欠番再利用は行わない（シート側連番とのズレを生まない）
//   - 起点は req.body.serial_start で上書き可能（フロントの bulk モーダルで明示）
//   - serial 桁数は projects.serial_digits（既定 3 桁）
//   - migration 未適用環境では従来の最小未使用方式にフォールバック
router.post('/creatives/bulk-preview', async (req, res) => {
  const { project_id, creative_type, appeal_type_id, count, draft_deadline, final_deadline,
          product_code, media_code, creative_fmt, creative_size, serial_start } = req.body;
  // 訴求軸（appeal_type_id）は任意化: 未確定状態でもプレビュー可（ファイル名は空欄部分を詰めて生成される）
  if (!project_id || !creative_type || !count) {
    return res.status(400).json({ error: '案件・種別・本数は必須です' });
  }
  const { data: project } = await supabase
    .from('projects')
    .select('*, clients(id, name, client_code)')
    .eq('id', project_id)
    .single();
  let appealType = null;
  if (appeal_type_id) {
    const { data: at } = await supabase
      .from('client_appeal_axes').select('*').eq('id', appeal_type_id).single();
    appealType = at;
  }
  if (!project) return res.status(400).json({ error: '案件が見つかりません' });
  if (appeal_type_id && !appealType) return res.status(400).json({ error: '訴求軸が見つかりません' });

  // ADR 007: ファイル名テンプレ解決（schema-sync 失敗時は null → ハードコードフォールバック）
  const tplResolved = await resolveProjectFilenameTemplate(project);

  // ADR 008 Phase 4: 連番起点 & 桁数
  const { start: cfgStart, digits: cfgDigits } = await resolveProjectSerialConfig(project);
  const serialDigits = cfgDigits || 3;
  const overrideStart = (() => {
    const n = Number(serial_start);
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : null;
  })();
  let startSeq = overrideStart || cfgStart;

  // 旧仕様フォールバック: next_filename_serial 列が無い環境
  if (!startSeq) {
    const { data: existingCreatives } = await supabase
      .from('creatives').select('internal_code, file_name, appeal_type_id').eq('project_id', project_id);
    const usedSeqs = (existingCreatives || []).map(c => {
      if (c.internal_code) { const m = c.internal_code.match(/^(\d{3})_/); if (m) return Number(m[1]); }
      const fn = c.file_name || '';
      const m7 = fn.match(/_(\d{7})$/); if (m7) return Number(m7[1]);
      const m3 = fn.match(/^(\d{3})_/); return m3 ? Number(m3[1]) : null;
    }).filter(n => n !== null);
    let n = 1;
    while (usedSeqs.includes(n)) n++;
    startSeq = n;
  }

  const today = new Date();
  const dateStr = `${String(today.getFullYear()).slice(2)}${String(today.getMonth()+1).padStart(2,'0')}${String(today.getDate()).padStart(2,'0')}`;

  const previews = [];
  let nextSeq = startSeq;
  for (let i = 0; i < count; i++) {
    const seqStr = String(nextSeq).padStart(serialDigits, '0');
    let fileName;
    if (tplResolved) {
      const tokenValues = buildFilenameTokenValues({
        project, appealType, body: req.body, seqStr7: seqStr, dateStr, version: '',
      });
      fileName = renderFilename(tplResolved.template, tokenValues, tplResolved.overrides, { serialDigits });
    } else {
      const appealCode = appealType ? appealType.code : '';
      const parts = [dateStr, product_code, media_code, creative_fmt, appealCode, creative_size, seqStr]
        .map(p => (p||'').toString().trim()).filter(Boolean);
      fileName = parts.join('_');
    }
    previews.push({ file_name: fileName, draft_deadline: draft_deadline || null, final_deadline: final_deadline || null });
    nextSeq++;
  }
  res.json({ previews, serial_start: startSeq, next_serial_after: startSeq + count, serial_digits: serialDigits });
});

// クリエイティブ作成
// 一括登録
//
// ADR 008 Phase 4 (2026-05-09):
//   採番方式は bulk-preview と同じく projects.next_filename_serial 起点。
//   完了時に projects.next_filename_serial = 起点 + count に同期更新する。
//   serial_start (req.body) で起点を上書き可能（フロント bulk モーダルで指定）。
router.post('/creatives/bulk', async (req, res) => {
  const {
    project_id, creative_type, appeal_type_id,
    count, draft_deadline, final_deadline, note,
    product_id, product_code, media_code, creative_fmt, creative_size,
    assignee_id, team_id, talent_flag,
    serial_start
  } = req.body;
  // 訴求軸（appeal_type_id）は任意化: 未確定状態でも一括登録できるようにする
  if (!project_id || !creative_type || !count) {
    return res.status(400).json({ error: '案件・種別・本数は必須です' });
  }
  if (count < 1 || count > 100) {
    return res.status(400).json({ error: '本数は1〜100の間で指定してください' });
  }
  const { data: project } = await supabase
    .from('projects')
    .select('*, clients(id, name, client_code)')
    .eq('id', project_id)
    .single();
  let appealType = null;
  if (appeal_type_id) {
    const { data: at } = await supabase
      .from('client_appeal_axes').select('*').eq('id', appeal_type_id).single();
    appealType = at;
  }
  if (!project) {
    return res.status(400).json({ error: '案件が見つかりません' });
  }
  if (appeal_type_id && !appealType) {
    return res.status(400).json({ error: '訴求軸が見つかりません' });
  }

  // ADR 007: ファイル名テンプレ解決（schema-sync 失敗時は null → ハードコードフォールバック）
  const tplResolved = await resolveProjectFilenameTemplate(project);

  // ADR 008 Phase 4: 連番起点 & 桁数
  const { start: cfgStart, digits: cfgDigits } = await resolveProjectSerialConfig(project);
  const serialDigits = cfgDigits || 3;
  const overrideStart = (() => {
    const n = Number(serial_start);
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : null;
  })();
  let startSeq = overrideStart || cfgStart;

  // 旧仕様フォールバック: next_filename_serial 列が無い環境
  if (!startSeq) {
    const { data: existingCreatives } = await supabase
      .from('creatives').select('internal_code, file_name, appeal_type_id').eq('project_id', project_id);
    const usedSeqsLegacy = (existingCreatives || []).map(c => {
      if (c.internal_code) { const m = c.internal_code.match(/^(\d{3})_/); if (m) return Number(m[1]); }
      const fn = c.file_name || '';
      const m7 = fn.match(/_(\d{7})$/); if (m7) return Number(m7[1]);
      const m3 = fn.match(/^(\d{3})_/); return m3 ? Number(m3[1]) : null;
    }).filter(n => n !== null);
    let n = 1;
    while (usedSeqsLegacy.includes(n)) n++;
    startSeq = n;
  }

  const today = new Date();
  const dateStr = `${String(today.getFullYear()).slice(2)}${String(today.getMonth()+1).padStart(2,'0')}${String(today.getDate()).padStart(2,'0')}`;

  const inserts = [];
  let nextSeq = startSeq;
  for (let i = 0; i < count; i++) {
    const seqStr = String(nextSeq).padStart(serialDigits, '0');
    let fileName;
    if (tplResolved) {
      const tokenValues = buildFilenameTokenValues({
        project, appealType, body: req.body, seqStr7: seqStr, dateStr, version: '',
      });
      fileName = renderFilename(tplResolved.template, tokenValues, tplResolved.overrides, { serialDigits });
    } else {
      const appealCode = appealType ? appealType.code : '';
      const parts = [dateStr, product_code, media_code, creative_fmt, appealCode, creative_size, seqStr]
        .map(p => (p||'').toString().trim()).filter(Boolean);
      fileName = parts.join('_');
    }
    const insert = { project_id, file_name: fileName, creative_type,
      appeal_type_id: appeal_type_id || null,
      draft_deadline: draft_deadline || null, final_deadline: final_deadline || null,
      note: note || null, status: '未着手',
      product_id: product_id || null, media_code: media_code || null,
      creative_fmt: creative_fmt || null, creative_size: creative_size || null,
      talent_flag: talent_flag === true,
      team_id: team_id || null };
    inserts.push(insert);
    nextSeq++;
  }
  const { data, error } = await supabase.from('creatives').insert(inserts).select();
  if (error) return res.status(500).json({ error: error.message });

  // 採番起点を進める（ADR 008 Phase 4）
  // - next_filename_serial 列があれば advancedTo (= startSeq + count) に進める
  // - seq_counter 列は Phase 5 で削除予定だが、互換のため advancedTo - 1 で同期更新する
  const advancedTo = startSeq + count;
  try {
    const updatePayload = { next_filename_serial: advancedTo, seq_counter: advancedTo - 1 };
    const { error: upErr } = await supabase.from('projects').update(updatePayload).eq('id', project_id);
    if (upErr && /next_filename_serial/i.test(upErr.message || '')) {
      await supabase.from('projects').update({ seq_counter: advancedTo - 1 }).eq('id', project_id);
    }
  } catch (e) {
    console.warn('[bulk] advance serial failed:', e?.message || e);
  }

  res.json({ ok: true, count: data.length, creatives: data, next_serial_after: advancedTo, serial_digits: serialDigits });
});

// 個別登録
router.post('/creatives', async (req, res) => {
  const {
    project_id, cycle_id, file_name, creative_type,
    draft_deadline, final_deadline, script_url, note, appeal_type_id,
    product_id, media_code, creative_fmt, creative_size,
    assignee_id, internal_code, production_date, talent_flag, team_id, memo,
    client_review_url
  } = req.body;
  if (!project_id || !file_name || !creative_type) {
    return res.status(400).json({ error: '案件・ファイル名・種別は必須です' });
  }

  // team_id は明示指定があればそれを採用、なければ assignee の team_id を派生
  let resolvedTeamId = team_id || null;
  if (!resolvedTeamId && assignee_id) {
    const { data: u } = await supabase.from('users').select('team_id').eq('id', assignee_id).single();
    resolvedTeamId = u?.team_id || null;
  }

  // LP / HP / LINE カテゴリの案件の場合、初期 status_code を default テンプレの最小 sort_order の code に設定する。
  // 動画 / 静止画 は status_code を入れない（既存の status 駆動を維持）。
  // schema-sync 未適用 / テーブル無し環境では try/catch で握りつぶす。
  let initialStatusCode = null;
  try {
    const { data: proj } = await supabase
      .from('projects')
      .select('primary_category_id')
      .eq('id', project_id)
      .maybeSingle();
    if (proj?.primary_category_id) {
      const { data: cat } = await supabase
        .from('creative_categories')
        .select('id, code')
        .eq('id', proj.primary_category_id)
        .maybeSingle();
      if (cat?.code && ['lp', 'hp', 'line'].includes(cat.code)) {
        const { data: tpls } = await supabase
          .from('creative_status_templates')
          .select('id, is_default, items:creative_status_template_items(code, sort_order)')
          .eq('category_id', cat.id);
        const tpl = (tpls || []).find(t => t.is_default) || (tpls || [])[0];
        const items = (tpl?.items || []).slice().sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
        if (items.length) initialStatusCode = items[0].code;
      }
    }
  } catch (e) {
    console.warn('[creatives:create] initial status_code 解決失敗:', e.message);
  }

  const insertPayload = {
    project_id, cycle_id, file_name, creative_type,
    draft_deadline: draft_deadline || null,
    final_deadline: final_deadline || null,
    script_url: script_url || null,
    note: note || null,
    status: assignee_id ? '制作中（初稿提出前）' : '未着手',
    appeal_type_id: appeal_type_id || null,
    product_id: product_id || null,
    media_code: media_code || null,
    creative_fmt: creative_fmt || null,
    creative_size: creative_size || null,
    internal_code: internal_code || null,
    production_date: production_date || null,
    talent_flag: talent_flag || false,
    team_id: resolvedTeamId,
    memo: (memo && String(memo).trim()) ? memo : null,
    client_review_url: (client_review_url && String(client_review_url).trim()) ? client_review_url : null,
  };
  if (initialStatusCode) insertPayload.status_code = initialStatusCode;

  let { data, error } = await supabase.from('creatives').insert(insertPayload).select().single();
  // schema-sync 失敗で status_code 列がまだ無い場合のフォールバック
  if (error && /status_code/i.test(error.message || '') && initialStatusCode) {
    const { status_code: _omit, ...fallback } = insertPayload;
    const retry = await supabase.from('creatives').insert(fallback).select().single();
    data = retry.data; error = retry.error;
  }
  if (error) return res.status(500).json({ error: error.message });
  // 担当者を creative_assignments に登録
  if (assignee_id) {
    const { data: assigneeUser } = await supabase.from('users').select('rank').eq('id', assignee_id).single();
    await supabase.from('creative_assignments').insert({
      creative_id: data.id,
      user_id: assignee_id,
      role: 'editor',
      rank_applied: assigneeUser?.rank || null,
    });
  }
  // 新規作成時も ball_holder_id を初期化（担当者付きで作られた場合は初期通知が飛ぶ）
  syncBallHolderId(data.id).catch(e => console.warn('[ball_holder_id] sync failed:', e.message));

  // admin / secretary に「クリエイティブ登録通知」を発火（登録者本人は除外）
  // 主処理は止めない — 通知失敗は console.warn で握りつぶす
  (async () => {
    try {
      const { createBulkNotifications } = require('../utils/notification');
      const senderId = req.user?.id || null;
      const senderName = req.user?.nickname || req.user?.full_name || null;

      const { data: recipients, error: recErr } = await supabase
        .from('users')
        .select('id')
        .eq('is_active', true)
        .in('role', ['admin', 'secretary']);
      if (recErr) {
        console.warn('[creative_registered] 受信者取得失敗:', recErr.message);
        return;
      }

      const targets = (recipients || []).filter(u => u.id !== senderId);
      if (targets.length === 0) return;

      const title = senderName
        ? `${senderName}さんがクリエイティブを登録しました`
        : 'クリエイティブが登録されました';

      const rows = targets.map(u => ({
        user_id: u.id,
        notification_type: 'creative_registered',
        title,
        body: data.file_name || null,
        link_url: `/haruka.html?creative=${data.id}`,
        meta: { creative_id: data.id, project_id: data.project_id },
        sender_id: senderId,
      }));
      await createBulkNotifications(rows);
    } catch (e) {
      console.warn('[creative_registered] 通知発火失敗:', e.message);
    }
  })();

  res.json(data);
});

// クリエイティブ更新
router.put('/creatives/:id', requireAuth, async (req, res) => {
  const {
    file_name, status, deadline, draft_deadline, final_deadline, script_url,
    frameio_url, delivery_url, final_delivery_url, client_review_url,
    help_flag, talent_flag, note, revision_count,
    director_comment, client_comment, editor_comment,
    creative_type, appeal_type_id, product_id, media_code, creative_fmt, creative_size,
    assignee_id, team_id, memo,
    director_user_id,
    director_user_ids,
    producer_user_ids,
    force_delivered_reason,
    // 動画ファイル無しで工程を進める場合のフラグ（代表 髙橋指示・2026-05-09 補足）。
    // 例: クライアント直接やり取り済み、口頭で完結、素材待ち 等。
    // フラグが立っていてもサーバ側はファイル必須バリデーションを一切持っていないため、
    // 受け取って snapshot にプレフィックス付きで残すだけで OK。
    fileless_progression,
    fileless_reason
  } = req.body;

  // help_flag（SOS）の権限制御:
  //   creative.sos_others 権限あり → 全クリエイティブに対して可
  //   なし（editor / designer 等）→ 自分が assignment に入っている場合のみ可
  if (help_flag !== undefined) {
    const role = getEffectiveRole(req);
    const canSosOthers = await userHasPermission(role, 'creative.sos_others');
    if (!canSosOthers) {
      const { data: own } = await supabase
        .from('creative_assignments')
        .select('id')
        .eq('creative_id', req.params.id)
        .eq('user_id', req.user?.id)
        .limit(1);
      if (!own || own.length === 0) {
        return res.status(403).json({ error: '自分が担当しているクリエイティブのみSOSを操作できます' });
      }
    }
  }

  const updateData = {
    updated_at: new Date().toISOString()
  };
  if (file_name !== undefined) updateData.file_name = file_name;
  if (status !== undefined) updateData.status = status;
  if (deadline !== undefined) updateData.deadline = deadline;
  if (draft_deadline !== undefined) updateData.draft_deadline = draft_deadline;
  if (final_deadline !== undefined) updateData.final_deadline = final_deadline;
  if (script_url !== undefined) updateData.script_url = script_url;
  if (frameio_url !== undefined) updateData.frameio_url = frameio_url;
  if (delivery_url !== undefined) updateData.delivery_url = delivery_url;
  if (final_delivery_url !== undefined) updateData.final_delivery_url = final_delivery_url;
  if (client_review_url !== undefined) {
    // 空文字 → null として保存（フロントの入力体験に合わせる）
    const trimmed = typeof client_review_url === 'string' ? client_review_url.trim() : client_review_url;
    updateData.client_review_url = trimmed ? trimmed : null;
  }
  if (help_flag !== undefined) updateData.help_flag = help_flag;
  if (talent_flag !== undefined) updateData.talent_flag = talent_flag;
  if (note !== undefined) updateData.note = note;
  if (revision_count !== undefined) updateData.revision_count = revision_count;
  // ADR 011 補足 (2026-05-09 v2): コメント書き込みごとに _updated_at を同時セット。
  //   ・本体 creatives.{director,client,editor}_comment_updated_at を now() で更新する。
  //   ・snapshot 確定時に beforeRow.director_comment_updated_at をコピー保存することで、
  //     過去ラウンドの指摘時刻と編集者の提出時刻を別々に表示できる。
  //   ・列が migration 未適用の本番に対しては後段で fallback（schema-sync 失敗時の安全網）。
  const _commentNowIso = new Date().toISOString();
  if (director_comment !== undefined) {
    updateData.director_comment = director_comment;
    updateData.director_comment_updated_at = _commentNowIso;
  }
  if (client_comment !== undefined) {
    updateData.client_comment = client_comment;
    updateData.client_comment_updated_at = _commentNowIso;
  }
  if (editor_comment !== undefined) {
    updateData.editor_comment = editor_comment;
    updateData.editor_comment_updated_at = _commentNowIso;
  }
  if (creative_type !== undefined) updateData.creative_type = creative_type;
  if (appeal_type_id !== undefined) updateData.appeal_type_id = appeal_type_id || null;
  if (product_id !== undefined) updateData.product_id = product_id || null;
  if (media_code !== undefined) updateData.media_code = media_code || null;
  if (creative_fmt !== undefined) updateData.creative_fmt = creative_fmt || null;
  if (creative_size !== undefined) updateData.creative_size = creative_size || null;
  if (team_id !== undefined) updateData.team_id = team_id || null;
  if (memo !== undefined) updateData.memo = (memo && String(memo).trim()) ? memo : null;

  // 納品完了モード（途中工程をスキップして直接「納品」にする）
  // 必ず理由が必要。クリエイティブファイル未アップロードでも許可。
  if (force_delivered_reason !== undefined) {
    const reason = String(force_delivered_reason || '').trim();
    if (!reason) {
      return res.status(400).json({ error: '納品完了モードでは理由が必須です' });
    }
    updateData.status = '納品';
    updateData.is_payable = true;
    updateData.force_delivered = true;
    updateData.force_delivered_reason = reason;
    updateData.force_delivered_at = new Date().toISOString();
    updateData.force_delivered_by = req.user?.id || null;
  }

  // 納品完了時に支払い可能フラグを自動オン
  if (status === '納品') updateData.is_payable = true;

  // ADR 008 Phase 4: file_name 変更検知用に before の file_name と project を取得しておく。
  //   変更があれば後段で Slack 通知（fire-and-forget）。
  let beforeFileName = null;
  let beforeProjectIdForSlack = null;
  if (updateData.file_name !== undefined) {
    const { data: bf } = await supabase
      .from('creatives')
      .select('file_name, project_id')
      .eq('id', req.params.id)
      .maybeSingle();
    beforeFileName = bf?.file_name ?? null;
    beforeProjectIdForSlack = bf?.project_id ?? null;
  }

  // ステータス変更を検知するため、更新前の値を取得
  // ADR 011: ラウンドsnapshot確定のため、コメント3種も同時に取得する。
  // ADR 011 補足 (2026-05-09 v2): director/client/editor_comment_updated_at も取得して
  //   snapshot 行の director_commented_at / client_commented_at へコピーする。
  //   これにより「過去にディレクターが指摘を書いた時刻」と「今回編集者が再提出した時刻」を
  //   別々に保存・表示できる（PR #446 v1 では beforeRow.updated_at を使っていたが、
  //   ステータス遷移時刻 ≠ 指摘書き込み時刻 のためズレることがあった）。
  let beforeStatus = null;
  let beforeRow = null;
  if (updateData.status !== undefined) {
    let beforeQuery = await supabase
      .from('creatives')
      .select('status, director_comment, editor_comment, client_comment, updated_at, director_comment_updated_at, client_comment_updated_at, editor_comment_updated_at')
      .eq('id', req.params.id)
      .maybeSingle();
    if (beforeQuery.error) {
      const msg = beforeQuery.error.message || '';
      if (/comment_updated_at/.test(msg) || /column .+ does not exist/.test(msg)) {
        // 列欠損環境フォールバック: 旧スキーマで再取得
        beforeQuery = await supabase
          .from('creatives')
          .select('status, director_comment, editor_comment, client_comment, updated_at')
          .eq('id', req.params.id)
          .maybeSingle();
      }
    }
    const before = beforeQuery.data;
    beforeStatus = before?.status || null;
    beforeRow = before || null;
  }

  let { data, error } = await supabase
    .from('creatives')
    .update(updateData)
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) {
    // 新列 (director/client/editor _comment_updated_at) が schema-sync 未適用の環境用フォールバック。
    // 列欠損が原因なら _updated_at 系を抜いて再 UPDATE → 本体更新は成功させる。
    const msg = error.message || '';
    const isMissingNewCol = /comment_updated_at/.test(msg);
    if (isMissingNewCol) {
      const { director_comment_updated_at: _d, client_comment_updated_at: _c, editor_comment_updated_at: _e, ...legacyUpdate } = updateData;
      ({ data, error } = await supabase
        .from('creatives')
        .update(legacyUpdate)
        .eq('id', req.params.id)
        .select()
        .single());
    }
  }
  if (error) return res.status(500).json({ error: error.message });

  // ADR 008 Phase 4: file_name 変更を Slack に通知（fire-and-forget）
  //   - 監査ログテーブルは作らず、Slack への通知のみで運用開始
  //   - 通知先は案件 slack_channel_url > system_settings.broadcast_slack_channel_url の順
  //   - 通知失敗は無視（DB UPDATE は成功させる）
  if (
    updateData.file_name !== undefined &&
    typeof updateData.file_name === 'string' &&
    beforeFileName !== null &&
    beforeFileName !== updateData.file_name
  ) {
    (async () => {
      try {
        const notif = require('../notifications');
        let projectName = '(不明)';
        let projectSlackUrl = null;
        if (beforeProjectIdForSlack) {
          const { data: proj } = await supabase
            .from('projects')
            .select('name, slack_channel_url')
            .eq('id', beforeProjectIdForSlack)
            .maybeSingle();
          if (proj) {
            projectName = proj.name || projectName;
            projectSlackUrl = proj.slack_channel_url || null;
          }
        }
        let actorName = '(不明)';
        if (req.user?.id) {
          const { data: u } = await supabase
            .from('users')
            .select('full_name, nickname')
            .eq('id', req.user.id)
            .maybeSingle();
          actorName = u?.nickname || u?.full_name || actorName;
        }
        let slackUrl = projectSlackUrl;
        if (!slackUrl) {
          const { data: setting } = await supabase
            .from('system_settings')
            .select('value')
            .eq('key', 'broadcast_slack_channel_url')
            .maybeSingle();
          slackUrl = setting?.value || null;
        }
        if (!slackUrl) {
          console.warn('[creative file_name change] no slack channel configured (project + broadcast 両方未設定)');
          return;
        }
        const text =
          `📝 クリエイティブのファイル名が変更されました\n` +
          `案件: ${projectName}\n` +
          `変更者: ${actorName}\n` +
          `変更前: \`${beforeFileName}\`\n` +
          `変更後: \`${updateData.file_name}\``;
        const r = await notif.sendSlackChannel(slackUrl, text);
        if (!r.ok) {
          console.warn('[creative file_name change] slack push failed:', r.reason);
        }
      } catch (e) {
        console.warn('[creative file_name change] slack push error:', e?.message || e);
      }
    })();
  }

  // ADR 011 補足: 全ステータス遷移を creative_status_transitions に audit log として記録。
  //   通常 PUT 経由で status が変わったすべてのケースを 1 行 1 record で残す。
  //   - ラウンド比較 UI の正確な時刻表示 (Dチェック/D後修正/Pチェック等の移行時刻)
  //   - 平均サイクルタイム集計 / 遅延検知 / 案件採算分析の基盤
  //   schema-sync 未適用環境では INSERT が落ちるが warn のみで本処理は止めない。
  if (
    updateData.status !== undefined &&
    beforeRow &&
    beforeRow.status !== updateData.status
  ) {
    try {
      // version_at_change: そのとき creative_files に存在する最大 version。
      //   ラウンド比較 UI で「いつ V2 が Dチェックに進んだか」等の追跡用。
      let versionAtChange = null;
      try {
        const { data: latestFileForCst } = await supabase
          .from('creative_files')
          .select('version')
          .eq('creative_id', req.params.id)
          .order('version', { ascending: false })
          .limit(1)
          .maybeSingle();
        versionAtChange = latestFileForCst?.version ?? null;
      } catch (_) { /* 取得失敗は null のまま */ }

      // PR #(d-to-p-handoff-comment): 同 PUT で status と director_comment / client_comment を
      // 同時送信する UI フロー（saveCreativeDetail）に対応するため、updateData 側に新しい
      // コメントが入っていればそれを優先する。
      //   例: Dチェック→Pチェックで「OK次へ」を書きながら status 遷移するケース。
      //   beforeRow.director_comment は OLD 値（前ラウンドの指摘内容）なので、
      //   それを audit log に残すと「Dチェック→Pチェック の引き継ぎ承認コメント」が
      //   前ラウンドの指摘に化ける。代表 髙橋 報告のラウンド比較UIバグの根本原因。
      const directorCommentAtChange = (updateData.director_comment !== undefined)
        ? (updateData.director_comment ?? null)
        : (beforeRow.director_comment ?? null);
      const clientCommentAtChange = (updateData.client_comment !== undefined)
        ? (updateData.client_comment ?? null)
        : (beforeRow.client_comment ?? null);
      const editorCommentAtChange = (updateData.editor_comment !== undefined)
        ? (updateData.editor_comment ?? null)
        : (beforeRow.editor_comment ?? null);

      const { error: cstErr } = await supabase
        .from('creative_status_transitions')
        .insert({
          creative_id: req.params.id,
          from_status: beforeRow.status,
          to_status:   updateData.status,
          changed_by:  req.user?.id || null,
          changed_at:  new Date().toISOString(),
          director_comment_at_change: directorCommentAtChange,
          client_comment_at_change:   clientCommentAtChange,
          editor_comment_at_change:   editorCommentAtChange,
          version_at_change: versionAtChange,
        });
      if (cstErr) {
        console.warn('[creative_status_transitions] insert failed:', cstErr.message);
      }
    } catch (cstBlockErr) {
      console.warn('[creative_status_transitions] block failed:', cstBlockErr?.message || cstBlockErr);
    }
  }

  // ADR 011: ラウンド snapshot 自動 INSERT
  // 修正済 → 再チェック への遷移時に「指摘＋それに対する次の提出」をペアで frozen 保存。
  // creative_version_history テーブルに 1 行 INSERT。失敗しても fire-and-forget（メイン更新は完了している）。
  try {
    const REVISION_TO_CHECK = {
      'Dチェック後修正':              { newStatus: 'Dチェック',                 stage: 'd_check'  },
      'Pチェック後修正':              { newStatus: 'Pチェック',                 stage: 'p_check'  },
      'クライアントチェック後修正':   { newStatus: 'クライアントチェック中',     stage: 'cl_check' },
    };
    const trans = REVISION_TO_CHECK[beforeStatus];
    if (
      beforeRow &&
      updateData.status !== undefined &&
      trans && updateData.status === trans.newStatus
    ) {
      // 直前のチェック段階で書かれた指摘（director_comment or client_comment）と
      // 今回提出時に編集者が書いた連絡事項（editor_comment）の最新値を frozen 保存。
      // updateData.editor_comment が今回新たに送られてきた場合はそれ、なければ before を使う。
      const editorCommentSnapshot =
        (updateData.editor_comment !== undefined && updateData.editor_comment !== null)
          ? updateData.editor_comment
          : (beforeRow.editor_comment || null);
      // 直近の creative_files から最大 version を取得（このラウンドの提出物）
      const { data: latestFile } = await supabase
        .from('creative_files')
        .select('id, version')
        .eq('creative_id', req.params.id)
        .order('version', { ascending: false })
        .limit(1)
        .maybeSingle();

      // 動画なし提出（代表 髙橋指示・2026-05-09 補足）:
      //   ・creative_file_id は NULL を保存する
      //   ・version_num は「次のラウンド番号」を採番:
      //       - 既存 snapshot が無ければ M+1（M=最新ファイル version、無ければ 0）→ 1 から開始
      //       - 既存 snapshot がある場合: max(snapshot.version_num) + 1
      //   ・editor_comment にプレフィックス [動画なし] を付与（理由は任意）
      let versionNum;
      let fileId;
      let snapshotEditorComment = editorCommentSnapshot;
      if (fileless_progression) {
        // 既存 snapshot の最大 version_num を取得
        let maxSnap = 0;
        try {
          const { data: snapRows } = await supabase
            .from('creative_version_history')
            .select('version_num')
            .eq('creative_id', req.params.id)
            .order('version_num', { ascending: false })
            .limit(1);
          maxSnap = (snapRows && snapRows[0] && Number(snapRows[0].version_num)) || 0;
        } catch (_) { /* 列欠損環境は 0 のまま */ }
        const M = Number(latestFile?.version) || 0;
        const baseline = Math.max(maxSnap, M);
        versionNum = baseline + 1;
        fileId = null;
        // editor_comment に [動画なし] プレフィックス（理由が空でもタグだけは残す）
        const reason = (typeof fileless_reason === 'string' ? fileless_reason : '').trim();
        const tag = reason ? `[動画なし] ${reason}` : '[動画なし]';
        snapshotEditorComment = editorCommentSnapshot
          ? `${tag}\n${editorCommentSnapshot}`
          : tag;
      } else {
        versionNum = latestFile?.version || 1;
        fileId     = latestFile?.id || null;
      }

      // 同一 (creative_id, version_num, round_stage) の二重 INSERT を回避（連打対策）
      const { data: existing } = await supabase
        .from('creative_version_history')
        .select('id')
        .eq('creative_id', req.params.id)
        .eq('version_num', versionNum)
        .eq('round_stage', trans.stage)
        .limit(1);
      if (!existing || existing.length === 0) {
        // タイムスタンプ分離 (PR #446 v2 / ADR 011 補足 2026-05-09):
        //   ・editor_submitted_at   = いま再提出ボタンが押された時刻（= snapshot 確定時刻）
        //   ・director_commented_at = beforeRow.director_comment_updated_at
        //                             （ディレクターが指摘コメントを書いた過去の時刻）
        //   ・client_commented_at   = beforeRow.client_comment_updated_at
        //                             （クライアントが指摘コメントを書いた過去の時刻）
        //   v1 では beforeRow.updated_at（ステータス遷移時刻）を使っていたが、
        //   それだと editor 再提出と director 指摘が同時刻に見える事故が出ていた
        //   （ユーザー報告: V3 提出ラウンドで両方 17:44）。
        //   v2 ではコメント書き込み時刻を creatives 本体に持たせ、それをコピーする。
        //   _updated_at 列が NULL（=migration 直後の既存データ）の場合のみ
        //   beforeRow.updated_at にフォールバックする。
        const nowIso = new Date().toISOString();
        const directorCommentedAt = beforeRow?.director_comment_updated_at || beforeRow?.updated_at || null;
        const clientCommentedAt   = beforeRow?.client_comment_updated_at   || beforeRow?.updated_at || null;
        const insertPayload = {
          creative_id:           req.params.id,
          version_num:           versionNum,
          director_comment:      beforeRow.director_comment || null,
          client_comment:        beforeRow.client_comment   || null,
          editor_comment:        snapshotEditorComment,
          round_stage:           trans.stage,
          creative_file_id:      fileId,
          recorded_by:           req.user?.id || null,
          editor_submitted_at:   nowIso,
          director_commented_at: directorCommentedAt,
          client_commented_at:   clientCommentedAt,
        };
        let { error: histErr } = await supabase
          .from('creative_version_history')
          .insert(insertPayload);
        if (histErr) {
          // 新列 (editor_submitted_at / director_commented_at / client_commented_at) が
          // schema-sync 未適用の環境でも本処理は止めない。新列を抜いて再試行 → それでも
          // ダメなら warn のみ。
          const msg = histErr.message || '';
          const isMissingNewCol = /editor_submitted_at|director_commented_at|client_commented_at/.test(msg);
          if (isMissingNewCol) {
            const { editor_submitted_at: _e, director_commented_at: _d, client_commented_at: _cc, ...legacy } = insertPayload;
            const retry = await supabase.from('creative_version_history').insert(legacy);
            if (retry.error) {
              console.warn('[creative_version_history] snapshot insert failed (after fallback):', retry.error.message);
            }
          } else {
            console.warn('[creative_version_history] snapshot insert failed:', histErr.message);
          }
        }
      }
    }
  } catch (snapErr) {
    console.warn('[creative_version_history] snapshot block failed:', snapErr?.message || snapErr);
  }

  // 担当者更新（assignee_id が送られてきた場合）
  if (assignee_id !== undefined) {
    await supabase.from('creative_assignments').delete().eq('creative_id', req.params.id).eq('role', 'editor');
    if (assignee_id) {
      const { data: assigneeUser } = await supabase.from('users').select('rank').eq('id', assignee_id).single();
      await supabase.from('creative_assignments').insert({
        creative_id: req.params.id,
        user_id: assignee_id,
        role: 'editor',
        rank_applied: assigneeUser?.rank || null,
      });
    }
  }

  // Dチェック担当者更新（director_user_ids（複数）または director_user_id（単数互換）が送られてきた場合）
  // - 案件のメインディレクター以外（サブディレクター・秘書・他チームメンバー等）に Dチェックを依頼するために、
  //   creative_assignments role='director' を「選択されたユーザーIDセット」に同期する。
  //   選択されたが既存にない → INSERT
  //   既存にあるが選択されていない → DELETE
  // - 空配列の場合は no-op（既存維持）。
  // - 互換: director_user_id が送られてきた場合は配列化して扱う。
  let dirIdsInput = null;
  if (Array.isArray(director_user_ids)) {
    dirIdsInput = director_user_ids;
  } else if (director_user_id !== undefined) {
    // 旧UI互換: 空文字 / null の場合は「割当削除（メインDフォールバック）」を意味していたため、空配列で表現
    dirIdsInput = director_user_id ? [director_user_id] : [];
  }
  if (dirIdsInput !== null) {
    // 重複除去 + 偽値除去
    const desiredIds = [...new Set(dirIdsInput.filter(Boolean))];

    if (desiredIds.length === 0) {
      // 旧UIの「メインDフォールバック」と同じ挙動を維持するため、空配列なら全削除する。
      // （新UIは1人以上必須のためここには到達しない想定）
      await supabase.from('creative_assignments')
        .delete().eq('creative_id', req.params.id).eq('role', 'director');
    } else {
      // 既存 director assignment を取得し、差分同期
      const { data: existing } = await supabase
        .from('creative_assignments')
        .select('id, user_id')
        .eq('creative_id', req.params.id)
        .eq('role', 'director');
      const existingIds = new Set((existing || []).map(r => r.user_id).filter(Boolean));
      const desiredSet = new Set(desiredIds);
      const toDelete = (existing || []).filter(r => !desiredSet.has(r.user_id)).map(r => r.id);
      const toInsertIds = desiredIds.filter(id => !existingIds.has(id));

      if (toDelete.length > 0) {
        const { error: dErr } = await supabase
          .from('creative_assignments').delete().in('id', toDelete);
        if (dErr) console.warn('[creative_assignments][director] delete failed:', dErr.message);
      }
      if (toInsertIds.length > 0) {
        // 一括 rank 取得（N+1解消）
        const { data: dirUsers } = await supabase
          .from('users').select('id, rank').in('id', toInsertIds);
        const rankById = new Map((dirUsers || []).map(u => [u.id, u.rank || null]));
        const rows = toInsertIds.map(uid => ({
          creative_id: req.params.id,
          user_id: uid,
          role: 'director',
          rank_applied: rankById.get(uid) || null,
        }));
        const { error: iErr } = await supabase.from('creative_assignments').insert(rows);
        if (iErr) console.warn('[creative_assignments][director] insert failed:', iErr.message);
      }
    }
  }

  // Pチェック担当者更新（producer_user_ids（複数）が送られてきた場合）
  // - 案件のメインプロデューサー以外（サブP・秘書・他チームメンバー等）に Pチェックを依頼するために、
  //   creative_assignments role='producer' を「選択されたユーザーIDセット」に同期する。
  //   選択されたが既存にない → INSERT
  //   既存にあるが選択されていない → DELETE
  // - 空配列の場合は全削除（新UIは1人以上必須のため通常到達しない）。
  // 設計は director_user_ids と同等（PR #218 と対称）。
  if (Array.isArray(producer_user_ids)) {
    const desiredIds = [...new Set(producer_user_ids.filter(Boolean))];

    if (desiredIds.length === 0) {
      await supabase.from('creative_assignments')
        .delete().eq('creative_id', req.params.id).eq('role', 'producer');
    } else {
      const { data: existing } = await supabase
        .from('creative_assignments')
        .select('id, user_id')
        .eq('creative_id', req.params.id)
        .eq('role', 'producer');
      const existingIds = new Set((existing || []).map(r => r.user_id).filter(Boolean));
      const desiredSet = new Set(desiredIds);
      const toDelete = (existing || []).filter(r => !desiredSet.has(r.user_id)).map(r => r.id);
      const toInsertIds = desiredIds.filter(id => !existingIds.has(id));

      if (toDelete.length > 0) {
        const { error: dErr } = await supabase
          .from('creative_assignments').delete().in('id', toDelete);
        if (dErr) console.warn('[creative_assignments][producer] delete failed:', dErr.message);
      }
      if (toInsertIds.length > 0) {
        // 一括 rank 取得（N+1解消）
        const { data: prdUsers } = await supabase
          .from('users').select('id, rank').in('id', toInsertIds);
        const rankById = new Map((prdUsers || []).map(u => [u.id, u.rank || null]));
        const rows = toInsertIds.map(uid => ({
          creative_id: req.params.id,
          user_id: uid,
          role: 'producer',
          rank_applied: rankById.get(uid) || null,
        }));
        const { error: iErr } = await supabase.from('creative_assignments').insert(rows);
        if (iErr) console.warn('[creative_assignments][producer] insert failed:', iErr.message);
      }
    }
  }

  // 「クライアントチェック中」遷移時の Drive 自動共有（同期実行）
  // - 通知より先に実行して client_review_url を確定させる
  // - 失敗してもクリエイティブ更新自体は完遂（手動入力フォールバック）
  // - 既存値があれば上書きしない（lib/drive-share 側で保護）
  const STATUS_CLIENT_REVIEW = 'クライアントチェック中';
  if (
    updateData.status === STATUS_CLIENT_REVIEW &&
    beforeStatus !== STATUS_CLIENT_REVIEW
  ) {
    try {
      const result = await shareForClientReview({ creativeId: req.params.id });
      console.log('[client-review] auto-share:', { creativeId: req.params.id, ...result });
    } catch (err) {
      console.error('[client-review] auto-share failed:', err?.stack || err?.message || err, { creativeId: req.params.id });
    }
  }

  // ステータスが実際に変わったときだけ Slack/Chatwork 通知（fire-and-forget）
  if (updateData.status !== undefined && beforeStatus !== updateData.status) {
    try {
      const notif = require('../notifications');
      notif.notifyCreativeStatusChange({
        creative: { id: req.params.id },
        oldStatus: beforeStatus,
        newStatus: updateData.status,
        comment: req.body.review_comment || req.body.director_comment || req.body.client_comment || req.body.editor_comment || null,
        actorUserId: req.user?.id || null,
      }).catch(e => console.warn('[notif] failed:', e.message));
    } catch (e) {
      console.warn('[notif] enqueue failed:', e.message);
    }
  }

  // ball_holder_id キャッシュ更新（status / assignee / director が変わった場合のみ）
  // 派生計算を実列にUPDATEして notify_ball_returned トリガーで通知が発火する。
  // - 複数ディレクター指定時は getBallHolder() が role='director' の最初のassignmentを採用する仕様（合理的フォールバック）
  if (
    updateData.status !== undefined ||
    assignee_id !== undefined ||
    director_user_id !== undefined ||
    director_user_ids !== undefined ||
    producer_user_ids !== undefined
  ) {
    syncBallHolderId(req.params.id).catch(e => console.warn('[ball_holder_id] sync failed:', e.message));
  }

  res.json(data);
});

// ============================================================
// 事後修正モード（クリエイティブ追加時の取り違え救済）
// ============================================================
// 背景: クリエイティブ追加時に案件を取り違えて登録するケース（同名クライアントの動画/デザイン案件混同等）
//       がある。後から正しい案件・属性に付け替え、変更履歴を creative_edit_logs に残す。
//
// 編集可能項目:
//   - project_id（最重要・案件取り違え救済の主目的）
//   - cycle_id（project_id 変更時は必ずクリアし、フロント側で再選択）
//   - product_id, appeal_type_id（project_id に紐づくため、案件変更時は再選択必須）
//   - creative_type, file_name, memo, note
//
// 権限:
//   - admin / secretary は無条件で可
//   - producer / producer_director / director は「自分が当該クリエイティブの旧 project の director_id / producer_id /
//     creative_assignments(role='director' or 'producer') のいずれかに該当」する場合のみ可
//   - editor / designer は不可（自分担当でも不可）
//
// 整合性ガード:
//   - status='納品' / force_delivered=true / 紐づく invoice_items の親 invoices.status != 'draft' → project_id 変更を禁止
//     （その他項目は変更可）
//
// reason は project_id を変更するときのみ必須。それ以外は任意。
//
// すべての変更は creative_edit_logs にフィールドごと1行ずつ INSERT する。
//
// ============================================================

// 「事後修正モード」での編集可否を判定するヘルパー（権限 + ガード）
async function evaluateCreativeEditEligibility(creativeId, userId, userRole) {
  // 1. 対象クリエイティブを取得
  const { data: c, error: cErr } = await supabase
    .from('creatives')
    .select('id, project_id, status, force_delivered, projects:project_id(director_id, producer_id)')
    .eq('id', creativeId)
    .maybeSingle();
  if (cErr) return { ok: false, status: 500, error: cErr.message };
  if (!c) return { ok: false, status: 404, error: 'クリエイティブが見つかりません' };

  // 2. 権限判定
  const ALLOW_ANY = ['admin', 'secretary'];
  const ALLOW_OWN = ['producer', 'producer_director', 'director'];
  let canEdit = false;
  let canChangeProject = true;
  let projectChangeBlockedReason = null;

  if (ALLOW_ANY.includes(userRole)) {
    canEdit = true;
  } else if (ALLOW_OWN.includes(userRole)) {
    // 旧 project の director / producer 本人 OR creative_assignments(role='director'|'producer') 本人
    const isProjectLeader =
      (c.projects?.director_id && c.projects.director_id === userId) ||
      (c.projects?.producer_id && c.projects.producer_id === userId);
    let isAssigned = false;
    if (!isProjectLeader) {
      const { data: asn } = await supabase
        .from('creative_assignments')
        .select('id')
        .eq('creative_id', creativeId)
        .eq('user_id', userId)
        .in('role', ['director', 'producer'])
        .limit(1);
      isAssigned = (asn && asn.length > 0);
    }
    canEdit = isProjectLeader || isAssigned;
  }

  if (!canEdit) {
    return { ok: false, status: 403, error: '事後修正モードを使用する権限がありません（admin / secretary / 担当プロデューサー / 担当ディレクター のみ操作可能）' };
  }

  // 3. 案件変更ガード: 納品済み / force_delivered / 確定済み請求書に紐付く
  const DELIVERED_STATUSES = ['納品', '完納', '納品済'];
  if (DELIVERED_STATUSES.includes(c.status) || c.force_delivered === true) {
    canChangeProject = false;
    projectChangeBlockedReason = '納品済みのため案件を変更できません（その他項目は変更可）';
  }
  if (canChangeProject) {
    const { data: linked } = await supabase
      .from('invoice_items')
      .select('id, invoice:invoices(status)')
      .eq('creative_id', creativeId);
    const hasFinalized = (linked || []).some(it => it.invoice && it.invoice.status && it.invoice.status !== 'draft');
    if (hasFinalized) {
      canChangeProject = false;
      projectChangeBlockedReason = '請求書が発行・確定済みのため案件を変更できません（その他項目は変更可）';
    }
  }

  return { ok: true, creative: c, canChangeProject, projectChangeBlockedReason };
}

// GET /api/creatives/:id/edit-eligibility
// フロント: 「編集」ボタン表示制御 + 案件変更可否のグレーアウトに使用
router.get('/creatives/:id/edit-eligibility', requireAuth, async (req, res) => {
  const role = getEffectiveRole(req);
  const result = await evaluateCreativeEditEligibility(req.params.id, req.user?.id, role);
  if (!result.ok) {
    // 403/404/500 はそのまま返す。フロントは「編集」ボタン非表示とする。
    return res.status(result.status).json({ error: result.error, can_edit: false });
  }
  res.json({
    can_edit: true,
    can_change_project: result.canChangeProject,
    project_change_blocked_reason: result.projectChangeBlockedReason,
  });
});

// PUT /api/creatives/:id/edit-mode
// 事後修正モード本体。通常の PUT /creatives/:id とは独立した経路で、変更ごとに監査ログを残す。
router.put('/creatives/:id/edit-mode', requireAuth, async (req, res) => {
  const creativeId = req.params.id;
  const role = getEffectiveRole(req);
  const eligibility = await evaluateCreativeEditEligibility(creativeId, req.user?.id, role);
  if (!eligibility.ok) {
    return res.status(eligibility.status).json({ error: eligibility.error });
  }

  // 受付項目（ホワイトリスト）— 通常 PUT との混線を避けるため明示的に絞る
  // draft_deadline / final_deadline は事後修正で日付ごと修正できるよう追加（PR #TBD）
  const ALLOWED = ['project_id', 'creative_type', 'file_name', 'product_id', 'appeal_type_id', 'memo', 'note', 'draft_deadline', 'final_deadline'];
  const DATE_FIELDS = new Set(['draft_deadline', 'final_deadline']);
  const reason = (req.body?.reason ?? '').toString().trim() || null;
  const incoming = {};
  for (const k of ALLOWED) {
    if (k in (req.body || {})) {
      let v = req.body[k];
      if (typeof v === 'string') v = v.trim();
      if (v === '') v = null;
      // 日付は YYYY-MM-DD のみ受け付け（簡易 validate）
      if (DATE_FIELDS.has(k) && v != null) {
        const m = String(v).match(/^(\d{4}-\d{2}-\d{2})/);
        if (!m) {
          return res.status(400).json({ error: `${k} は YYYY-MM-DD 形式で指定してください` });
        }
        v = m[1];
      }
      incoming[k] = v;
    }
  }
  if (Object.keys(incoming).length === 0) {
    return res.status(400).json({ error: '変更項目がありません' });
  }

  // 旧クリエイティブをフルロードして差分計算 + 表示用スナップショット作成
  const { data: before, error: beforeErr } = await supabase
    .from('creatives')
    .select('id, project_id, creative_type, file_name, product_id, appeal_type_id, memo, note, draft_deadline, final_deadline, projects:project_id(id, name)')
    .eq('id', creativeId)
    .maybeSingle();
  if (beforeErr) return res.status(500).json({ error: beforeErr.message });
  if (!before) return res.status(404).json({ error: 'クリエイティブが見つかりません' });

  // project_id 変更: ガード + 整合性: cycle_id / product_id / appeal_type_id をクリアまたはフロントで再指定
  const projectChanged = ('project_id' in incoming) && incoming.project_id !== before.project_id;
  if (projectChanged) {
    if (!eligibility.canChangeProject) {
      return res.status(400).json({ error: eligibility.projectChangeBlockedReason || '案件を変更できません' });
    }
    if (!reason) {
      return res.status(400).json({ error: '案件変更時は「変更理由」が必須です' });
    }
    if (!incoming.project_id) {
      return res.status(400).json({ error: '案件は必須です' });
    }
    // 移動先案件が実在するか確認
    const { data: dst } = await supabase.from('projects').select('id, name').eq('id', incoming.project_id).maybeSingle();
    if (!dst) return res.status(400).json({ error: '指定された案件が見つかりません' });

    // 案件変更時は cycle_id をリセット（旧案件の月次サイクルは別案件に持ち越せない）
    incoming.cycle_id = null;
    // product_id / appeal_type_id がフロントから明示送信されていなければ null にリセット（整合性）
    if (!('product_id' in incoming)) incoming.product_id = null;
    if (!('appeal_type_id' in incoming)) incoming.appeal_type_id = null;
  }

  // 表示用スナップショットを作るために旧 product / appeal の名称を取得
  // 商材は client_products / project_products どちらかに格納されている（sync_products フラグ依存）→ 両方を試行
  // 訴求軸も同様に client_appeal_axes / project_appeal_axes
  async function lookupProductName(id) {
    if (!id) return null;
    let r = await supabase.from('client_products').select('name').eq('id', id).maybeSingle();
    if (r.data?.name) return r.data.name;
    r = await supabase.from('project_products').select('name').eq('id', id).maybeSingle();
    return r.data?.name || null;
  }
  async function lookupAppealName(id) {
    if (!id) return null;
    let r = await supabase.from('client_appeal_axes').select('name').eq('id', id).maybeSingle();
    if (r.data?.name) return r.data.name;
    r = await supabase.from('project_appeal_axes').select('name').eq('id', id).maybeSingle();
    return r.data?.name || null;
  }

  const oldProductName = await lookupProductName(before.product_id);
  const oldAppealName = await lookupAppealName(before.appeal_type_id);
  const newProjectName = projectChanged
    ? (await supabase.from('projects').select('name').eq('id', incoming.project_id).maybeSingle()).data?.name || null
    : (before.projects?.name || null);
  const newProductName = ('product_id' in incoming) ? await lookupProductName(incoming.product_id) : null;
  const newAppealName = ('appeal_type_id' in incoming) ? await lookupAppealName(incoming.appeal_type_id) : null;

  // 差分検出 + ログ行作成
  const editorName = req.user?.full_name || req.user?.nickname || req.user?.email || null;
  const logRows = [];
  const fieldDisplay = {
    project_id: { old: before.projects?.name || null, new: newProjectName },
    product_id: { old: oldProductName, new: newProductName },
    appeal_type_id: { old: oldAppealName, new: newAppealName },
  };
  // 日付列は DB 側が ISO（YYYY-MM-DDTHH:mm:ss）/ Date オブジェクト等で返す可能性があるため、
  // 比較・ログ表示は YYYY-MM-DD に正規化する。
  const _normYmd = (v) => {
    if (v == null) return null;
    const s = String(v);
    const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : s;
  };
  for (const [k, v] of Object.entries(incoming)) {
    if (k === 'cycle_id') continue; // 表示しない（project_id 変更に付随する内部リセット）
    const isDate = DATE_FIELDS.has(k);
    const oldRaw = isDate ? _normYmd(before[k] ?? null) : (before[k] ?? null);
    const newRaw = isDate ? _normYmd(v ?? null) : (v ?? null);
    if (oldRaw === newRaw) continue;
    const disp = fieldDisplay[k];
    logRows.push({
      creative_id: creativeId,
      edited_by: req.user?.id || null,
      edited_by_name: editorName,
      field_name: k,
      old_value: disp ? (disp.old ?? (oldRaw ? String(oldRaw) : null)) : (oldRaw == null ? null : String(oldRaw)),
      new_value: disp ? (disp.new ?? (newRaw ? String(newRaw) : null)) : (newRaw == null ? null : String(newRaw)),
      reason: reason,
    });
  }
  if (logRows.length === 0) {
    return res.status(400).json({ error: '実際の変更がありません' });
  }

  // 案件変更時、旧案件の director / producer 担当が新案件で不整合になる可能性があるが、
  // 担当者は creative_assignments で明示管理されているため自動クリアはしない（既存担当をそのまま維持）。
  // 必要なら詳細モーダルから別途 D/P チェッカーで再指定できる。

  // 監査ログを先に INSERT（更新失敗時にログだけ残るのは許容: 後から状況を追える）
  const { error: logErr } = await supabase.from('creative_edit_logs').insert(logRows);
  if (logErr) {
    return res.status(500).json({ error: '監査ログ記録に失敗しました: ' + logErr.message });
  }

  // 本体 UPDATE（cycle_id 含む）
  const updatePayload = { ...incoming, updated_at: new Date().toISOString() };
  const { data: updated, error: updErr } = await supabase
    .from('creatives')
    .update(updatePayload)
    .eq('id', creativeId)
    .select()
    .single();
  if (updErr) return res.status(500).json({ error: updErr.message });

  // ボール保持者キャッシュは project 変更でも担当が変わらない限り影響しないが、念のため同期
  if (projectChanged) {
    syncBallHolderId(creativeId).catch(e => console.warn('[ball_holder_id] sync failed:', e.message));
  }

  res.json({ ok: true, creative: updated, log_count: logRows.length });
});

// GET /api/creatives/:id/edit-logs
// 事後修正モードの編集履歴を取得（クリエイティブ詳細画面の下部に表示）
router.get('/creatives/:id/edit-logs', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('creative_edit_logs')
    .select('id, creative_id, edited_by, edited_by_name, edited_at, field_name, old_value, new_value, reason, editor:edited_by(id, full_name, nickname, avatar_url)')
    .eq('creative_id', req.params.id)
    .order('edited_at', { ascending: false })
    .limit(200);
  if (error) {
    // 列・テーブル未適用環境では空配列を返す（schema-cache 反映待ち等で UI を壊さない）
    console.warn('[creative_edit_logs] fetch failed:', error.message);
    return res.json([]);
  }
  res.json(data || []);
});

// ==================== ADR 013: クリエイティブ単価上書き ====================
// 詳細: docs/design/decisions/012-creative-level-rate-overrides.md
// migrations: 2026-05-10_creative_rate_overrides.sql
//
// - GET /api/creatives/:id/rate-overrides   読み取り（誰でも）
// - PUT /api/creatives/:id/rate-overrides   admin のみ
//
// creatives.override_client_amount: クライアント請求額の上書き（NULL=line 継承）
// creative_cost_overrides: ロール別支払額の上書き（差分同期：配列に無い既存行は DELETE）
//
// creative_assignments.role は TEXT (role code) なので、roles.code → roles.id のマッピングを噛ませて
// 「現在の担当 (role × user)」と line_costs / overrides を結合する。

// creative_cost_overrides テーブル未作成時に PostgREST が出すエラーを判定
function _isMissingCostOverridesTable(err) {
  if (!err) return false;
  const code = err.code || '';
  const msg = (err.message || '').toLowerCase();
  return code === '42P01' || msg.includes('creative_cost_overrides');
}

// GET /api/creatives/:id/rate-overrides
router.get('/creatives/:id/rate-overrides', requireAuth, async (req, res) => {
  const creativeId = req.params.id;

  const { data: creative, error: cErr } = await supabase
    .from('creatives')
    .select('id, line_id, override_client_amount, creative_assignments(id, role, user_id, users:user_id(id, full_name, email))')
    .eq('id', creativeId)
    .maybeSingle();
  if (cErr) {
    // 列未追加（migration 未適用）でも UI が壊れないよう、override_client_amount を外して再試行
    if ((cErr.message || '').includes('override_client_amount')) {
      const { data: fallback } = await supabase
        .from('creatives')
        .select('id, line_id, creative_assignments(id, role, user_id, users:user_id(id, full_name, email))')
        .eq('id', creativeId)
        .maybeSingle();
      if (!fallback) return res.status(404).json({ error: 'クリエイティブが見つかりません' });
      return res.json({
        creative_id: creativeId,
        override_client_amount: null,
        line_client_unit_price: null,
        cost_overrides: [],
        line_costs: [],
        _migration_pending: true,
      });
    }
    return res.status(500).json({ error: cErr.message });
  }
  if (!creative) return res.status(404).json({ error: 'クリエイティブが見つかりません' });

  // line（client_unit_price 取得用）
  let lineClientUnitPrice = null;
  if (creative.line_id) {
    const { data: line } = await supabase
      .from('project_estimate_lines')
      .select('id, client_unit_price')
      .eq('id', creative.line_id)
      .maybeSingle();
    lineClientUnitPrice = line?.client_unit_price ?? null;
  }

  // line_costs（あれば）
  let lineCosts = [];
  if (creative.line_id) {
    const { data: lc, error: lcErr } = await supabase
      .from('project_estimate_line_costs')
      .select('id, role_id, user_id, unit_price, role:roles(id, code, label), user:users(id, full_name, email)')
      .eq('line_id', creative.line_id);
    if (!lcErr && Array.isArray(lc)) {
      lineCosts = lc.map(r => ({
        role_id: r.role_id,
        role_code: r.role?.code || null,
        role_name_ja: r.role?.label || null,
        user_id: r.user_id,
        user_name: r.user?.full_name || r.user?.email || null,
        amount: r.unit_price ?? null,
      }));
    }
  }

  // 担当 (creative_assignments.role: TEXT) → roles.id マッピング
  const assignments = Array.isArray(creative.creative_assignments) ? creative.creative_assignments : [];
  const assignedCodes = Array.from(new Set(assignments.map(a => {
    let code = a?.role || '';
    if (code === 'director_as_editor') code = 'editor';
    return code;
  }).filter(Boolean)));
  let codeToRole = {};
  if (assignedCodes.length > 0) {
    const { data: rolesData } = await supabase
      .from('roles')
      .select('id, code, label')
      .in('code', assignedCodes);
    for (const r of (rolesData || [])) codeToRole[r.code] = r;
  }

  // 既存 overrides
  let existingOverrides = [];
  {
    const { data, error } = await supabase
      .from('creative_cost_overrides')
      .select('id, role_id, user_id, amount, note')
      .eq('creative_id', creativeId);
    if (error) {
      if (_isMissingCostOverridesTable(error)) {
        console.warn('[rate-overrides] creative_cost_overrides table missing. Apply migrations/2026-05-10_creative_rate_overrides.sql');
      } else {
        return res.status(500).json({ error: error.message });
      }
    } else if (Array.isArray(data)) {
      existingOverrides = data;
    }
  }

  // 担当 (role × user) ごとに行を作る
  const seen = new Set();
  const costOverrides = [];
  for (const a of assignments) {
    const code = (a.role === 'director_as_editor') ? 'editor' : a.role;
    const role = codeToRole[code];
    if (!role) continue;
    const userId = a.user_id || null;
    const key = `${role.id}::${userId || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const ov = existingOverrides.find(o => o.role_id === role.id && (o.user_id || null) === userId);
    const lineMatch = lineCosts.find(lc => lc.role_id === role.id && (lc.user_id || null) === userId);
    costOverrides.push({
      role_id: role.id,
      role_code: role.code,
      role_name_ja: role.label,
      user_id: userId,
      user_name: a?.users?.full_name || a?.users?.email || null,
      amount: ov ? Number(ov.amount) : null,
      line_amount: lineMatch ? lineMatch.amount : null,
    });
  }

  // 担当に存在しないが override だけ残っている行も末尾に追加（孤立データの可視化）
  for (const o of existingOverrides) {
    const key = `${o.role_id}::${o.user_id || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let roleLabel = null;
    let userName = null;
    {
      const { data: r } = await supabase.from('roles').select('id, code, label').eq('id', o.role_id).maybeSingle();
      roleLabel = r?.label || null;
    }
    if (o.user_id) {
      const { data: u } = await supabase.from('users').select('id, full_name, email').eq('id', o.user_id).maybeSingle();
      userName = u?.full_name || u?.email || null;
    }
    costOverrides.push({
      role_id: o.role_id,
      role_code: null,
      role_name_ja: roleLabel,
      user_id: o.user_id || null,
      user_name: userName,
      amount: Number(o.amount),
      line_amount: null,
    });
  }

  res.json({
    creative_id: creativeId,
    override_client_amount: creative.override_client_amount ?? null,
    line_client_unit_price: lineClientUnitPrice,
    cost_overrides: costOverrides,
    line_costs: lineCosts,
  });
});

// PUT /api/creatives/:id/rate-overrides  （admin のみ）
// body: { override_client_amount: number|null, cost_overrides: [{ role_id, user_id, amount, note }, ...] }
//
// 仕様:
// - admin 以外は 403
// - override_client_amount が null/undefined → creatives.override_client_amount = NULL
// - cost_overrides 配列に存在する (role_id, user_id) を upsert、配列に無い既存行は DELETE（差分同期）
// - 監査ログ creative_edit_logs に rate_override:* の field_name で before/after を記録
router.put('/creatives/:id/rate-overrides', requireAuth, async (req, res) => {
  const creativeId = req.params.id;
  const role = getEffectiveRole(req);
  if (role !== 'admin') {
    return res.status(403).json({ error: '単価上書きは管理者のみが編集できます' });
  }

  const body = req.body || {};
  const incoming = Array.isArray(body.cost_overrides) ? body.cost_overrides : [];
  let newClientAmount = body.override_client_amount;
  if (newClientAmount === undefined || newClientAmount === '' || newClientAmount === null) {
    newClientAmount = null;
  } else {
    const n = Number(newClientAmount);
    if (!Number.isFinite(n) || n < 0) {
      return res.status(400).json({ error: 'override_client_amount は 0 以上の数値か null で指定してください' });
    }
    newClientAmount = n;
  }

  const { data: before, error: bErr } = await supabase
    .from('creatives')
    .select('id, override_client_amount')
    .eq('id', creativeId)
    .maybeSingle();
  if (bErr) {
    if ((bErr.message || '').includes('override_client_amount')) {
      return res.status(503).json({ error: 'creatives.override_client_amount 列が未作成です。migrations/2026-05-10_creative_rate_overrides.sql を本番Supabase に適用してください。' });
    }
    return res.status(500).json({ error: bErr.message });
  }
  if (!before) return res.status(404).json({ error: 'クリエイティブが見つかりません' });

  for (const r of incoming) {
    if (!r || !r.role_id) {
      return res.status(400).json({ error: 'cost_overrides の各要素には role_id が必要です' });
    }
    const n = Number(r.amount);
    if (!Number.isFinite(n) || n < 0) {
      return res.status(400).json({ error: 'cost_overrides の amount は 0 以上の数値で指定してください' });
    }
    r.amount = n;
    r.user_id = r.user_id || null;
    r.note = (r.note ?? null);
  }

  const { data: existing, error: eErr } = await supabase
    .from('creative_cost_overrides')
    .select('id, role_id, user_id, amount')
    .eq('creative_id', creativeId);
  if (eErr) {
    if (_isMissingCostOverridesTable(eErr)) {
      return res.status(503).json({ error: 'creative_cost_overrides テーブルが未作成です。migrations/2026-05-10_creative_rate_overrides.sql を本番Supabase に適用してください。' });
    }
    return res.status(500).json({ error: eErr.message });
  }
  const existingArr = existing || [];
  const keyOf = (roleId, userId) => `${roleId}::${userId || ''}`;
  const incomingKeys = new Set(incoming.map(r => keyOf(r.role_id, r.user_id)));
  const editorName = req.user?.full_name || req.user?.nickname || req.user?.email || null;
  const editorId = req.user?.id || null;
  const nowIso = new Date().toISOString();
  const logRows = [];

  // 1) override_client_amount の差分
  if ((before.override_client_amount ?? null) !== (newClientAmount ?? null)) {
    const { error: upErr } = await supabase
      .from('creatives')
      .update({ override_client_amount: newClientAmount, updated_at: nowIso })
      .eq('id', creativeId);
    if (upErr) return res.status(500).json({ error: upErr.message });
    logRows.push({
      creative_id: creativeId,
      edited_by: editorId,
      edited_by_name: editorName,
      field_name: 'rate_override:override_client_amount',
      old_value: before.override_client_amount == null ? null : String(before.override_client_amount),
      new_value: newClientAmount == null ? null : String(newClientAmount),
      reason: null,
    });
  }

  // 2) cost_overrides の差分同期（INSERT/UPDATE/DELETE）
  const roleIds = Array.from(new Set([
    ...incoming.map(r => r.role_id),
    ...existingArr.map(r => r.role_id),
  ].filter(Boolean)));
  const userIds = Array.from(new Set([
    ...incoming.map(r => r.user_id).filter(Boolean),
    ...existingArr.map(r => r.user_id).filter(Boolean),
  ]));
  const roleMap = {};
  if (roleIds.length > 0) {
    const { data: rs } = await supabase.from('roles').select('id, code, label').in('id', roleIds);
    for (const r of (rs || [])) roleMap[r.id] = r;
  }
  const userMap = {};
  if (userIds.length > 0) {
    const { data: us } = await supabase.from('users').select('id, full_name, email').in('id', userIds);
    for (const u of (us || [])) userMap[u.id] = u;
  }
  const dispLabel = (roleId, userId) => {
    const r = roleMap[roleId];
    const u = userId ? userMap[userId] : null;
    const roleLabel = r?.label || roleId;
    const userLabel = u ? (u.full_name || u.email || userId) : '（ロール全体）';
    return `${roleLabel} / ${userLabel}`;
  };

  // DELETE: 既存にあるが incoming に無い
  const toDelete = existingArr.filter(r => !incomingKeys.has(keyOf(r.role_id, r.user_id)));
  if (toDelete.length > 0) {
    const ids = toDelete.map(r => r.id);
    const { error: delErr } = await supabase
      .from('creative_cost_overrides')
      .delete()
      .in('id', ids);
    if (delErr) return res.status(500).json({ error: delErr.message });
    for (const r of toDelete) {
      logRows.push({
        creative_id: creativeId,
        edited_by: editorId,
        edited_by_name: editorName,
        field_name: `rate_override:cost:${dispLabel(r.role_id, r.user_id)}`,
        old_value: String(r.amount),
        new_value: null,
        reason: null,
      });
    }
  }

  // UPSERT
  for (const r of incoming) {
    const prior = existingArr.find(e => e.role_id === r.role_id && (e.user_id || null) === r.user_id);
    if (prior) {
      if (Number(prior.amount) === Number(r.amount)) continue;
      const { error: upErr } = await supabase
        .from('creative_cost_overrides')
        .update({ amount: r.amount, note: r.note, updated_by: editorId })
        .eq('id', prior.id);
      if (upErr) return res.status(500).json({ error: upErr.message });
      logRows.push({
        creative_id: creativeId,
        edited_by: editorId,
        edited_by_name: editorName,
        field_name: `rate_override:cost:${dispLabel(r.role_id, r.user_id)}`,
        old_value: String(prior.amount),
        new_value: String(r.amount),
        reason: null,
      });
    } else {
      const { error: insErr } = await supabase
        .from('creative_cost_overrides')
        .insert({
          creative_id: creativeId,
          role_id: r.role_id,
          user_id: r.user_id || null,
          amount: r.amount,
          note: r.note,
          created_by: editorId,
          updated_by: editorId,
        });
      if (insErr) {
        if (_isMissingCostOverridesTable(insErr)) {
          return res.status(503).json({ error: 'creative_cost_overrides テーブルが未作成です。migrations/2026-05-10_creative_rate_overrides.sql を本番Supabase に適用してください。' });
        }
        return res.status(500).json({ error: insErr.message });
      }
      logRows.push({
        creative_id: creativeId,
        edited_by: editorId,
        edited_by_name: editorName,
        field_name: `rate_override:cost:${dispLabel(r.role_id, r.user_id)}`,
        old_value: null,
        new_value: String(r.amount),
        reason: null,
      });
    }
  }

  // 監査ログ（一括 INSERT）。失敗しても本処理は巻き戻さない
  if (logRows.length > 0) {
    const { error: logErr } = await supabase.from('creative_edit_logs').insert(logRows);
    if (logErr) {
      console.warn('[rate-overrides] audit log insert failed:', logErr.message);
    }
  }

  res.json({ ok: true, change_count: logRows.length });
});

// 単発再共有エンドポイント
//   POST /creatives/:id/share-client-review            -> 既存値を尊重
//   POST /creatives/:id/share-client-review?force=true -> 既存値を上書き
// 用途: 自動共有が失敗した／別ファイルにすり替えたい等、管理者操作用
router.post('/creatives/:id/share-client-review', requireAuth, requirePermission('project.create_edit'), async (req, res) => {
  const force = req.query?.force === 'true' || req.query?.force === '1' || req.body?.force === true;
  try {
    const result = await shareForClientReview({ creativeId: req.params.id, force });
    res.json(result);
  } catch (err) {
    console.error('[client-review] manual share failed:', err?.stack || err?.message || err, { creativeId: req.params.id });
    res.status(500).json({ error: err?.message || 'auto-share failed' });
  }
});

// 管理者によるステータス強制変更（戻し含む）
//
// セキュリティ:
//   - 管理者のみ実行可（VIEW AS の偽装を許さないため effectiveRole で判定）
//   - 理由必須
//
// 統計の整合性ガード:
//   - 該当 creative が請求書明細に紐づいている場合:
//     - 提出済 / 承認済 invoice の明細が含まれる → ブロック（売上計上済の本数を後から動かさない）
//     - 下書き invoice の明細のみ → 削除して invoice 合計を再計算（下書きは集計に出ないので OK）
//   - 戻し先が「納品」以外なら is_payable=false / force_delivered* を全クリア
//   - すべての変更を creative_status_audit に記録
router.post('/creatives/:id/admin-status', requireAuth, async (req, res) => {
  const role = getEffectiveRole(req);
  if (role !== 'admin') return res.status(403).json({ error: '管理者のみ実行できます' });

  const { status: newStatus, reason } = req.body || {};
  const r = String(reason || '').trim();
  if (!newStatus) return res.status(400).json({ error: 'status は必須です' });
  if (!r)         return res.status(400).json({ error: '理由は必須です' });

  // ADR 011 補足: 遷移 audit log のためコメント3種も同時取得しておく。
  const { data: creative, error: cErr } = await supabase
    .from('creatives')
    .select('id, status, director_comment, client_comment, editor_comment')
    .eq('id', req.params.id)
    .maybeSingle();
  if (cErr) return res.status(500).json({ error: cErr.message });
  if (!creative) return res.status(404).json({ error: 'クリエイティブが見つかりません' });

  if (creative.status === newStatus) {
    return res.json({ ok: true, no_change: true });
  }

  // 請求書紐付けチェック
  const { data: items } = await supabase
    .from('invoice_items')
    .select('id, invoice_id, total_amount, invoice:invoices(id, invoice_number, status)')
    .eq('creative_id', req.params.id);

  const issuedItems = (items || []).filter(i => i.invoice && i.invoice.status !== 'draft');
  if (issuedItems.length > 0) {
    const nums = Array.from(new Set(issuedItems.map(i => `${i.invoice.invoice_number}（${i.invoice.status}）`)));
    return res.status(409).json({
      error:
        '提出済/承認済の請求書に明細として登録されているためステータスを変更できません。\n' +
        '統計の整合性を保つため、先に該当請求書を取り下げる必要があります。\n\n' +
        '対象請求書: ' + nums.join(', '),
    });
  }

  // 下書き明細の削除 + invoice 合計の再計算
  const draftItems = (items || []).filter(i => i.invoice && i.invoice.status === 'draft');
  const deletedItemIds = draftItems.map(i => i.id);
  const affectedInvoiceIds = Array.from(new Set(draftItems.map(i => i.invoice_id)));
  if (deletedItemIds.length > 0) {
    await supabase.from('invoice_item_details').delete().in('invoice_item_id', deletedItemIds);
    const { error: delErr } = await supabase.from('invoice_items').delete().in('id', deletedItemIds);
    if (delErr) return res.status(500).json({ error: delErr.message });

    for (const invId of affectedInvoiceIds) {
      const { data: rem } = await supabase
        .from('invoice_items').select('total_amount').eq('invoice_id', invId);
      const total = (rem || []).reduce((s, x) => s + (x.total_amount || 0), 0);
      await supabase.from('invoices')
        .update({ total_amount: total, updated_at: new Date().toISOString() })
        .eq('id', invId);
    }
  }

  // クリエイティブ更新（戻し時は派生フラグもクリア）
  const updatePayload = {
    status: newStatus,
    updated_at: new Date().toISOString(),
  };
  if (newStatus !== '納品') {
    updatePayload.is_payable = false;
    updatePayload.force_delivered = false;
    updatePayload.force_delivered_reason = null;
    updatePayload.force_delivered_at = null;
    updatePayload.force_delivered_by = null;
  }
  const { data: updated, error: uErr } = await supabase
    .from('creatives').update(updatePayload).eq('id', req.params.id).select().single();
  if (uErr) return res.status(500).json({ error: uErr.message });

  // 監査ログ
  await supabase.from('creative_status_audit').insert({
    creative_id: req.params.id,
    from_status: creative.status,
    to_status: newStatus,
    reason: r,
    changed_by: req.user?.id || null,
    deleted_invoice_item_ids: deletedItemIds.length ? deletedItemIds : null,
  });

  // ADR 011 補足: creative_status_transitions にも同じ遷移を audit log として記録。
  //   creative_status_audit は管理者強制変更専用 (reason 必須・請求書チェックあり) だが、
  //   transitions は通常運用と管理者操作の両方を「同じ table」で時系列に取れるようにする。
  //   ラウンド比較 UI / サイクルタイム集計 / 遅延検知バッチで参照される。
  try {
    let versionAtChange = null;
    try {
      const { data: latestFileForCst } = await supabase
        .from('creative_files')
        .select('version')
        .eq('creative_id', req.params.id)
        .order('version', { ascending: false })
        .limit(1)
        .maybeSingle();
      versionAtChange = latestFileForCst?.version ?? null;
    } catch (_) { /* 取得失敗は null のまま */ }

    const { error: cstErr } = await supabase
      .from('creative_status_transitions')
      .insert({
        creative_id: req.params.id,
        from_status: creative.status,
        to_status:   newStatus,
        changed_by:  req.user?.id || null,
        changed_at:  new Date().toISOString(),
        director_comment_at_change: creative.director_comment ?? null,
        client_comment_at_change:   creative.client_comment   ?? null,
        editor_comment_at_change:   creative.editor_comment   ?? null,
        version_at_change: versionAtChange,
      });
    if (cstErr) {
      console.warn('[creative_status_transitions] admin insert failed:', cstErr.message);
    }
  } catch (cstBlockErr) {
    console.warn('[creative_status_transitions] admin block failed:', cstBlockErr?.message || cstBlockErr);
  }

  // 「クライアントチェック中」遷移時の Drive 自動共有（同期）
  if (newStatus === 'クライアントチェック中' && creative.status !== 'クライアントチェック中') {
    try {
      const result = await shareForClientReview({ creativeId: req.params.id });
      console.log('[client-review] auto-share (admin):', { creativeId: req.params.id, ...result });
    } catch (err) {
      console.error('[client-review] auto-share (admin) failed:', err?.stack || err?.message || err, { creativeId: req.params.id });
    }
  }

  // 通知（fire-and-forget）
  try {
    const notif = require('../notifications');
    notif.notifyCreativeStatusChange({
      creative: { id: req.params.id },
      oldStatus: creative.status,
      newStatus,
      comment: `【管理者によるステータス変更】理由: ${r}`,
      actorUserId: req.user?.id || null,
    }).catch(e => console.warn('[notif] failed:', e.message));
  } catch(e) { console.warn('[notif] enqueue failed:', e.message); }

  // ball_holder_id キャッシュ更新（管理者による直接ステータス変更も同様に通知発火対象）
  syncBallHolderId(req.params.id).catch(e => console.warn('[ball_holder_id] sync failed:', e.message));

  res.json({
    ok: true,
    from: creative.status,
    to: newStatus,
    deleted_invoice_items: deletedItemIds.length,
    affected_invoices: affectedInvoiceIds.length,
    creative: updated,
  });
});

// =====================================================
// LP / HP / LINE 専用: テンプレ駆動の status_code 進行 / 戻し
// =====================================================
// 動画 / 静止画 系（status 駆動・既存ハードコード STEPS）には影響を与えない。
// `creatives.projects.primary_category.code` が lp/hp/line のもののみ対象。
// それ以外のカテゴリで叩かれた場合は 400 を返す。

async function _resolveCategoryAndItems(creativeId) {
  const { data: creative } = await supabase
    .from('creatives')
    .select('id, status_code, project_id, projects(id, primary_category_id)')
    .eq('id', creativeId)
    .maybeSingle();
  if (!creative) return { error: { status: 404, message: 'クリエイティブが見つかりません' } };
  const catId = creative.projects?.primary_category_id;
  if (!catId) return { error: { status: 400, message: 'カテゴリが未設定です' } };
  const { data: cat } = await supabase
    .from('creative_categories')
    .select('id, code')
    .eq('id', catId)
    .maybeSingle();
  if (!cat?.code || !['lp', 'hp', 'line'].includes(cat.code)) {
    return { error: { status: 400, message: 'このエンドポイントは LP / HP / LINE 専用です' } };
  }
  const { data: tpls } = await supabase
    .from('creative_status_templates')
    .select('id, is_default, items:creative_status_template_items(code, label, sort_order, is_milestone)')
    .eq('category_id', cat.id);
  const tpl = (tpls || []).find(t => t.is_default) || (tpls || [])[0] || null;
  const items = ((tpl?.items) || []).slice().sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
  if (!items.length) return { error: { status: 500, message: '工程テンプレが空です' } };
  return { creative, category: cat, items };
}

// 次のステップへ進める（LP/HP/LINE 専用）
router.post('/creatives/:id/advance-template-status', requireAuth, requirePermission('project.create_edit'), async (req, res) => {
  const r = await _resolveCategoryAndItems(req.params.id);
  if (r.error) return res.status(r.error.status).json({ error: r.error.message });
  const { creative, items } = r;

  const currentCode = creative.status_code || items[0].code;
  const idx = items.findIndex(i => i.code === currentCode);
  if (idx < 0) return res.status(400).json({ error: '現在の status_code がテンプレに存在しません' });
  const next = items[idx + 1];
  if (!next) return res.status(400).json({ error: '既に最終ステップです' });

  const { data: updated, error: uErr } = await supabase
    .from('creatives')
    .update({ status_code: next.code, updated_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .select('id, status_code')
    .single();
  if (uErr) return res.status(500).json({ error: uErr.message });

  res.json({
    ok: true,
    status_code: updated.status_code,
    label: next.label,
    is_milestone: !!next.is_milestone,
    is_final: idx + 1 === items.length - 1,
  });
});

// 前のステップへ戻す（管理者のみ・LP/HP/LINE 専用）
router.post('/creatives/:id/back-template-status', requireAuth, async (req, res) => {
  if (getEffectiveRole(req) !== 'admin') return res.status(403).json({ error: '管理者のみ実行できます' });
  const r = await _resolveCategoryAndItems(req.params.id);
  if (r.error) return res.status(r.error.status).json({ error: r.error.message });
  const { creative, items } = r;

  const currentCode = creative.status_code || items[0].code;
  const idx = items.findIndex(i => i.code === currentCode);
  if (idx <= 0) return res.status(400).json({ error: '既に最初のステップです' });
  const prev = items[idx - 1];

  const { data: updated, error: uErr } = await supabase
    .from('creatives')
    .update({ status_code: prev.code, updated_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .select('id, status_code')
    .single();
  if (uErr) return res.status(500).json({ error: uErr.message });

  res.json({
    ok: true,
    status_code: updated.status_code,
    label: prev.label,
    is_milestone: !!prev.is_milestone,
  });
});

// クリエイティブ削除（複数対応）
router.delete('/creatives', requireAuth, async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'ids は必須です' });

  // 請求書明細に紐付いていないか事前チェック（FK 違反を分かりやすいメッセージに変換）
  const { data: linkedItems, error: linkErr } = await supabase
    .from('invoice_items')
    .select('creative_id, invoice:invoices(invoice_number, status), creative:creatives(file_name)')
    .in('creative_id', ids);
  if (linkErr) return res.status(500).json({ error: linkErr.message });

  if (linkedItems && linkedItems.length > 0) {
    // クリエイティブ単位にまとめて、紐付き請求書を列挙
    const byCreative = new Map();
    for (const it of linkedItems) {
      const cid = it.creative_id;
      if (!byCreative.has(cid)) {
        byCreative.set(cid, {
          file_name: it.creative?.file_name || '(不明)',
          invoices: new Set(),
        });
      }
      const num = it.invoice?.invoice_number || '不明';
      const st  = it.invoice?.status === 'draft' ? '下書き' : '提出済';
      byCreative.get(cid).invoices.add(`${num}（${st}）`);
    }
    const lines = Array.from(byCreative.values()).map(v =>
      `・${v.file_name} → ${Array.from(v.invoices).join(' / ')}`
    );
    return res.status(409).json({
      error:
        '以下のクリエイティブは請求書の明細に登録されているため削除できません。\n' +
        '先に該当請求書から明細を外す（または下書き請求書を削除する）必要があります。\n\n' +
        lines.join('\n'),
    });
  }

  // Drive ファイルは「即削除」せず、「【削除】」プレフィックスを付けてリネームする。
  // 誤削除を防ぐため、後から手動で Drive 上で確認して整理する運用を想定。
  // 対象: creative_files.drive_file_id（原本） + faststart_drive_file_id（高速化版）
  const { data: filesToRename } = await supabase
    .from('creative_files')
    .select('id, generated_name, original_name, drive_file_id, faststart_drive_file_id')
    .in('creative_id', ids);

  const renameResults = { renamed: 0, skipped: 0, failed: 0 };
  if ((filesToRename || []).length > 0 && process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
    try {
      const drive = await getDriveService();
      const PREFIX = '【削除】';
      const renameOne = async (driveFileId, baseName) => {
        if (!driveFileId) return 'skipped';
        try {
          // 既に【削除】プレフィックスがあれば二重リネームを避ける
          const newName = baseName?.startsWith(PREFIX) ? baseName : `${PREFIX}${baseName || '(no-name)'}`;
          await drive.files.update({
            fileId: driveFileId,
            requestBody: { name: newName },
            supportsAllDrives: true,
          });
          driveLog('info', `Driveファイルリネーム: ${newName}`, { driveFileId });
          return 'renamed';
        } catch (e) {
          driveLog('warn', `Driveリネーム失敗（DB側削除は継続）: ${e.message}`, { driveFileId });
          return 'failed';
        }
      };
      for (const f of filesToRename) {
        const baseName = f.generated_name || f.original_name;
        const r1 = await renameOne(f.drive_file_id, baseName);
        renameResults[r1]++;
        if (f.faststart_drive_file_id) {
          // faststart 版は <basename>_fast.mp4 でアップロードされている前提だが、
          // 取得が手間なのでそのまま baseName_fast.mp4 風で命名（多少不正確でも【削除】識別が目的）
          const fastName = baseName ? baseName.replace(/\.(mp4|mov|m4v)$/i, '_fast.mp4') : null;
          const r2 = await renameOne(f.faststart_drive_file_id, fastName);
          renameResults[r2]++;
        }
      }
    } catch (e) {
      driveLog('error', `Driveサービス初期化失敗（DB側削除は継続）: ${e.message}`);
    }
  }

  // DB 側の関連レコードは即削除（Driveのリネームが失敗していても DB はクリーンに）
  await supabase.from('creative_assignments').delete().in('creative_id', ids);
  await supabase.from('creative_files').delete().in('creative_id', ids);
  const { error } = await supabase.from('creatives').delete().in('id', ids);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, deleted: ids.length, drive_rename: renameResults });
});

// ==================== クリエイティブファイル ====================

// アップロード済みファイル一覧
router.get('/creatives/:id/files', async (req, res) => {
  // version DESC を最優先にし、同 version 内では uploaded_at DESC で並べる。
  // version は creative_files にしか存在しない一意な世代番号なので、
  // これにより最新世代が常に先頭に来る（V1 重複事故が発生していても識別容易）。
  const { data, error } = await supabase
    .from('creative_files')
    .select('*')
    .eq('creative_id', req.params.id)
    .order('version', { ascending: false })
    .order('uploaded_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ファイルアップロード（Google Drive）
router.post('/creatives/:id/upload', upload.single('file'), async (req, res) => {
  const creativeId = req.params.id;
  const { width, height } = req.body;
  let { generated_name } = req.body;
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'ファイルが選択されていません' });

  // バージョン採番（ラウンド番号方式・代表 髙橋指示 / ADR 011 補足）:
  //
  //   旧: MAX(version)+1 で素直にカウントアップ
  //   新: 「Vはそのラリーのやりとりでしかカウントアップしない」
  //       → version_num = "現在のラウンド番号"
  //       → ラウンド = 提出物 と それに対する指摘 のペア = creative_version_history の1行
  //
  // 導出ルール（フロントは信用しない・サーバ単一ソース）:
  //   M = creative_files の MAX(version)
  //   ・M = 0 (まだ何も無い)                              → 新規 = 1
  //   ・M がスナップショット済み (= 提出済) → 次ラウンドへ進む = M + 1
  //   ・M がまだスナップショット無し (= 未提出/取り消し→再アップ) → 現ラウンド維持 = M
  //
  // 取り消し→再アップの流れ:
  //   1) UI が DELETE /api/creatives/:cid/files/:fid を先に叩く（route 6120 の安全装置で
  //      最新バージョン かつ snapshot 未登録 のみ DELETE 可能）
  //   2) この POST が来た時点で creative_files から該当行は消えている → MAX(version) は M-1
  //   3) M-1 はスナップショット済(提出済) → assignedVersion = (M-1)+1 = M
  //   → 同じバージョン番号で再アップロードされる（V2 取り消し→再アップ → V2 のまま、V3 にはならない）
  const requestedVersion = parseInt(req.body.version, 10);
  const { data: maxRow } = await supabase
    .from('creative_files')
    .select('version')
    .eq('creative_id', creativeId)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();
  const M = maxRow?.version || 0;
  let version;
  if (M === 0) {
    version = 1;
  } else {
    // M が snapshot 済か確認
    let snapForMCount = 0;
    try {
      const { data: snapRows } = await supabase
        .from('creative_version_history')
        .select('id')
        .eq('creative_id', creativeId)
        .eq('version_num', M)
        .limit(1);
      snapForMCount = (snapRows && snapRows.length) || 0;
    } catch (e) {
      // creative_version_history テーブルが無い環境（旧 DB）は
      // 旧挙動 (MAX+1) にフォールバック。
      console.warn('[creatives/upload] cvh check failed → fallback to MAX+1:', e?.message || e);
      snapForMCount = 1;
    }
    if (snapForMCount > 0) {
      version = M + 1; // M が提出済 → 次ラウンドへ
    } else {
      // M が未提出 (snapshot 無し) のとき:
      //   - 通常: 同ラウンド維持 (= 取り消し→再アップで version=M のまま)
      //   - ただし「後修正 status」中で初めて修正版をアップする場合は次ラウンドへ進める。
      //     理由: snapshot は「修正→再チェック」遷移時に確定するため、Dチェック→D後修正
      //     の遷移時点では V1 は未 snapshot。この間に V2 をアップすると単純な「未 snapshot」
      //     判定では V1 と衝突する (version=1 採番) ので、status を見て補正する。
      //     ADR 011 補足セクション参照。
      const REVISION_STATUSES = ['Dチェック後修正','Pチェック後修正','クライアントチェック後修正'];
      let creativeStatus = null;
      try {
        const { data: cRow } = await supabase
          .from('creatives')
          .select('status')
          .eq('id', creativeId)
          .maybeSingle();
        creativeStatus = cRow?.status || null;
      } catch (_) { /* 取れなくても続行 */ }
      if (creativeStatus && REVISION_STATUSES.includes(creativeStatus)) {
        version = M + 1; // 後修正中の初アップ → 次ラウンドへ
      } else {
        version = M;     // 同ラウンド維持（取消→再アップ等）
      }
    }
  }
  if (requestedVersion && requestedVersion !== version) {
    console.info(
      `[creatives/upload] version override: front=${requestedVersion} → server=${version} (creative_id=${creativeId}, M=${M})`
    );
  } else {
    console.info(`[creatives/upload] version assigned: ${version} (creative_id=${creativeId}, M=${M})`);
  }

  // 安全装置: 同一ラウンド (=同一 version) で未提出の creative_files 行がまだ残っているケース
  // （UI ガードを通らずサーバへ直接 POST が来た / DELETE 失敗で取り残されたゴミ等）。
  // 残っていると同じ version_num で複数行できて _cdRoundsCache の整合が壊れるため、
  // best-effort で削除してから新しい行を INSERT する。Drive 側の orphan は許容（ロギングのみ）。
  if (version === M && M > 0) {
    try {
      const { data: stale } = await supabase
        .from('creative_files')
        .select('id, drive_file_id, faststart_drive_file_id')
        .eq('creative_id', creativeId)
        .eq('version', version);
      if (stale && stale.length > 0) {
        console.warn(`[creatives/upload] same-round stale rows detected (version=${version}, count=${stale.length}) → cleanup`);
        const ids = stale.map(r => r.id);
        // 子テーブル best-effort（CASCADE 環境では no-op）
        try { await supabase.from('creative_file_comments').delete().in('creative_file_id', ids); } catch (_) {}
        try { await supabase.from('creative_file_likes').delete().in('creative_file_id', ids); } catch (_) {}
        await supabase.from('creative_files').delete().in('id', ids);
      }
    } catch (e) {
      console.warn('[creatives/upload] same-round cleanup failed (続行):', e?.message || e);
    }
  }

  // generated_name に埋め込まれた _vN を確定 version で上書きする。
  // 例: フロントが "cool_v1.mp4" を送ってきても、サーバ採番が 3 なら "cool_v3.mp4" にする。
  // _vN パターンが無ければそのまま使う（保険）。
  if (generated_name) {
    const replaced = generated_name.replace(/_v\d+(\.[^.]+)$/, `_v${version}$1`);
    if (replaced !== generated_name) {
      console.info(`[creatives/upload] generated_name rewritten: ${generated_name} → ${replaced}`);
    }
    generated_name = replaced;
  }

  // クリエイティブ + 案件情報を取得
  const { data: creative, error: cErr } = await supabase
    .from('creatives')
    .select('*, projects(id, name, deadline_unit, deadline_weekday, clients(id, name, client_code))')
    .eq('id', creativeId)
    .single();
  if (cErr) return res.status(500).json({ error: cErr.message });

  const project = creative.projects;
  let driveFileId = null;
  let driveUrl = null;
  let driveError = null;
  let typeFolderId_ = null; // faststart 後処理で同じフォルダにアップロードするため外側で保持

  // Drive ルートフォルダID: system_settings テーブル → env var の優先順
  const rootFolderId = await getDriveRootFolderId();

  // Google Drive にアップロード（credentials が設定されている場合のみ）
  driveLog('info', 'アップロード開始', { creativeId, file: file?.originalname, size: file?.size, rootFolderId: !!rootFolderId, hasKey: !!process.env.GOOGLE_SERVICE_ACCOUNT_KEY });
  if (rootFolderId && process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
    let driveStep = 'init';
    try {
      const drive = await getDriveService();
      driveLog('info', 'Driveサービス認証OK');

      // ルート → クライアント名 → 案件名 を自動作成
      const clientName = (project?.clients?.name || 'その他').replace(/[/\\?%*:|"<>]/g, '_');
      const projectName = (project?.name || '案件未設定').replace(/[/\\?%*:|"<>]/g, '_');

      driveStep = 'clientFolder';
      driveLog('info', `クライアントフォルダ取得/作成: ${clientName}`);
      const clientFolderId = await getOrCreateFolder(drive, rootFolderId, clientName);
      if (!clientFolderId) throw new Error(`クライアントフォルダ作成失敗: ${clientName}`);
      driveLog('info', `クライアントフォルダOK`, { id: clientFolderId });

      driveStep = 'projectFolder';
      driveLog('info', `案件フォルダ取得/作成: ${projectName}`);
      const baseFolderId = await getOrCreateFolder(drive, clientFolderId, projectName);
      if (!baseFolderId) throw new Error(`案件フォルダ作成失敗: ${projectName}`);
      driveLog('info', `案件フォルダOK`, { id: baseFolderId });

      const now = new Date();
      const yyyymm = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;

      // 動画か静止画かでフォルダ名を分ける
      const isVideo = file.mimetype.startsWith('video/');
      const typeFolder = isVideo ? '動画' : '静止画';

      driveStep = 'monthFolder';
      const monthFolderId = await getOrCreateFolder(drive, baseFolderId, yyyymm);
      driveLog('info', `月フォルダOK: ${yyyymm}`, { id: monthFolderId });

      driveStep = 'typeFolder';
      let typeFolderId;
      if (project.deadline_unit === 'weekly' && project.deadline_weekday !== null && project.deadline_weekday !== undefined) {
        const jsTarget = (project.deadline_weekday + 1) % 7;
        const daysUntil = ((jsTarget - now.getDay()) + 7) % 7 || 7;
        const deadline = new Date(now);
        deadline.setDate(deadline.getDate() + daysUntil);
        const dMonth = deadline.getMonth() + 1;
        const dDay = deadline.getDate();
        const firstOfMonth = new Date(deadline.getFullYear(), deadline.getMonth(), 1);
        const weekNum = Math.ceil((dDay + firstOfMonth.getDay()) / 7);
        const weekFolderName = `W${weekNum}_${String(dMonth).padStart(2,'0')}${String(dDay).padStart(2,'0')}`;
        const weekFolderId = await getOrCreateFolder(drive, monthFolderId, weekFolderName);
        typeFolderId = await getOrCreateFolder(drive, weekFolderId, typeFolder);
      } else {
        typeFolderId = await getOrCreateFolder(drive, monthFolderId, typeFolder);
      }
      driveLog('info', `タイプフォルダOK: ${typeFolder}`, { id: typeFolderId });
      typeFolderId_ = typeFolderId; // faststart 後処理で同フォルダにアップロードするため外側に渡す
      // ファイルは typeFolder に直接格納（workFolder は廃止）

      // ファイルをアップロード（PassThrough stream で安定化）
      driveStep = 'fileUpload';
      const uploadFileName = generated_name || file.originalname;
      driveLog('info', `ファイルアップロード開始: ${uploadFileName}`, { mimeType: file.mimetype, bytes: file.buffer.length });
      const { PassThrough } = require('stream');
      const passThrough = new PassThrough();
      passThrough.end(file.buffer);

      const uploadRes = await drive.files.create({
        requestBody: {
          name: uploadFileName,
          parents: [typeFolderId],
        },
        media: { mimeType: file.mimetype, body: passThrough },
        fields: 'id, webViewLink',
        supportsAllDrives: true,
      });

      driveFileId = uploadRes.data.id;
      driveUrl    = uploadRes.data.webViewLink;
      driveLog('info', `ファイルアップロード完了！`, { driveFileId, driveUrl });

      driveStep = 'permission';
      try {
        await drive.permissions.create({
          fileId: driveFileId,
          supportsAllDrives: true,
          requestBody: { role: 'reader', type: 'anyone' },
        });
        driveLog('info', '公開権限設定OK');
      } catch (permErr) {
        driveLog('warn', `権限設定失敗（閲覧には影響なし）: ${permErr.message}`);
      }
    } catch (e) {
      driveLog('error', `Drive upload error [step=${driveStep}]: ${e.message}`, { stack: e.stack?.split('\n')[1] });
      driveError = `[${driveStep}] ${e.message}`;
    }
  } else {
    driveError = rootFolderId ? null : 'drive_root_folder_id が未設定です';
    if (!process.env.GOOGLE_SERVICE_ACCOUNT_KEY) driveError = 'GOOGLE_SERVICE_ACCOUNT_KEY が未設定です';
    if (driveError) driveLog('error', driveError);
    else driveLog('warn', '環境変数未設定のためDriveスキップ');
  }

  // creative_files テーブルに記録
  // mime_type / file_size をキャッシュしておくと /files/:fileId/stream で
  // 毎回 drive.files.get(fields:mimeType,size) を叩く必要がなくなる
  const willFaststart = shouldFaststart(file.mimetype, generated_name || file.originalname);
  const uploadedBy = req.user?.id || null;
  // 必須フィールド（旧スキーマでも必ず存在する）
  const baseRow = {
    creative_id: creativeId,
    original_name: file.originalname,
    generated_name: generated_name || file.originalname,
    width: parseInt(width) || null,
    height: parseInt(height) || null,
    version: version,
    drive_file_id: driveFileId,
    drive_url: driveUrl,
    uploaded_by: uploadedBy,
  };
  // 後方追加した optional 列（mime_type / file_size / faststart_status）。
  // 本番 DB に列が無い環境では INSERT が PGRST204 で失敗するので、
  // その場合は optional 列を外して再試行する。
  const optionalRow = {
    mime_type: file.mimetype || null,
    file_size: file.size || file.buffer?.length || null,
    faststart_status: willFaststart ? 'pending' : 'skipped',
  };
  const isMissingCol = (err) => {
    if (!err) return false;
    const msg = err.message || '';
    return /column .+ does not exist/.test(msg) || /Could not find the .+ column/.test(msg) || err.code === 'PGRST204';
  };
  let { data: fileRecord, error: fErr } = await supabase
    .from('creative_files')
    .insert({ ...baseRow, ...optionalRow })
    .select()
    .single();
  if (isMissingCol(fErr)) {
    console.warn('[creative_files] 後方追加列なし → fallback で再試行:', fErr.message);
    ({ data: fileRecord, error: fErr } = await supabase
      .from('creative_files')
      .insert(baseRow)
      .select()
      .single());
  }
  if (fErr) return res.status(500).json({ error: fErr.message });

  // version はサーバ側採番が真。フロントはこの値を使ってトースト等を表示する。
  res.json({ ok: true, file: fileRecord, version, drive_url: driveUrl, drive_error: driveError });

  // faststart プレビュー版生成は非同期（fire-and-forget）。
  // res.json() 後に setImmediate で起動 → ユーザーのアップロード待ち時間を増やさない。
  // ENABLE_FASTSTART_AUTOGEN=off で全体無効化可能（lib/faststart.js 側で判定）。
  // TODO: 同時実行数が増えたら p-queue 等で直列化する
  if (willFaststart && driveFileId && fileRecord?.id && faststartIsEnabled()) {
    setImmediate(() => {
      generateFaststart({ creativeFileId: fileRecord.id })
        .catch(err => driveLog('error', `faststart 起動失敗: ${err?.message}`, { creativeFileId: fileRecord.id }));
    });
  }
});

// DELETE /api/creatives/:cid/files/:fid
// 「アップロード取り消し」用エンドポイント。アップロード直後に間違いに気づいたユーザーが
// 確定提出（Dチェックへ提出 等）する前にバージョンを丸ごと取り消すために使う。
//
// 安全装置:
//   - 取り消せるのは「最新バージョン」のみ。中間バージョンの削除は許可しない（履歴整合性のため）。
//   - そのバージョンが既に creative_version_history に snapshot されていたら拒否（=提出済）。
//
// 副作用:
//   - Drive 上の原本ファイル + faststart プレビュー版を best-effort で削除（失敗しても DB 削除は続行）
//   - creative_files DELETE → 関連する creative_file_comments / likes / checklist は ON DELETE CASCADE 想定。
//     CASCADE 未設定のレガシー DB でもメイン取り消しは成功させたいので、子テーブル削除は best-effort。
router.delete('/creatives/:cid/files/:fid', requireAuth, async (req, res) => {
  const { cid, fid } = req.params;
  try {
    // 1) 対象ファイルを取得
    const { data: target, error: tErr } = await supabase
      .from('creative_files')
      .select('id, creative_id, version, drive_file_id, faststart_drive_file_id, generated_name')
      .eq('id', fid)
      .eq('creative_id', cid)
      .maybeSingle();
    if (tErr) return res.status(500).json({ error: tErr.message });
    if (!target) return res.status(404).json({ error: '対象ファイルが見つかりません' });

    // 2) 最新バージョンか確認
    const { data: maxRow } = await supabase
      .from('creative_files')
      .select('version')
      .eq('creative_id', cid)
      .order('version', { ascending: false })
      .limit(1)
      .maybeSingle();
    const maxVer = maxRow?.version || 0;
    if ((target.version || 0) !== maxVer) {
      return res.status(409).json({ error: '最新バージョンのみ取り消せます（中間バージョンは取り消し不可）' });
    }

    // 3) 既に snapshot 済 (=提出済) なら拒否
    try {
      const { data: snap } = await supabase
        .from('creative_version_history')
        .select('id')
        .eq('creative_id', cid)
        .eq('version_num', target.version)
        .limit(1);
      if (snap && snap.length > 0) {
        return res.status(409).json({ error: 'このバージョンは既に提出済のため取り消せません' });
      }
    } catch (_) {
      // creative_version_history テーブルが無い環境はスキップ（snapshot 概念がない＝提出判定不可なので続行）
    }

    // 4) Drive 上のファイル削除（best-effort）
    let driveError = null;
    if (process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
      try {
        const drive = await getDriveService();
        const toDelete = [target.drive_file_id, target.faststart_drive_file_id].filter(Boolean);
        for (const driveFileId of toDelete) {
          try {
            await drive.files.delete({ fileId: driveFileId, supportsAllDrives: true });
            driveLog('info', `Drive ファイル削除OK`, { driveFileId });
          } catch (delErr) {
            driveLog('warn', `Drive ファイル削除失敗 (続行): ${delErr.message}`, { driveFileId });
            driveError = delErr.message;
          }
        }
      } catch (e) {
        driveLog('warn', `Drive サービス取得失敗 (DB 削除のみ続行): ${e.message}`);
        driveError = e.message;
      }
    }

    // 5) 子テーブルを best-effort で削除（CASCADE が無い環境でも残骸を残さない）
    try { await supabase.from('creative_file_comments').delete().eq('creative_file_id', fid); } catch (_) {}
    try { await supabase.from('creative_file_likes').delete().eq('creative_file_id', fid); } catch (_) {}

    // 6) creative_files 本体を削除
    const { error: dErr } = await supabase
      .from('creative_files')
      .delete()
      .eq('id', fid)
      .eq('creative_id', cid);
    if (dErr) return res.status(500).json({ error: dErr.message });

    res.json({ ok: true, deleted_version: target.version, drive_error: driveError });
  } catch (e) {
    console.error('[creatives/files DELETE] failed:', e);
    res.status(500).json({ error: e?.message || 'unknown error' });
  }
});

// Google Drive ファイルストリーミングプロキシ（Range リクエスト対応・動画シーク可能）
//
// 高速化:
//   1. creative_files に mime_type / file_size をキャッシュしている場合、
//      Range リクエストごとの drive.files.get(fields:mimeType,size) 呼び出しを省略
//   2. faststart 版（再エンコード無し / -movflags +faststart）が用意されていれば
//      原本ではなくそちらをサーブする（画質ロスなしで初再生・シーク高速化）
//   3. ?original=1 を付ければ強制的に原本を返す（検証用）
router.get('/files/:fileId/stream', async (req, res) => {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_KEY) return res.status(503).json({ error: 'Drive未設定' });
  try {
    // creative_files から原本のキャッシュとfaststart情報を取得
    const { data: cf } = await supabase
      .from('creative_files')
      .select('mime_type, file_size, faststart_drive_file_id, faststart_file_size')
      .eq('drive_file_id', req.params.fileId)
      .maybeSingle();

    const wantsOriginal = req.query.original === '1';
    const useFaststart  = !wantsOriginal && cf?.faststart_drive_file_id;
    const effectiveFileId = useFaststart ? cf.faststart_drive_file_id : req.params.fileId;
    const cachedSize     = useFaststart ? cf.faststart_file_size : cf?.file_size;
    const cachedMimeType = cf?.mime_type; // -c copy なので原本と同じ

    const drive = await getDriveService();

    // メタ情報をキャッシュから取得。無ければ Drive に問い合わせて DB に書き戻す。
    let mimeType = cachedMimeType;
    let fileSize = (typeof cachedSize === 'number' && cachedSize > 0) ? cachedSize : 0;
    if (!mimeType || !fileSize) {
      const meta = await drive.files.get({
        fileId: effectiveFileId,
        fields: 'mimeType,size',
        supportsAllDrives: true,
      });
      mimeType = mimeType || meta.data.mimeType || 'video/mp4';
      fileSize = fileSize || parseInt(meta.data.size || '0', 10);
      // ベストエフォートで書き戻し（失敗しても配信は継続）
      if (cf) {
        const patch = useFaststart
          ? { faststart_file_size: fileSize }
          : { mime_type: mimeType, file_size: fileSize };
        supabase.from('creative_files').update(patch).eq('drive_file_id', req.params.fileId).then(() => {}, () => {});
      }
    }
    if (!mimeType) mimeType = 'video/mp4';

    const rangeHeader = req.headers.range;

    if (rangeHeader && fileSize > 0) {
      // Range リクエスト → 206 Partial Content
      const [startStr, endStr] = rangeHeader.replace(/bytes=/, '').split('-');
      const start = parseInt(startStr, 10);
      const end   = endStr ? parseInt(endStr, 10) : fileSize - 1;
      const chunkSize = end - start + 1;

      res.writeHead(206, {
        'Content-Range':  `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges':  'bytes',
        'Content-Length': chunkSize,
        'Content-Type':   mimeType,
        'Cache-Control':  'private, max-age=3600',
      });

      const streamRes = await drive.files.get(
        { fileId: effectiveFileId, alt: 'media', supportsAllDrives: true },
        { responseType: 'stream', headers: { Range: `bytes=${start}-${end}` } }
      );
      streamRes.data.pipe(res);
    } else {
      // 通常リクエスト → 200 OK
      res.writeHead(200, {
        'Content-Type':   mimeType,
        'Accept-Ranges':  'bytes',
        ...(fileSize > 0 ? { 'Content-Length': fileSize } : {}),
        'Cache-Control':  'private, max-age=3600',
      });
      const streamRes = await drive.files.get(
        { fileId: effectiveFileId, alt: 'media', supportsAllDrives: true },
        { responseType: 'stream' }
      );
      streamRes.data.pipe(res);
    }
  } catch (e) {
    console.error('Drive stream error:', e.message);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

// 既存ファイルの faststart 化（バックフィル）
// 対象: creative_files の動画で faststart_drive_file_id 未設定のもの
// 管理者のみ実行可。指定 creative_file id 単体 or pending 全件 ?all=1。
router.post('/creatives/files/:id/faststart', requireAuth, async (req, res) => {
  if (!(await requesterHasAnyRole(req, ['admin']))) return res.status(403).json({ error: '管理者のみ実行できます' });
  if (!ffmpeg) return res.status(503).json({ error: 'FFmpeg未インストール' });
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_KEY) return res.status(503).json({ error: 'Drive未設定' });

  const targetIds = [];
  if (req.params.id === 'all') {
    const limit = Math.min(parseInt(req.query.limit) || 5, 20);
    const { data: rows } = await supabase
      .from('creative_files')
      .select('id, generated_name, mime_type, faststart_status, drive_file_id')
      .or('faststart_status.is.null,faststart_status.eq.pending,faststart_status.eq.failed')
      .not('drive_file_id', 'is', null)
      .limit(limit);
    (rows || []).forEach(r => {
      if (shouldFaststart(r.mime_type || 'video/mp4', r.generated_name)) targetIds.push(r.id);
    });
  } else {
    targetIds.push(req.params.id);
  }
  if (!targetIds.length) return res.json({ dispatched: 0, message: '対象ファイルがありません' });

  for (const fileId of targetIds) {
    setImmediate(() => generateFaststart({ creativeFileId: fileId }).catch(err => {
      driveLog('error', `backfill 失敗 [${fileId}]: ${err?.message}`);
    }));
  }
  res.json({ dispatched: targetIds.length, ids: targetIds });
});

// 単体ファイル再生成エンドポイント（UI の「再生成」ボタン用）。
// faststart_status='failed' のファイルや、強制的に再生成したい場合に呼ぶ。
// 管理者のみ実行可。fire-and-forget でレスポンスは即返す。
router.post('/creative-files/:id/regenerate-faststart', requireAuth, async (req, res) => {
  if (!(await requesterHasAnyRole(req, ['admin']))) return res.status(403).json({ error: '管理者のみ実行できます' });
  if (!ffmpeg) return res.status(503).json({ error: 'FFmpeg未インストール' });
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_KEY) return res.status(503).json({ error: 'Drive未設定' });

  const creativeFileId = req.params.id;
  // 強制再生成のため、既存 faststart_drive_file_id があっても処理させたい場合は
  // 事前に status を pending にリセットする
  await supabase.from('creative_files').update({
    faststart_status: 'pending',
    faststart_drive_file_id: null,
  }).eq('id', creativeFileId);

  setImmediate(() => generateFaststart({ creativeFileId }).catch(err => {
    driveLog('error', `regenerate-faststart 失敗 [${creativeFileId}]: ${err?.message}`);
  }));
  res.json({ ok: true, dispatched: creativeFileId });
});

// 画質変換ストリーミング（FFmpeg経由）
// GET /files/:fileId/stream/transcode?height=720
router.get('/files/:fileId/stream/transcode', async (req, res) => {
  if (!ffmpeg)           return res.status(503).json({ error: 'FFmpeg未インストール' });
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_KEY) return res.status(503).json({ error: 'Drive未設定' });

  const height = parseInt(req.query.height) || 720;
  const validHeights = [360, 540, 720, 1080];
  const targetH = validHeights.includes(height) ? height : 720;

  try {
    const drive = await getDriveService();
    const meta  = await drive.files.get(
      { fileId: req.params.fileId, fields: 'mimeType,size', supportsAllDrives: true }
    );
    const mimeType = meta.data.mimeType || 'video/mp4';
    if (!mimeType.startsWith('video/')) return res.status(400).json({ error: '動画ファイルのみ対応' });

    const driveStream = await drive.files.get(
      { fileId: req.params.fileId, alt: 'media', supportsAllDrives: true },
      { responseType: 'stream' }
    );

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('X-Quality', `${targetH}p`);

    ffmpeg(driveStream.data)
      .videoCodec('libx264')
      .audioCodec('aac')
      .size(`?x${targetH}`)
      .outputOptions(['-preset ultrafast', '-crf 28', '-movflags frag_keyframe+empty_moov', '-f mp4'])
      .on('error', (err) => {
        console.error('FFmpeg transcode error:', err.message);
        if (!res.headersSent) res.status(500).json({ error: err.message });
      })
      .pipe(res, { end: true });
  } catch (e) {
    console.error('Drive transcode stream error:', e.message);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

// 特例請求可能フラグ（管理者のみ）
router.post('/creatives/:id/special-payable', async (req, res) => {
  const { reason, approved_by } = req.body;
  if (!reason) return res.status(400).json({ error: '理由は必須です' });
  const { data, error } = await supabase
    .from('creatives')
    .update({
      special_payable: true,
      special_payable_reason: reason,
      special_payable_by: approved_by,
      special_payable_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ==================== アサイン ====================

// アサイン追加
router.post('/creatives/:id/assignments', async (req, res) => {
  const { user_id, role, rank_applied } = req.body;
  if (!user_id || !role) return res.status(400).json({ error: 'ユーザー・役割は必須です' });
  const { data, error } = await supabase
    .from('creative_assignments')
    .insert({
      creative_id: req.params.id,
      user_id, role, rank_applied
    })
    .select(`*, users(id, full_name, role)`)
    .single();
  if (error) return res.status(500).json({ error: error.message });
  // ball_holder_id キャッシュ更新（assignment 変更で誰が今ボール持つか変わるため）
  syncBallHolderId(req.params.id).catch(e => console.warn('[ball_holder_id] sync failed:', e.message));
  res.json(data);
});

// アサイン削除
router.delete('/assignments/:id', async (req, res) => {
  // 削除前に creative_id を控えておく（DELETE 後の同期に必要）
  const { data: prev } = await supabase
    .from('creative_assignments')
    .select('creative_id')
    .eq('id', req.params.id)
    .maybeSingle();
  const { error } = await supabase
    .from('creative_assignments')
    .delete()
    .eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  if (prev?.creative_id) {
    syncBallHolderId(prev.creative_id).catch(e => console.warn('[ball_holder_id] sync failed:', e.message));
  }
  res.json({ ok: true });
});

// ==================== メンバー ====================

// メンバー一覧（権限による段階的開示）
//   member.list あり → 全員返す（機微情報は member.edit_password 保有者のみ）
//   member.list なし → 自分1件のみ返す（プロフィール画面のため）
router.get('/members', requireAuth, async (req, res) => {
  // VIEW AS 中は実効ロールで判定（最高管理者のみ X-View-As が有効）
  const effectiveRole = getEffectiveRole(req);
  const canList = await userHasPermission(effectiveRole, 'member.list');
  const canSeeSensitive = await userHasPermission(effectiveRole, 'member.edit_password');
  // hide_birth_year 列が無い環境でも落ちないようフォールバックで再試行する
  // （schema-sync が失敗していて本番DBに該当列が存在しないケースのため。PR #91 / #79 と同様パターン）
  // feedback batch 002 で追加: holiday_weekdays / camera_model / tripod_info / lighting_info
  // 機材情報・休日曜日はチーム設計に必要なので一覧API でも返す（機微情報ではないので非機微列）。
  // default_creative_tab は最も新しい列なので baseColsWith にだけ含めて、未適用環境では fallback で外す
  // creative_default_* (PR #277) はメンバーマスターでクリエイティブ画面の初期表示状態を保持。未適用環境では fallback で外す
  const baseColsWith    = 'id, email, full_name, nickname, role, job_type, rank, team_id, slack_dm_id, chatwork_dm_id, is_active, left_at, left_reason, weekday_hours, weekend_hours, holiday_weekdays, note, avatar_url, hide_birth_year, camera_model, tripod_info, lighting_info, default_creative_tab, creative_default_view, creative_default_view_mode, creative_default_group_mode, creative_default_range, creative_default_include_ended, creative_default_include_delivered, creative_default_delayed_only, creative_default_sos_only, creative_default_statuses, creative_default_ball_types';
  // hide_birth_year がない環境向けフォールバック（default_creative_tab も同様に外す）
  const baseColsWithout = 'id, email, full_name, nickname, role, job_type, rank, team_id, slack_dm_id, chatwork_dm_id, is_active, left_at, left_reason, weekday_hours, weekend_hours, holiday_weekdays, note, avatar_url, camera_model, tripod_info, lighting_info';
  // 列が無い環境向けの最終フォールバック（migration 未適用 / schema-sync 失敗時）
  const baseColsLegacy  = 'id, email, full_name, nickname, role, job_type, rank, team_id, slack_dm_id, chatwork_dm_id, is_active, left_at, left_reason, weekday_hours, weekend_hours, note, avatar_url';
  // invoice_registration_number は invoices-worker のmigration適用前は存在しないため
  // 末尾に置いて、未適用環境向けの追加フォールバックで削除できるようにしておく
  const sensitiveColsLegacy = ', birthday, bank_name, bank_code, branch_name, branch_code, account_type, account_number, account_holder_kana, phone, postal_code, address';
  const sensitiveCols = sensitiveColsLegacy + ', invoice_registration_number';
  // PostgreSQL 直の "column ... does not exist" と PostgREST の schema cache エラー (PGRST204) の両方を拾う
  const isMissingCol = (err) => {
    if (!err) return false;
    const msg = err.message || '';
    return /column .+ does not exist/.test(msg) || /Could not find the .+ column/.test(msg) || err.code === 'PGRST204';
  };
  if (!canList) {
    // 自分1件のみ（機微情報フル）
    let { data, error } = await supabase.from('users')
      .select(baseColsWith + sensitiveCols).eq('id', req.user.id).maybeSingle();
    if (isMissingCol(error)) {
      console.warn('[members] invoice_registration_number等の最新列なし → fallback で再取得:', error.message);
      ({ data, error } = await supabase.from('users')
        .select(baseColsWith + sensitiveColsLegacy).eq('id', req.user.id).maybeSingle());
    }
    if (isMissingCol(error)) {
      console.warn('[members] hide_birth_year列なし → fallback で再取得:', error.message);
      ({ data, error } = await supabase.from('users')
        .select(baseColsWithout + sensitiveColsLegacy).eq('id', req.user.id).maybeSingle());
    }
    if (isMissingCol(error)) {
      console.warn('[members] holiday_weekdays/camera等の追加列なし → legacy fallback:', error.message);
      ({ data, error } = await supabase.from('users')
        .select(baseColsLegacy + sensitiveColsLegacy).eq('id', req.user.id).maybeSingle());
    }
    if (error) return res.status(500).json({ error: error.message });
    return res.json(data ? [data] : []);
  }
  const colsWith = canSeeSensitive ? baseColsWith + sensitiveCols : baseColsWith;
  const colsWithFallback = canSeeSensitive ? baseColsWith + sensitiveColsLegacy : baseColsWith;
  const colsWithout = canSeeSensitive ? baseColsWithout + sensitiveColsLegacy : baseColsWithout;
  const colsLegacy = canSeeSensitive ? baseColsLegacy + sensitiveColsLegacy : baseColsLegacy;
  let { data, error } = await supabase.from('users').select(colsWith).order('full_name');
  if (isMissingCol(error)) {
    console.warn('[members] invoice_registration_number等の最新列なし → fallback で再取得:', error.message);
    ({ data, error } = await supabase.from('users').select(colsWithFallback).order('full_name'));
  }
  if (isMissingCol(error)) {
    console.warn('[members] hide_birth_year列なし → fallback で再取得:', error.message);
    ({ data, error } = await supabase.from('users').select(colsWithout).order('full_name'));
  }
  if (isMissingCol(error)) {
    console.warn('[members] holiday_weekdays/camera等の追加列なし → legacy fallback:', error.message);
    ({ data, error } = await supabase.from('users').select(colsLegacy).order('full_name'));
  }
  if (error) return res.status(500).json({ error: error.message });
  // 自分自身のレコードには機微情報を必ず含める
  if (!canSeeSensitive && Array.isArray(data)) {
    const selfBaseCols = 'id, birthday, bank_name, bank_code, branch_name, branch_code, account_type, account_number, account_holder_kana, phone, postal_code, address';
    let { data: self } = await supabase.from('users')
      .select(selfBaseCols + ', invoice_registration_number')
      .eq('id', req.user.id).maybeSingle();
    if (!self) {
      // 列未適用環境フォールバック
      ({ data: self } = await supabase.from('users').select(selfBaseCols).eq('id', req.user.id).maybeSingle());
    }
    if (self) {
      const idx = data.findIndex(m => m.id === self.id);
      if (idx >= 0) Object.assign(data[idx], self);
    }
  }
  // ADR 008 Stage 2: team_members.leader_rank を enrichments で付与（team_id ベースのみ）
  // メンバー一覧のリーダー/サブリーダーバッジ表示と編集用select の初期値に使う。
  // 1 メンバーは複数 team_members 行を持ちうるが、ここでは users.team_id（基本チーム）のみを参照する。
  if (Array.isArray(data) && data.length > 0) {
    try {
      const { data: tmRows, error: tmErr } = await supabase
        .from('team_members')
        .select('team_id, user_id, leader_rank')
        .not('leader_rank', 'is', null);
      if (!tmErr && Array.isArray(tmRows)) {
        // (team_id, user_id) -> leader_rank の Map
        const key = (t, u) => `${t}::${u}`;
        const lrMap = new Map();
        tmRows.forEach(r => {
          if (r.team_id && r.user_id) lrMap.set(key(r.team_id, r.user_id), r.leader_rank);
        });
        data.forEach(m => {
          m.leader_rank = (m.team_id ? lrMap.get(key(m.team_id, m.id)) : null) || null;
        });
      } else if (tmErr) {
        console.warn('[members] leader_rank enrich skipped:', tmErr.message);
      }
    } catch (e) {
      console.warn('[members] leader_rank enrich error:', e.message);
    }
  }
  res.json(data);
});

// メンバー作成
router.post('/members', requireAuth, requirePermission('member.edit_password'), async (req, res) => {
  const {
    email, full_name, role, job_type, rank, team_id, slack_dm_id, chatwork_dm_id,
    birthday, weekday_hours, weekend_hours, default_creative_tab,
    // メンバー編集モーダル（5 タブ）の全フィールドを新規追加時にも保存する
    // — 従来は基本情報のみ受け取って silent drop していた
    nickname, hide_birth_year, note,
    bank_name, bank_code, branch_name, branch_code,
    account_type, account_number, account_holder_kana,
    phone, postal_code, address,
    camera_model, tripod_info, lighting_info, holiday_weekdays,
  } = req.body;
  if (!email || !full_name || !role) return res.status(400).json({ error: 'メール・名前・ロールは必須です' });
  // default_creative_tab のバリデーション ('all' / 'video' / 'design' / null)
  const ALLOWED_DCT = new Set(['all', 'video', 'design']);
  let dctValue = null;
  if (default_creative_tab !== undefined && default_creative_tab !== null && default_creative_tab !== '') {
    if (typeof default_creative_tab !== 'string' || !ALLOWED_DCT.has(default_creative_tab)) {
      return res.status(400).json({ error: 'default_creative_tab は all / video / design / null のいずれかにしてください' });
    }
    dctValue = default_creative_tab;
  }
  // クリエイティブ画面の初期値10列（PR #277）— 受け取って正規化
  const cvDefaults = normalizeCreativeDefaults(req.body);
  if (cvDefaults._error) return res.status(400).json({ error: cvDefaults._error });
  const insertPayload = {
    email, full_name, role, job_type, rank: rank || null, team_id: team_id || null,
    slack_dm_id: slack_dm_id || null, chatwork_dm_id: chatwork_dm_id || null,
    birthday: birthday || null,
    weekday_hours: weekday_hours || [{from:9,to:18}],
    weekend_hours: weekend_hours || null,
    default_creative_tab: dctValue,
    ...cvDefaults.fields,
    // 追加フィールド（5 タブ全保存）
    nickname: nickname || null,
    hide_birth_year: !!hide_birth_year,
    note: note || null,
    bank_name: bank_name || null,
    bank_code: bank_code || null,
    branch_name: branch_name || null,
    branch_code: branch_code || null,
    account_type: account_type || null,
    account_number: account_number || null,
    account_holder_kana: account_holder_kana || null,
    phone: phone || null,
    postal_code: postal_code || null,
    address: address || null,
    camera_model: camera_model || null,
    tripod_info: tripod_info || null,
    lighting_info: lighting_info || null,
    holiday_weekdays: Array.isArray(holiday_weekdays) ? holiday_weekdays : undefined,
  };
  if (insertPayload.holiday_weekdays === undefined) delete insertPayload.holiday_weekdays;

  // 列が無い環境（migration 未適用 / schema-sync 失敗）でも落ちないよう、
  // PUT と同じく「missing col を 1 個ずつ落として再試行」する
  const isMissingColErr = (err) => {
    if (!err) return false;
    const msg = err.message || '';
    return /column .+ does not exist/.test(msg) || /Could not find the .+ column/.test(msg) || err.code === 'PGRST204';
  };
  const extractMissingCol = (err) => {
    if (!err) return null;
    const msg = err.message || '';
    const m1 = msg.match(/column "?([a-zA-Z_]+)"? does not exist/);
    if (m1) return m1[1];
    const m2 = msg.match(/Could not find the '([a-zA-Z_]+)' column/);
    if (m2) return m2[1];
    return null;
  };
  const droppedColumns = [];
  let attempt = { ...insertPayload };
  let { data, error } = await supabase.from('users').insert(attempt).select().single();
  for (let i = 0; i < 12 && isMissingColErr(error); i++) {
    const col = extractMissingCol(error);
    if (col && col in attempt) {
      console.warn(`[members:create] ${col} 列なし → fallback で再試行:`, error.message);
      delete attempt[col];
      droppedColumns.push(col);
    } else {
      console.warn('[members:create] 列名抽出不可 → 追加カラム一括除外で再試行:', error.message);
      // creative_default_* (PR #277) + 追加フィールド (PR #269) の和集合
      ['default_creative_tab',
       'creative_default_view','creative_default_view_mode','creative_default_group_mode','creative_default_range',
       'creative_default_include_ended','creative_default_include_delivered','creative_default_delayed_only','creative_default_sos_only',
       'creative_default_statuses','creative_default_ball_types',
       'nickname','hide_birth_year','note',
       'bank_name','bank_code','branch_name','branch_code','account_type','account_number',
       'account_holder_kana','phone','postal_code','address',
       'camera_model','tripod_info','lighting_info','holiday_weekdays']
        .forEach(k => {
          if (k in attempt) {
            delete attempt[k];
            if (!droppedColumns.includes(k)) droppedColumns.push(k);
          }
        });
    }
    ({ data, error } = await supabase.from('users').insert(attempt).select().single());
  }
  if (error) return res.status(500).json({ error: error.message });
  // dual-write: 新規作成された user の users.role に対応する user_roles を作成
  if (data && data.id && role) {
    await syncUserRolesForLegacyRole(data.id, role);
    invalidateRolesCache();
  }
  if (droppedColumns.length > 0) {
    console.warn(`[members:create] silent drop された列: ${droppedColumns.join(', ')}`);
    return res.json({ ...data, _droppedColumns: droppedColumns });
  }
  res.json(data);
});

// クリエイティブ画面の初期値10列（PR #277）を req.body から拾って正規化する。
// undefined（リクエストに含まれない）→ 既存値を上書きしない（fields に入れない）。
// null / 空文字 → DB に NULL 保存（フロントは既定値フォールバック）。
// 値が許可リスト外 → _error を返す（呼び出し側で 400 を返す）。
function normalizeCreativeDefaults(body) {
  const ALLOWED_VIEW       = new Set(['all', 'mine', 'ball']);
  const ALLOWED_VIEW_MODE  = new Set(['gantt', 'list']);
  const ALLOWED_GROUP_MODE = new Set(['project', 'client', 'assignee', 'team']);
  const ALLOWED_RANGE      = new Set(['week', '2week', 'month', '2month']);
  const ALLOWED_STATUS     = new Set(['未着手','台本制作','素材・ナレ作成','編集','Dチェック','Dチェック後修正','Pチェック','Pチェック後修正','クライアントチェック中','クライアントチェック後修正','納品','保留']);
  const ALLOWED_BALL       = new Set(['editor', 'D', 'P', 'client']);
  const fields = {};
  const setText = (key, val, allowed, label) => {
    if (val === undefined) return null;
    if (val === null || val === '') { fields[key] = null; return null; }
    if (typeof val !== 'string' || !allowed.has(val)) return `${label} は ${[...allowed].join(' / ')} / null のいずれかにしてください`;
    fields[key] = val;
    return null;
  };
  const setBool = (key, val) => {
    if (val === undefined) return;
    if (val === null) { fields[key] = null; return; }
    fields[key] = !!val;
  };
  const setArrayJsonb = (key, val, allowed, label) => {
    if (val === undefined) return null;
    if (val === null) { fields[key] = null; return null; }
    if (!Array.isArray(val)) return `${label} は配列または null にしてください`;
    const cleaned = val.filter(s => typeof s === 'string' && allowed.has(s));
    fields[key] = cleaned;
    return null;
  };
  let err = null;
  err = err || setText('creative_default_view',       body.creative_default_view,       ALLOWED_VIEW,       'creative_default_view');
  err = err || setText('creative_default_view_mode',  body.creative_default_view_mode,  ALLOWED_VIEW_MODE,  'creative_default_view_mode');
  err = err || setText('creative_default_group_mode', body.creative_default_group_mode, ALLOWED_GROUP_MODE, 'creative_default_group_mode');
  err = err || setText('creative_default_range',      body.creative_default_range,      ALLOWED_RANGE,      'creative_default_range');
  setBool('creative_default_include_ended',     body.creative_default_include_ended);
  setBool('creative_default_include_delivered', body.creative_default_include_delivered);
  setBool('creative_default_delayed_only',      body.creative_default_delayed_only);
  setBool('creative_default_sos_only',          body.creative_default_sos_only);
  err = err || setArrayJsonb('creative_default_statuses',   body.creative_default_statuses,   ALLOWED_STATUS, 'creative_default_statuses');
  err = err || setArrayJsonb('creative_default_ball_types', body.creative_default_ball_types, ALLOWED_BALL,   'creative_default_ball_types');
  if (err) return { _error: err };
  return { fields };
}

// メンバー一括登録（共通処理）— members 配列を受け取り、{ created, failed, errors } を返却
async function bulkInsertMembers(members) {
  // チームコード→IDのマップを取得
  const { data: teams } = await supabase.from('teams').select('id, team_code');
  const teamMap = {};
  (teams || []).forEach(t => { teamMap[t.team_code] = t.id; });

  // 既存メールアドレス集合（スプレッドシート→重複検知）
  const { data: existingUsers } = await supabase.from('users').select('email');
  const existingEmails = new Set((existingUsers || []).map(u => (u.email || '').toLowerCase()));

  let created = 0, failed = 0, skipped = 0;
  const errors = [];
  for (const m of members) {
    const { full_name, email, role, job_type, rank, team_code, birthday,
            nickname, slack_dm_id, chatwork_dm_id, phone, postal_code, address, note } = m;
    if (!full_name || !email || !role) { failed++; errors.push({ email, reason: '名前・メール・ロール必須' }); continue; }
    if (existingEmails.has(String(email).toLowerCase())) { skipped++; continue; }
    const { data: inserted, error } = await supabase.from('users').insert({
      full_name, email, role,
      job_type: job_type || null,
      rank: rank || null,
      team_id: team_code ? (teamMap[team_code] || null) : null,
      birthday: birthday || null,
      nickname: nickname || null,
      slack_dm_id: slack_dm_id || null,
      chatwork_dm_id: chatwork_dm_id || null,
      phone: phone || null,
      postal_code: postal_code || null,
      address: address || null,
      note: note || null,
      weekday_hours: [{from:9,to:18}]
    }).select('id').single();
    if (error) { failed++; errors.push({ email, reason: error.message }); }
    else {
      created++;
      existingEmails.add(String(email).toLowerCase());
      // dual-write: user_roles も同期
      if (inserted && inserted.id) {
        await syncUserRolesForLegacyRole(inserted.id, role);
      }
    }
  }
  // 一括処理後にロールキャッシュを破棄
  invalidateRolesCache();
  return { created, failed, skipped, errors };
}

// メンバー一括登録
router.post('/members/bulk', requireAuth, requirePermission('member.edit_password'), async (req, res) => {
  const { members } = req.body;
  if (!members?.length) return res.status(400).json({ error: 'データがありません' });
  const result = await bulkInsertMembers(members);
  res.json(result);
});

// ===== メンバー一覧 ↔ Google スプレッドシート連携 =====
const MEMBER_SHEET_HEADERS = [
  'full_name','email','role','job_type','rank','team_code','birthday','nickname',
  'slack_dm_id','chatwork_dm_id','phone','postal_code','address','note'
];
const MEMBER_SHEET_LEGEND = [
  '【必須】名前（フルネーム）例: 田中 太郎',
  '【必須】メールアドレス 例: tanaka@example.com',
  '【必須】役割を英字で入力 → admin=管理者 / secretary=秘書 / producer=プロデューサー / producer_director=PD兼任 / director=ディレクター / editor=動画編集者 / designer=デザイナー',
  '職種を英字で入力 → video=動画のみ / design=デザインのみ / both=両方',
  'ランクを英字1文字で入力 → S / A / B / C（空白可）',
  'チームコード: チーム管理で登録したコード（例: A）（空白可）',
  '生年月日をYYYY-MM-DD形式で入力（例: 1990-01-15）（空白可）',
  'ニックネーム（検索・フィルターで使用可）例: たろ（空白可）',
  'Slack DM ID（空白可）',
  'Chatwork DM ID（空白可）',
  '電話番号（空白可）例: 090-1234-5678',
  '郵便番号（空白可）例: 150-0001',
  '住所（空白可）例: 東京都渋谷区...',
  'メモ・備考（空白可）'
];

function buildMemberSheetTitle(type) {
  const d = new Date();
  const pad = n => String(n).padStart(2,'0');
  const ymd = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}`;
  const label = type === 'design' ? 'デザイン' : '動画';
  return `メンバー一覧_${label}_${ymd}`;
}

function filterMembersByType(members, type) {
  if (type === 'design') return members.filter(m => m.job_type === 'design' || m.job_type === 'both');
  // video（既定）: video / both / 未設定
  return members.filter(m => !m.job_type || m.job_type === 'video' || m.job_type === 'both');
}

// スプレッドシートへエクスポート
router.post('/members/export-sheet', requireAuth, async (req, res) => {
  try {
    const type = (req.query.type === 'design') ? 'design' : 'video';
    const { data: members, error: memErr } = await supabase
      .from('users').select('*').order('created_at', { ascending: true });
    if (memErr) return res.status(500).json({ error: memErr.message });
    const { data: teams } = await supabase.from('teams').select('id, team_code');
    const teamCodeById = {};
    (teams || []).forEach(t => { teamCodeById[t.id] = t.team_code; });

    const filtered = filterMembersByType(members || [], type);
    const dataRows = filtered.map(m => [
      m.full_name || '', m.email || '', m.role || '',
      m.job_type || '', m.rank || '',
      teamCodeById[m.team_id] || '',
      m.birthday ? String(m.birthday).slice(0,10) : '',
      m.nickname || '',
      m.slack_dm_id || '',
      m.chatwork_dm_id || '',
      m.phone || '',
      m.postal_code || '',
      m.address || '',
      m.note || ''
    ]);
    const rows = [MEMBER_SHEET_HEADERS, MEMBER_SHEET_LEGEND, ...dataRows];
    const title = buildMemberSheetTitle(type);
    const { url } = await createSheetWithData(title, rows);
    res.json({ url, title, count: dataRows.length });
  } catch (e) {
    console.error('[members/export-sheet]', e);
    res.status(500).json({ error: e.message || 'スプレッドシート作成に失敗しました' });
  }
});

// スプレッドシートからインポート（権限: member.edit_password）
router.post('/members/import-sheet', requireAuth, requirePermission('member.edit_password'), async (req, res) => {
  try {
    const { url } = req.body || {};
    if (!url) return res.status(400).json({ error: 'スプレッドシートURLを指定してください' });
    const spreadsheetId = extractSpreadsheetId(url);
    if (!spreadsheetId) return res.status(400).json({ error: 'スプレッドシートURLを認識できません（/spreadsheets/d/... の形式が必要）' });

    let values;
    try {
      values = await readSheetData(spreadsheetId);
    } catch (e) {
      const msg = String(e.message || e);
      if (/permission|forbidden|denied/i.test(msg)) {
        return res.status(403).json({ error: 'シートへのアクセス権限がありません。サービスアカウントに閲覧権限を付与してください。' });
      }
      if (/not found/i.test(msg)) {
        return res.status(404).json({ error: 'スプレッドシートが見つかりません。URLを確認してください。' });
      }
      return res.status(500).json({ error: msg });
    }

    if (!values.length) return res.status(400).json({ error: 'シートが空です' });
    if (values.length < 3) return res.status(400).json({ error: '3行目以降にデータがありません（1行目=ヘッダー、2行目=凡例、3行目以降=データ）' });

    const headers = (values[0] || []).map(h => String(h || '').trim().toLowerCase());
    const requiredHeaders = ['full_name','email','role'];
    const missing = requiredHeaders.filter(h => !headers.includes(h));
    if (missing.length) return res.status(400).json({ error: `列ヘッダーが不足しています: ${missing.join(', ')}` });
    const idx = h => headers.indexOf(h);
    const get = (row, h) => {
      const i = idx(h);
      return i >= 0 ? String(row[i] ?? '').trim() : '';
    };
    const normBirthday = v => {
      if (!v) return '';
      const m = v.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
      if (!m) return v;
      return `${m[1]}-${String(m[2]).padStart(2,'0')}-${String(m[3]).padStart(2,'0')}`;
    };

    const members = [];
    for (let i = 2; i < values.length; i++) {
      const row = values[i] || [];
      if (!row.length) continue;
      const full_name = get(row, 'full_name');
      const email = get(row, 'email');
      const role = get(row, 'role');
      if (!full_name && !email && !role) continue; // 完全空行はスキップ
      members.push({
        full_name, email, role: role || 'editor',
        job_type: get(row, 'job_type'),
        rank: get(row, 'rank'),
        team_code: get(row, 'team_code'),
        birthday: normBirthday(get(row, 'birthday')),
        nickname: get(row, 'nickname'),
        slack_dm_id: get(row, 'slack_dm_id'),
        chatwork_dm_id: get(row, 'chatwork_dm_id'),
        phone: get(row, 'phone'),
        postal_code: get(row, 'postal_code'),
        address: get(row, 'address'),
        note: get(row, 'note'),
      });
    }
    if (!members.length) return res.status(400).json({ error: 'インポート対象のデータがありません' });

    const result = await bulkInsertMembers(members);
    res.json({
      imported: result.created,
      skipped: result.skipped,
      failed: result.failed,
      errors: result.errors,
      total: members.length,
    });
  } catch (e) {
    console.error('[members/import-sheet]', e);
    res.status(500).json({ error: e.message || 'インポートに失敗しました' });
  }
});

// メンバー更新
// MEMBER_ROLE_RANK: ロールコードベースでランクを与える。
// 'producer' を持つ + 'director' を持つ（旧 producer_director 相当）は両者の高い方を採用。
const MEMBER_ROLE_RANK = { admin:6, secretary:5, producer:5, producer_director:4, director:3, designer:2, editor:1 };
function rankOfRoleCodes(codes) {
  if (!Array.isArray(codes) || codes.length === 0) return 0;
  let max = 0;
  for (const c of codes) {
    const v = MEMBER_ROLE_RANK[c] || 0;
    if (v > max) max = v;
  }
  return max;
}
router.put('/members/:id', requireAuth, async (req, res) => {
  const requester = req.user;
  // user_roles ベースの実効ロール集合（fallback で users.role を 1 要素として扱う）
  const requesterCodes = await getRequesterRoleCodes(req);
  const requesterRole = requester.role; // 旧コード経路（一部のロジックは legacy 値を見る）
  const requesterLevel = rankOfRoleCodes(requesterCodes);

  // 対象メンバーを取得して権限チェック
  const { data: target } = await supabase.from('users').select('id,role').eq('id', req.params.id).maybeSingle();
  if (!target) return res.status(404).json({ error: 'メンバーが見つかりません' });

  // 対象のロールも user_roles ベースで取得
  const targetCodes = await getUserRoleCodes(target.id);
  // user_roles が空なら legacy users.role を fallback
  const effectiveTargetCodes = targetCodes.length > 0
    ? targetCodes
    : (target.role === 'producer_director' ? ['producer','director'] : (target.role ? [target.role] : []));
  const targetLevel = rankOfRoleCodes(effectiveTargetCodes);

  // member.edit_password 保有可否（user_roles 集合 → role_permissions 経由で評価）
  // 現状の userHasPermission は単一 legacy role 文字列を受けるため、配列中の各コードを順に試す
  let isAdmin = false;
  for (const c of (requesterCodes.length > 0 ? requesterCodes : [requesterRole])) {
    if (!c) continue;
    if (await userHasPermission(c, 'member.edit_password')) { isAdmin = true; break; }
  }
  const isSelf = requester.id === target.id;

  const requesterIsProducerLike = requesterCodes.includes('producer')
    || requesterCodes.includes('producer_director')
    || requesterRole === 'producer' || requesterRole === 'producer_director';

  // 権限チェック: member.edit_password 保有者は全員編集可。producer は自分+下位ランク。それ以外は自分のみ
  if (!isAdmin) {
    const canEdit = requesterIsProducerLike
      ? (isSelf || targetLevel < requesterLevel)
      : isSelf;
    if (!canEdit) return res.status(403).json({ error: '権限が不足しています' });
  }

  const {
    full_name, nickname, role, job_type, rank,
    team_id, slack_dm_id, chatwork_dm_id,
    is_active, left_at, left_reason,
    birthday, hide_birth_year, weekday_hours, weekend_hours, note,
    bank_name, bank_code, branch_name, branch_code,
    account_type, account_number, account_holder_kana,
    invoice_registration_number,
    phone, postal_code, address,
    // feedback batch 002: カメラ機材 / 休日曜日
    camera_model, tripod_info, lighting_info, holiday_weekdays,
    // クリエイティブ画面の初期表示タブ ('all' / 'video' / 'design' / null)
    default_creative_tab
  } = req.body;

  // default_creative_tab のバリデーション: 'all' / 'video' / 'design' / null のみ許可
  // それ以外（不正値）は NULL として保存（前向きフォールバック）
  const ALLOWED_DEFAULT_CREATIVE_TAB = new Set(['all', 'video', 'design']);
  let normalizedDefaultCreativeTab;
  if (default_creative_tab === undefined) {
    // リクエストに含まれない → 既存値を上書きしない（updateData に入れない）
    normalizedDefaultCreativeTab = undefined;
  } else if (default_creative_tab === null || default_creative_tab === '') {
    normalizedDefaultCreativeTab = null;
  } else if (typeof default_creative_tab === 'string' && ALLOWED_DEFAULT_CREATIVE_TAB.has(default_creative_tab)) {
    normalizedDefaultCreativeTab = default_creative_tab;
  } else {
    return res.status(400).json({ error: 'default_creative_tab は all / video / design / null のいずれかにしてください' });
  }

  const updateData = {
    full_name, nickname: nickname || null, job_type,
    team_id: team_id || null,
    slack_dm_id: slack_dm_id || null,
    chatwork_dm_id: chatwork_dm_id || null,
    weekday_hours: weekday_hours || null,
    weekend_hours: weekend_hours || null,
    note: note || null,
    // 機材情報・休日曜日（本人 / 管理者以外でも編集可。チーム設計のため公開情報扱い）
    camera_model: camera_model || null,
    tripod_info: tripod_info || null,
    lighting_info: lighting_info || null,
    // holiday_weekdays は配列のみ受け付け。空配列はそのまま空配列で保存（休日なし扱い）
    holiday_weekdays: Array.isArray(holiday_weekdays) ? holiday_weekdays : undefined,
    updated_at: new Date().toISOString()
  };
  if (updateData.holiday_weekdays === undefined) delete updateData.holiday_weekdays;
  // default_creative_tab: undefined（リクエスト未指定）なら更新せず、それ以外（null含む）は反映
  if (normalizedDefaultCreativeTab !== undefined) {
    updateData.default_creative_tab = normalizedDefaultCreativeTab;
  }
  // クリエイティブ画面の初期値10列（PR #277）— 受け取って正規化し、明示指定された列のみ反映
  const cvDefaults = normalizeCreativeDefaults(req.body);
  if (cvDefaults._error) return res.status(400).json({ error: cvDefaults._error });
  Object.assign(updateData, cvDefaults.fields);
  // 機微フィールド（個人情報・口座）は 本人 or member.edit_password 保有者のみ更新可
  // → producer/PD が下位メンバーの口座情報を書き換えられないよう分離
  if (isSelf || isAdmin) {
    updateData.birthday = birthday || null;
    if (hide_birth_year !== undefined) updateData.hide_birth_year = !!hide_birth_year;
    updateData.bank_name = bank_name || null;
    updateData.bank_code = bank_code || null;
    updateData.branch_name = branch_name || null;
    updateData.branch_code = branch_code || null;
    updateData.account_type = account_type || null;
    updateData.account_number = account_number || null;
    updateData.account_holder_kana = account_holder_kana || null;
    // インボイス登録番号: 空欄 OR /^T\d{13}$/ のみ許可（クライアント側でも検証済みだがサーバーでも防御）
    if (invoice_registration_number !== undefined) {
      const irn = (invoice_registration_number || '').trim();
      if (irn && !/^T\d{13}$/.test(irn)) {
        return res.status(400).json({ error: '適格請求書発行事業者登録番号は「T」+ 数字13桁で入力してください' });
      }
      updateData.invoice_registration_number = irn || null;
    }
    updateData.phone = phone || null;
    updateData.postal_code = postal_code || null;
    updateData.address = address || null;
    // 適格請求書発行事業者 登録番号（インボイス制度）。本人/管理者のみ書き換え可。
    if (invoice_registration_number !== undefined) {
      const v = normalizeInvoiceRegistrationNumber(invoice_registration_number);
      if (v && typeof v === 'object' && v.error) return res.status(400).json({ error: v.error });
      updateData.invoice_registration_number = v; // null or 'T...'
    }
  }
  // ロール変更・在籍ステータスは member.edit_password のみ
  if (isAdmin) {
    updateData.role = role;
    updateData.is_active = is_active;
    updateData.left_at = left_at || null;
    updateData.left_reason = left_reason || null;
  }
  // ランク変更は member.edit_password 保有者または producer/PD
  if (isAdmin || requesterIsProducerLike) {
    updateData.rank = rank || null;
  }

  // hide_birth_year / holiday_weekdays / camera_* / 口座系などの列が無い環境でも落ちないよう
  // 段階的にフォールバック再試行する。
  // (PG直の "column ... does not exist" と PostgREST の schema cache エラー両方を拾う)
  const isMissingColErr = (err) => {
    if (!err) return false;
    const msg = err.message || '';
    return /column .+ does not exist/.test(msg) || /Could not find the .+ column/.test(msg) || err.code === 'PGRST204';
  };
  // どの列で落ちたかをエラーメッセージから抽出して、次の試行で当該列だけ削除する
  const extractMissingCol = (err) => {
    if (!err) return null;
    const msg = err.message || '';
    const m1 = msg.match(/column "?([a-zA-Z_]+)"? does not exist/);
    if (m1) return m1[1];
    const m2 = msg.match(/Could not find the '([a-zA-Z_]+)' column/);
    if (m2) return m2[1];
    return null;
  };
  let attempt = { ...updateData };
  // フォールバックで silent drop した列を追跡し、レスポンスでフロントに通知する
  // （「保存しても反映されない」が無音で起きないように可視化）
  const droppedColumns = [];
  let { data, error } = await supabase.from('users').update(attempt).eq('id', req.params.id).select().single();
  // 最大 N 回まで「missing col を 1 個ずつ落として再試行」
  for (let i = 0; i < 10 && isMissingColErr(error); i++) {
    const col = extractMissingCol(error);
    if (col && col in attempt) {
      console.warn(`[members:update] ${col} 列なし → fallback で再保存:`, error.message);
      delete attempt[col];
      droppedColumns.push(col);
    } else {
      // 列名が抽出できなければ、追加で入れた可能性のある列をまとめて落として最後の挑戦
      console.warn('[members:update] 列名抽出不可 → 追加カラム一括除外で再保存:', error.message);
      const bulk = ['hide_birth_year','holiday_weekdays','camera_model','tripod_info','lighting_info',
       'default_creative_tab',
       'creative_default_view','creative_default_view_mode','creative_default_group_mode','creative_default_range',
       'creative_default_include_ended','creative_default_include_delivered','creative_default_delayed_only','creative_default_sos_only',
       'creative_default_statuses','creative_default_ball_types',
       'bank_name','bank_code','branch_name','branch_code','account_type','account_number',
       'account_holder_kana','invoice_registration_number','phone','postal_code','address','nickname','note','birthday'];
      bulk.forEach(k => {
        if (k in attempt) {
          delete attempt[k];
          if (!droppedColumns.includes(k)) droppedColumns.push(k);
        }
      });
    }
    ({ data, error } = await supabase.from('users').update(attempt).eq('id', req.params.id).select().single());
  }
  if (error) return res.status(500).json({ error: error.message });
  // dual-write: users.role が更新された場合は user_roles も同期する。
  // 'role' フィールドが updateData に含まれていた場合のみ実施（admin による変更時のみ）。
  // 失敗してもアプリは止めない（ログ警告のみ）。
  if (Object.prototype.hasOwnProperty.call(updateData, 'role')) {
    await syncUserRolesForLegacyRole(req.params.id, updateData.role);
    invalidateRolesCache();
  }
  // 列が drop された場合は警告フラグを付ける（フロント側で toast 警告を出せるよう）
  if (droppedColumns.length > 0) {
    console.warn(`[members:update] silent drop された列: ${droppedColumns.join(', ')} — 本番DBに該当列が無い可能性があります`);
    return res.json({ ...data, _droppedColumns: droppedColumns });
  }
  res.json(data);
});

// メンバー完全削除（admin のみ・自分自身は不可）
router.delete('/members/:id', requireAuth, requirePermission('member.delete'), async (req, res) => {
  const targetId = req.params.id;
  if (targetId === req.user.id) return res.status(400).json({ error: '自分自身は削除できません' });

  try {
    // FK参照を先にnull化
    await supabase.from('teams').update({ director_id: null }).eq('director_id', targetId);
    await supabase.from('teams').update({ producer_id: null }).eq('producer_id', targetId);
    await supabase.from('projects').update({ producer_id: null }).eq('producer_id', targetId);
    await supabase.from('projects').update({ director_id: null }).eq('director_id', targetId);
    await supabase.from('creatives').update({ special_payable_by: null }).eq('special_payable_by', targetId);
    await supabase.from('invoices').update({ issuer_id: null }).eq('issuer_id', targetId);
    await supabase.from('invoices').update({ recipient_id: null }).eq('recipient_id', targetId);
    await supabase.from('invoices').update({ approved_by: null }).eq('approved_by', targetId);
    await supabase.from('creative_files').update({ uploaded_by: null }).eq('uploaded_by', targetId);
    // 担当クリエイティブのアサインを削除
    await supabase.from('creative_assignments').delete().eq('user_id', targetId);
    // ユーザー削除
    const { error } = await supabase.from('users').delete().eq('id', targetId);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// 退職処理（管理者のみ）
router.post('/members/:id/deactivate', requireAuth, requirePermission('member.deactivate'), async (req, res) => {
  const { left_reason } = req.body;
  const { data, error } = await supabase
    .from('users')
    .update({
      is_active: false,
      left_at: new Date().toISOString(),
      left_reason: left_reason || null,
      updated_at: new Date().toISOString()
    })
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// 復帰処理（管理者のみ）
router.post('/members/:id/reactivate', requireAuth, requirePermission('member.deactivate'), async (req, res) => {
  const { data, error } = await supabase
    .from('users')
    .update({
      is_active: true,
      left_at: null,
      left_reason: null,
      updated_at: new Date().toISOString()
    })
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// メンバーアバター登録
// 方針: クライアント側で 300x300 JPEG にリサイズ済の Base64 を data URL 形式で受け取り
// users.avatar_url にそのまま保存する。
// 既存の Drive 連携は Supabase Service Account 設定が前提のため、設定不要・依存なし
// で動く Base64 採用。1ユーザーあたり最大 ~80KB 程度に収まり、users 行の肥大化リスクは極小。
router.post('/members/:id/avatar', requireAuth, upload.single('file'), async (req, res) => {
  const targetId = req.params.id;
  const requesterId = req.user.id;
  const isSelf = requesterId === targetId;
  // VIEW AS 中は実効ロールで判定（最高管理者のみ X-View-As が有効）
  const isAdmin = await userHasPermission(getEffectiveRole(req), 'member.edit_password');
  if (!isSelf && !isAdmin) return res.status(403).json({ error: '権限がありません' });

  const file = req.file;
  if (!file) return res.status(400).json({ error: 'ファイルが必要です' });
  if (!file.mimetype || !file.mimetype.startsWith('image/')) {
    return res.status(400).json({ error: '画像ファイルを選択してください' });
  }
  if (file.size > 5 * 1024 * 1024) {
    return res.status(400).json({ error: 'ファイルサイズは5MB以下にしてください' });
  }

  // Base64 data URL に変換して保存（クライアント側でリサイズ済み想定）
  const dataUrl = `data:${file.mimetype};base64,${file.buffer.toString('base64')}`;
  // DB 行の肥大化を避けるため、保存時点で 300KB を超えるものは拒否
  if (dataUrl.length > 300 * 1024) {
    return res.status(400).json({ error: '画像サイズが大きすぎます。再度お試しください' });
  }

  const { data, error } = await supabase
    .from('users')
    .update({ avatar_url: dataUrl, updated_at: new Date().toISOString() })
    .eq('id', targetId)
    .select('id, avatar_url')
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ avatar_url: data.avatar_url });
});

// メンバーアバター削除
router.delete('/members/:id/avatar', requireAuth, async (req, res) => {
  const targetId = req.params.id;
  const requesterId = req.user.id;
  const isSelf = requesterId === targetId;
  // VIEW AS 中は実効ロールで判定（最高管理者のみ X-View-As が有効）
  const isAdmin = await userHasPermission(getEffectiveRole(req), 'member.edit_password');
  if (!isSelf && !isAdmin) return res.status(403).json({ error: '権限がありません' });

  const { error } = await supabase
    .from('users')
    .update({ avatar_url: null, updated_at: new Date().toISOString() })
    .eq('id', targetId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ==================== 請求書 ====================

// 請求書一覧
router.get('/invoices', async (req, res) => {
  const { issuer_id, year, month, status } = req.query;
  const buildQuery = (selectStr) => {
    let q = supabase.from('invoices').select(selectStr).order('created_at', { ascending: false });
    if (issuer_id) q = q.eq('issuer_id', issuer_id);
    if (year)  q = q.eq('year',  parseInt(year));
    if (month) q = q.eq('month', parseInt(month));
    if (status) q = q.eq('status', status);
    return q;
  };
  // 段階的フォールバック:
  //   1) 監査列 + 登録番号 あり (full)
  //   2) 監査列なし + 登録番号 あり
  //   3) 監査列 + 登録番号なし
  //   4) どちらもなし
  // migration 適用前後どちらでも 500 にならないようにする。
  const select = ({ audit, regNo }) => `*, projects(id,name,clients(id,name${regNo ? ',invoice_registration_number' : ''})), issuer:issuer_id(id,full_name${regNo ? ',invoice_registration_number' : ''}), invoice_items(id,total_amount,is_special,special_reason${audit ? ',original_unit_price,price_change_reason' : ''},label,quantity,unit,unit_price,sort_order,cost_type,creative_label,creative_id,creatives(id,file_name,creative_type,final_deadline,draft_deadline,updated_at),invoice_item_details(*))`;
  let { data, error } = await buildQuery(select({ audit: true, regNo: true }));
  if (error && /invoice_registration_number/.test(error.message || '')) {
    console.warn('[invoices] invoice_registration_number 列未反映のためフォールバック:', error.message);
    ({ data, error } = await buildQuery(select({ audit: true, regNo: false })));
  }
  if (error && /original_unit_price|price_change_reason/.test(error.message || '')) {
    console.warn('[invoices] 監査列未反映のためフォールバック select を使用:', error.message);
    ({ data, error } = await buildQuery(select({ audit: false, regNo: true })));
    if (error && /invoice_registration_number/.test(error.message || '')) {
      console.warn('[invoices] invoice_registration_number 列も未反映のため二重フォールバック:', error.message);
      ({ data, error } = await buildQuery(select({ audit: false, regNo: false })));
    }
  }
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// 請求書プレビュー：自分のクリエイティブ一覧＋単価を返す（:idより前に定義必須）
router.get('/invoices/preview-items', async (req, res) => {
  const uid = req.user?.id;
  const year  = parseInt(req.query.year);
  const month = parseInt(req.query.month);
  if (!uid || !year || !month) return res.status(400).json({ error: 'パラメータ不足' });

  // Stage 5: 旧 project_rates / director_rates / producer_rates の参照を撤去し、
  // project_estimate_lines + project_estimate_line_costs (ADR 002+003+004+005) を read する。
  const { resolveCreativeRoleCost } = require('../utils/pricing');

  // 自分がアサインされたクリエイティブを取得（月フィルタなし、全部取得してJS側でフィルタ）
  // Issue #192: ディレクター本人（projects.director_id = uid）のクリエイティブも対象に含める。
  // 加えてプロデューサー本人（projects.producer_id = uid）の案件もUNIONで取得する。
  // creative_assignments に居ないケースを救うため、自分が担当する案件をUNIONで取得する。
  const CREATIVE_SELECT = `
    id, file_name, status, creative_type, final_deadline, draft_deadline,
    project_id, line_id, category_id, is_payable, special_payable, special_payable_reason,
    projects(id, name, director_id, producer_id, clients(name, client_code)),
    creative_assignments(user_id, role, rank_applied, users(id, full_name, role))
  `;
  const [{ data: assignedCreatives, error: cErr }, { data: directedProjects }, { data: producedProjects }] = await Promise.all([
    supabase.from('creatives').select(CREATIVE_SELECT).not('creative_assignments', 'is', null),
    supabase.from('projects').select('id').eq('director_id', uid),
    supabase.from('projects').select('id').eq('producer_id', uid),
  ]);
  if (cErr) return res.status(500).json({ error: cErr.message });

  // ディレクター/プロデューサー本人の案件にぶら下がる creatives を別途取得（assignment 無しでも拾えるように）
  const leaderProjectIds = Array.from(new Set([
    ...((directedProjects || []).map(p => p.id)),
    ...((producedProjects || []).map(p => p.id)),
  ]));
  let leaderCreatives = [];
  if (leaderProjectIds.length) {
    const { data: lc } = await supabase
      .from('creatives')
      .select(CREATIVE_SELECT)
      .in('project_id', leaderProjectIds);
    leaderCreatives = lc || [];
  }

  // 重複排除して結合
  const creativesById = new Map();
  for (const c of (assignedCreatives || [])) creativesById.set(c.id, c);
  for (const c of leaderCreatives) if (!creativesById.has(c.id)) creativesById.set(c.id, c);
  const allCreatives = Array.from(creativesById.values());

  // 当月final_deadlineフィルタ + （自分がアサイン or ディレクター or プロデューサー）
  const startDate = new Date(year, month - 1, 1).toISOString().slice(0, 10);
  const endDate   = new Date(year, month, 0).toISOString().slice(0, 10);

  const myCreatives = allCreatives.filter(c => {
    const mine = c.creative_assignments?.some(a => a.user_id === uid);
    const isDirector = c.projects?.director_id === uid;
    const isProducer = c.projects?.producer_id === uid;
    if (!mine && !isDirector && !isProducer) return false;
    const dl = c.final_deadline || c.draft_deadline || '';
    return dl >= startDate && dl <= endDate;
  });

  // 対象案件の単価を新スキーマ (lines + line_costs) からまとめて取得
  // ADR 002 (見積行統合) + ADR 005 (status filter) + Stage 5 (旧 rates テーブル参照撤去)
  const projectIds = [...new Set(myCreatives.map(c => c.project_id))];
  const linesByProject = new Map(); // project_id -> line[]
  const lineCostsByLine = {};       // line_id -> line_cost[]
  if (projectIds.length) {
    const { data: lines, error: linesErr } = await supabase
      .from('project_estimate_lines')
      .select(`
        id, project_id, category_id, name, planned_count, client_unit_price, status, sort_order,
        category:creative_categories(id, code, name),
        line_costs:project_estimate_line_costs(
          id, line_id, role_id, user_id, unit_price, pricing_type, percentage, actual_hours,
          role:roles(id, code, label)
        )
      `)
      .in('project_id', projectIds);
    if (linesErr) {
      console.warn('[preview-items] estimate_lines load failed:', linesErr.message);
    } else {
      for (const line of (lines || [])) {
        if (!linesByProject.has(line.project_id)) linesByProject.set(line.project_id, []);
        linesByProject.get(line.project_id).push(line);
        lineCostsByLine[line.id] = Array.isArray(line.line_costs) ? line.line_costs : [];
      }
    }
  }

  // ユーザーの現在のランクを取得（rank_appliedがNULLの古いデータ用）
  const { data: currentUser } = await supabase.from('users').select('rank').eq('id', uid).single();
  const currentRank = currentUser?.rank || null;

  const PREVIEW_COST_TYPE_LABELS = {
    base_fee:     '編集',
    script_fee:   '台本作成',
    ai_fee:       'AI生成（ナレーション含む）',
    other_fee:    'その他',
    director_fee: 'ディレクション費',
    producer_fee: 'プロデュース費',
  };

  const result = myCreatives.map(c => {
    const assignment = c.creative_assignments?.find(a => a.user_id === uid);
    const isDirector = c.projects?.director_id === uid;
    const isProducer = c.projects?.producer_id === uid;
    const rankApplied = assignment?.rank_applied ?? currentRank;

    // assignment.role を優先解決ロールにする。assignment が無いなら director/producer。
    const primaryRole = assignment?.role
      || (isDirector ? 'director' : (isProducer ? 'producer' : null));

    const breakdown = [];
    let baseFeeAmount = 0;
    let directorFee = 0;
    let producerFee = 0;

    // editor/designer など primaryRole の単価（旧 base_fee 相当・新スキーマでは role 単位の単一 unit_price）
    if (assignment && primaryRole && primaryRole !== 'director' && primaryRole !== 'producer') {
      const r = resolveCreativeRoleCost({
        creative: c,
        roleCode: primaryRole,
        rankApplied,
        linesByProject,
        lineCostsByLine,
      });
      baseFeeAmount = r.unit_price || 0;
      if (baseFeeAmount > 0) {
        breakdown.push({ cost_type: 'base_fee', label: PREVIEW_COST_TYPE_LABELS.base_fee, unit_price: baseFeeAmount });
      }
    }

    // director_fee（projects.director_id 一致、または assignment.role='director'）
    if (isDirector || assignment?.role === 'director') {
      const r = resolveCreativeRoleCost({
        creative: c,
        roleCode: 'director',
        rankApplied,
        linesByProject,
        lineCostsByLine,
      });
      directorFee = r.unit_price || 0;
      if (directorFee > 0) {
        breakdown.push({ cost_type: 'director_fee', label: PREVIEW_COST_TYPE_LABELS.director_fee, unit_price: directorFee });
      }
    }

    // producer_fee
    if (isProducer || assignment?.role === 'producer') {
      const r = resolveCreativeRoleCost({
        creative: c,
        roleCode: 'producer',
        rankApplied,
        linesByProject,
        lineCostsByLine,
      });
      producerFee = r.unit_price || 0;
      if (producerFee > 0) {
        breakdown.push({ cost_type: 'producer_fee', label: PREVIEW_COST_TYPE_LABELS.producer_fee, unit_price: producerFee });
      }
    }

    const total = breakdown.reduce((sum, b) => sum + (b.unit_price || 0), 0);
    // 後方互換: rate オブジェクト（旧 4分割）はもう生成できないので base_fee のみセット、他は 0
    const rateObj = baseFeeAmount > 0 ? {
      base_fee:   baseFeeAmount,
      script_fee: 0,
      ai_fee:     0,
      other_fee:  0,
    } : null;
    return {
      id: c.id,
      file_name: c.file_name,
      status: c.status,
      creative_type: c.creative_type,
      final_deadline: c.final_deadline,
      draft_deadline: c.draft_deadline,
      is_payable: c.is_payable,
      special_payable: c.special_payable,
      project_id: c.project_id,
      project_name: c.projects?.name || '',
      client_name: c.projects?.clients?.name || '',
      assignment_role: primaryRole,
      rank_applied: assignment?.rank_applied || currentRank,
      rate: rateObj,
      director_fee: directorFee,
      producer_fee: producerFee,
      breakdown,
      total,
    };
  });

  res.json(result);
});

// 請求書詳細（PDF印刷用）― preview-items より後に定義
router.get('/invoices/:id', requireAuth, async (req, res) => {
  // インボイス制度対応:
  //   issuer.invoice_registration_number / clients.invoice_registration_number を含めて取得し、
  //   PDF/印刷プレビューで適格請求書発行事業者の登録番号（T+13桁）を表示する。
  //   列未反映環境（migration 未適用）でも落ちないよう、列なしフォールバック select を別途用意する。
  const buildSelect = (auditCols, withRegNo) => `
      *,
      projects(id, name, clients(id, name, client_code${withRegNo ? ', invoice_registration_number' : ''})),
      issuer:issuer_id(
        id, full_name, email,
        bank_name, bank_code, branch_name, branch_code,
        account_type, account_number, account_holder_kana${withRegNo ? ',\n        invoice_registration_number' : ''}
      ),
      invoice_items(
        id, total_amount, is_special, special_reason,
        ${auditCols ? 'original_unit_price, price_change_reason,' : ''}
        label, quantity, unit, unit_price, sort_order,
        cost_type, creative_label, creative_id,
        creatives(id, file_name, creative_type, final_deadline, draft_deadline, updated_at,
          projects(id, name, clients(id, name, client_code${withRegNo ? ', invoice_registration_number' : ''}))
        ),
        invoice_item_details(cost_type, unit_price, amount)
      )
    `;
  let { data, error } = await supabase.from('invoices').select(buildSelect(true, true)).eq('id', req.params.id).single();
  if (error && /invoice_registration_number/.test(error.message || '')) {
    console.warn('[invoices/:id] invoice_registration_number 列未反映のためフォールバック select を使用:', error.message);
    ({ data, error } = await supabase.from('invoices').select(buildSelect(true, false)).eq('id', req.params.id).single());
  }
  if (error && /original_unit_price|price_change_reason/.test(error.message || '')) {
    console.warn('[invoices/:id] 監査列未反映のためフォールバック select を使用:', error.message);
    ({ data, error } = await supabase.from('invoices').select(buildSelect(false, true)).eq('id', req.params.id).single());
    if (error && /invoice_registration_number/.test(error.message || '')) {
      console.warn('[invoices/:id] invoice_registration_number 列も未反映のため二重フォールバック:', error.message);
      ({ data, error } = await supabase.from('invoices').select(buildSelect(false, false)).eq('id', req.params.id).single());
    }
  }
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: '請求書が見つかりません' });
  if (data.issuer_id !== req.user?.id && !(await isStaffRequester(req))) {
    return res.status(403).json({ error: 'アクセス権限がありません' });
  }
  res.json(data);
});

// ==================== 全体連絡（アナウンスメント） ====================
//
// ダッシュボードに掲示する全社向け連絡。各メンバーは「完了 ✅」を押せる。
// 投稿者は誰がやった/やってないかの一覧が見える。
// 投稿時に system_settings.broadcast_slack_channel_url が設定されていれば、
// 同時に Slack チャンネルへも投稿する（通知失敗してもアプリは止めない）。

const notif = require('../notifications');

// Slack 全体連絡用のメッセージ本文を組み立てる。
// タイトル・期限・対応ステップは Slack の code (`...`) / code block (```...```)
// で囲むことで視認性を上げる。本文（body）は素のまま。
// 末尾に「ダッシュボードを開いて完了 ✅ を押す」具体的アクションを必ず添える。
// 全員に通知が届くように <!channel> メンションも付与する。
function buildBroadcastSlackText(annData, { reissue = false } = {}) {
  const lines = [];
  lines.push('<!channel>');
  // タイトル: inline code
  lines.push(`\`📢 ${annData.title}${reissue ? ' （修正・再送）' : ''}\``);
  // 本文: 素のまま
  if (annData.body) {
    lines.push('');
    lines.push(annData.body);
  }
  // 期限: inline code
  if (annData.deadline_at) {
    const d = new Date(annData.deadline_at);
    lines.push('');
    lines.push(`\`期限: ${d.toLocaleString('ja-JP', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Tokyo' })}\``);
  }
  // 対応内容: code block でステップ列挙
  lines.push('');
  lines.push('👉 対応をお願いします');
  lines.push('```');
  lines.push('1. HARUKA FILM SYSTEM のダッシュボードを開く');
  lines.push('2. 上部「📢 お知らせ」セクションの本連絡を確認');
  lines.push('3. 対応が完了したら「完了 ✅」ボタンを押す');
  lines.push('```');
  return lines.join('\n');
}

// 自分宛のアクティブな連絡一覧（自分の done_at 同梱）
router.get('/announcements', requireAuth, async (req, res) => {
  const showAll = req.query.all === '1';
  let q = supabase.from('announcements')
    .select('id, title, body, posted_by, posted_at, deadline_at, is_active, slack_pushed_at, posted_by_user:posted_by(id, full_name, avatar_url)')
    .order('posted_at', { ascending: false });
  if (!showAll) q = q.eq('is_active', true);
  const { data: list, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  if (!list || list.length === 0) return res.json([]);
  const ids = list.map(a => a.id);
  const { data: acks } = await supabase.from('announcement_acks')
    .select('announcement_id, done_at').eq('user_id', req.user.id).in('announcement_id', ids);
  const ackMap = new Map((acks || []).map(a => [a.announcement_id, a.done_at]));
  res.json(list.map(a => ({ ...a, my_done_at: ackMap.get(a.id) || null })));
});

// 投稿（member.list 権限保有者）
router.post('/announcements', requireAuth, requirePermission('member.list'), async (req, res) => {
  const { title, body, deadline_at, push_to_slack } = req.body || {};
  if (!title || !String(title).trim()) return res.status(400).json({ error: 'タイトルは必須です' });
  const { data: created, error } = await supabase.from('announcements')
    .insert({
      title: String(title).trim(),
      body: body || null,
      posted_by: req.user.id,
      deadline_at: deadline_at || null,
      is_active: true,
    })
    .select('id, title, body, posted_at, deadline_at')
    .single();
  if (error) return res.status(500).json({ error: error.message });

  // Slack 一斉通知（system_settings.broadcast_slack_channel_url が設定されていれば）
  let slackResult = null;
  if (push_to_slack !== false) {
    try {
      const { data: setting } = await supabase.from('system_settings')
        .select('value').eq('key', 'broadcast_slack_channel_url').maybeSingle();
      const url = setting?.value;
      if (url) {
        const text = buildBroadcastSlackText(created, { reissue: false });
        const r = await notif.sendSlackChannel(url, text);
        slackResult = r.ok ? 'ok' : `failed: ${r.reason || 'unknown'}`;
        if (r.ok) {
          await supabase.from('announcements')
            .update({ slack_pushed_at: new Date().toISOString(), slack_push_result: 'ok' })
            .eq('id', created.id);
        } else {
          await supabase.from('announcements')
            .update({ slack_push_result: slackResult })
            .eq('id', created.id);
        }
      } else {
        slackResult = 'no_channel_configured';
      }
    } catch (e) {
      console.warn('[announcements] slack push failed:', e.message);
      slackResult = `error: ${e.message}`;
    }
  }
  res.json({ ...created, slack_push_result: slackResult });
});

// 編集
router.patch('/announcements/:id', requireAuth, requirePermission('member.list'), async (req, res) => {
  const { title, body, deadline_at, is_active, push_to_slack } = req.body || {};
  const update = { updated_at: new Date().toISOString() };
  if (title !== undefined) update.title = String(title).trim();
  if (body !== undefined) update.body = body || null;
  if (deadline_at !== undefined) update.deadline_at = deadline_at || null;
  if (is_active !== undefined) update.is_active = !!is_active;
  const { data, error } = await supabase.from('announcements')
    .update(update).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });

  // Slack 再送（リクエストで明示的に true が渡された場合のみ）
  let slackResult = null;
  if (push_to_slack === true) {
    try {
      const { data: setting } = await supabase.from('system_settings')
        .select('value').eq('key', 'broadcast_slack_channel_url').maybeSingle();
      const url = setting?.value;
      if (url) {
        const text = buildBroadcastSlackText(data, { reissue: true });
        const r = await notif.sendSlackChannel(url, text);
        slackResult = r.ok ? 'ok' : `failed: ${r.reason || 'unknown'}`;
        if (r.ok) {
          await supabase.from('announcements')
            .update({ slack_pushed_at: new Date().toISOString(), slack_push_result: 'ok' })
            .eq('id', req.params.id);
        } else {
          await supabase.from('announcements')
            .update({ slack_push_result: slackResult }).eq('id', req.params.id);
        }
      } else {
        slackResult = 'no_channel_configured';
      }
    } catch (e) {
      console.warn('[announcements] slack re-push failed:', e.message);
      slackResult = `error: ${e.message}`;
    }
  }
  res.json({ ...data, slack_push_result: slackResult });
});

// 終了（is_active=false）
// 終了時に Slack チャンネルへ「感謝メッセージ + 代理完了されたメンバーへの個別メンション」を投稿する。
// Slack 投稿に失敗してもアプリは止めない（既存パターン同様 try/catch + console.warn）。
router.delete('/announcements/:id', requireAuth, requirePermission('member.list'), async (req, res) => {
  const annId = req.params.id;
  const { error } = await supabase.from('announcements')
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq('id', annId);
  if (error) return res.status(500).json({ error: error.message });

  // Slack 投稿（感謝メッセージ + 代理完了メンバーへのメンション）
  try {
    const { data: setting } = await supabase.from('system_settings')
      .select('value').eq('key', 'broadcast_slack_channel_url').maybeSingle();
    const url = setting?.value;
    if (url) {
      // タイトル取得
      const { data: ann, error: aErr } = await supabase.from('announcements')
        .select('id, title').eq('id', annId).maybeSingle();
      if (aErr) {
        console.warn('[announcement close] title fetch failed:', aErr.message);
      }
      const title = ann?.title || '';

      // 代理完了されたユーザー id を集める
      // proxy_acked_by_user_id 列が無い環境では空配列扱い（schema-sync silent skip 対策 / MEMORY 参照）
      let proxyAckedUserIds = [];
      {
        const r = await supabase.from('announcement_acks')
          .select('user_id, proxy_acked_by_user_id')
          .eq('announcement_id', annId)
          .not('proxy_acked_by_user_id', 'is', null);
        if (r.error) {
          console.warn('[announcement close] proxy_acked_by_user_id select failed, treating as empty:', r.error.message);
        } else {
          proxyAckedUserIds = Array.from(new Set((r.data || [])
            .map(a => a.user_id).filter(Boolean)));
        }
      }

      // 対象ユーザーの slack_dm_id / full_name を取得
      let proxyUsers = [];
      if (proxyAckedUserIds.length > 0) {
        const { data: us, error: uErr } = await supabase.from('users')
          .select('id, full_name, slack_dm_id').in('id', proxyAckedUserIds);
        if (uErr) {
          console.warn('[announcement close] proxy user fetch failed:', uErr.message);
        } else {
          proxyUsers = us || [];
        }
      }

      // メッセージ組み立て
      const lines = [];
      lines.push('`✅ 全体連絡を終了しました`');
      if (title) lines.push(`\`${title}\``);
      lines.push('');
      lines.push('ご対応ありがとうございました 🙏');
      lines.push('また次回もご協力お願いします。');
      if (proxyUsers.length > 0) {
        lines.push('');
        lines.push('▼以下の方は代理で完了させていただきました');
        proxyUsers.forEach(u => {
          const mention = u.slack_dm_id ? `<@${u.slack_dm_id}>` : (u.full_name || '(名前未設定)');
          lines.push(`${mention} こちらで完了しました`);
        });
      }
      const text = lines.join('\n');

      const r = await notif.sendSlackChannel(url, text);
      if (!r.ok) {
        console.warn('[announcement close] slack post failed:', r.reason || 'unknown');
      }
    }
  } catch (e) {
    console.warn('[announcement close] slack push failed:', e.message);
  }

  res.json({ ok: true });
});

// 完了をマーク（本人）
router.post('/announcements/:id/ack', requireAuth, async (req, res) => {
  const now = new Date().toISOString();
  // 本人が押した場合は proxy_* を明示的に NULL にする
  // (過去に代理で完了 → 本人が改めて押した というケースで履歴が残るのは設計上 OK だが、
  //  「現状 = 本人完了」を表現するため上書き NULL する)
  const { error } = await supabase.from('announcement_acks')
    .upsert({
      announcement_id: req.params.id,
      user_id: req.user.id,
      done_at: now,
      proxy_acked_by_user_id: null,
      proxy_acked_at: null,
    }, { onConflict: 'announcement_id,user_id' });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, done_at: now });
});

// 完了を取り消し
router.delete('/announcements/:id/ack', requireAuth, async (req, res) => {
  const { error } = await supabase.from('announcement_acks')
    .delete().eq('announcement_id', req.params.id).eq('user_id', req.user.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// 代理完了 (admin / secretary 限定)
// body: { user_id } - 代理で完了させたいユーザー
// 履歴: announcement_acks.proxy_acked_by_user_id / proxy_acked_at に押した管理者を記録
// 一度本人または代理で完了済みのものに対しては no-op (既に done_at あり) として 200 で返す
router.post('/announcements/:id/proxy-ack', requireAuth, async (req, res) => {
  const myRole = req.user?.role;
  if (myRole !== 'admin' && myRole !== 'secretary') {
    return res.status(403).json({ error: '代理完了は管理者または秘書のみ実行できます' });
  }
  const targetUserId = req.body?.user_id;
  if (!targetUserId) return res.status(400).json({ error: 'user_id は必須です' });
  if (targetUserId === req.user.id) {
    return res.status(400).json({ error: '自分自身を代理完了することはできません（通常の完了ボタンを使ってください）' });
  }

  // 既に完了済みなら no-op
  const { data: existing, error: exErr } = await supabase.from('announcement_acks')
    .select('user_id, done_at, proxy_acked_by_user_id, proxy_acked_at')
    .eq('announcement_id', req.params.id)
    .eq('user_id', targetUserId)
    .maybeSingle();
  if (exErr) return res.status(500).json({ error: exErr.message });
  if (existing && existing.done_at) {
    return res.json({ ok: true, already_done: true, done_at: existing.done_at });
  }

  // ターゲットユーザーが存在することを確認（FK エラーを早期に検出）
  const { data: targetUser, error: uErr } = await supabase.from('users')
    .select('id, full_name, is_active').eq('id', targetUserId).maybeSingle();
  if (uErr) return res.status(500).json({ error: uErr.message });
  if (!targetUser) return res.status(404).json({ error: '対象ユーザーが見つかりません' });

  const now = new Date().toISOString();
  const { error } = await supabase.from('announcement_acks')
    .upsert({
      announcement_id: req.params.id,
      user_id: targetUserId,
      done_at: now,
      proxy_acked_by_user_id: req.user.id,
      proxy_acked_at: now,
    }, { onConflict: 'announcement_id,user_id' });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, done_at: now, proxy_acked_by_user_id: req.user.id, proxy_acked_at: now });
});

// 未対応者への督促（同じ announcement に対する再督促は 5分間レート制限）
// インメモリ Map で実装（プロセス再起動でリセットされるが許容）。migration を追加しないため。
const _announcementRemindCooldown = new Map(); // key: announcement_id, value: timestamp(ms)
const REMIND_COOLDOWN_MS = 5 * 60 * 1000;

// ロール並び順（仕様: admin → secretary → producer → producer_director → director → editor → designer）
const REMIND_ROLE_RANK = {
  admin: 0, secretary: 1, producer: 2, producer_director: 3,
  director: 4, editor: 5, designer: 6,
};

router.post('/announcements/:id/remind', requireAuth, requirePermission('member.list'), async (req, res) => {
  const annId = req.params.id;

  // レート制限チェック
  const last = _announcementRemindCooldown.get(annId);
  const now = Date.now();
  if (last && (now - last) < REMIND_COOLDOWN_MS) {
    const remainSec = Math.ceil((REMIND_COOLDOWN_MS - (now - last)) / 1000);
    const remainMin = Math.ceil(remainSec / 60);
    return res.status(429).json({ error: `直近で督促済みです。約${remainMin}分後に再送可能です。` });
  }

  // announcement 取得
  const { data: ann, error: aErr } = await supabase.from('announcements')
    .select('id, title, deadline_at, is_active')
    .eq('id', annId).maybeSingle();
  if (aErr) return res.status(500).json({ error: aErr.message });
  if (!ann) return res.status(404).json({ error: '連絡が見つかりません' });

  // 全アクティブメンバー
  const { data: members, error: mErr } = await supabase.from('users')
    .select('id, full_name, role, slack_dm_id')
    .eq('is_active', true);
  if (mErr) return res.status(500).json({ error: mErr.message });

  // 完了済み user_id
  const { data: acks, error: kErr } = await supabase.from('announcement_acks')
    .select('user_id, done_at').eq('announcement_id', annId);
  if (kErr) return res.status(500).json({ error: kErr.message });
  const doneSet = new Set((acks || []).filter(a => a.done_at).map(a => a.user_id));

  // 未対応者を抽出
  const unacked = (members || []).filter(m => !doneSet.has(m.id));
  if (unacked.length === 0) {
    return res.status(400).json({ error: '全員対応済みです' });
  }

  // ロール → 名前順ソート
  unacked.sort((a, b) => {
    const ra = REMIND_ROLE_RANK[a.role] ?? 99;
    const rb = REMIND_ROLE_RANK[b.role] ?? 99;
    if (ra !== rb) return ra - rb;
    return (a.full_name || '').localeCompare(b.full_name || '', 'ja');
  });

  // Slack メンション組み立て: slack_dm_id があれば <@id>、なければ名前のみ
  const mentionParts = unacked.map(u => {
    if (u.slack_dm_id) return `<@${u.slack_dm_id}>`;
    return u.full_name || '(名前未設定)';
  });
  const mentionLine = mentionParts.join(' ');

  // Slack 投稿
  let slackPosted = false;
  try {
    const { data: setting } = await supabase.from('system_settings')
      .select('value').eq('key', 'broadcast_slack_channel_url').maybeSingle();
    const url = setting?.value;
    if (url) {
      const lines = [];
      lines.push('`【督促】未対応の方へ`');
      lines.push(mentionLine);
      lines.push('');
      lines.push('▼対応をお願いします');
      lines.push(`\`${ann.title}\``);
      if (ann.deadline_at) {
        const d = new Date(ann.deadline_at);
        lines.push(`\`期限: ${d.toLocaleString('ja-JP', { dateStyle: 'medium', timeStyle: 'short' })}\``);
      }
      const text = lines.join('\n');
      const r = await notif.sendSlackChannel(url, text);
      slackPosted = !!r.ok;
      if (!r.ok) console.warn('[announcement remind] slack push failed:', r.reason);
    } else {
      console.warn('[announcement remind] broadcast_slack_channel_url 未設定');
    }
  } catch (e) {
    console.warn('[announcement remind] slack push error:', e.message);
  }

  // in-app 通知（一括 INSERT）
  try {
    const { createBulkNotifications } = require('../utils/notification');
    const rows = unacked.map(u => ({
      user_id: u.id,
      notification_type: 'announcement_remind',
      title: '未対応の通知があります',
      body: ann.title,
      link_url: `/haruka.html?announcement=${annId}`,
      meta: { announcement_id: annId },
      sender_id: req.user.id,
    }));
    await createBulkNotifications(rows);
  } catch (e) {
    console.warn('[announcement remind] notification insert failed:', e.message);
  }

  // クールダウンを記録
  _announcementRemindCooldown.set(annId, now);

  res.json({ success: true, remindedCount: unacked.length, slackPosted });
});

// ============================================================
// ADR 008 Stage 3: 「リーダーに依頼」督促DM
// ============================================================
// 各チームのリーダー (team_members.leader_rank='leader') 宛に個別DMを送る。
// - リーダー1人 = DM 1通（自チームの未対応者一覧をメンションで列挙）
// - リーダー不在チーム / 未所属の未対応者 → 秘書チーム (teams.team_type='secretary') へ
//   まとめて 1通エスカレ
// - 全員対応済みのチームはスキップ
// - 24h dedup: 同じ announcement × 同じ受信者 へ 24h 以内に送信済みなら、
//   force=1 が指定されない限りスキップ
// 通知の媒体: 既存 announcement remind と同じ Slack channel + in-app notification_logs
// （個別DMは「Slack channel に <@user_id> メンション付きで投稿」する形で実現する。
//  プロジェクトの既存パターン参照: notifications.js の sendNotif）
//
// 既存の /announcements/:id/remind とは別系統で動く（並走可）。
router.post('/announcements/:id/leader-remind', requireAuth, requirePermission('member.list'), async (req, res) => {
  const annId = req.params.id;
  const force = req.query.force === '1' || req.body?.force === true;

  // announcement 取得
  const { data: ann, error: aErr } = await supabase.from('announcements')
    .select('id, title, deadline_at, is_active')
    .eq('id', annId).maybeSingle();
  if (aErr) return res.status(500).json({ error: aErr.message });
  if (!ann) return res.status(404).json({ error: '連絡が見つかりません' });

  // 全アクティブメンバー（team_id 含む）
  const { data: members, error: mErr } = await supabase.from('users')
    .select('id, full_name, role, slack_dm_id, team_id, is_active')
    .eq('is_active', true);
  if (mErr) return res.status(500).json({ error: mErr.message });

  // 完了済 user_id
  const { data: acks, error: kErr } = await supabase.from('announcement_acks')
    .select('user_id, done_at').eq('announcement_id', annId);
  if (kErr) return res.status(500).json({ error: kErr.message });
  const doneSet = new Set((acks || []).filter(a => a.done_at).map(a => a.user_id));

  // 未対応者
  const unacked = (members || []).filter(m => !doneSet.has(m.id));
  if (unacked.length === 0) {
    return res.status(400).json({ error: '全員対応済みです' });
  }

  // チーム情報（team_type, team_code, team_name）
  const { data: teams, error: tErr } = await supabase.from('teams')
    .select('id, team_code, team_name, team_type, director_id').order('team_code');
  if (tErr) return res.status(500).json({ error: tErr.message });
  const teamById = new Map((teams || []).map(t => [t.id, t]));
  const secretaryTeamIds = new Set((teams || []).filter(t => t.team_type === 'secretary').map(t => t.id));

  // 「基本チーム」= team_code が単一の英大文字 (announcement status と同じ仕様)
  const isBasicTeam = (code) => typeof code === 'string' && /^[A-Z]$/.test(code);
  const basicTeamIdSet = new Set((teams || []).filter(t => isBasicTeam(t.team_code)).map(t => t.id));

  // team_members.leader_rank='leader' Map (migration 未適用環境では空 Map のままにする)
  const teamLeaderMap = new Map(); // team_id -> leader user_id
  try {
    const { data: tmRows, error: tmErr } = await supabase
      .from('team_members')
      .select('team_id, user_id, leader_rank')
      .eq('leader_rank', 'leader');
    if (!tmErr && Array.isArray(tmRows)) {
      tmRows.forEach(r => {
        if (r.team_id && r.user_id) teamLeaderMap.set(r.team_id, r.user_id);
      });
    } else if (tmErr) {
      console.warn('[leader-remind] team_members leader_rank fetch skipped:', tmErr.message);
    }
  } catch (e) {
    console.warn('[leader-remind] team_members leader_rank fetch error:', e.message);
  }

  // ユーザーをチームごとに振り分け
  const unackedByTeam = new Map(); // team_id -> [members]
  const unackedNoTeam = []; // 基本チームに属さない未対応者
  unacked.forEach(u => {
    if (u.team_id && basicTeamIdSet.has(u.team_id)) {
      if (!unackedByTeam.has(u.team_id)) unackedByTeam.set(u.team_id, []);
      unackedByTeam.get(u.team_id).push(u);
    } else {
      unackedNoTeam.push(u);
    }
  });

  // 秘書チームメンバー（leader 不在チーム / 未所属メンバーのエスカレ先）
  // 秘書ロール（users.role='secretary'）または team_type='secretary' チーム所属者を秘書扱い
  const secretaryMembers = (members || []).filter(m =>
    m.role === 'secretary' || (m.team_id && secretaryTeamIds.has(m.team_id))
  );
  // 秘書本人が未対応の場合でも、エスカレ DM は受け取る側として送る（セルフ宛も可）。
  // ただし重複は user_id でユニーク化。

  // ADR 008 Stage 3: 「未所属/リーダー不在」のエスカレ先は秘書チームのリーダー1人のみ。
  // 秘書チーム全員にメンションすると通知過多になるため、teamLeaderMap で
  // team_type='secretary' のチームのリーダー (team_members.leader_rank='leader')
  // を抽出する。リーダーが居ない場合のみフォールバックで秘書メンバー全員に送る。
  const secretaryLeaderIds = new Set();
  for (const [teamId, leaderUserId] of teamLeaderMap.entries()) {
    if (secretaryTeamIds.has(teamId) && leaderUserId) {
      secretaryLeaderIds.add(leaderUserId);
    }
  }
  const secretaryEscalationRecipients = secretaryLeaderIds.size > 0
    ? (members || []).filter(m => secretaryLeaderIds.has(m.id))
    : secretaryMembers; // 秘書チームにリーダー指定が無い環境向けの後方互換

  // リーダー宛 / 秘書宛 の送信タスクを組み立てる
  // 各タスク: { recipientUserId, members: [unacked...], teamLabel, kind }
  const tasks = [];
  // 1) リーダーが居るチーム
  for (const [teamId, ms] of unackedByTeam.entries()) {
    if (ms.length === 0) continue;
    const leaderUserId = teamLeaderMap.get(teamId);
    const team = teamById.get(teamId);
    const teamLabel = team
      ? `${team.team_code}チーム${team.team_name ? ' / ' + team.team_name : ''}`
      : '';
    if (leaderUserId) {
      tasks.push({
        recipientUserId: leaderUserId,
        members: ms,
        teamLabel,
        teamId,
        escalation: false,
      });
    } else {
      // リーダー不在 → 秘書宛にまとめる（あとで集約）
      // 一旦ここでは「秘書送信用バッファ」として保持
      tasks.push({
        recipientUserId: null, // 後で秘書全員に展開
        members: ms,
        teamLabel,
        teamId,
        escalation: true,
      });
    }
  }
  // 2) 未所属の未対応者
  if (unackedNoTeam.length > 0) {
    tasks.push({
      recipientUserId: null,
      members: unackedNoTeam,
      teamLabel: '未所属',
      teamId: null,
      escalation: true,
    });
  }

  // 24h dedup チェック: notification_logs に同 announcement × 同 user × kind='leader_remind' / 'leader_remind_escalation'
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const recipientCandidates = new Set();
  tasks.forEach(t => {
    if (t.recipientUserId) recipientCandidates.add(t.recipientUserId);
  });
  // エスカレ宛は秘書チームのリーダー（不在時のみフォールバックで秘書全員）→ 受信者集合に追加
  if (tasks.some(t => t.escalation)) {
    secretaryEscalationRecipients.forEach(m => recipientCandidates.add(m.id));
  }
  const dedupSkipSet = new Set(); // 直近24h で送信済の (recipientUserId)
  if (!force && recipientCandidates.size > 0) {
    try {
      const { data: recent, error: rErr } = await supabase
        .from('notification_logs')
        .select('user_id, notification_type, meta, created_at')
        .in('user_id', Array.from(recipientCandidates))
        .in('notification_type', ['leader_remind', 'leader_remind_escalation'])
        .gte('created_at', since);
      if (!rErr && Array.isArray(recent)) {
        recent.forEach(row => {
          const annIdInMeta = row.meta && row.meta.announcement_id;
          if (annIdInMeta === annId) dedupSkipSet.add(row.user_id);
        });
      } else if (rErr) {
        console.warn('[leader-remind] dedup check failed:', rErr.message);
      }
    } catch (e) {
      console.warn('[leader-remind] dedup check error:', e.message);
    }
  }

  // Slack channel URL（既存 broadcast_slack_channel_url を使う）
  let slackChannelUrl = null;
  try {
    const { data: setting } = await supabase.from('system_settings')
      .select('value').eq('key', 'broadcast_slack_channel_url').maybeSingle();
    slackChannelUrl = setting?.value || null;
  } catch (e) {
    console.warn('[leader-remind] system_settings fetch failed:', e.message);
  }

  // 期限残日数
  const remainDaysText = ann.deadline_at
    ? (() => {
        const ms = new Date(ann.deadline_at).getTime() - Date.now();
        const days = Math.ceil(ms / (24 * 60 * 60 * 1000));
        return days >= 0 ? `（残り${days}日）` : `（${Math.abs(days)}日超過）`;
      })()
    : '';
  const deadlineText = ann.deadline_at
    ? new Date(ann.deadline_at).toLocaleString('ja-JP', { dateStyle: 'medium', timeStyle: 'short' })
    : '';

  // メンバー行を組み立て: slack_dm_id があれば <@id>、無ければ名前
  const memberMention = (m) => m.slack_dm_id ? `<@${m.slack_dm_id}> さん` : `${m.full_name || '(名前未設定)'} さん`;

  // Slack 投稿: 1リーダー = 1メッセージ（チャンネルに投稿しつつ <@リーダー> メンションでDM相当）
  // 個別 user_id への DM は Slack 仕様上、bot との会話を開いていない場合うまく届かないため、
  // 既存パターンに合わせて「broadcast_slack_channel_url に <@リーダー> 付きで投稿」する。
  // 結果として「リーダー宛の個別お声がけ」として可視化される。
  const buildLeaderText = (recipient, ms, teamLabel) => {
    const lines = [];
    const headerName = recipient && recipient.slack_dm_id ? `<@${recipient.slack_dm_id}>` : (recipient?.full_name || '');
    lines.push(`${headerName} お疲れさまです 🙏`);
    lines.push(`\`【リーダーへ依頼】「${ann.title}」\` に未対応のメンバーがいます。`);
    if (deadlineText) lines.push(`期限: ${deadlineText} ${remainDaysText}`);
    if (teamLabel) lines.push(`対象: ${teamLabel}`);
    lines.push('');
    ms.forEach(m => lines.push(`・${memberMention(m)}`));
    lines.push('');
    lines.push('お声がけお願いします 🙇‍♂️');
    return lines.join('\n');
  };
  const buildEscalationText = (recipients, escalationGroups) => {
    // recipients = 秘書メンバー配列、escalationGroups = [{ teamLabel, members }]
    const lines = [];
    if (recipients.length > 0) {
      const head = recipients.filter(r => r.slack_dm_id).map(r => `<@${r.slack_dm_id}>`).join(' ');
      if (head) lines.push(`${head} お疲れさまです 🙏`);
    }
    lines.push(`\`【未所属/リーダー不在 督促依頼】「${ann.title}」\``);
    if (deadlineText) lines.push(`期限: ${deadlineText} ${remainDaysText}`);
    lines.push('');
    escalationGroups.forEach(g => {
      lines.push(`▼ ${g.teamLabel}`);
      g.members.forEach(m => lines.push(`・${memberMention(m)}`));
    });
    lines.push('');
    lines.push('リーダー不在のため、秘書チームから直接お声がけお願いします 🙇‍♂️');
    return lines.join('\n');
  };

  // 実行
  const sentLog = []; // { recipient_user_id, members: [user_id], escalation }
  const skippedLog = []; // { recipient_user_id, reason }
  const dmRowsForLog = []; // notification_logs に書き込む行

  // === Phase 1: リーダー直送 ===
  const leaderTasks = tasks.filter(t => !t.escalation && t.recipientUserId);
  for (const task of leaderTasks) {
    if (dedupSkipSet.has(task.recipientUserId)) {
      skippedLog.push({ recipient_user_id: task.recipientUserId, reason: 'dedup_24h' });
      continue;
    }
    const recipient = (members || []).find(m => m.id === task.recipientUserId) || null;
    const text = buildLeaderText(recipient, task.members, task.teamLabel);
    if (slackChannelUrl) {
      try {
        const r = await notif.sendSlackChannel(slackChannelUrl, text);
        if (!r.ok) console.warn('[leader-remind] slack push failed:', r.reason);
      } catch (e) {
        console.warn('[leader-remind] slack push error:', e.message);
      }
    }
    sentLog.push({
      recipient_user_id: task.recipientUserId,
      team_id: task.teamId,
      team_label: task.teamLabel,
      member_count: task.members.length,
      escalation: false,
    });
    dmRowsForLog.push({
      user_id: task.recipientUserId,
      notification_type: 'leader_remind',
      title: 'リーダー督促依頼',
      body: `${task.teamLabel}: ${task.members.length}名が未対応`,
      link_url: `/haruka.html?announcement=${annId}`,
      meta: {
        announcement_id: annId,
        team_id: task.teamId,
        team_label: task.teamLabel,
        member_ids: task.members.map(m => m.id),
        member_names: task.members.map(m => m.full_name),
      },
      sender_id: req.user.id,
    });
  }

  // === Phase 2: 秘書チームへエスカレ（1メッセージにまとめる） ===
  const escalationTasks = tasks.filter(t => t.escalation);
  if (escalationTasks.length > 0) {
    // 受信側秘書（dedup を考慮）。秘書チームのリーダー1人のみ（不在時はフォールバック）。
    const escalationRecipients = secretaryEscalationRecipients.filter(m => !dedupSkipSet.has(m.id));
    const escalationSkipped = secretaryEscalationRecipients.filter(m => dedupSkipSet.has(m.id));
    escalationSkipped.forEach(m => skippedLog.push({ recipient_user_id: m.id, reason: 'dedup_24h' }));

    if (escalationRecipients.length > 0) {
      const escalationGroups = escalationTasks.map(t => ({ teamLabel: t.teamLabel, members: t.members }));
      const text = buildEscalationText(escalationRecipients, escalationGroups);
      if (slackChannelUrl) {
        try {
          const r = await notif.sendSlackChannel(slackChannelUrl, text);
          if (!r.ok) console.warn('[leader-remind] slack escalation push failed:', r.reason);
        } catch (e) {
          console.warn('[leader-remind] slack escalation push error:', e.message);
        }
      }
      const totalEscMembers = escalationGroups.reduce((s, g) => s + g.members.length, 0);
      sentLog.push({
        recipient_user_ids: escalationRecipients.map(m => m.id),
        team_label: '秘書チーム（エスカレ）',
        member_count: totalEscMembers,
        escalation: true,
      });
      escalationRecipients.forEach(r => {
        dmRowsForLog.push({
          user_id: r.id,
          notification_type: 'leader_remind_escalation',
          title: 'リーダー不在チームの督促依頼',
          body: `${escalationGroups.length}グループ・${totalEscMembers}名が未対応`,
          link_url: `/haruka.html?announcement=${annId}`,
          meta: {
            announcement_id: annId,
            escalation: true,
            groups: escalationGroups.map(g => ({
              team_label: g.teamLabel,
              member_ids: g.members.map(m => m.id),
              member_names: g.members.map(m => m.full_name),
            })),
          },
          sender_id: req.user.id,
        });
      });
    } else if (secretaryEscalationRecipients.length === 0) {
      console.warn('[leader-remind] 秘書チームのリーダー（およびフォールバックの秘書メンバー）が居ないためエスカレ未送信');
    }
  }

  // notification_logs 一括 INSERT
  if (dmRowsForLog.length > 0) {
    try {
      const { createBulkNotifications } = require('../utils/notification');
      await createBulkNotifications(dmRowsForLog);
    } catch (e) {
      console.warn('[leader-remind] notification insert failed:', e.message);
    }
  }

  res.json({
    success: true,
    sent: sentLog,
    skipped: skippedLog,
    sent_count: sentLog.length,
    skipped_count: skippedLog.length,
    slack_channel_configured: !!slackChannelUrl,
  });
});

// 対応状況（投稿者向け: 完了済みメンバー / 未完了メンバー）
router.get('/announcements/:id/status', requireAuth, requirePermission('member.list'), async (req, res) => {
  const { data: ann, error: aErr } = await supabase.from('announcements')
    .select('id, title, deadline_at, posted_at').eq('id', req.params.id).maybeSingle();
  if (aErr) return res.status(500).json({ error: aErr.message });
  if (!ann) return res.status(404).json({ error: '連絡が見つかりません' });
  const { data: members, error: mErr } = await supabase.from('users')
    .select('id, full_name, role, avatar_url, team_id').eq('is_active', true).order('full_name');
  if (mErr) return res.status(500).json({ error: mErr.message });
  // proxy_acked_by_user_id / proxy_acked_at は migration 未適用環境では存在しないので
  // try/catch で明示的にフォールバック select する（schema-sync silent skip 対策 / MEMORY 参照）
  let acks = [];
  let kErr = null;
  {
    const r = await supabase.from('announcement_acks')
      .select('user_id, done_at, proxy_acked_by_user_id, proxy_acked_at')
      .eq('announcement_id', req.params.id);
    if (r.error) {
      // 列が無いケース: 旧 select で再試行
      console.warn('[announcement status] proxy_* select failed, retrying without proxy cols:', r.error.message);
      const r2 = await supabase.from('announcement_acks')
        .select('user_id, done_at')
        .eq('announcement_id', req.params.id);
      if (r2.error) { kErr = r2.error; }
      else { acks = r2.data || []; }
    } else {
      acks = r.data || [];
    }
  }
  if (kErr) return res.status(500).json({ error: kErr.message });

  // 代理完了者の名前解決（バッチ 1 query）
  const proxyByIds = Array.from(new Set((acks || [])
    .map(a => a.proxy_acked_by_user_id).filter(Boolean)));
  const proxyByMap = new Map();
  if (proxyByIds.length > 0) {
    const { data: proxyUsers, error: puErr } = await supabase.from('users')
      .select('id, full_name').in('id', proxyByIds);
    if (puErr) {
      console.warn('[announcement status] proxy user name fetch failed:', puErr.message);
    } else {
      (proxyUsers || []).forEach(u => proxyByMap.set(u.id, u.full_name || ''));
    }
  }

  // チーム情報を取得（director_id/producer_id でリーダー判定。team_code 昇順で表示）
  const { data: teams, error: tErr } = await supabase.from('teams')
    .select('id, team_code, team_name, director_id, producer_id').order('team_code');
  if (tErr) return res.status(500).json({ error: tErr.message });

  // ADR 008 Stage 1: team_members.leader_rank='leader' でリーダー判定（director_id にフォールバック）
  // ADR 008 Stage 2: sub_leader も同時に集めてバッジ表示用に返す
  // migration 未適用環境では leader_rank 列が存在せず select が落ちる可能性があるため、
  // try/catch でラップして欠損時は空 Map にする（既存挙動を壊さない）。
  const teamLeaderMap = new Map(); // team_id -> leader user_id
  const teamSubLeadersMap = new Map(); // team_id -> Set<sub_leader user_id>
  try {
    const { data: tmRows, error: tmErr } = await supabase
      .from('team_members')
      .select('team_id, user_id, leader_rank')
      .not('leader_rank', 'is', null);
    if (!tmErr && Array.isArray(tmRows)) {
      tmRows.forEach(r => {
        if (!r.team_id || !r.user_id) return;
        if (r.leader_rank === 'leader') {
          teamLeaderMap.set(r.team_id, r.user_id);
        } else if (r.leader_rank === 'sub_leader') {
          if (!teamSubLeadersMap.has(r.team_id)) teamSubLeadersMap.set(r.team_id, new Set());
          teamSubLeadersMap.get(r.team_id).add(r.user_id);
        }
      });
    } else if (tmErr) {
      // leader_rank 列未追加 / team_members 未作成の環境でも 500 にしない
      console.warn('[announcement status] team_members leader_rank fetch skipped:', tmErr.message);
    }
  } catch (e) {
    console.warn('[announcement status] team_members leader_rank fetch error:', e.message);
  }

  const ackMap = new Map((acks || []).map(a => [a.user_id, a]));
  const baseMember = (m) => {
    const a = ackMap.get(m.id);
    const proxyId = a?.proxy_acked_by_user_id || null;
    return {
      user_id: m.id,
      full_name: m.full_name,
      role: m.role,
      avatar_url: m.avatar_url,
      team_id: m.team_id,
      done_at: a?.done_at || null,
      proxy_acked_by_user_id: proxyId,
      proxy_acked_by_name: proxyId ? (proxyByMap.get(proxyId) || null) : null,
      proxy_acked_at: a?.proxy_acked_at || null,
    };
  };

  // 「基本チーム」= team_code が単一の英大文字 (A〜Z) のチーム。
  // それ以外（cWX、RYO 等の案件付随チーム）はカード化せず、所属メンバーは
  // 「未所属」グループにまとめる。これは対応状況の見やすさのため。
  const isBasicTeam = (code) => typeof code === 'string' && /^[A-Z]$/.test(code);
  const basicTeams = (teams || []).filter(t => isBasicTeam(t.team_code));
  const basicTeamIdSet = new Set(basicTeams.map(t => t.id));

  // ユーザーをチームごとに振り分け（基本チームの users.team_id ベース）
  const byTeam = new Map();
  basicTeams.forEach(t => byTeam.set(t.id, []));
  const noTeam = [];
  (members || []).forEach(m => {
    if (m.team_id && basicTeamIdSet.has(m.team_id)) byTeam.get(m.team_id).push(baseMember(m));
    else noTeam.push(baseMember(m));
  });

  // 各チーム内の並び: リーダー → プロデューサー → 残り（名前順）
  // ADR 008 Stage 1: leader_user_id（team_members.leader_rank='leader' があれば優先 / 無ければ director_id）
  const ROLE_RANK = { admin: 0, secretary: 1, producer: 2, producer_director: 2, director: 3, designer: 4, editor: 5 };
  function sortTeamMembers(arr, team, leaderUserId) {
    return arr.slice().sort((a, b) => {
      const aIsLeader = a.user_id === leaderUserId;
      const bIsLeader = b.user_id === leaderUserId;
      if (aIsLeader !== bIsLeader) return aIsLeader ? -1 : 1;
      const aIsProd = a.user_id === team.producer_id;
      const bIsProd = b.user_id === team.producer_id;
      if (aIsProd !== bIsProd) return aIsProd ? -1 : 1;
      const ra = ROLE_RANK[a.role] ?? 9;
      const rb = ROLE_RANK[b.role] ?? 9;
      if (ra !== rb) return ra - rb;
      return (a.full_name || '').localeCompare(b.full_name || '', 'ja');
    });
  }

  // 基本チームごとに整形（メンバーがいない基本チームは省略）
  const groups = basicTeams
    .filter(t => (byTeam.get(t.id) || []).length > 0)
    .map(t => {
      // leader_user_id 優先順位: team_members.leader_rank='leader' → teams.director_id
      const leaderUserId = teamLeaderMap.get(t.id) || t.director_id || null;
      const subLeaderIds = Array.from(teamSubLeadersMap.get(t.id) || []);
      const sorted = sortTeamMembers(byTeam.get(t.id), t, leaderUserId);
      return {
        team_id: t.id,
        team_code: t.team_code,
        team_name: t.team_name,
        director_id: t.director_id, // 後方互換のため残す
        producer_id: t.producer_id,
        leader_user_id: leaderUserId, // ADR 008 Stage 1: バッジ判定はこれを優先
        sub_leader_user_ids: subLeaderIds, // ADR 008 Stage 2: 🥈 サブリーダーバッジ用
        members: sorted,
        done_count: sorted.filter(m => m.done_at).length,
        total_count: sorted.length,
      };
    });

  // 未所属
  if (noTeam.length > 0) {
    const sortedNoTeam = noTeam.slice().sort((a, b) => {
      const ra = ROLE_RANK[a.role] ?? 9;
      const rb = ROLE_RANK[b.role] ?? 9;
      if (ra !== rb) return ra - rb;
      return (a.full_name || '').localeCompare(b.full_name || '', 'ja');
    });
    groups.push({
      team_id: null,
      team_code: '未所属',
      team_name: '',
      director_id: null,
      producer_id: null,
      leader_user_id: null,
      sub_leader_user_ids: [],
      members: sortedNoTeam,
      done_count: sortedNoTeam.filter(m => m.done_at).length,
      total_count: sortedNoTeam.length,
    });
  }

  // 互換性のため flat なメンバー一覧も返す（古いフロントが残っても壊れないように）
  const flat = (members || []).map(baseMember);
  res.json({ announcement: ann, groups, members: flat });
});


// ==================== つぶやき機能（社内タイムライン）====================
//
// 写真1枚 + 短いコメント + ❤️ いいね のミニ社内 SNS。
// ダッシュボード上に表示され、90 日で自動消滅 (ピン留めは永続)。
// 画像はアバターと同じく base64 data URL で DB に直接保存
// (クライアント側で 1024px / JPEG 0.85 にリサイズ、400KB 上限)。

const TWEET_IMAGE_MAX_BYTES = 500 * 1024; // base64 後 500KB 上限
const TWEET_BODY_MAX = 280;
const TWEET_COMMENT_MAX = 500;
const TWEET_REACTION_TYPES = ['good', 'heart', 'clap', 'smile', 'surprised'];

// 自分のいいね状態 + いいね件数を含む一覧
//   Phase 1 段階4 拡張: my_reactions / reaction_count / comment_count を付与。
//   既存 like_count / my_liked は heart リアクション数で計算して互換維持。
//   独立タブ向け拡張:
//     ?mine=1        — 自分の投稿 OR 自分にメンションされた投稿 OR 自分がコメント参加した投稿
//     ?staff_only=1  — 投稿者の role が admin / secretary のもののみ
router.get('/tweets', requireAuth, async (req, res) => {
  const mine = req.query.mine === '1' || req.query.mine === 'true';
  const staffOnly = req.query.staff_only === '1' || req.query.staff_only === 'true';
  // roles=admin,secretary,producer,producer_director,director,editor,designer
  //   フロントの roleGroups → users.role 値の集合（producer_director を含む）
  //   後方互換: staff_only=1 は roles=admin,secretary に変換
  const ALLOWED_ROLES = new Set([
    'admin', 'secretary', 'producer', 'producer_director', 'director', 'editor', 'designer',
  ]);
  let rolesFilter = String(req.query.roles || '')
    .split(',').map(s => s.trim()).filter(Boolean)
    .filter(r => ALLOWED_ROLES.has(r));
  if (rolesFilter.length === 0 && staffOnly) {
    rolesFilter = ['admin', 'secretary'];
  }

  let q = supabase
    .from('tweets')
    // FK ヒント `users!user_id` を明示。段階4 migration で tweet_reactions / tweet_comments
    // が users への FK を持ったことで PostgREST が relationship を一意に解決できなくなる
    // ため、tweets.user_id を介した埋め込みであることを明示する。
    .select('id, user_id, body, image_data, expires_at, is_pinned, created_at, edited_at, mentioned_user_ids, reaction_count, comment_count, users!user_id(id, full_name, avatar_url, role)')
    .or(`is_pinned.eq.true,expires_at.gt.${new Date().toISOString()}`);

  // ロール絞り込み（運営のみ / 個別ロール）:
  //   user_roles JOIN roles ベースで対象 user_id 集合を取得（dual-read: 旧 users.role も並走）
  if (rolesFilter.length > 0) {
    const roleSet = new Set();
    // user_roles 経由（合成値 'producer_director' は roles マスタに無いため除外して引く）
    const codesForJoin = rolesFilter.filter(c => c !== 'producer_director');
    if (codesForJoin.length > 0) {
      const { data: ur } = await supabase
        .from('user_roles').select('user_id, roles(code)').in('roles.code', codesForJoin);
      (ur || []).forEach(r => { if (r.roles) roleSet.add(r.user_id); });
    }
    // dual-read: 旧 users.role 列も拾う（'producer_director' を含む全コード）
    const { data: legacyRole, error: sErr } = await supabase
      .from('users').select('id').in('role', rolesFilter);
    if (sErr) return res.status(500).json({ error: sErr.message });
    (legacyRole || []).forEach(u => roleSet.add(u.id));
    const ids = Array.from(roleSet);
    if (ids.length === 0) return res.json([]);
    q = q.in('user_id', ids);
  }

  // 自分のつぶやき・返信フィルター:
  //   1) 自分の投稿
  //   2) mentioned_user_ids に自分が含まれる投稿
  //   3) 自分がコメントに参加した投稿（tweet_comments を引いて tweet_id 集合を作る）
  if (mine) {
    const meId = req.user.id;
    const nowIso = new Date().toISOString();

    // (a) 自分の投稿 + メンション対象  (b) 自分が参加したコメントの tweet 集合
    //     を並列取得（これまでは (a)+(b) が逐次だった分の round trip を 1 段削減）。
    const [myCommentsRes, ownAndMentionRes] = await Promise.all([
      supabase.from('tweet_comments').select('tweet_id').eq('user_id', meId).is('deleted_at', null),
      supabase.from('tweets')
        .select('id, user_id, body, image_data, expires_at, is_pinned, created_at, edited_at, mentioned_user_ids, reaction_count, comment_count, users!user_id(id, full_name, avatar_url, role)')
        .or(`is_pinned.eq.true,expires_at.gt.${nowIso}`)
        .or(`user_id.eq.${meId},mentioned_user_ids.cs.{${meId}}`),
    ]);
    if (myCommentsRes.error) return res.status(500).json({ error: myCommentsRes.error.message });
    if (ownAndMentionRes.error) return res.status(500).json({ error: ownAndMentionRes.error.message });

    const commentedTweetIds = Array.from(new Set((myCommentsRes.data || []).map(c => c.tweet_id))).filter(Boolean);

    const merged = new Map();
    for (const t of (ownAndMentionRes.data || [])) merged.set(t.id, t);

    // (c) コメント参加対象 — 取得したコメント tweet_id があるときだけ追加クエリ
    if (commentedTweetIds.length > 0) {
      const { data: commentTweets, error: ctErr } = await supabase.from('tweets')
        .select('id, user_id, body, image_data, expires_at, is_pinned, created_at, edited_at, mentioned_user_ids, reaction_count, comment_count, users!user_id(id, full_name, avatar_url, role)')
        .or(`is_pinned.eq.true,expires_at.gt.${nowIso}`)
        .in('id', commentedTweetIds);
      if (ctErr) return res.status(500).json({ error: ctErr.message });
      for (const t of (commentTweets || [])) if (!merged.has(t.id)) merged.set(t.id, t);
    }

    let list = Array.from(merged.values());

    // ロール絞り込み（roles=... or 後方互換 staff_only=1）併用時のフィルター
    if (rolesFilter.length > 0) {
      const allowed = new Set(rolesFilter);
      list = list.filter(t => allowed.has(t.users?.role));
    }

    list.sort((a, b) => {
      if (!!a.is_pinned !== !!b.is_pinned) return a.is_pinned ? -1 : 1;
      return new Date(b.created_at) - new Date(a.created_at);
    });
    // hardcoded slice(0, 50) → 200 に拡張（2026-05-08）
    // ページネーション UI が無く、active tweet 総数 > 50 の状況で 51件目以降が silent に消えていた
    list = list.slice(0, 200);

    if (!list.length) return res.json([]);

    // 既存 GET と同じロジックでリアクションを付与
    const ids = list.map(t => t.id);
    const { data: allReactions } = await supabase.from('tweet_reactions')
      .select('tweet_id, user_id, reaction_type').in('tweet_id', ids);
    const countByType = new Map();
    const myReactionsMap = new Map();
    (allReactions || []).forEach(r => {
      if (!countByType.has(r.tweet_id)) countByType.set(r.tweet_id, {});
      const cm = countByType.get(r.tweet_id);
      cm[r.reaction_type] = (cm[r.reaction_type] || 0) + 1;
      if (r.user_id === req.user.id) {
        if (!myReactionsMap.has(r.tweet_id)) myReactionsMap.set(r.tweet_id, new Set());
        myReactionsMap.get(r.tweet_id).add(r.reaction_type);
      }
    });
    return res.json(list.map(t => {
      const myReactions = Array.from(myReactionsMap.get(t.id) || []);
      const counts = countByType.get(t.id) || {};
      const heartCount = counts.heart || 0;
      return {
        ...t,
        reaction_count: t.reaction_count ?? 0,
        comment_count:  t.comment_count  ?? 0,
        reaction_counts: counts,
        my_reactions: myReactions,
        like_count: heartCount,
        my_liked:   myReactions.includes('heart'),
      };
    }));
  }

  // 通常の一覧
  // hardcoded .limit(50) → 200 に拡張（2026-05-08）
  // ページネーション UI が無く、active tweet 総数 > 50 で 51件目以降が永遠に見えない silent miss だった
  const { data: list, error } = await q
    .order('is_pinned', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) return res.status(500).json({ error: error.message });
  if (!list || list.length === 0) return res.json([]);
  const ids = list.map(t => t.id);

  // 5種リアクションを一括取得（種別ごとカウント + 自分が押した種別）
  const { data: allReactions } = await supabase.from('tweet_reactions')
    .select('tweet_id, user_id, reaction_type').in('tweet_id', ids);
  const countByType = new Map();   // tweet_id -> { good: n, heart: n, ... }
  const myReactionsMap = new Map(); // tweet_id -> Set<reaction_type>
  (allReactions || []).forEach(r => {
    if (!countByType.has(r.tweet_id)) countByType.set(r.tweet_id, {});
    const cm = countByType.get(r.tweet_id);
    cm[r.reaction_type] = (cm[r.reaction_type] || 0) + 1;
    if (r.user_id === req.user.id) {
      if (!myReactionsMap.has(r.tweet_id)) myReactionsMap.set(r.tweet_id, new Set());
      myReactionsMap.get(r.tweet_id).add(r.reaction_type);
    }
  });

  res.json(list.map(t => {
    const myReactions = Array.from(myReactionsMap.get(t.id) || []);
    const counts = countByType.get(t.id) || {};
    const heartCount = counts.heart || 0;
    return {
      ...t,
      reaction_count: t.reaction_count ?? 0,
      comment_count:  t.comment_count  ?? 0,
      reaction_counts: counts,           // { good: 3, heart: 2, ... }
      my_reactions: myReactions,         // ['good','heart']
      // 互換維持（旧UIが残っても壊れないように）
      like_count: heartCount,
      my_liked:   myReactions.includes('heart'),
    };
  }));
});

// つぶやき投稿（写真は任意 + 本文）
//   Phase 1 段階4: メンション抽出 → mentioned_user_ids 保存 → mention 通知発火
router.post('/tweets', requireAuth, upload.single('image'), async (req, res) => {
  const file = req.file;
  const body = String(req.body?.body || '').trim();
  if (!body) return res.status(400).json({ error: '本文を入力してください' });
  if (body.length > TWEET_BODY_MAX) {
    return res.status(400).json({ error: `本文は ${TWEET_BODY_MAX} 字以内にしてください` });
  }
  let dataUrl = null;
  if (file) {
    if (!file.mimetype || !file.mimetype.startsWith('image/')) {
      return res.status(400).json({ error: '画像ファイルを選択してください' });
    }
    dataUrl = `data:${file.mimetype};base64,${file.buffer.toString('base64')}`;
    if (dataUrl.length > TWEET_IMAGE_MAX_BYTES) {
      return res.status(400).json({ error: '画像サイズが大きすぎます（縮小してから再投稿してください）' });
    }
  }

  // メンション解決
  const mentionedIds = await extractMentions(body);

  const { data, error } = await supabase.from('tweets')
    .insert({
      user_id: req.user.id,
      body,
      image_data: dataUrl,
      mentioned_user_ids: mentionedIds,
    })
    .select('id, user_id, body, image_data, expires_at, is_pinned, created_at, edited_at, mentioned_user_ids, reaction_count, comment_count')
    .single();
  if (error) return res.status(500).json({ error: error.message });

  // メンション通知（自分自身は除外）
  const senderName = req.user.nickname || req.user.full_name || '誰か';
  const excerpt = body.length > 50 ? body.slice(0, 50) + '…' : body;
  for (const uid of (mentionedIds || [])) {
    if (uid === req.user.id) continue;
    createNotification({
      userId: uid,
      type: 'mention',
      title: `${senderName}さんがあなたをメンションしました`,
      body: excerpt,
      linkUrl: `/haruka.html?tweet=${data.id}`,
      meta: {
        tweet_id: data.id,
        mentioned_by_name: senderName,
        post_excerpt: excerpt,
      },
      senderId: req.user.id,
    }).catch(e => console.error('[tweets] mention 通知失敗:', e.message));
  }

  res.json({
    ...data,
    reaction_counts: {},
    my_reactions: [],
    like_count: 0,
    my_liked: false,
  });
});

// 本文編集（投稿者本人のみ。画像・ピン留めは触らない）
//   メンションは抽出し直して mentioned_user_ids を更新するが、
//   再投稿の度にスパム通知が飛ばないよう、編集時は新規メンション分のみ通知する。
router.patch('/tweets/:id', requireAuth, async (req, res) => {
  const body = String(req.body?.body || '').trim();
  if (!body) return res.status(400).json({ error: '本文を入力してください' });
  if (body.length > TWEET_BODY_MAX) {
    return res.status(400).json({ error: `本文は ${TWEET_BODY_MAX} 字以内にしてください` });
  }

  const { data: existing, error: tErr } = await supabase.from('tweets')
    .select('id, user_id, body, mentioned_user_ids').eq('id', req.params.id).maybeSingle();
  if (tErr) return res.status(500).json({ error: tErr.message });
  if (!existing) return res.status(404).json({ error: 'つぶやきが見つかりません' });
  if (existing.user_id !== req.user.id) {
    return res.status(403).json({ error: '自分の投稿のみ編集できます' });
  }

  const newMentionedIds = await extractMentions(body);
  const oldSet = new Set(existing.mentioned_user_ids || []);

  const { data, error } = await supabase.from('tweets')
    .update({ body, mentioned_user_ids: newMentionedIds, edited_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .select('id, user_id, body, image_data, expires_at, is_pinned, created_at, edited_at, mentioned_user_ids, reaction_count, comment_count')
    .single();
  if (error) return res.status(500).json({ error: error.message });

  // 編集で追加された新規メンションだけ通知
  const senderName = req.user.nickname || req.user.full_name || '誰か';
  const excerpt = body.length > 50 ? body.slice(0, 50) + '…' : body;
  for (const uid of (newMentionedIds || [])) {
    if (uid === req.user.id) continue;
    if (oldSet.has(uid)) continue;
    createNotification({
      userId: uid,
      type: 'mention',
      title: `${senderName}さんがあなたをメンションしました`,
      body: excerpt,
      linkUrl: `/haruka.html?tweet=${data.id}`,
      meta: {
        tweet_id: data.id,
        mentioned_by_name: senderName,
        post_excerpt: excerpt,
      },
      senderId: req.user.id,
    }).catch(e => console.error('[tweets] mention(edit) 通知失敗:', e.message));
  }

  res.json(data);
});

// 削除（投稿者本人 OR admin / secretary）
router.delete('/tweets/:id', requireAuth, async (req, res) => {
  const { data: t, error: tErr } = await supabase.from('tweets')
    .select('id, user_id').eq('id', req.params.id).maybeSingle();
  if (tErr) return res.status(500).json({ error: tErr.message });
  if (!t) return res.status(404).json({ error: 'つぶやきが見つかりません' });
  const isSelf = t.user_id === req.user.id;
  const role = getEffectiveRole(req);
  const isMod = role === 'admin' || role === 'secretary';
  if (!isSelf && !isMod) return res.status(403).json({ error: '権限がありません' });
  const { error } = await supabase.from('tweets').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ---------- 既存いいねAPI（互換維持） ----------
// heart リアクションと別に tweet_likes も維持しているが、ユーザー体感で揃うよう
// like ボタン押下時は tweet_reactions(heart) も一緒に発火する。
router.post('/tweets/:id/like', requireAuth, async (req, res) => {
  const { error } = await supabase.from('tweet_likes')
    .upsert({ tweet_id: req.params.id, user_id: req.user.id }, { onConflict: 'tweet_id,user_id' });
  if (error) return res.status(500).json({ error: error.message });
  // 新リアクション体系へも反映（既に heart 押し済みなら ON CONFLICT でスキップ）
  await supabase.from('tweet_reactions')
    .upsert(
      { tweet_id: req.params.id, user_id: req.user.id, reaction_type: 'heart' },
      { onConflict: 'tweet_id,user_id,reaction_type' }
    );
  res.json({ ok: true });
});

router.delete('/tweets/:id/like', requireAuth, async (req, res) => {
  const { error } = await supabase.from('tweet_likes')
    .delete().eq('tweet_id', req.params.id).eq('user_id', req.user.id);
  if (error) return res.status(500).json({ error: error.message });
  await supabase.from('tweet_reactions')
    .delete()
    .eq('tweet_id', req.params.id)
    .eq('user_id', req.user.id)
    .eq('reaction_type', 'heart');
  res.json({ ok: true });
});

// ==================== Phase 1 段階4: 5種リアクション ====================

// リアクション追加
//   POST /api/tweets/:id/reactions  body: { reaction_type }
//   既に同じ種別を押している場合は 409 を返す（UI 側はトグル運用なので基本起きない）
router.post('/tweets/:id/reactions', requireAuth, async (req, res) => {
  const tweetId = req.params.id;
  const reactionType = String(req.body?.reaction_type || '').trim();
  if (!TWEET_REACTION_TYPES.includes(reactionType)) {
    return res.status(400).json({ error: 'リアクション種別が不正です' });
  }

  // 投稿者を確認（通知発火用）
  const { data: tweet, error: tErr } = await supabase.from('tweets')
    .select('id, user_id, body').eq('id', tweetId).maybeSingle();
  if (tErr) return res.status(500).json({ error: tErr.message });
  if (!tweet) return res.status(404).json({ error: 'つぶやきが見つかりません' });

  const { data, error } = await supabase.from('tweet_reactions')
    .insert({ tweet_id: tweetId, user_id: req.user.id, reaction_type: reactionType })
    .select('id, reaction_type')
    .single();
  if (error) {
    // UNIQUE 違反 → 409
    if (error.code === '23505') {
      return res.status(409).json({ error: 'すでにこのリアクションを押しています' });
    }
    return res.status(500).json({ error: error.message });
  }

  // heart リアクションは旧 tweet_likes にも同期（GETの like_count 整合維持）
  if (reactionType === 'heart') {
    await supabase.from('tweet_likes')
      .upsert({ tweet_id: tweetId, user_id: req.user.id }, { onConflict: 'tweet_id,user_id' });
  }

  // 投稿者が自分以外なら post_reaction 通知
  if (tweet.user_id !== req.user.id) {
    const senderName = req.user.nickname || req.user.full_name || '誰か';
    const reactionEmoji = {
      good: '👍', heart: '❤️', clap: '👏', smile: '😊', surprised: '😳',
    }[reactionType] || '✨';
    const excerpt = (tweet.body || '').length > 50
      ? tweet.body.slice(0, 50) + '…'
      : (tweet.body || '');
    createNotification({
      userId: tweet.user_id,
      type: 'post_reaction',
      title: `${senderName}さんが ${reactionEmoji} リアクションしました`,
      body: excerpt,
      linkUrl: `/haruka.html?tweet=${tweetId}`,
      meta: {
        tweet_id: tweetId,
        reaction_type: reactionType,
        sender_name: senderName,
      },
      senderId: req.user.id,
    }).catch(e => console.error('[tweets] reaction 通知失敗:', e.message));
  }

  res.json({ ok: true, id: data.id, reaction_type: data.reaction_type });
});

// リアクション取消
//   DELETE /api/tweets/:id/reactions/:type
router.delete('/tweets/:id/reactions/:type', requireAuth, async (req, res) => {
  const reactionType = String(req.params.type || '');
  if (!TWEET_REACTION_TYPES.includes(reactionType)) {
    return res.status(400).json({ error: 'リアクション種別が不正です' });
  }
  const { error } = await supabase.from('tweet_reactions')
    .delete()
    .eq('tweet_id', req.params.id)
    .eq('user_id', req.user.id)
    .eq('reaction_type', reactionType);
  if (error) return res.status(500).json({ error: error.message });

  // heart の場合は旧 tweet_likes も削除
  if (reactionType === 'heart') {
    await supabase.from('tweet_likes')
      .delete().eq('tweet_id', req.params.id).eq('user_id', req.user.id);
  }

  res.json({ ok: true });
});

// ==================== Phase 1 段階4: コメント ====================

// コメント一覧
//   GET /api/tweets/:id/comments
//   deleted_at IS NULL のみ、created_at 昇順
router.get('/tweets/:id/comments', requireAuth, async (req, res) => {
  const { data, error } = await supabase.from('tweet_comments')
    .select('id, tweet_id, user_id, body, mentioned_user_ids, created_at, users!user_id(id, full_name, avatar_url, role)')
    .eq('tweet_id', req.params.id)
    .is('deleted_at', null)
    .order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// コメント投稿
//   POST /api/tweets/:id/comments  body: { body }
//   ・メンション抽出 → mentioned_user_ids 保存 → mention 通知
//   ・投稿者が自分以外なら post_comment 通知
router.post('/tweets/:id/comments', requireAuth, async (req, res) => {
  const tweetId = req.params.id;
  const body = String(req.body?.body || '').trim();
  if (!body) return res.status(400).json({ error: 'コメントを入力してください' });
  if (body.length > TWEET_COMMENT_MAX) {
    return res.status(400).json({ error: `コメントは ${TWEET_COMMENT_MAX} 字以内にしてください` });
  }

  const { data: tweet, error: tErr } = await supabase.from('tweets')
    .select('id, user_id, body').eq('id', tweetId).maybeSingle();
  if (tErr) return res.status(500).json({ error: tErr.message });
  if (!tweet) return res.status(404).json({ error: 'つぶやきが見つかりません' });

  const mentionedIds = await extractMentions(body);

  const { data: comment, error } = await supabase.from('tweet_comments')
    .insert({
      tweet_id: tweetId,
      user_id: req.user.id,
      body,
      mentioned_user_ids: mentionedIds,
    })
    .select('id, tweet_id, user_id, body, mentioned_user_ids, created_at')
    .single();
  if (error) return res.status(500).json({ error: error.message });

  // 通知発火
  const senderName = req.user.nickname || req.user.full_name || '誰か';
  const excerpt = body.length > 50 ? body.slice(0, 50) + '…' : body;
  const notifiedSet = new Set(); // 同じ人への二重通知を防ぐ

  // 1) 投稿者へのコメント通知（自分以外）
  if (tweet.user_id !== req.user.id) {
    notifiedSet.add(tweet.user_id);
    createNotification({
      userId: tweet.user_id,
      type: 'post_comment',
      title: `${senderName}さんがコメントしました`,
      body: excerpt,
      linkUrl: `/haruka.html?tweet=${tweetId}`,
      meta: {
        tweet_id: tweetId,
        comment_id: comment.id,
        sender_name: senderName,
        post_excerpt: excerpt,
      },
      senderId: req.user.id,
    }).catch(e => console.error('[tweets] comment 通知失敗:', e.message));
  }

  // 2) メンション通知（自分自身 / 投稿者重複は除外）
  for (const uid of (mentionedIds || [])) {
    if (uid === req.user.id) continue;
    if (notifiedSet.has(uid)) continue;
    notifiedSet.add(uid);
    createNotification({
      userId: uid,
      type: 'mention',
      title: `${senderName}さんがあなたをメンションしました`,
      body: excerpt,
      linkUrl: `/haruka.html?tweet=${tweetId}`,
      meta: {
        tweet_id: tweetId,
        comment_id: comment.id,
        mentioned_by_name: senderName,
        post_excerpt: excerpt,
      },
      senderId: req.user.id,
    }).catch(e => console.error('[tweets] mention(comment) 通知失敗:', e.message));
  }

  // フロント表示用に user 情報も付与して返す
  const { data: u } = await supabase.from('users')
    .select('id, full_name, avatar_url, role').eq('id', req.user.id).maybeSingle();

  res.json({ ...comment, users: u || null });
});

// コメント削除（本人 or admin/secretary、論理削除）
//   DELETE /api/tweets/:id/comments/:commentId
router.delete('/tweets/:id/comments/:commentId', requireAuth, async (req, res) => {
  const { data: c, error: cErr } = await supabase.from('tweet_comments')
    .select('id, user_id, deleted_at').eq('id', req.params.commentId).maybeSingle();
  if (cErr) return res.status(500).json({ error: cErr.message });
  if (!c) return res.status(404).json({ error: 'コメントが見つかりません' });
  if (c.deleted_at) return res.json({ ok: true }); // 既に削除済み

  const isSelf = c.user_id === req.user.id;
  const role = getEffectiveRole(req);
  const isMod = role === 'admin' || role === 'secretary';
  if (!isSelf && !isMod) return res.status(403).json({ error: '権限がありません' });

  const { error } = await supabase.from('tweet_comments')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', req.params.commentId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});


// ==================== クライアント請求書 ====================

// 納品済みクリエイティブ一覧（クライアント向け請求書作成用）
router.get('/client-invoice/items', requireAuth, async (req, res) => {
  const { client_id, year, month } = req.query;
  if (!client_id) return res.status(400).json({ error: 'client_id is required' });

  const { data: projects } = await supabase.from('projects').select('id').eq('client_id', client_id);
  if (!projects?.length) return res.json([]);
  const projectIds = projects.map(p => p.id);

  let query = supabase.from('creatives')
    .select(`id, file_name, status, client_fee, project_id, updated_at,
      projects(id, name, clients(id, name, client_code)),
      creative_assignments(users(id, full_name))`)
    .in('project_id', projectIds)
    .eq('status', '納品')
    .order('updated_at', { ascending: false });

  if (year && month) {
    const y = parseInt(year), m = parseInt(month);
    query = query
      .gte('updated_at', new Date(y, m-1, 1).toISOString())
      .lt('updated_at', new Date(y, m, 1).toISOString());
  }

  const { data: creatives, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  res.json((creatives||[]).map(c => ({
    id: c.id,
    file_name: c.file_name,
    client_fee: c.client_fee || 0,
    project_name: c.projects?.name || '-',
    client_name: c.projects?.clients?.name || '-',
    assignees: [...new Set((c.creative_assignments||[]).map(a => a.users?.full_name).filter(Boolean))].join('、') || '-',
  })));
});

// クライアント請求書生成
router.post('/client-invoice/generate', requireAuth, async (req, res) => {
  const { client_id, year, month, items, notes } = req.body;
  if (!client_id || !items?.length) return res.status(400).json({ error: 'client_id と items は必須です' });

  const now = new Date();
  const ym = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}`;
  const { count } = await supabase.from('invoices').select('*', {count:'exact',head:true}).like('invoice_number', `INV-${ym}-%`);
  const invoiceNumber = `INV-${ym}-${String((count||0)+1).padStart(3,'0')}`;
  const totalAmount = items.reduce((s, i) => s + (i.client_fee || 0), 0);

  const { data: projects } = await supabase.from('projects').select('id').eq('client_id', client_id).limit(1);
  const project_id = projects?.[0]?.id || null;

  const { data: invoice, error: invErr } = await supabase.from('invoices').insert({
    invoice_number: invoiceNumber,
    issuer_id: req.user.id,
    project_id,
    total_amount: totalAmount,
    status: 'draft',
    year: year || now.getFullYear(),
    month: month || (now.getMonth()+1),
    invoice_type: 'client',
    recipient_client_id: client_id,
    notes: notes || null,
  }).select().single();
  if (invErr) return res.status(500).json({ error: invErr.message });

  // invoice_items を一括保存
  const { data: invItems, error: itemsErr } = await supabase
    .from('invoice_items')
    .insert(items.map((item, idx) => ({
      invoice_id: invoice.id,
      creative_id: item.creative_id,
      creative_label: item.file_name || item.label || null,
      cost_type: 'base_fee',
      total_amount: item.client_fee,
      is_special: false,
      label: item.file_name || item.label || '明細',
      quantity: 1,
      unit: '本',
      unit_price: item.client_fee || 0,
      sort_order: idx,
    })))
    .select('id, creative_id');
  if (itemsErr) return res.status(500).json({ error: itemsErr.message });

  // invoice_item_details を一括保存
  const details = (invItems || []).map(invItem => ({
    invoice_item_id: invItem.id,
    cost_type: 'base_fee',
    unit_price: items.find(i => i.creative_id === invItem.creative_id)?.client_fee,
    amount:     items.find(i => i.creative_id === invItem.creative_id)?.client_fee,
  }));
  if (details.length) await supabase.from('invoice_item_details').insert(details);

  // creatives.client_fee を並列更新
  await Promise.all(items.map(item =>
    supabase.from('creatives').update({ client_fee: item.client_fee }).eq('id', item.creative_id)
  ));

  res.json(invoice);
});

// 請求書 備考更新（draft/rejected のみ）
router.patch('/invoices/:id', requireAuth, async (req, res) => {
  const { notes, line_items } = req.body;
  const invId = req.params.id;
  const { data: inv, error: fetchErr } = await supabase
    .from('invoices').select('issuer_id, status').eq('id', invId).single();
  if (fetchErr || !inv) return res.status(404).json({ error: '請求書が見つかりません' });
  if (inv.issuer_id !== req.user?.id && !(await isStaffRequester(req)))
    return res.status(403).json({ error: 'アクセス権限がありません' });

  // 明細編集は draft / rejected のみ許可（提出済み以降は不可）
  if (Array.isArray(line_items)) {
    if (!['draft', 'rejected'].includes(inv.status)) {
      return res.status(403).json({ error: '提出済み以降の請求書は明細編集できません' });
    }

    const CHANGE_REASON_MAX = 500;
    // バリデーション
    for (const li of line_items) {
      if (!li.label || !String(li.label).trim()) {
        return res.status(400).json({ error: '品目（label）は必須です' });
      }
      const q = Number(li.quantity);
      const up = Number(li.unit_price);
      if (!Number.isFinite(q) || q < 0) return res.status(400).json({ error: '数量は0以上の数値で入力してください' });
      if (!Number.isFinite(up) || up < 0) return res.status(400).json({ error: '単価は0以上の数値で入力してください' });
      // change_reason の型・長さチェック（あれば）
      if (li.change_reason !== undefined && li.change_reason !== null) {
        if (typeof li.change_reason !== 'string') {
          return res.status(400).json({ error: '変更理由は文字列で指定してください' });
        }
        if (li.change_reason.length > CHANGE_REASON_MAX) {
          return res.status(400).json({ error: `変更理由は${CHANGE_REASON_MAX}文字以内で入力してください` });
        }
      }
    }

    // 既存明細を取得（監査列込み。未反映環境ではフォールバック）
    let existing = null, exErr = null;
    let auditCols = true;
    {
      const r = await supabase.from('invoice_items')
        .select('id, unit_price, original_unit_price, price_change_reason')
        .eq('invoice_id', invId);
      existing = r.data; exErr = r.error;
      if (exErr && /original_unit_price|price_change_reason/.test(exErr.message || '')) {
        auditCols = false;
        const r2 = await supabase.from('invoice_items')
          .select('id, unit_price').eq('invoice_id', invId);
        existing = r2.data; exErr = r2.error;
      }
    }
    if (exErr) return res.status(500).json({ error: exErr.message });
    const existingMap = new Map((existing || []).map(r => [r.id, r]));
    const keepIds = new Set(line_items.filter(li => li.id).map(li => li.id));

    // 単価変更行の理由必須チェック（既存行のみ。新規行は元単価という概念なし）
    for (let i = 0; i < line_items.length; i++) {
      const li = line_items[i];
      if (!li.id || !existingMap.has(li.id)) continue;
      const prev = existingMap.get(li.id);
      const prevOrigUp = (auditCols && prev.original_unit_price != null)
        ? Number(prev.original_unit_price)
        : Number(prev.unit_price);
      const newUp = Math.round(Number(li.unit_price) || 0);
      if (Number.isFinite(prevOrigUp) && prevOrigUp !== newUp) {
        const reason = (typeof li.change_reason === 'string') ? li.change_reason.trim() : '';
        if (!reason) {
          return res.status(400).json({ error: `${i+1}行目: 単価を変更した行は変更理由が必須です` });
        }
      }
    }

    // 削除対象（送られてこなかった既存行）
    const toDelete = [...existingMap.keys()].filter(id => !keepIds.has(id));
    if (toDelete.length) {
      // 関連する details を先に削除（FK制約回避）
      await supabase.from('invoice_item_details').delete().in('invoice_item_id', toDelete);
      const { error: delErr } = await supabase.from('invoice_items').delete().in('id', toDelete);
      if (delErr) return res.status(500).json({ error: delErr.message });
    }

    // 更新 / 新規挿入
    let totalAmount = 0;
    for (let i = 0; i < line_items.length; i++) {
      const li = line_items[i];
      const quantity   = Number(li.quantity) || 0;
      const unit_price = Math.round(Number(li.unit_price) || 0);
      const amount     = Math.round(quantity * unit_price);
      const sort_order = Number.isFinite(Number(li.sort_order)) ? Number(li.sort_order) : i;
      totalAmount += amount;

      const row = {
        invoice_id:   invId,
        label:        String(li.label).trim(),
        quantity,
        unit:         li.unit ? String(li.unit).trim() : '式',
        unit_price,
        total_amount: amount,
        sort_order,
      };
      // クリエイティブ紐付け / コスト種別 / 表示用ラベルを保持（送られてきた場合のみ反映）
      if (li.creative_id !== undefined)    row.creative_id    = li.creative_id || null;
      if (li.cost_type !== undefined)      row.cost_type      = li.cost_type   || null;
      if (li.creative_label !== undefined) row.creative_label = li.creative_label || null;

      // creative_id があれば cost_type 必須
      if (row.creative_id && !row.cost_type) {
        return res.status(400).json({ error: 'creative紐付け行は cost_type が必須です' });
      }

      const isExisting = li.id && existingMap.has(li.id);
      // 監査列の付与（DBに列がある場合のみ）
      if (auditCols) {
        const reason = (typeof li.change_reason === 'string') ? li.change_reason.trim() : '';
        if (isExisting) {
          const prev = existingMap.get(li.id);
          const prevOrigUp = prev.original_unit_price != null
            ? Number(prev.original_unit_price)
            : Number(prev.unit_price);
          // original_unit_price は既存値を維持（無ければ unit_price で初期化）
          row.original_unit_price = Number.isFinite(prevOrigUp) ? prevOrigUp : unit_price;
          if (Number.isFinite(prevOrigUp) && prevOrigUp !== unit_price) {
            // 単価変更あり → 新しい理由で上書き
            row.price_change_reason = reason || null;
          } else {
            // 変更なし → 既存理由をそのまま保持
            row.price_change_reason = prev.price_change_reason ?? null;
          }
        } else {
          // 新規追加行: original = current, 理由は null
          row.original_unit_price = unit_price;
          row.price_change_reason = null;
        }
      }

      const writeRow = async (payload) => {
        if (isExisting) {
          return await supabase.from('invoice_items').update(payload).eq('id', li.id);
        }
        return await supabase.from('invoice_items').insert(payload);
      };
      let { error: wErr } = await writeRow(row);
      if (wErr && /original_unit_price|price_change_reason/.test(wErr.message || '')) {
        // 監査列が未反映の環境向けフォールバック
        const { original_unit_price: _o, price_change_reason: _r, ...rest } = row;
        ({ error: wErr } = await writeRow(rest));
      }
      if (wErr) return res.status(500).json({ error: wErr.message });
    }

    // invoices.total_amount を再計算
    await supabase.from('invoices').update({
      total_amount: totalAmount,
      updated_at: new Date().toISOString(),
    }).eq('id', invId);
  }

  // notes 更新（line_items のみ送られてきた場合は notes はそのまま）
  const updatePayload = {};
  if (notes !== undefined) updatePayload.notes = notes ?? null;
  if (Object.keys(updatePayload).length) {
    updatePayload.updated_at = new Date().toISOString();
    const { error: nErr } = await supabase
      .from('invoices').update(updatePayload).eq('id', invId);
    if (nErr) return res.status(500).json({ error: nErr.message });
  }

  // 最終結果を返す
  const { data: result, error: getErr } = await supabase
    .from('invoices').select('*').eq('id', invId).single();
  if (getErr) return res.status(500).json({ error: getErr.message });
  res.json(result);
});

// 請求書作成（選択クリエイティブから生成）
router.post('/invoices/generate', requireAuth, async (req, res) => {
  // Stage 5: 旧 project_rates / director_rates / producer_rates の参照を撤去し、
  // project_estimate_lines + project_estimate_line_costs (ADR 002+003+004+005) を read する。
  const { resolveCreativeRoleCost } = require('../utils/pricing');
  const { cycle_id, selected_creative_ids, selected_items } = req.body;
  let { project_id } = req.body;
  // admin/secretary のみ代理発行可能、それ以外はログインユーザー本人に固定
  const issuer_id = ((await isStaffRequester(req)) && req.body.issuer_id)
    ? req.body.issuer_id
    : req.user.id;
  if (!issuer_id) return res.status(400).json({ error: '発行者は必須です' });

  // selected_items のバリデーションと正規化
  // Issue #192: ディレクター請求書には director_fee 行を含められる
  // プロデューサー対応: producer_fee 行も含められる
  const ALLOWED_COST_TYPES = new Set(['base_fee', 'script_fee', 'ai_fee', 'other_fee', 'director_fee', 'producer_fee']);
  const CHANGE_REASON_MAX = 500;
  let overrideMap = null;
  if (Array.isArray(selected_items) && selected_items.length) {
    overrideMap = new Map();
    for (const si of selected_items) {
      if (!si || !si.creative_id || !Array.isArray(si.items)) {
        return res.status(400).json({ error: 'selected_items の形式が不正です' });
      }
      const normalized = [];
      for (const it of si.items) {
        if (!it || !ALLOWED_COST_TYPES.has(it.cost_type)) {
          return res.status(400).json({ error: 'cost_type が不正です' });
        }
        const up = Number(it.unit_price);
        if (!Number.isFinite(up) || !Number.isInteger(up) || up < 0) {
          return res.status(400).json({ error: '単価は0以上の整数で指定してください' });
        }
        let changeReason = null;
        if (it.change_reason !== undefined && it.change_reason !== null) {
          if (typeof it.change_reason !== 'string') {
            return res.status(400).json({ error: '変更理由は文字列で指定してください' });
          }
          const trimmed = it.change_reason.trim();
          if (trimmed.length > CHANGE_REASON_MAX) {
            return res.status(400).json({ error: `変更理由は${CHANGE_REASON_MAX}文字以内で入力してください` });
          }
          if (trimmed.length > 0) changeReason = trimmed;
        }
        if (up > 0) normalized.push({ cost_type: it.cost_type, unit_price: up, change_reason: changeReason });
      }
      if (normalized.length) overrideMap.set(si.creative_id, normalized);
    }
    if (!overrideMap.size) return res.status(400).json({ error: '請求対象がありません' });
  }

  // 請求可能なクリエイティブを取得
  // 後から追加された列（schema-sync が失敗していると本番に存在しない可能性がある）
  // PR #79 と同様に、SELECT 句を「optional 込み → 失敗時 optional 抜きで再試行」できる形にする
  // Issue #192: ディレクター請求の判定のため projects(director_id) も取得
  // プロデューサー対応: projects(producer_id) も取得
  // 追加メンバー（Dチェック呼び出し）対応: creatives.additional_reviewer_ids も取得
  //   - additional_reviewer_ids に含まれるユーザーは「Dチェック追加レビュアー」であり、報酬対象外。
  //   - creative_assignments には INSERT されない方針なので構造的には混入しないが、
  //     将来的なバグでも報酬が発生しないよう本ハンドラ内で明示的にガードする（防御的プログラミング）。
  const OPTIONAL_COLS = ['force_delivered', 'force_delivered_reason', 'force_delivered_at', 'additional_reviewer_ids'];
  const buildSelect = (includeOptional) => `*${includeOptional ? ', ' + OPTIONAL_COLS.join(', ') : ''}, projects(id, director_id, producer_id), creative_assignments(user_id, role, rank_applied, users(id, full_name))`;

  if (!(overrideMap && overrideMap.size) && !(selected_creative_ids && selected_creative_ids.length) && !project_id) {
    return res.status(400).json({ error: '請求対象クリエイティブを選択してください' });
  }

  const overrideCreativeIds = overrideMap ? [...overrideMap.keys()] : null;
  const buildAndApply = (includeOptional) => {
    let q = supabase
      .from('creatives')
      .select(buildSelect(includeOptional))
      .not('creative_assignments', 'is', null);
    if (overrideCreativeIds && overrideCreativeIds.length) {
      q = q.in('id', overrideCreativeIds);
    } else if (selected_creative_ids && selected_creative_ids.length) {
      q = q.in('id', selected_creative_ids);
    } else if (project_id) {
      q = q.eq('project_id', project_id).or('is_payable.eq.true,special_payable.eq.true');
    }
    if (cycle_id) q = q.eq('cycle_id', cycle_id);
    return q;
  };

  let { data: creatives, error: cErr } = await buildAndApply(true);
  // schema-sync が失敗していて optional 列が本番DBに存在しない場合、optional を外して再試行する
  if (cErr && /column .+ does not exist/.test(cErr.message || '')) {
    console.warn('[invoices/generate] optional列なし → fallback で再取得:', cErr.message);
    ({ data: creatives, error: cErr } = await buildAndApply(false));
  }
  if (cErr) return res.status(500).json({ error: cErr.message });
  if (!creatives.length) return res.status(400).json({ error: '請求可能なクリエイティブがありません' });

  // 追加メンバー（Dチェック呼び出し）ガード: 列が無い場合・schema-sync 未適用環境では空配列扱い。
  // creatives 側 PR がまだ本番に適用されていない場合でも 500 にならないよう、必ずアプリ側で || [] する。
  const additionalReviewerIdsOf = (c) => Array.isArray(c?.additional_reviewer_ids) ? c.additional_reviewer_ids : [];

  // 早期拒否: issuer_id が「全該当クリエイティブで追加レビュアーとしてしか紐づいていない」場合は明示的に 400。
  //   - 追加レビュアーは creative_assignments に INSERT されないので、本来 selectAble にもならないが、
  //     不正リクエストや将来の混入バグを早期検知するための明示ガード。
  //   - issuer が director_id / producer_id 経由で正規請求対象なら通す（その場合は弾かない）。
  const issuerIsOnlyAdditionalReviewer = creatives.every(c => {
    const additional = additionalReviewerIdsOf(c);
    if (!additional.includes(issuer_id)) return false; // 追加レビュアーですらない creative は対象外なので false
    const isDirector = c.projects?.director_id === issuer_id;
    const isProducer = c.projects?.producer_id === issuer_id;
    const inAssignments = (c.creative_assignments || []).some(a => a.user_id === issuer_id);
    // director/producer/assignments のいずれかに正規所属しているなら追加レビュアーであっても請求は通す
    return !isDirector && !isProducer && !inAssignments;
  });
  if (issuerIsOnlyAdditionalReviewer) {
    return res.status(400).json({ error: '追加レビュアー（Dチェック呼び出し）は請求対象外です' });
  }

  // selected_creative_ids使用時はproject_idを最初のクリエイティブから補完
  if (!project_id && creatives.length) project_id = creatives[0].project_id;

  // 対象案件の単価を新スキーマ (lines + line_costs) からまとめて取得（Stage 5）
  // ADR 002 (見積行統合) + ADR 005 (status filter)
  const projectIds = [...new Set(creatives.map(c => c.project_id))];
  const linesByProject = new Map();
  const lineCostsByLine = {};
  if (projectIds.length) {
    const { data: lines, error: linesErr } = await supabase
      .from('project_estimate_lines')
      .select(`
        id, project_id, category_id, name, planned_count, client_unit_price, status, sort_order,
        category:creative_categories(id, code, name),
        line_costs:project_estimate_line_costs(
          id, line_id, role_id, user_id, unit_price, pricing_type, percentage, actual_hours,
          role:roles(id, code, label)
        )
      `)
      .in('project_id', projectIds);
    if (linesErr) {
      console.warn('[invoices/generate] estimate_lines load failed:', linesErr.message);
    } else {
      for (const line of (lines || [])) {
        if (!linesByProject.has(line.project_id)) linesByProject.set(line.project_id, []);
        linesByProject.get(line.project_id).push(line);
        lineCostsByLine[line.id] = Array.isArray(line.line_costs) ? line.line_costs : [];
      }
    }
  }

  // 請求書番号を自動採番
  const now = new Date();
  const ym = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}`;
  const { count } = await supabase
    .from('invoices')
    .select('*', { count: 'exact', head: true })
    .like('invoice_number', `INV-${ym}-%`);
  const invoiceNumber = `INV-${ym}-${String((count||0)+1).padStart(3,'0')}`;

  // 明細を生成
  // 新方式: 1 creative = 複数 invoice_items（コスト種別ごと）
  const COST_TYPE_LABELS = {
    base_fee:     '編集',
    script_fee:   '台本作成',
    ai_fee:       'AI生成（ナレーション含む）',
    other_fee:    'その他',
    director_fee: 'ディレクション費',
    producer_fee: 'プロデュース費',
  };
  let totalAmount = 0;
  const itemRows = [];   // 実際に invoice_items に INSERT する行
  let sortCounter = 0;

  for (const creative of creatives) {
    // 追加レビュアー（Dチェック呼び出し）の防御フィルタ:
    //   - additional_reviewer_ids に含まれる user は creative_assignments に INSERT されない設計だが、
    //     仮に何らかのバグで assignment に紛れ込んでいても、正規 role が付いていなければ請求対象にしない。
    //   - 同一人物が「editor 等の正規assignment」かつ「additional_reviewer_ids」両方に居るケースは
    //     正規assignment側を優先する（＝ assignment 検索ロジックでヒットすれば請求対象、これは現状動作で満たされる）。
    //   - director_id / producer_id は projects テーブル側の固定値であり、creatives.additional_reviewer_ids とは
    //     別カラム・別テーブル。構造上「追加メンバーが director_id に化ける」ことはあり得ない。
    const additionalReviewerIds = additionalReviewerIdsOf(creative);
    const assignment = creative.creative_assignments?.find(
      a => a.user_id === issuer_id
    );
    const isDirector = creative.projects?.director_id === issuer_id;
    const isProducer = creative.projects?.producer_id === issuer_id;
    if (!assignment && !isDirector && !isProducer) continue;
    // 防御ガード: assignment が無く director/producer でもなく、追加レビュアーとしてのみ紐づくなら明示スキップ
    // （上の continue で既に弾かれているはずだが、二重防御として残す）
    if (!assignment && !isDirector && !isProducer && additionalReviewerIds.includes(issuer_id)) continue;

    const creativeLabel = creative.file_name || '';
    let breakdown;

    // デフォルト単価（新スキーマ project_estimate_lines/line_costs 由来）を算出
    // 旧 4 分割 (base_fee/script_fee/ai_fee/other_fee) は editor/designer の単一 line_cost に統合済み。
    // よって base_fee 1 行に丸める（cost_type の他 3 種は overrideMap でしか発生しない）。
    const primaryRole = assignment?.role
      || (isDirector ? 'director' : (isProducer ? 'producer' : null));
    const rankApplied = assignment?.rank_applied ?? null;

    let defaultBaseFee = 0;
    if (assignment && primaryRole && primaryRole !== 'director' && primaryRole !== 'producer') {
      const r = resolveCreativeRoleCost({
        creative, roleCode: primaryRole, rankApplied, linesByProject, lineCostsByLine,
      });
      defaultBaseFee = r.unit_price || 0;
    }
    let defaultDirectorFee = 0;
    if (isDirector || primaryRole === 'director') {
      const r = resolveCreativeRoleCost({
        creative, roleCode: 'director', rankApplied, linesByProject, lineCostsByLine,
      });
      defaultDirectorFee = r.unit_price || 0;
    }
    let defaultProducerFee = 0;
    if (isProducer || primaryRole === 'producer') {
      const r = resolveCreativeRoleCost({
        creative, roleCode: 'producer', rankApplied, linesByProject, lineCostsByLine,
      });
      defaultProducerFee = r.unit_price || 0;
    }
    const defaultUnitPriceMap = {
      base_fee:     defaultBaseFee,
      script_fee:   0, // 新スキーマでは role 単位の単一 unit_price に統合済み
      ai_fee:       0,
      other_fee:    0,
      director_fee: defaultDirectorFee,
      producer_fee: defaultProducerFee,
    };

    if (overrideMap) {
      breakdown = overrideMap.get(creative.id) || [];
    } else {
      const fromRate = (defaultBaseFee > 0) ? [
        { cost_type: 'base_fee', unit_price: defaultBaseFee },
      ] : [];
      const fromDirector = (defaultDirectorFee > 0) ? [
        { cost_type: 'director_fee', unit_price: defaultDirectorFee },
      ] : [];
      const fromProducer = (defaultProducerFee > 0) ? [
        { cost_type: 'producer_fee', unit_price: defaultProducerFee },
      ] : [];
      breakdown = [...fromRate, ...fromDirector, ...fromProducer].filter(b => b.unit_price > 0);
    }

    if (!breakdown.length) continue;

    for (const b of breakdown) {
      const defaultUp = defaultUnitPriceMap[b.cost_type] || 0;
      const isOverridden = overrideMap && b.unit_price !== defaultUp;
      if (isOverridden && (!b.change_reason || !b.change_reason.trim())) {
        return res.status(400).json({ error: `単価を変更した行は変更理由が必須です（${creativeLabel} / ${COST_TYPE_LABELS[b.cost_type] || b.cost_type}）` });
      }
      totalAmount += b.unit_price;
      itemRows.push({
        creative_id:    creative.id,
        creative_label: creativeLabel,
        cost_type:      b.cost_type,
        label:          COST_TYPE_LABELS[b.cost_type] || b.cost_type,
        quantity:       1,
        unit:           '本',
        unit_price:     b.unit_price,
        total_amount:   b.unit_price,
        // 単価変更とspecial_payableは別概念。is_special/special_reasonはcreative由来に戻す
        is_special:     creative.special_payable || false,
        special_reason: creative.special_payable_reason || null,
        // 監査用：変更されていなくてもデフォルト単価を必ず保存
        original_unit_price: defaultUp,
        price_change_reason: isOverridden ? b.change_reason : null,
        sort_order:     sortCounter++,
      });
    }
  }

  if (!itemRows.length) return res.status(400).json({ error: '該当するアサインが見つかりません' });

  // 請求書を保存
  const { data: invoice, error: iErr } = await supabase
    .from('invoices')
    .insert({
      invoice_number: invoiceNumber,
      issuer_id, project_id, cycle_id,
      total_amount: totalAmount,
      status: 'draft',
      year: req.body.year || now.getFullYear(),
      month: req.body.month || (now.getMonth() + 1),
      recipient_id: req.body.recipient_id || null,
      notes: req.body.notes || null,
    })
    .select()
    .single();
  if (iErr) return res.status(500).json({ error: iErr.message });

  // 明細（コスト種別ごと）を一括保存
  const buildItemRow = (r, withAudit) => {
    const row = {
      invoice_id:    invoice.id,
      creative_id:   r.creative_id,
      creative_label:r.creative_label,
      cost_type:     r.cost_type,
      total_amount:  r.total_amount,
      is_special:    r.is_special,
      special_reason:r.special_reason,
      label:         r.label,
      quantity:      r.quantity,
      unit:          r.unit,
      unit_price:    r.unit_price,
      sort_order:    r.sort_order,
    };
    if (withAudit) {
      row.original_unit_price = r.original_unit_price;
      row.price_change_reason = r.price_change_reason;
    }
    return row;
  };
  let invItems, itemsErr;
  ({ data: invItems, error: itemsErr } = await supabase
    .from('invoice_items')
    .insert(itemRows.map(r => buildItemRow(r, true)))
    .select('id, creative_id, cost_type, unit_price'));
  if (itemsErr && /original_unit_price|price_change_reason/.test(itemsErr.message || '')) {
    console.warn('[invoices/generate] 監査列未反映のためフォールバック insert を使用:', itemsErr.message);
    ({ data: invItems, error: itemsErr } = await supabase
      .from('invoice_items')
      .insert(itemRows.map(r => buildItemRow(r, false)))
      .select('id, creative_id, cost_type, unit_price'));
  }
  if (itemsErr) return res.status(500).json({ error: itemsErr.message });

  // 後方互換: invoice_item_details にも対応行を入れる（旧クエリで参照する画面が混在しても破綻しないように）
  const allDetails = (invItems || []).map(ii => ({
    invoice_item_id: ii.id,
    cost_type:  ii.cost_type || 'other_fee',
    unit_price: ii.unit_price || 0,
    amount:     ii.unit_price || 0,
  }));
  if (allDetails.length) {
    const { error: detErr } = await supabase.from('invoice_item_details').insert(allDetails);
    if (detErr) return res.status(500).json({ error: detErr.message });
  }

  res.json({ ok: true, invoice_number: invoiceNumber, total_amount: totalAmount, items_count: itemRows.length });
});

// 請求書発行（draft → issued）
router.post('/invoices/:id/issue', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('invoices')
    .update({ status: 'issued', issued_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// 請求書提出（draft → submitted）
router.post('/invoices/:id/submit', requireAuth, async (req, res) => {
  const id = req.params.id;
  const { data: existing, error: fetchErr } = await supabase
    .from('invoices')
    .select('id, status, issuer_id')
    .eq('id', id)
    .maybeSingle();
  if (fetchErr) {
    console.error('[invoices/submit] fetch error:', fetchErr);
    return res.status(500).json({ error: `取得失敗: ${fetchErr.message}` });
  }
  if (!existing) return res.status(404).json({ error: '請求書が見つかりません' });
  if (existing.status !== 'draft' && existing.status !== 'rejected') {
    return res.status(400).json({ error: `この状態では提出できません（現在: ${existing.status}）` });
  }
  const { data, error } = await supabase
    .from('invoices')
    .update({ status: 'submitted', submitted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .maybeSingle();
  if (error) {
    console.error('[invoices/submit] update error:', error);
    return res.status(500).json({ error: `更新失敗: ${error.message}` });
  }
  if (!data) return res.status(500).json({ error: '更新後の取得に失敗しました' });
  res.json(data);
});

// 請求書承認（submitted → approved）管理者のみ
router.post('/invoices/:id/approve', requireAuth, requireLevel('admin'), async (req, res) => {
  const { data, error } = await supabase
    .from('invoices')
    .update({ status: 'approved', approved_at: new Date().toISOString(), approved_by: req.user?.id || null, updated_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// 請求書差し戻し（submitted → rejected）管理者のみ
router.post('/invoices/:id/reject', requireAuth, requireLevel('admin'), async (req, res) => {
  const { rejection_reason } = req.body;
  const { data, error } = await supabase
    .from('invoices')
    .update({ status: 'rejected', rejected_at: new Date().toISOString(), rejection_reason: rejection_reason || null, updated_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// 請求書削除（draft のみ）― 子テーブルを先に削除してFK制約を回避
router.delete('/invoices/:id', requireAuth, async (req, res) => {
  const invId = req.params.id;

  // 明細の存在確認 + オーナーチェック
  const { data: inv } = await supabase.from('invoices').select('issuer_id, status').eq('id', invId).single();
  if (!inv) return res.status(404).json({ error: '請求書が見つかりません' });
  if (!['draft','rejected'].includes(inv.status)) return res.status(400).json({ error: '下書き・差し戻し以外は削除できません' });
  if (inv.issuer_id !== req.user?.id && !(await isStaffRequester(req)))
    return res.status(403).json({ error: 'アクセス権限がありません' });

  // 1. invoice_item_details を削除（invoice_items 経由）
  const { data: items } = await supabase.from('invoice_items').select('id').eq('invoice_id', invId);
  if (items?.length) {
    const itemIds = items.map(i => i.id);
    const { error: detErr } = await supabase.from('invoice_item_details').delete().in('invoice_item_id', itemIds);
    if (detErr) return res.status(500).json({ error: detErr.message });
  }

  // 2. invoice_items を削除
  const { error: itemErr } = await supabase.from('invoice_items').delete().eq('invoice_id', invId);
  if (itemErr) return res.status(500).json({ error: itemErr.message });

  // 3. invoice を削除
  const { error } = await supabase.from('invoices').delete().eq('id', invId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ==================== ボール保持者判定 ====================

function getBallHolder(status, assignments, directorByTeamId, directorByUserId, directorIdByTeamId, directorIdByUserId, projectDirector) {
  const editor   = assignments?.find(a => ['editor','designer','director_as_editor'].includes(a.role));
  const dirAssign = assignments?.find(a => a.role === 'director');

  const editorName = editor?.users?.full_name || '編集者';
  const editorId = editor?.users?.id || null;

  // ディレクター名 / ID の優先順位:
  //   1. assignment 直接（role='director' の creative_assignments）
  //   2. projects.director_id（案件専用ディレクター・本来の最優先設定）
  //   3. 編集者のチーム代表ディレクター（フォールバック）
  //   4. 編集者の所属メンバー → チーム代表（フォールバック）
  //   5. 'ディレクター' リテラル
  let directorName = dirAssign?.users?.full_name;
  let directorId = dirAssign?.users?.id || null;
  if (!directorName && projectDirector) {
    directorName = projectDirector.full_name || '';
    directorId   = projectDirector.id || null;
  }
  if (!directorName && editor?.users) {
    const u = editor.users;
    directorName = (u.team_id && directorByTeamId?.get(u.team_id))
      || (u.id && directorByUserId?.get(u.id))
      || '';
    directorId = (u.team_id && directorIdByTeamId?.get(u.team_id))
      || (u.id && directorIdByUserId?.get(u.id))
      || null;
  }
  directorName = directorName || 'ディレクター';

  const ballMap = {
    '未着手': { holder: editorName, type: 'editor', user_id: editorId },
    '制作中（初稿提出前）': { holder: editorName, type: 'editor', user_id: editorId },
    '台本制作': { holder: editorName, type: 'editor', user_id: editorId },
    '素材・ナレ作成': { holder: editorName, type: 'editor', user_id: editorId },
    '編集': { holder: editorName, type: 'editor', user_id: editorId },
    'Dチェック': { holder: directorName, type: 'director', user_id: directorId },
    'Dチェック後修正': { holder: editorName, type: 'editor', user_id: editorId },
    'Pチェック': { holder: 'プロデューサー', type: 'producer' },
    'Pチェック後修正': { holder: editorName, type: 'editor', user_id: editorId },
    'クライアントチェック中': { holder: 'クライアント', type: 'client' },
    // CLチェック修正指摘がDBに保存された時点で、ディレクターが client feedback を翻訳・伝達するフェーズは完了しており、
    // 次は編集者が修正する段階。よって Dチェック後修正・Pチェック後修正と揃えて editor 単独をボール保持者とする。
    'クライアントチェック後修正': { holder: editorName, type: 'editor', user_id: editorId },
    '納品': { holder: '完了', type: 'done' },
  };
  return ballMap[status] || { holder: '不明', type: 'unknown' };
}

// ==================== ball_holder_id キャッシュ同期 ====================
//
// 役割:
//   通知機能（notify_ball_returned トリガー）が反応するのは creatives.ball_holder_id 列。
//   一方、表示用の ball_holder（誰が今ボール持ってるか）は status × creative_assignments
//   × projects.director_id から派生計算（getBallHolder）している。
//
//   トリガーで通知を打つには「派生結果のIDを実列にキャッシュUPDATEする」必要がある。
//   これを担うのが syncBallHolderId()。
//
// 呼び出すべきタイミング:
//   ・creative の status を更新した直後
//   ・creative_assignments を追加・削除した直後
//   ・projects.director_id を変更した直後（広範囲影響なので Phase 1 では未対応。Phase 2で再検討）
//
// 設計判断:
//   getBallHolder() のロジックを温存してそのまま流用。Single source of truth を保つ。
//   ball_holder_id が NULL／同値の場合は UPDATE しない（無駄な書き込みとトリガー誤発火を避ける）。
//
// パフォーマンス:
//   1クリエイティブあたり追加クエリ 4本程度（creative + assignments + teams + project director）。
//   バックフィル時はN+1注意（scripts/backfill_ball_holder_id.js は逐次実行で問題なし、
//   全件でも数百〜数千件なので運用に耐える）。
async function syncBallHolderId(creativeId, sb) {
  const client = sb || supabase;
  if (!creativeId) return null;
  try {
    // 1. クリエイティブ本体 + assignments + 案件専用ディレクター
    const { data: c, error: cErr } = await client
      .from('creatives')
      .select(`
        id, status, ball_holder_id, project_id, team_id,
        projects(id, director_id),
        creative_assignments(role, users(id, full_name, team_id))
      `)
      .eq('id', creativeId)
      .maybeSingle();
    if (cErr) { console.warn('[syncBallHolderId] creative fetch failed:', cErr.message); return null; }
    if (!c) return null;

    // 2. ディレクター解決用に teams を取得（チーム経由のディレクター推論）
    const { data: teamsRaw } = await client
      .from('teams')
      .select('id, director_id, director:director_id(full_name), team_members(user_id)');
    const directorByTeamId   = new Map();
    const directorByUserId   = new Map();
    const directorIdByTeamId = new Map();
    const directorIdByUserId = new Map();
    (teamsRaw || []).forEach(t => {
      const name = t.director?.full_name || '';
      if (t.director_id) {
        directorByTeamId.set(t.id, name);
        directorIdByTeamId.set(t.id, t.director_id);
      }
      (t.team_members || []).forEach(tm => {
        if (tm.user_id && !directorByUserId.has(tm.user_id)) {
          directorByUserId.set(tm.user_id, name);
          directorIdByUserId.set(tm.user_id, t.director_id || null);
        }
      });
    });

    // 3. 案件専用ディレクターのフルネーム取得（assignment にディレクター無い時のフォールバック）
    let projectDirector = null;
    const projDirId = c.projects?.director_id;
    if (projDirId) {
      const { data: u } = await client.from('users').select('id, full_name').eq('id', projDirId).maybeSingle();
      projectDirector = u || null;
    }

    // 4. getBallHolder() に投げて新しいID算出
    const ball = getBallHolder(
      c.status, c.creative_assignments,
      directorByTeamId, directorByUserId, directorIdByTeamId, directorIdByUserId,
      projectDirector
    );
    // user_id（editor / director / producer 等）は単数。
    // 将来 type:'all' のような複数保持ステータスを再導入する場合のフォールバックとして、
    // user_ids 配列があればその先頭（編集者）をキャッシュに採用するロジックを残しておく。
    // （現時点では type:'all' を使うステータスは存在しないため、このフォールバックは発火しない）
    let nextHolderId = ball?.user_id || null;
    if (!nextHolderId && Array.isArray(ball?.user_ids) && ball.user_ids.length > 0) {
      nextHolderId = ball.user_ids[0];
    }

    // 5. 変化が無ければ UPDATE しない（トリガー無駄発火を回避）
    if ((c.ball_holder_id || null) === (nextHolderId || null)) {
      return c.ball_holder_id || null;
    }

    const { error: uErr } = await client
      .from('creatives')
      .update({ ball_holder_id: nextHolderId })
      .eq('id', creativeId);
    if (uErr) { console.warn('[syncBallHolderId] update failed:', uErr.message); return null; }
    return nextHolderId;
  } catch (e) {
    console.warn('[syncBallHolderId] exception:', e.message);
    return null;
  }
}

// 外部スクリプト・他モジュールからも使えるよう named export はファイル末尾の
// `router.syncBallHolderId = ...` ＋ `module.exports = router;` で公開している。

// ==================== 訴求タイプ ====================

// 訴求タイプマスター一覧
router.get('/appeal-types', async (req, res) => {
  const { data, error } = await supabase
    .from('appeal_types')
    .select('*')
    .eq('is_active', true)
    .order('sort_order', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.get('/projects/:id/appeal-types', async (req, res) => {
  const { data, error } = await supabase
    .from('project_appeal_types')
    .select(`*, appeal_types(id, code, name)`)
    .eq('project_id', req.params.id)
    .order('created_at');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// 案件に訴求タイプを追加
router.post('/projects/:id/appeal-types', requireAuth, requirePermission('project.create_edit'), async (req, res) => {
  const { appeal_type_id } = req.body;
  if (!appeal_type_id) return res.status(400).json({ error: '訴求タイプIDは必須です' });
  const { data, error } = await supabase
    .from('project_appeal_types')
    .insert({ project_id: req.params.id, appeal_type_id, seq_counter: 0 })
    .select(`*, appeal_types(id, code, name)`)
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// 案件から訴求タイプを削除
router.delete('/projects/:id/appeal-types/:patId', requireAuth, requirePermission('project.create_edit'), async (req, res) => {
  const { error } = await supabase
    .from('project_appeal_types')
    .delete()
    .eq('id', req.params.patId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ==================== ファイル名自動生成 ====================

router.post('/projects/:id/generate-filename', async (req, res) => {
  const { appeal_type_id, production_date, product_code, media_code, creative_fmt, creative_size } = req.body;
  if (!appeal_type_id) return res.status(400).json({ error: '訴求タイプは必須です' });

  const { data: project, error: pErr } = await supabase
    .from('projects')
    .select(`*, clients(id, name, client_code)`)
    .eq('id', req.params.id)
    .single();
  if (pErr) return res.status(500).json({ error: pErr.message });

  const { data: appealType, error: aErr } = await supabase
    .from('client_appeal_axes')
    .select('*')
    .eq('id', appeal_type_id)
    .single();
  if (aErr || !appealType) return res.status(400).json({ error: '訴求タイプが見つかりません' });

  const clientCode = (project.clients?.client_code ||
    project.clients?.name?.slice(0, 3).toUpperCase() || 'UNK')
    .toUpperCase().slice(0, 3);

  // 案件内の使用済みシーケンス番号を内部コードから取得
  const { data: allCreatives } = await supabase
    .from('creatives')
    .select('internal_code, file_name, appeal_type_id')
    .eq('project_id', req.params.id);

  // 使用済み連番を収集
  // 優先順位: internal_code先頭3桁 → 新ファイル名末尾7桁 → 旧ファイル名先頭3桁
  const usedSeqs = (allCreatives || [])
    .map(c => {
      if (c.internal_code) {
        const m = c.internal_code.match(/^(\d{3})_/);
        if (m) return Number(m[1]);
      }
      const fn = c.file_name || '';
      const m7 = fn.match(/_(\d{7})$/);  // 新形式: 末尾7桁
      if (m7) return Number(m7[1]);
      const m3 = fn.match(/^(\d{3})_/);  // 旧形式: 先頭3桁
      return m3 ? Number(m3[1]) : null;
    })
    .filter(n => n !== null);

  // ADR 008 Phase 4: 連番起点（projects.next_filename_serial）優先、無ければ最小未使用
  const { start: cfgStart, digits: cfgDigits } = await resolveProjectSerialConfig(project);
  const serialDigits = cfgDigits || 3;
  let nextSeq = cfgStart;
  if (!nextSeq) {
    nextSeq = 1;
    while (usedSeqs.includes(nextSeq)) nextSeq++;
  }

  // 訴求タイプの連番
  const nextAppealSeq = (allCreatives || []).filter(c => c.appeal_type_id === appeal_type_id).length + 1;

  const seqStr3 = String(nextSeq).padStart(3, '0');
  const seqStr  = String(nextSeq).padStart(serialDigits, '0');
  const appealSeqStr = String(nextAppealSeq).padStart(2, '0');

  // 内部コード（旧命名規約）
  const internalCode = `${seqStr3}_${clientCode}_${appealType.code}${appealSeqStr}_v1`;

  // 制作日: YYMMDD
  const dateStr = (() => {
    const d = production_date ? new Date(production_date) : new Date();
    const yy = String(d.getFullYear()).slice(2);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yy}${mm}${dd}`;
  })();

  // ADR 007: ファイル名テンプレ解決
  const tplResolved = await resolveProjectFilenameTemplate(project);
  let newFileName;
  if (tplResolved) {
    const tokenValues = buildFilenameTokenValues({
      project, appealType, body: req.body, seqStr7: seqStr, dateStr, version: 'v1',
    });
    newFileName = renderFilename(tplResolved.template, tokenValues, tplResolved.overrides, { serialDigits });
  } else {
    // ハードコードフォールバック: {YYMMDD}_{商材}_{媒体}_{FMT}_{訴求軸}_{サイズ}_{seq(serial_digits)}
    const parts = [dateStr, product_code, media_code, creative_fmt, appealType.code, creative_size, seqStr]
      .map(p => (p || '').toString().trim())
      .filter(Boolean);
    newFileName = parts.join('_');
  }

  res.json({
    file_name: newFileName,
    internal_code: internalCode,
    seq: nextSeq,
    total: usedSeqs.length,
    appeal_seq: nextAppealSeq,
    client_code: clientCode,
    appeal_code: appealType.code,
    date_str: dateStr,
  });
});

// ==================== チーム ====================

// チーム一覧
router.get('/teams', async (req, res) => {
  // team_members.leader_rank はチームカード内のメンバー順序（リーダー優先）に使うので含める。
  // 旧スキーマ環境（leader_rank 列なし）でも壊れないよう、エラーになったら user_id のみで再取得する。
  let { data, error } = await supabase
    .from('teams')
    .select(`
      *,
      director:users!teams_director_id_fkey(id, full_name),
      producer:users!teams_producer_id_fkey(id, full_name),
      team_members(user_id, leader_rank)
    `)
    .order('team_code');
  if (error) {
    console.warn('[GET /teams] leader_rank select failed, fallback to user_id only:', error.message);
    const fb = await supabase
      .from('teams')
      .select(`
        *,
        director:users!teams_director_id_fkey(id, full_name),
        producer:users!teams_producer_id_fkey(id, full_name),
        team_members(user_id)
      `)
      .order('team_code');
    if (fb.error) return res.status(500).json({ error: fb.error.message });
    data = fb.data;
  }
  res.json(data);
});

// チーム作成
router.post('/teams', requireAuth, requirePermission('team.manage'), async (req, res) => {
  const { team_code, team_name, team_type, director_id, producer_id } = req.body;
  if (!team_code || !team_name || !team_type) {
    return res.status(400).json({ error: 'コード・名前・種別は必須です' });
  }
  const { data, error } = await supabase
    .from('teams')
    .insert({ team_code, team_name, team_type, director_id: director_id || null, producer_id: producer_id || null })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// チーム更新
router.put('/teams/:id', requireAuth, requirePermission('team.manage'), async (req, res) => {
  const { team_code, team_name, team_type, director_id, producer_id, is_active, member_ids } = req.body;
  const updateData = {
    team_name, team_type,
    director_id: director_id || null,
    producer_id: producer_id || null,
    is_active,
    updated_at: new Date().toISOString()
  };
  if (team_code !== undefined) {
    const trimmed = String(team_code).trim();
    if (!trimmed) return res.status(400).json({ error: 'チームコードは必須です' });
    updateData.team_code = trimmed;
  }
  const { data, error } = await supabase
    .from('teams')
    .update(updateData)
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) {
    if (error.code === '23505') {
      return res.status(400).json({ error: `チームコード「${updateData.team_code}」は既に使用されています` });
    }
    return res.status(500).json({ error: error.message });
  }

  // team_members 中間テーブルで管理（users.team_id は基本チームとして変更しない）
  if (member_ids !== undefined) {
    const teamId = req.params.id;
    await supabase.from('team_members').delete().eq('team_id', teamId);
    if (member_ids.length > 0) {
      const inserts = member_ids.map(uid => ({ team_id: teamId, user_id: uid }));
      const { error: e2 } = await supabase.from('team_members').insert(inserts);
      if (e2) return res.status(500).json({ error: e2.message });
    }
  }

  res.json(data);
});

// ADR 008 Stage 2: チームメンバーの leader_rank（リーダー / サブリーダー）更新
// PUT /api/teams/:team_id/members/:user_id/leader-rank
//   body: { leader_rank: 'leader' | 'sub_leader' | null }
//
// 'leader' を指定する場合、同チームに既存 leader が居れば「置き換え方式」で
// 既存 leader を NULL に落としてから対象を leader にする（uniq_team_members_leader 違反回避）。
// team_members 行が存在しない場合は同時に INSERT する（メンバー編集モーダル経由で
// team_id を変更したばかりで team_members 行が未作成のケース対応）。
router.put('/teams/:team_id/members/:user_id/leader-rank', requireAuth, requirePermission('team.manage'), async (req, res) => {
  const { team_id, user_id } = req.params;
  const { leader_rank } = req.body || {};
  if (leader_rank !== null && leader_rank !== 'leader' && leader_rank !== 'sub_leader') {
    return res.status(400).json({ error: 'leader_rank は leader / sub_leader / null のいずれかにしてください' });
  }
  // チーム存在確認
  const { data: team, error: tErr } = await supabase
    .from('teams').select('id').eq('id', team_id).maybeSingle();
  if (tErr) return res.status(500).json({ error: tErr.message });
  if (!team) return res.status(404).json({ error: 'チームが見つかりません' });

  // 'leader' を割り当てる場合は既存 leader を先に NULL に落として置き換える
  if (leader_rank === 'leader') {
    const { error: clearErr } = await supabase
      .from('team_members')
      .update({ leader_rank: null })
      .eq('team_id', team_id)
      .eq('leader_rank', 'leader')
      .neq('user_id', user_id);
    if (clearErr) {
      // leader_rank 列未追加環境への defensive fallback（migration 未適用時に 500 を返さない）
      console.warn('[leader-rank PUT] clear existing leader failed:', clearErr.message);
      return res.status(500).json({ error: clearErr.message });
    }
  }

  // 対象 team_members 行を upsert（無ければ作る、あれば leader_rank だけ更新）
  // upsert は (team_id, user_id) 複合 PK を想定。SELECT → INSERT/UPDATE で 2 段階に分けて実装。
  const { data: existing, error: exErr } = await supabase
    .from('team_members')
    .select('team_id, user_id')
    .eq('team_id', team_id)
    .eq('user_id', user_id)
    .maybeSingle();
  if (exErr) return res.status(500).json({ error: exErr.message });

  if (existing) {
    const { error: upErr } = await supabase
      .from('team_members')
      .update({ leader_rank })
      .eq('team_id', team_id)
      .eq('user_id', user_id);
    if (upErr) return res.status(500).json({ error: upErr.message });
  } else {
    const { error: insErr } = await supabase
      .from('team_members')
      .insert({ team_id, user_id, leader_rank });
    if (insErr) return res.status(500).json({ error: insErr.message });
  }

  res.json({ ok: true, team_id, user_id, leader_rank });
});

// チーム削除（admin/secretary/producer/PD のみ）
// users.team_id / creatives.team_id は ON DELETE SET NULL で「未所属」に戻る。
// team_members / client_teams は ON DELETE CASCADE で自動削除される。
router.delete('/teams/:id', requireAuth, requirePermission('team.delete'), async (req, res) => {
  const teamId = req.params.id;
  const { error } = await supabase.from('teams').delete().eq('id', teamId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ==================== Slack ワークスペース ====================

// 一覧
router.get('/slack-workspaces', async (_req, res) => {
  const { data, error } = await supabase
    .from('slack_workspaces')
    .select('*')
    .order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// 作成
router.post('/slack-workspaces', async (req, res) => {
  const { name, team_id, bot_token } = req.body;
  if (!name || !team_id) return res.status(400).json({ error: '名前とワークスペースIDは必須です' });
  const { data, error } = await supabase
    .from('slack_workspaces')
    .insert({ name, team_id, bot_token: bot_token || null })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// 更新
router.put('/slack-workspaces/:id', async (req, res) => {
  const { name, team_id, bot_token } = req.body;
  const { data, error } = await supabase
    .from('slack_workspaces')
    .update({ name, team_id, bot_token: bot_token || null, updated_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// 削除
router.delete('/slack-workspaces/:id', async (req, res) => {
  const { error } = await supabase.from('slack_workspaces').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ==================== 通知デバッグ（最高管理者専用） ====================

// 通知デバッグ用: Chatwork ルームに直接投稿
router.post('/debug/test-chatwork', requireAuth, requireSuperAdmin, async (req, res) => {
  const { room_id, message } = req.body;
  if (!room_id || !message) return res.status(400).json({ error: 'room_id と message は必須です' });
  const token = process.env.CHATWORK_API_TOKEN;
  if (!token) return res.status(400).json({ ok: false, error: 'CHATWORK_API_TOKEN 未設定' });
  try {
    const axios = require('axios');
    const r = await axios.post(`https://api.chatwork.com/v2/rooms/${room_id}/messages`,
      new URLSearchParams({ body: message, self_unread: '0' }),
      { headers: { 'X-ChatWorkToken': token }, timeout: 10000, validateStatus: () => true }
    );
    return res.json({ ok: r.status >= 200 && r.status < 300, status: r.status, response: r.data });
  } catch (e) {
    return res.json({ ok: false, error: e.message, code: e.code });
  }
});

// 通知デバッグ用: Slack ワークスペースのチャンネルに直接投稿
router.post('/debug/test-slack', requireAuth, requireSuperAdmin, async (req, res) => {
  const { channel_url, message, mention_user_id } = req.body;
  if (!channel_url || !message) return res.status(400).json({ error: 'channel_url と message は必須です' });
  const m = String(channel_url).match(/\/client\/(T[A-Z0-9]+)\/(C[A-Z0-9]+)/);
  if (!m) return res.status(400).json({ ok: false, error: 'URL から workspace/channel を抽出できません (期待形式: https://app.slack.com/client/T.../C...)' });
  const team_id = m[1], channel_id = m[2];
  const { data, error: wsErr } = await supabase
    .from('slack_workspaces')
    .select('bot_token,name')
    .eq('team_id', team_id)
    .maybeSingle();
  if (wsErr) return res.json({ ok: false, error: `slack_workspaces 検索エラー: ${wsErr.message}` });
  if (!data?.bot_token) return res.json({ ok: false, error: `slack_workspaces に team_id=${team_id} の bot_token が登録されていません` });
  try {
    const axios = require('axios');
    const text = mention_user_id ? `<@${mention_user_id}> ${message}` : message;
    const r = await axios.post('https://slack.com/api/chat.postMessage',
      { channel: channel_id, text },
      { headers: { Authorization: `Bearer ${data.bot_token}`, 'Content-Type': 'application/json' }, timeout: 10000, validateStatus: () => true }
    );
    return res.json({ ok: r.data?.ok === true, status: r.status, workspace: data.name, channel: channel_id, response: r.data });
  } catch (e) {
    return res.json({ ok: false, error: e.message, code: e.code });
  }
});

// ==================== クライアント商材・訴求軸マスター ====================

// クライアント商材一覧
router.get('/clients/:id/products', async (req, res) => {
  const { data, error } = await supabase.from('client_products')
    .select('*').eq('client_id', req.params.id)
    .order('sort_order').order('created_at');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});
// クライアント商材作成
router.post('/clients/:id/products', requireAuth, requirePermission('project.create_edit'), async (req, res) => {
  const { code, name, note, expires_at, sort_order } = req.body;
  if (!code || !name) return res.status(400).json({ error: 'コードと名称は必須です' });
  const { data, error } = await supabase.from('client_products')
    .insert({ client_id: req.params.id, code: code.toUpperCase(), name, note: note||null, expires_at: expires_at||null, sort_order: parseInt(sort_order)||0, is_active: true })
    .select().single();
  if (error) {
    if (error.code === '23505') return res.status(400).json({ error: `コード「${code.toUpperCase()}」の商材は既に登録されています` });
    return res.status(500).json({ error: error.message });
  }
  res.json(data);
});
// クライアント商材更新
router.put('/clients/:id/products/:pid', requireAuth, requirePermission('project.create_edit'), async (req, res) => {
  const { code, name, note, expires_at, sort_order, is_active } = req.body;
  const { data, error } = await supabase.from('client_products')
    .update({ code, name, note: note||null, expires_at: expires_at||null, sort_order: parseInt(sort_order)||0, is_active, updated_at: new Date().toISOString() })
    .eq('id', req.params.pid).eq('client_id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});
// クライアント商材削除
router.delete('/clients/:id/products/:pid', requireAuth, requirePermission('project.create_edit'), async (req, res) => {
  const { error } = await supabase.from('client_products').delete().eq('id', req.params.pid);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// クライアント訴求軸一覧
router.get('/clients/:id/appeal-axes', async (req, res) => {
  const { data, error } = await supabase.from('client_appeal_axes')
    .select('*').eq('client_id', req.params.id)
    .order('sort_order').order('created_at');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});
// クライアント訴求軸作成
router.post('/clients/:id/appeal-axes', requireAuth, requirePermission('project.create_edit'), async (req, res) => {
  const { code, name, note, expires_at, sort_order } = req.body;
  if (!code || !name) return res.status(400).json({ error: 'コードと名称は必須です' });
  const { data, error } = await supabase.from('client_appeal_axes')
    .insert({ client_id: req.params.id, code: code.toLowerCase(), name, note: note||null, expires_at: expires_at||null, sort_order: parseInt(sort_order)||0, is_active: true })
    .select().single();
  if (error) {
    if (error.code === '23505') return res.status(400).json({ error: `コード「${code.toLowerCase()}」の訴求軸は既に登録されています` });
    return res.status(500).json({ error: error.message });
  }
  res.json(data);
});
// クライアント訴求軸更新
router.put('/clients/:id/appeal-axes/:aid', requireAuth, requirePermission('project.create_edit'), async (req, res) => {
  const { code, name, note, expires_at, sort_order, is_active } = req.body;
  const { data, error } = await supabase.from('client_appeal_axes')
    .update({ code, name, note: note||null, expires_at: expires_at||null, sort_order: parseInt(sort_order)||0, is_active, updated_at: new Date().toISOString() })
    .eq('id', req.params.aid).eq('client_id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});
// クライアント訴求軸削除
router.delete('/clients/:id/appeal-axes/:aid', requireAuth, requirePermission('project.create_edit'), async (req, res) => {
  const { error } = await supabase.from('client_appeal_axes').delete().eq('id', req.params.aid);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ==================== 案件商材・訴求軸（syncスイッチ対応） ====================

// 案件の実効商材（sync=ONならクライアント、OFFなら案件独自）
router.get('/projects/:id/effective-products', async (req, res) => {
  const { data: proj } = await supabase.from('projects').select('client_id, sync_products').eq('id', req.params.id).single();
  if (!proj) return res.status(404).json({ error: '案件が見つかりません' });
  const table = proj.sync_products !== false ? 'client_products' : 'project_products';
  const field = proj.sync_products !== false ? 'client_id' : 'project_id';
  const id    = proj.sync_products !== false ? proj.client_id : req.params.id;
  const { data, error } = await supabase.from(table).select('*').eq(field, id)
    .eq('is_active', true).order('sort_order').order('created_at');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// 案件の実効訴求軸
router.get('/projects/:id/effective-appeal-axes', async (req, res) => {
  const { data: proj } = await supabase.from('projects').select('client_id, sync_appeal_axes').eq('id', req.params.id).single();
  if (!proj) return res.status(404).json({ error: '案件が見つかりません' });
  const table = proj.sync_appeal_axes !== false ? 'client_appeal_axes' : 'project_appeal_axes';
  const field = proj.sync_appeal_axes !== false ? 'client_id' : 'project_id';
  const id    = proj.sync_appeal_axes !== false ? proj.client_id : req.params.id;
  const { data, error } = await supabase.from(table).select('*').eq(field, id)
    .eq('is_active', true).order('sort_order').order('created_at');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// 案件商材CRUD（sync=OFF時）
router.get('/projects/:id/products', async (req, res) => {
  const { data, error } = await supabase.from('project_products')
    .select('*').eq('project_id', req.params.id).order('sort_order').order('created_at');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});
router.post('/projects/:id/products', requireAuth, requirePermission('project.create_edit'), async (req, res) => {
  const { code, name, note, sort_order } = req.body;
  if (!code || !name) return res.status(400).json({ error: 'コードと名称は必須です' });
  const { data, error } = await supabase.from('project_products')
    .insert({ project_id: req.params.id, code, name, note: note||null, sort_order: parseInt(sort_order)||0 })
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});
router.put('/projects/:id/products/:pid', requireAuth, requirePermission('project.create_edit'), async (req, res) => {
  const { code, name, note, sort_order, is_active } = req.body;
  const { data, error } = await supabase.from('project_products')
    .update({ code, name, note: note||null, sort_order: parseInt(sort_order)||0, is_active, updated_at: new Date().toISOString() })
    .eq('id', req.params.pid).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});
router.delete('/projects/:id/products/:pid', requireAuth, requirePermission('project.create_edit'), async (req, res) => {
  const { error } = await supabase.from('project_products').delete().eq('id', req.params.pid);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// 案件訴求軸CRUD（sync=OFF時）
router.get('/projects/:id/appeal-axes', async (req, res) => {
  const { data, error } = await supabase.from('project_appeal_axes')
    .select('*').eq('project_id', req.params.id).order('sort_order').order('created_at');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});
router.post('/projects/:id/appeal-axes', requireAuth, requirePermission('project.create_edit'), async (req, res) => {
  const { code, name, note, sort_order } = req.body;
  if (!code || !name) return res.status(400).json({ error: 'コードと名称は必須です' });
  const { data, error } = await supabase.from('project_appeal_axes')
    .insert({ project_id: req.params.id, code, name, note: note||null, sort_order: parseInt(sort_order)||0 })
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});
router.put('/projects/:id/appeal-axes/:aid', requireAuth, requirePermission('project.create_edit'), async (req, res) => {
  const { code, name, note, sort_order, is_active } = req.body;
  const { data, error } = await supabase.from('project_appeal_axes')
    .update({ code, name, note: note||null, sort_order: parseInt(sort_order)||0, is_active, updated_at: new Date().toISOString() })
    .eq('id', req.params.aid).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});
router.delete('/projects/:id/appeal-axes/:aid', requireAuth, requirePermission('project.create_edit'), async (req, res) => {
  const { error } = await supabase.from('project_appeal_axes').delete().eq('id', req.params.aid);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// クライアントマスターから案件へコピー（商材）
router.post('/projects/:id/products/copy-from-client', requireAuth, requirePermission('project.create_edit'), async (req, res) => {
  const { data: proj } = await supabase.from('projects').select('client_id').eq('id', req.params.id).single();
  if (!proj) return res.status(404).json({ error: '案件が見つかりません' });
  const { data: clientItems } = await supabase.from('client_products')
    .select('*').eq('client_id', proj.client_id);
  if (!clientItems?.length) return res.json({ copied: 0 });
  await supabase.from('project_products').delete().eq('project_id', req.params.id);
  const inserts = clientItems.map(({ code, name, note, sort_order }) =>
    ({ project_id: req.params.id, code, name, note, sort_order }));
  const { error } = await supabase.from('project_products').insert(inserts);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ copied: inserts.length });
});

// クライアントマスターから案件へコピー（訴求軸）
router.post('/projects/:id/appeal-axes/copy-from-client', requireAuth, requirePermission('project.create_edit'), async (req, res) => {
  const { data: proj } = await supabase.from('projects').select('client_id').eq('id', req.params.id).single();
  if (!proj) return res.status(404).json({ error: '案件が見つかりません' });
  const { data: clientItems } = await supabase.from('client_appeal_axes')
    .select('*').eq('client_id', proj.client_id);
  if (!clientItems?.length) return res.json({ copied: 0 });
  await supabase.from('project_appeal_axes').delete().eq('project_id', req.params.id);
  const inserts = clientItems.map(({ code, name, note, sort_order }) =>
    ({ project_id: req.params.id, code, name, note, sort_order }));
  const { error } = await supabase.from('project_appeal_axes').insert(inserts);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ copied: inserts.length });
});

// ==================== ユーザー利用状況 ====================

const SUPER_ADMIN_EMAILS = ['hiikun.ascs@gmail.com', 'satoru.takahashi@haruka-film.com'];

router.get('/admin/user-stats', requireAuth, async (req, res) => {
  if (!SUPER_ADMIN_EMAILS.includes(req.user?.email)) return res.status(403).json({ error: '権限がありません' });

  // 全ユーザー取得
  const { data: users } = await supabase
    .from('users')
    .select('id, full_name, nickname, avatar_url, email, role, rank, is_active, last_seen_at, login_count, created_at')
    .order('last_seen_at', { ascending: false, nullsFirst: false });

  // 直近30日のログインログ（ユーザーごとの集計）
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { data: logs } = await supabase
    .from('user_activity_logs')
    .select('user_id, action, ip_address, user_agent, created_at')
    .eq('action', 'login')
    .gte('created_at', since)
    .order('created_at', { ascending: false });

  // ユーザーごとの直近30日ログイン回数・最終ログイン
  const logMap = {};
  (logs || []).forEach(l => {
    if (!logMap[l.user_id]) logMap[l.user_id] = { count: 0, last_login: null, last_ua: '', last_ip: '' };
    logMap[l.user_id].count++;
    if (!logMap[l.user_id].last_login) {
      logMap[l.user_id].last_login  = l.created_at;
      logMap[l.user_id].last_ua     = l.user_agent;
      logMap[l.user_id].last_ip     = l.ip_address;
    }
  });

  const now = Date.now();
  const result = (users || []).map(u => {
    const log = logMap[u.id] || {};
    const lastSeenMs = u.last_seen_at ? new Date(u.last_seen_at).getTime() : null;
    const isOnline = lastSeenMs && (now - lastSeenMs) < 10 * 60 * 1000; // 10分以内
    return {
      ...u,
      login_count_30d: log.count || 0,
      last_login:      log.last_login || null,
      last_ua:         log.last_ua || '',
      last_ip:         log.last_ip || '',
      is_online:       !!isOnline,
    };
  });

  res.json(result);
});

// PostgREST スキーマキャッシュを手動でリロードする緊急用エンドポイント
// 用途: 起動時の schema-sync で ALTER は通ったのに PostgREST のキャッシュに反映されず
//       「Could not find the 'X' column of 'Y' in the schema cache」エラーが出る時の復旧。
// 通常は db/migrate.js が NOTIFY pgrst, 'reload schema' を送るが、Supabase 側の
// LISTEN が確立する前に送られたりすると取りこぼされる。再送できる手段を残しておく。
router.post('/admin/reload-schema-cache', requireAuth, async (req, res) => {
  if (!SUPER_ADMIN_EMAILS.includes(req.user?.email)) return res.status(403).json({ error: '権限がありません' });
  const dbUrl = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL;
  if (!dbUrl) return res.status(500).json({ error: 'DATABASE_URL/SUPABASE_DB_URL が未設定です' });
  const { Client } = require('pg');
  const client = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 });
  try {
    await client.connect();
    // 取りこぼし対策で2回送る（PostgREST が処理中だと最初の通知を読み飛ばすケースがあるため）
    await client.query("NOTIFY pgrst, 'reload schema'");
    await new Promise(r => setTimeout(r, 500));
    await client.query("NOTIFY pgrst, 'reload schema'");
    res.json({ ok: true, message: 'PostgREST スキーマキャッシュのリロードを通知しました（反映に数秒かかります）' });
  } catch (err) {
    console.error('[reload-schema-cache]', err);
    res.status(500).json({ error: err.message });
  } finally {
    try { await client.end(); } catch {}
  }
});

// schema-sync を強制再実行する管理者エンドポイント
// 用途: Railway起動時の schema-sync が DATABASE_URL 未設定や接続失敗で silent skip されたとき、
//       SQL Editor を開かずに db/migrate.js の保険ALTERを含む全文再適用 + PostgREST通知を行うための復旧口。
// 戻り値: runSchemaSync の生結果 ({ skipped } / { ok, okCount, errCount, errors, elapsedMs } / { ok:false, error })
router.post('/admin/run-schema-sync', requireAuth, async (req, res) => {
  if (!SUPER_ADMIN_EMAILS.includes(req.user?.email)) return res.status(403).json({ error: '権限がありません' });
  try {
    const runSchemaSync = require('../db/migrate');
    const result = await runSchemaSync();
    const summary = result?.skipped
      ? 'DATABASE_URL/SUPABASE_DB_URL が未設定のためスキップしました（Railway環境変数を確認してください）'
      : result?.ok === false
        ? `エラーで終了しました: ${result.error || `okCount=${result.okCount} errCount=${result.errCount}`}`
        : `schema-sync 完了 (OK=${result?.okCount ?? 0} NG=${result?.errCount ?? 0}, ${result?.elapsedMs ?? 0}ms)`;
    res.json({ ok: result?.ok !== false && !result?.skipped, summary, result });
  } catch (err) {
    console.error('[run-schema-sync]', err);
    res.status(500).json({ error: err.message });
  }
});

// ==================== システム設定 ====================

// システム設定取得（認証済みなら誰でも読める）
router.get('/system-settings', requireAuth, async (_req, res) => {
  const { data, error } = await supabase.from('system_settings').select('key, value');
  if (error) return res.status(500).json({ error: error.message });
  const settings = {};
  (data || []).forEach(r => { settings[r.key] = r.value; });
  res.json(settings);
});

// システム設定更新（スーパーアドミンのみ）
router.put('/system-settings', requireAuth, async (req, res) => {
  if (!SUPER_ADMIN_EMAILS.includes(req.user?.email)) {
    return res.status(403).json({ error: 'システム設定の変更は最高管理者のみ可能です' });
  }
  const { key, value } = req.body;
  if (!key) return res.status(400).json({ error: 'keyは必須です' });
  const { error } = await supabase.from('system_settings')
    .upsert({ key, value: value || null, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// システム設定からDriveルートフォルダIDを取得するヘルパー
async function getDriveRootFolderId() {
  const { data } = await supabase.from('system_settings').select('value').eq('key', 'drive_root_folder_id').single();
  return data?.value || process.env.DRIVE_ROOT_FOLDER_ID || null;
}

// ==================== いいね ====================

// ファイルのいいね一覧取得
router.get('/creative-files/:id/likes', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('creative_file_likes')
    .select('id, timecode_sec, created_at, users(id, full_name)')
    .eq('creative_file_id', req.params.id)
    .order('timecode_sec');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// いいね追加
router.post('/creative-files/:id/likes', requireAuth, async (req, res) => {
  const { timecode_sec } = req.body;
  const user = req.user;
  const tc = Math.round(parseFloat(timecode_sec) * 100) / 100;
  const { data, error } = await supabase
    .from('creative_file_likes')
    .upsert({ creative_file_id: req.params.id, user_id: user.id, timecode_sec: tc }, { onConflict: 'creative_file_id,user_id,timecode_sec' })
    .select('id, timecode_sec')
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// いいね削除
router.delete('/creative-files/:fileId/likes/:likeId', requireAuth, async (req, res) => {
  const { error } = await supabase
    .from('creative_file_likes')
    .delete()
    .eq('id', req.params.likeId)
    .eq('user_id', req.user.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// いいねランキング（タイムコード別集計）
router.get('/likes/ranking', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('creative_file_likes')
    .select('timecode_sec, creative_file_id, creative_files(id, generated_name, creative_id, creatives(file_name))')
    .order('created_at', { ascending: false })
    .limit(500);
  if (error) return res.status(500).json({ error: error.message });

  // timecode_sec + creative_file_id 単位で集計
  const map = {};
  for (const row of data) {
    const key = `${row.creative_file_id}__${row.timecode_sec}`;
    if (!map[key]) map[key] = {
      creative_file_id: row.creative_file_id,
      timecode_sec: row.timecode_sec,
      file_name: row.creative_files?.generated_name || '不明',
      creative_name: row.creative_files?.creatives?.file_name || '',
      count: 0
    };
    map[key].count++;
  }
  const ranking = Object.values(map).sort((a, b) => b.count - a.count).slice(0, 20);
  res.json(ranking);
});

// ユーザー別いいね数ランキング
router.get('/likes/ranking/users', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('creative_file_likes')
    .select('user_id, users(id, full_name)')
    .limit(1000);
  if (error) return res.status(500).json({ error: error.message });

  const map = {};
  for (const row of data) {
    const uid = row.user_id;
    if (!map[uid]) map[uid] = { user_id: uid, full_name: row.users?.full_name || '不明', count: 0 };
    map[uid].count++;
  }
  const ranking = Object.values(map).sort((a, b) => b.count - a.count).slice(0, 10);
  res.json(ranking);
});

// Drive接続診断エンドポイント（管理者用）
router.get('/drive-diagnose', requireAuth, async (_req, res) => {
  const result = { ok: false, checks: {} };

  // 1. サービスアカウントキー
  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!keyJson) {
    result.checks.service_account_key = { ok: false, message: 'GOOGLE_SERVICE_ACCOUNT_KEY 環境変数が未設定です' };
    return res.json(result);
  }
  let credentials;
  try {
    credentials = JSON.parse(keyJson);
    result.checks.service_account_key = { ok: true, message: `サービスアカウント: ${credentials.client_email}` };
  } catch (e) {
    result.checks.service_account_key = { ok: false, message: `JSON パースエラー: ${e.message}` };
    return res.json(result);
  }

  // 2. ルートフォルダID
  const rootFolderId = await getDriveRootFolderId();
  if (!rootFolderId) {
    result.checks.root_folder = { ok: false, message: 'drive_root_folder_id が未設定（システム設定またはDRIVE_ROOT_FOLDER_ID環境変数を確認）' };
    return res.json(result);
  }
  result.checks.root_folder = { ok: true, message: `フォルダID: ${rootFolderId}` };

  // 3. Drive API 接続テスト
  try {
    const drive = await getDriveService();
    const r = await drive.files.get({ fileId: rootFolderId, fields: 'id,name', supportsAllDrives: true });
    result.checks.drive_api = { ok: true, message: `フォルダ名: ${r.data.name}` };
    result.ok = true;
  } catch (e) {
    result.checks.drive_api = { ok: false, message: `Drive API エラー: ${e.message}` };
  }

  res.json(result);
});

// ==================== 汎用マスター管理 ====================

// 区分マスター一覧
router.get('/master/categories', async (_req, res) => {
  const { data, error } = await supabase
    .from('master_categories')
    .select('*')
    .order('sort_order').order('created_at');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// 区分マスター作成
router.post('/master/categories', requireAuth, requirePermission('master.page'), async (req, res) => {
  const { name, code, sort_order } = req.body;
  if (!name || !code) return res.status(400).json({ error: '名称とコードは必須です' });
  const { data, error } = await supabase
    .from('master_categories')
    .insert({ name, code, sort_order: parseInt(sort_order) || 0 })
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// システム保護コード（削除・コード変更禁止）
const PROTECTED_CATEGORY_CODES = ['COMMENT_CAT', 'media', 'creative_formats', 'sizes', 'products', 'appeal_axes'];

// 区分マスター更新
router.put('/master/categories/:id', requireAuth, requirePermission('master.page'), async (req, res) => {
  const { name, code, sort_order, is_active } = req.body;
  // 保護カテゴリーはコード変更を禁止
  const { data: existing } = await supabase.from('master_categories').select('code').eq('id', req.params.id).single();
  if (existing && PROTECTED_CATEGORY_CODES.includes(existing.code) && code !== existing.code) {
    return res.status(403).json({ error: 'システム区分のコードは変更できません' });
  }
  const { data, error } = await supabase
    .from('master_categories')
    .update({ name, code: existing && PROTECTED_CATEGORY_CODES.includes(existing.code) ? existing.code : code, sort_order: parseInt(sort_order) || 0, is_active, updated_at: new Date().toISOString() })
    .eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// 区分マスター削除
router.delete('/master/categories/:id', requireAuth, requirePermission('master.page'), async (req, res) => {
  const { data: existing } = await supabase.from('master_categories').select('code').eq('id', req.params.id).single();
  if (existing && PROTECTED_CATEGORY_CODES.includes(existing.code)) {
    return res.status(403).json({ error: 'このシステム区分は削除できません' });
  }
  const { error } = await supabase.from('master_categories').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ---- 値マスター ----

// 値一覧（管理用：全件）
router.get('/master/items', async (req, res) => {
  const { category_id } = req.query;
  let query = supabase
    .from('master_items')
    .select('*, master_categories(id, name, code)')
    .order('sort_order').order('created_at');
  if (category_id) query = query.eq('category_id', category_id);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// 値一覧（プルダウン用：有効かつ期限内のみ）
router.get('/master/items/active', async (req, res) => {
  let { category_id, category_code } = req.query;
  // category_code が指定された場合は先に category_id を解決
  if (!category_id && category_code) {
    const { data: cat } = await supabase.from('master_categories').select('id').eq('code', category_code).single();
    if (cat) category_id = cat.id;
    else return res.json([]); // 該当カテゴリーなし
  }
  const now = new Date().toISOString();
  let query = supabase
    .from('master_items')
    .select('*, master_categories(id, name, code)')
    .eq('is_active', true)
    .or(`expires_at.is.null,expires_at.gt.${now}`)
    .order('sort_order').order('created_at');
  if (category_id) query = query.eq('category_id', category_id);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// 値作成
router.post('/master/items', requireAuth, requirePermission('master.page'), async (req, res) => {
  const { category_id, code, name, note, sort_order, expires_at } = req.body;
  if (!category_id || !code || !name)
    return res.status(400).json({ error: '区分・コード・名称は必須です' });
  const { data, error } = await supabase
    .from('master_items')
    .insert({
      category_id, code, name,
      note: note || null,
      sort_order: parseInt(sort_order) || 0,
      expires_at: expires_at || null,
    })
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// 値更新
router.put('/master/items/:id', requireAuth, requirePermission('master.page'), async (req, res) => {
  const { code, name, note, sort_order, is_active, expires_at } = req.body;
  const { data, error } = await supabase
    .from('master_items')
    .update({
      code, name,
      note: note || null,
      sort_order: parseInt(sort_order) || 0,
      is_active,
      expires_at: expires_at || null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// 値削除
router.delete('/master/items/:id', requireAuth, requirePermission('master.page'), async (req, res) => {
  const { error } = await supabase.from('master_items').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ==================== ダッシュボード 予実管理 ====================

// 今月の予実サマリー（ADR 002+005+006 ベース）
//
// 計算式:
//   各 cycle (project_cycles で年月絞り込み) について
//     - 該当 project の lines（status active）の client_unit_price × planned_count を合算
//     - project_fixed_items(item_type='revenue', not cancelled) を加算
//   実績は cycle に紐付く creatives の本数 × line.client_unit_price で近似する
//   （line ベースに移行する過渡期のため、本数集計は creative_type の文字列マッチを継続）
router.get('/dashboard/monthly-forecast', async (req, res) => {
  const year = parseInt(req.query.year) || new Date().getFullYear();
  const month = parseInt(req.query.month) || (new Date().getMonth() + 1);

  const { data: cycles, error: cyclesError } = await supabase
    .from('project_cycles')
    .select(`
      *,
      projects (
        id, name, client_id,
        clients(name)
      )
    `)
    .eq('year', year)
    .eq('month', month);

  if (cyclesError) return res.status(500).json({ error: cyclesError.message });

  // cycle に紐付く creatives を一括取得
  const cycleIds = (cycles || []).map(c => c.id);
  const { data: allCreatives } = cycleIds.length
    ? await supabase.from('creatives').select('cycle_id, creative_type, line_id').in('cycle_id', cycleIds)
    : { data: [] };
  const creativesByCycle = {};
  (allCreatives || []).forEach(c => {
    if (!creativesByCycle[c.cycle_id]) creativesByCycle[c.cycle_id] = [];
    creativesByCycle[c.cycle_id].push(c);
  });

  // 案件単位で lines / fixed_items を一括取得（N+1 回避）
  const projectIds = Array.from(new Set((cycles || []).map(c => c.project_id).filter(Boolean)));
  const linesByProject = new Map();
  const fixedRevenueByProject = new Map();
  if (projectIds.length) {
    const { ACTIVE_LINE_STATUSES } = require('../utils/pricing');
    const activeStatuses = new Set(ACTIVE_LINE_STATUSES);
    const [linesRes, fxRes, catsRes] = await Promise.all([
      supabase
        .from('project_estimate_lines')
        .select('id, project_id, category_id, planned_count, client_unit_price, status')
        .in('project_id', projectIds),
      supabase
        .from('project_fixed_items')
        .select('project_id, item_type, amount, status')
        .in('project_id', projectIds)
        .eq('item_type', 'revenue'),
      supabase.from('creative_categories').select('id, code, name'),
    ]);
    const catCodeById = new Map();
    for (const c of (catsRes.data || [])) catCodeById.set(c.id, c.code || c.name || '');
    for (const l of (linesRes.data || [])) {
      if (!activeStatuses.has(l.status)) continue;
      if (!linesByProject.has(l.project_id)) linesByProject.set(l.project_id, []);
      linesByProject.get(l.project_id).push({ ...l, _cat_code: catCodeById.get(l.category_id) || '' });
    }
    for (const fi of (fxRes.data || [])) {
      if (fi.status === 'cancelled') continue;
      fixedRevenueByProject.set(fi.project_id,
        (fixedRevenueByProject.get(fi.project_id) || 0) + (Number(fi.amount) || 0));
    }
  }

  // 各 line の単価マップ（line_id -> client_unit_price）。actual 計算用。
  const unitPriceByLine = new Map();
  for (const arr of linesByProject.values()) {
    for (const line of arr) unitPriceByLine.set(line.id, Number(line.client_unit_price) || 0);
  }

  const isVideoCategory = (code) => /video|short|long|cut/i.test(code || '');
  const isDesignCategory = (code) => /design|image|static/i.test(code || '');

  const result = (cycles || []).map(cycle => {
    const creatives = creativesByCycle[cycle.id] || [];
    const videoCount = creatives.filter(c =>
      c.creative_type && (c.creative_type.includes('動画') || c.creative_type.toLowerCase().includes('video'))
    ).length;
    const designCount = creatives.filter(c =>
      c.creative_type && (c.creative_type.includes('デザイン') || c.creative_type.toLowerCase().includes('design'))
    ).length;

    const projectLines = linesByProject.get(cycle.project_id) || [];

    // planned_amount = lines の合計 + fixed revenue
    let planned = 0;
    let videoUnitPrice = 0;
    let designUnitPrice = 0;
    for (const line of projectLines) {
      planned += (Number(line.client_unit_price) || 0) * (Number(line.planned_count) || 0);
      // 表示用の「video / design 単価」は最初に見つけた値を使う（複数あれば代表値）
      if (isVideoCategory(line._cat_code)  && !videoUnitPrice)  videoUnitPrice  = Number(line.client_unit_price) || 0;
      if (isDesignCategory(line._cat_code) && !designUnitPrice) designUnitPrice = Number(line.client_unit_price) || 0;
    }
    planned += (fixedRevenueByProject.get(cycle.project_id) || 0);

    // actual_amount = creatives.line_id ごとに client_unit_price を合算
    // 実績本数が見積を超えても planned_count の天井までで打ち切る （見積より多く納品しても請求しない設計）
    let actual = 0;
    for (const c of creatives) {
      if (c.line_id) {
        actual += unitPriceByLine.get(c.line_id) || 0;
      } else {
        // line に紐付かない creative は creative_type でフォールバック
        if (c.creative_type && (c.creative_type.includes('動画') || c.creative_type.toLowerCase().includes('video'))) {
          actual += videoUnitPrice;
        } else if (c.creative_type && (c.creative_type.includes('デザイン') || c.creative_type.toLowerCase().includes('design'))) {
          actual += designUnitPrice;
        }
      }
    }

    return {
      project_id: cycle.project_id,
      project_name: cycle.projects?.name,
      client_name: cycle.projects?.clients?.name,
      planned_video: cycle.planned_video_count || 0,
      planned_design: cycle.planned_design_count || 0,
      actual_video: videoCount,
      actual_design: designCount,
      planned_amount: planned,
      actual_amount: actual,
      video_unit_price: videoUnitPrice,
      design_unit_price: designUnitPrice,
    };
  });

  res.json(result);
});

// ==================== クリエイティブ バージョン履歴 ====================

// バージョン履歴一覧取得
router.get('/creative-versions/:creativeId', async (req, res) => {
  const { data, error } = await supabase
    .from('creative_version_history')
    .select('*')
    .eq('creative_id', req.params.creativeId)
    .order('version_num', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ADR 011: ラウンド比較型UI 用エンドポイント
// クリエイティブのラウンド履歴（過去）を昇順で返す。
// レスポンス: [{ id, version_num, round_stage, director_comment, editor_comment, client_comment,
//                creative_file_id, recorded_by, created_at, file: { id, version, drive_url, drive_file_id, generated_name } | null }]
router.get('/creatives/:id/rounds', requireAuth, async (req, res) => {
  // schema 拡張済み環境では editor_comment / round_stage / creative_file_id / recorded_by が select 可能。
  // 列欠損環境でも 500 で詰まないように 2 段フォールバック。
  let { data, error } = await supabase
    .from('creative_version_history')
    .select('*')
    .eq('creative_id', req.params.id)
    .order('version_num', { ascending: true })
    .order('created_at', { ascending: true });
  if (error) {
    const msg = error.message || '';
    if (/column .+ does not exist/.test(msg) || /Could not find the .+ column/.test(msg) || error.code === 'PGRST204') {
      // 列欠損フォールバック（migration 未適用環境）: 旧スキーマ列のみで再取得
      ({ data, error } = await supabase
        .from('creative_version_history')
        .select('id, creative_id, version_num, director_comment, client_comment, created_at')
        .eq('creative_id', req.params.id)
        .order('version_num', { ascending: true })
        .order('created_at', { ascending: true }));
    }
  }
  if (error) return res.status(500).json({ error: error.message });

  // 関連 creative_files をまとめて取得（N+1 解消）
  const fileIds = [...new Set((data || []).map(r => r.creative_file_id).filter(Boolean))];
  let filesById = {};
  if (fileIds.length > 0) {
    const { data: files } = await supabase
      .from('creative_files')
      .select('id, version, drive_url, drive_file_id, generated_name')
      .in('id', fileIds);
    filesById = Object.fromEntries((files || []).map(f => [f.id, f]));
  }

  // 引き継ぎ承認コメント (handoff_to_next) を creative_status_transitions から付与
  // (PR #(d-to-p-handoff-comment) / 代表 髙橋指示・2026-05-09):
  //   各 round_stage にとっての「次工程への承認・引き継ぎ遷移」を探し、
  //   そのときディレクター/プロデューサー/クライアントが書いたコメントを
  //   round.handoff_to_next として埋め込む。フロントは round_stage が
  //   d_check/p_check/cl_check の round 本文の一番上に「Dチェック→Pチェック 承認」
  //   等のラベルとともに表示する（ラウンド比較UI）。
  //
  //   stage → 引き継ぎ遷移 (from_status → to_status):
  //     d_check  → 'Dチェック' → 'Pチェック'
  //     p_check  → 'Pチェック' → 'クライアントチェック中'
  //     cl_check → 'クライアントチェック中' → '納品'
  //
  //   コメント取得元:
  //     d_to_p / p_to_cl: director_comment_at_change（director_comment は
  //                       D/P が共有する単一フィールド）
  //     cl_to_delivered : client_comment_at_change
  //
  //   対応する snapshot round は「changed_at > round.created_at」の最早の transition。
  //   schema 未適用環境（creative_status_transitions テーブル無し）でも本処理は止めない。
  let transitions = [];
  try {
    const { data: trans, error: transErr } = await supabase
      .from('creative_status_transitions')
      .select('id, from_status, to_status, changed_at, changed_by, director_comment_at_change, client_comment_at_change, editor_comment_at_change, version_at_change')
      .eq('creative_id', req.params.id)
      .order('changed_at', { ascending: true });
    if (!transErr && Array.isArray(trans)) {
      transitions = trans;
    } else if (transErr) {
      console.warn('[creative_status_transitions] fetch failed:', transErr.message);
    }
  } catch (e) {
    console.warn('[creative_status_transitions] fetch block failed:', e?.message || e);
  }

  // round_stage → 引き継ぎ遷移定義（承認系）+ 修正依頼系
  // (PR #(revision-request-handoff) / 髙橋指示 2026-05-09):
  //   従来は承認系（Dチェック→Pチェック など）だけを表示していたが、
  //   修正依頼系（Dチェック→Dチェック後修正 など）も同じ仕組みでラウンド比較に紐付ける。
  //   修正依頼系の合流先は元の round_stage と同じ（差し戻しなので next stage は無い）が、
  //   handoff key としては別スロット ('d_to_d_revise' / 'p_to_p_revise' / 'cl_to_cl_revise') に分ける。
  const HANDOFF_BY_STAGE_APPROVE = {
    'd_check':  { from: 'Dチェック',                 to: 'Pチェック',                  next: 'd_to_p',          commentField: 'director_comment_at_change' },
    'p_check':  { from: 'Pチェック',                 to: 'クライアントチェック中',     next: 'p_to_cl',         commentField: 'director_comment_at_change' },
    'cl_check': { from: 'クライアントチェック中',     to: '納品',                       next: 'cl_to_delivered', commentField: 'client_comment_at_change'   },
  };
  const HANDOFF_BY_STAGE_REVISE = {
    'd_check':  { from: 'Dチェック',                 to: 'Dチェック後修正',            next: 'd_to_d_revise',   commentField: 'director_comment_at_change' },
    'p_check':  { from: 'Pチェック',                 to: 'Pチェック後修正',            next: 'p_to_p_revise',   commentField: 'director_comment_at_change' },
    'cl_check': { from: 'クライアントチェック中',     to: 'クライアントチェック後修正', next: 'cl_to_cl_revise', commentField: 'client_comment_at_change'   },
  };
  // transition.to_status から逆算して、紐付け対象の round_stage と種別を求める
  const TRANSITION_TO_FROM_STAGE = {
    // 承認系
    'Pチェック':                   'd_check',
    'クライアントチェック中':      'p_check',
    '納品':                        'cl_check',
    // 修正依頼系
    'Dチェック後修正':             'd_check',
    'Pチェック後修正':             'p_check',
    'クライアントチェック後修正':  'cl_check',
  };
  const TRANSITION_KIND = {
    'Pチェック':                   'approve',
    'クライアントチェック中':      'approve',
    '納品':                        'approve',
    'Dチェック後修正':             'revise',
    'Pチェック後修正':             'revise',
    'クライアントチェック後修正':  'revise',
  };

  // 先に rounds 出力配列を作る（handoff_to_next は後段で埋める）
  const result = (data || []).map(r => ({
    ...r,
    file: r.creative_file_id ? (filesById[r.creative_file_id] || null) : null,
    handoff_to_next: null,
  }));

  // 紐付け規則 (PR #(handoff-attach-fix) / 髙橋指示 2026-05-09):
  //   各 transition について、changed_at より **前** の同じ round_stage snapshot のうち
  //   **最も新しいもの** に handoff_to_next を貼り付ける。これにより再提出シナリオで
  //     v1 D→P transition (#1) → v1 d_check round に紐づく
  //     v3 D→P transition (#2) → v3 d_check round に紐づく
  //   と個別バインドされる。
  //   旧実装「round.created_at より後の最早 transition」は v1/v3 両方に同じ transition が
  //   マッチして表示崩れの原因になっていた。
  //
  //   data は version_num asc → created_at asc 済み（select の order 参照）。result も同順。
  //   transitions は changed_at asc 済み。
  //
  //   PR #462 リリース前の transition 行は director_comment_at_change が「前ラウンドの指摘内容」
  //   になっているケースがあるが、無いよりマシ（ユーザー確認済み）。
  //   creatives.director_comment へはフォールバックしない（最新値で時刻が合わない可能性）。
  const usedTransitionIds = new Set();
  for (const tr of transitions) {
    const fromStage = TRANSITION_TO_FROM_STAGE[tr.to_status];
    if (!fromStage) continue;
    const kind = TRANSITION_KIND[tr.to_status];
    if (!kind) continue;
    const def = (kind === 'revise' ? HANDOFF_BY_STAGE_REVISE : HANDOFF_BY_STAGE_APPROVE)[fromStage];
    if (!def) continue;
    if (tr.from_status !== def.from || tr.to_status !== def.to) continue; // 異常 from→to を弾く
    const trTime = tr.changed_at ? Date.parse(tr.changed_at) : NaN;
    if (Number.isNaN(trTime)) continue;
    // result を走査し、changed_at <= tr.changed_at を満たす同 stage snapshot のうち最新を採用。
    let target = null;
    for (const r of result) {
      if (r.round_stage !== fromStage) continue;
      const rTime = r.created_at ? Date.parse(r.created_at) : NaN;
      if (Number.isNaN(rTime)) continue;
      if (rTime <= trTime) {
        target = r; // ソート済みなので走査末尾の合致が最新
      }
    }
    if (!target) continue; // snapshot 無し → 後段の「孤児 handoff」処理で仮想ラウンド化
    // 同 round に複数 transition が当たる場合は最後（最新）の判断で上書き。
    // 注: 承認 transition と修正依頼 transition が同じ round に紐づく事は通常ない
    //   （承認したら次 stage に進むので、その snapshot 後に発生する transition は別 round 用）。
    //   よって kind の混在による上書き競合は実用上発生しない。
    usedTransitionIds.add(tr.id);
    const comment = tr[def.commentField] ?? null;
    target.handoff_to_next = {
      stage:       def.next, // 'd_to_p' | 'p_to_cl' | 'cl_to_delivered' | 'd_to_d_revise' | 'p_to_p_revise' | 'cl_to_cl_revise'
      from_status: tr.from_status,
      to_status:   tr.to_status,
      kind, // 'approve' | 'revise' — フロントで色/アイコン/ラベル切替に使う
      comment,
      changed_at:  tr.changed_at,
      changed_by:  tr.changed_by,
    };
  }

  // 孤児 handoff を仮想ラウンドとして追加 (PR #(d-to-p-handoff-comment)):
  //   修正なし直行ケース（制作中→Dチェック→Pチェック など、d_check スナップショット無し）
  //   でも引き継ぎ承認コメントを表示するために、対応する snapshot に紐付かない transition を
  //   「コメントだけのラウンド」として返す。
  //   editor_comment / director_comment / client_comment は NULL（編集者の提出メモも reviewer 指摘も無い）。
  //   handoff_to_next にだけ情報を入れることで、フロント `_cdRoundEntryHtml` が
  //   引き継ぎ承認ブロックのみを描画する。
  //   version_num は version_at_change（その時点の最新ファイル version）を採用し、
  //   ソート (version_num asc, created_at asc) で正しい位置に並ぶようにする。
  const HANDOFF_TRANSITIONS_TO_STAGE = {
    // 承認系
    'Dチェック→Pチェック':                          { stage: 'd_to_p',          kind: 'approve', synthetic_stage: 'd_check_handoff',  commentField: 'director_comment_at_change' },
    'Pチェック→クライアントチェック中':              { stage: 'p_to_cl',         kind: 'approve', synthetic_stage: 'p_check_handoff',  commentField: 'director_comment_at_change' },
    'クライアントチェック中→納品':                   { stage: 'cl_to_delivered', kind: 'approve', synthetic_stage: 'cl_check_handoff', commentField: 'client_comment_at_change'   },
    // 修正依頼系（PR #(revision-request-handoff)）: snapshot が無い直行ケースでも修正依頼コメントを表示
    'Dチェック→Dチェック後修正':                    { stage: 'd_to_d_revise',   kind: 'revise',  synthetic_stage: 'd_check_handoff',  commentField: 'director_comment_at_change' },
    'Pチェック→Pチェック後修正':                    { stage: 'p_to_p_revise',   kind: 'revise',  synthetic_stage: 'p_check_handoff',  commentField: 'director_comment_at_change' },
    'クライアントチェック中→クライアントチェック後修正': { stage: 'cl_to_cl_revise', kind: 'revise',  synthetic_stage: 'cl_check_handoff', commentField: 'client_comment_at_change'   },
  };
  for (const t of transitions) {
    if (usedTransitionIds.has(t.id)) continue;
    const key = `${t.from_status}→${t.to_status}`;
    const def = HANDOFF_TRANSITIONS_TO_STAGE[key];
    if (!def) continue;
    const comment = t[def.commentField] || null;
    if (!comment || !String(comment).trim()) continue; // 空コメントの孤児は出さない
    result.push({
      id:               `handoff-${t.id}`,
      creative_id:      req.params.id,
      version_num:      t.version_at_change ?? null,
      director_comment: null,
      client_comment:   null,
      editor_comment:   null,
      round_stage:      def.synthetic_stage,
      creative_file_id: null,
      recorded_by:      null,
      created_at:       t.changed_at,
      file:             null,
      _synthetic_handoff: true,
      handoff_to_next: {
        stage:       def.stage,
        from_status: t.from_status,
        to_status:   t.to_status,
        kind:        def.kind,
        comment,
        changed_at:  t.changed_at,
        changed_by:  t.changed_by,
      },
    });
  }

  // 「初回提出」仮想ラウンド (PR #(prev-panel-show-initial-submission) / 髙橋指示 2026-05-10):
  //   既存の snapshot ロジックは「修正後 → 再チェック」の往復ループに突入してから初めて
  //   creative_version_history に行を入れる。つまり**初回 Dチェック / Pチェック / クライアントチェック**で
  //   は snapshot が無く、ラウンド比較UIの「前回」パネルに「前工程で提出されたファイルと
  //   編集者の提出メモ」が表示されない（バグ報告 b9c7c60c に類似のレビュアー視点の盲点）。
  //
  //   ここでは creative_status_transitions から「初回チェックフェーズ突入」を検出し、
  //   仮想ラウンドを result に追加する。これにより前工程の提出物 (creative_files) と提出メモが
  //   「前回」として可視化される。
  //
  //   仮想化条件:
  //     ・to_status が 'Dチェック' / 'Pチェック' / 'クライアントチェック中'
  //     ・from_status が修正系（Dチェック後修正 / Pチェック後修正 / クライアントチェック後修正）でない
  //       → 修正→再チェックの往復は既存 snapshot で扱う
  //     ・version_at_change が NULL でない
  //     ・同じ (creative_id, version_num, round_stage) の既存 snapshot が無い
  //       → 既に snapshot 済みなら重複させない
  //
  //   ファイル紐付け:
  //     creative_file_id は version_at_change と一致する creative_files から逆引きして埋める。
  //     見つからなければ null（フロントの version_num フォールバック解決に任せる）。
  //
  //   editor_comment 解決の優先度:
  //     (a) transition.editor_comment_at_change（PR #(editor-comment-at-change) 以後）
  //     (b) (a) が NULL の旧データ: その transition より前の **同 creative_file (version_at_change)** に
  //         紐づく editor_comment（creatives.editor_comment は揮発的なので確実ではないが、
  //         無いより良い）。簡略化のため fallback は省略（旧データは editor_comment 空表示で許容）。
  //
  //   合流先 round_stage:
  //     to_status='Dチェック'                 → 'd_check'
  //     to_status='Pチェック'                 → 'p_check'
  //     to_status='クライアントチェック中'    → 'cl_check'
  //
  //   _synthetic_initial_submit=true マークでフロント側で「編集ボタンを出さない」「ライブと混同しない」等の判定に使える。
  const TO_STAGE_INITIAL = {
    'Dチェック':                   'd_check',
    'Pチェック':                   'p_check',
    'クライアントチェック中':      'cl_check',
  };
  const REVISION_FROM_STATUSES = new Set([
    'Dチェック後修正', 'Pチェック後修正', 'クライアントチェック後修正',
  ]);
  // creative_files を version_num→{id,...} マップ化（version_at_change からの逆引き用）。
  // N+1 解消のため上位スコープで一括取得済みの filesById は creative_file_id 引きなので
  // 別途 version で引けるマップを作る。
  let filesByVersion = {};
  try {
    const { data: cfRows } = await supabase
      .from('creative_files')
      .select('id, version, drive_url, drive_file_id, generated_name')
      .eq('creative_id', req.params.id);
    (cfRows || []).forEach(f => {
      if (f && f.version != null) {
        filesByVersion[Number(f.version)] = f;
      }
    });
  } catch (_) { /* 無くてもバグらない（ファイルカードは空欄になるだけ） */ }

  // 既存 snapshot の (version_num, round_stage) セット
  const existingSnapKeys = new Set(
    (data || []).map(r => `${r.version_num ?? ''}::${r.round_stage ?? ''}`)
  );
  for (const tr of transitions) {
    const stage = TO_STAGE_INITIAL[tr.to_status];
    if (!stage) continue;
    if (REVISION_FROM_STATUSES.has(tr.from_status)) continue;
    if (tr.version_at_change == null) continue;
    const key = `${tr.version_at_change}::${stage}`;
    if (existingSnapKeys.has(key)) continue;
    // 仮想ラウンドの editor_comment は transition.editor_comment_at_change を採用。
    // NULL のままでも arrival ラウンドとして file カードは出すので有用。
    const file = filesByVersion[Number(tr.version_at_change)] || null;
    const editorComment = (typeof tr.editor_comment_at_change === 'string' && tr.editor_comment_at_change.trim())
      ? tr.editor_comment_at_change
      : null;
    result.push({
      id:                    `initial-submit-${tr.id}`,
      creative_id:           req.params.id,
      version_num:           tr.version_at_change,
      director_comment:      null,
      client_comment:        null,
      editor_comment:        editorComment,
      round_stage:           stage,
      creative_file_id:      file ? file.id : null,
      recorded_by:           null,
      editor_submitted_at:   tr.changed_at || null,
      director_commented_at: null,
      client_commented_at:   null,
      created_at:            tr.changed_at || null,
      file:                  file,
      handoff_to_next:       null,
      _synthetic_initial_submit: true,
    });
    existingSnapKeys.add(key); // 同 transition 重複ガード
  }

  // 並び順を再保証（snapshot + 孤児 handoff + 初回提出 仮想 の混在ソート）:
  //   version_num asc (NULL は末尾) → created_at asc → round_stage の意味的順序（tertiary key）。
  //
  //   Tertiary key を入れた理由（PR #(d-approval-visible-on-p-check) / 髙橋指示 2026-05-10）:
  //     ディレクターが「OK→Pチェックへ」と承認した直後、同 version で
  //       (1) v=N stage='d_check'         (初回提出 仮想 or snapshot)
  //       (2) v=N stage='d_check_handoff' (D承認コメント入りの孤児 handoff)
  //       (3) v=N stage='p_check'         (Pチェック突入の初回提出 仮想)
  //     が並ぶ。created_at が同一になるケースもあり、その場合 'd_check' < 'd_check_handoff'
  //     のアルファベット順になり、(2) と (3) の前後が不安定になる。
  //     フロントは末尾を「最新」として `_cdRoundIndex = length - 1` で初期表示するため、
  //     (3) の p_check (編集者の提出時メモしか持たない) が選ばれてしまうと
  //     「Pチェック画面で D承認コメントが見えない」不具合になる。
  //
  //   stage の意味的順序（小さいほど時系列で先）:
  //     'd_check'(1)         < 'd_check_handoff'(2)   ← 提出 → 承認/差戻し
  //     'p_check'(3)         < 'p_check_handoff'(4)
  //     'cl_check'(5)        < 'cl_check_handoff'(6)
  //   この順序で並べると、同 created_at でも「承認 handoff」が直前の提出 stage の直後に来て
  //   「次工程の初回提出 仮想」より前に並ぶ。
  const stageOrder = (s) => {
    const order = {
      'd_check': 1, 'd_check_handoff': 2,
      'p_check': 3, 'p_check_handoff': 4,
      'cl_check': 5, 'cl_check_handoff': 6,
    };
    return order[s] ?? 99;
  };
  result.sort((a, b) => {
    const av = a.version_num == null ? Infinity : Number(a.version_num);
    const bv = b.version_num == null ? Infinity : Number(b.version_num);
    if (av !== bv) return av - bv;
    const tCmp = (a.created_at || '').localeCompare(b.created_at || '');
    if (tCmp !== 0) return tCmp;
    return stageOrder(a.round_stage) - stageOrder(b.round_stage);
  });

  res.json(result);
});

// ============================================================
// PATCH /api/creatives/:creativeId/versions/:versionId
//   バグ報告 #baed5d71 対応:
//   提出済みラウンドの「編集者の提出時メモ・連絡事項」(editor_comment) を、
//   相手がまだアクションする前であれば後から編集できるようにする。
//
// 編集が許可される条件（厳格チェック）:
//   1. version 行 R は creative_version_history の対象 creative の **最新 snapshot**。
//      （後続 round_stage が記録されていない＝相手が次工程に進んでいない）
//   2. リクエスト元が R.recorded_by 本人 または admin。
//   3. R.round_stage に対応する creative.status が「受け手側待ち」のまま:
//        d_check  → 'Dチェック'
//        p_check  → 'Pチェック'
//        cl_check → 'クライアントチェック中'
//      これにより「ディレクターが既に承認/差戻しした後」を弾く。
//
// 編集対象（Phase 1）:
//   - editor_comment のみ。
//   - file_url（成果物の差し替え）は本エンドポイントでは扱わない。
//     既存の「取り消し → 再アップロード」フローを使う想定。
//
// VIEW AS:
//   - 認可は auth.js#getEffectiveRoleCodes(req) で X-View-As を尊重して判定。
//   - admin プレビューでは編集可、editor プレビューでは recorded_by 本人のみ可。
//
// 通知:
//   - 保存後、本来の通知先（受け手側）に「コメントが修正されました」を Slack DM /
//     アプリ内通知として再送する。fire-and-forget（失敗しても本処理は止めない）。
// ============================================================
router.patch('/creatives/:creativeId/versions/:versionId', requireAuth, async (req, res) => {
  const { creativeId, versionId } = req.params;
  const editorCommentRaw = req.body?.editor_comment;
  if (typeof editorCommentRaw !== 'string') {
    return res.status(400).json({ error: 'editor_comment（文字列）は必須です' });
  }
  const editorCommentNew = editorCommentRaw.trim();
  if (!editorCommentNew) {
    return res.status(400).json({ error: 'editor_comment は空にできません' });
  }
  if (editorCommentNew.length > 5000) {
    return res.status(400).json({ error: 'editor_comment が長すぎます（5000字以内）' });
  }

  // 1) 対象 version 行を取得
  const { data: vRow, error: vErr } = await supabase
    .from('creative_version_history')
    .select('id, creative_id, version_num, round_stage, recorded_by, editor_comment, editor_submitted_at, created_at')
    .eq('id', versionId)
    .eq('creative_id', creativeId)
    .maybeSingle();
  if (vErr) {
    return res.status(500).json({ error: vErr.message });
  }
  if (!vRow) {
    return res.status(404).json({ error: 'バージョンが見つかりません' });
  }
  if (!['d_check', 'p_check', 'cl_check'].includes(vRow.round_stage || '')) {
    return res.status(400).json({ error: 'このラウンド種別はコメント編集に対応していません' });
  }

  // 2) 最新 snapshot か検証（後続 snapshot が無いこと）
  const { data: laterRows, error: laterErr } = await supabase
    .from('creative_version_history')
    .select('id, version_num, created_at')
    .eq('creative_id', creativeId);
  if (laterErr) {
    return res.status(500).json({ error: laterErr.message });
  }
  const isLatest = !(laterRows || []).some(r => {
    if (r.id === vRow.id) return false;
    const a = Number(r.version_num) || 0;
    const b = Number(vRow.version_num) || 0;
    if (a > b) return true;
    if (a < b) return false;
    // 同 version_num はあり得ないが念のため created_at で比較
    return (r.created_at || '') > (vRow.created_at || '');
  });
  if (!isLatest) {
    return res.status(409).json({ error: 'このラウンドはすでに次の工程に進んでいるため編集できません' });
  }

  // 3) creative.status が「受け手側待ち」のままか検証
  const ROUND_TO_WAITING_STATUS = {
    d_check:  'Dチェック',
    p_check:  'Pチェック',
    cl_check: 'クライアントチェック中',
  };
  const expectedStatus = ROUND_TO_WAITING_STATUS[vRow.round_stage];
  const { data: cRow, error: cErr } = await supabase
    .from('creatives')
    .select('id, status, project_id, file_name, team_id')
    .eq('id', creativeId)
    .maybeSingle();
  if (cErr) return res.status(500).json({ error: cErr.message });
  if (!cRow) return res.status(404).json({ error: 'クリエイティブが見つかりません' });
  if (cRow.status !== expectedStatus) {
    return res.status(409).json({
      error: `現在のステータス（${cRow.status || '不明'}）では編集できません。相手がすでに次の工程に進めています。`,
    });
  }

  // 4) 認可: 本人 または admin（VIEW AS 反映）
  let effectiveCodes = [];
  try {
    effectiveCodes = await getEffectiveRoleCodes(req);
  } catch (_) { /* fallback below */ }
  const isAdminEffective = effectiveCodes.includes('admin');
  const isOwner = !!(req.user?.id && vRow.recorded_by && req.user.id === vRow.recorded_by);
  if (!isAdminEffective && !isOwner) {
    return res.status(403).json({ error: '自分が提出したコメントのみ編集できます' });
  }

  // 5) 同値ガード（変更なしなら何もしない）
  const oldComment = vRow.editor_comment || '';
  if (oldComment.trim() === editorCommentNew) {
    return res.json({ ok: true, unchanged: true, version: vRow });
  }

  // 6) UPDATE — created_at は触らず、editor_submitted_at だけは「最後に編集した時刻」に更新する
  //    （フロント表示の「(編集済み hh:mm)」用に updated_at 相当を別途持たせる）
  //    creative_version_history には updated_at 列が無い（schema 確認済み）ため、
  //    変更検知用に editor_submitted_at の上書きはしない。代わりに meta は通知側で持つ。
  //    フロントは「edited_at」を独自に記録するため、応答に edited_at を含めて返す。
  const editedAtIso = new Date().toISOString();
  const { data: updated, error: upErr } = await supabase
    .from('creative_version_history')
    .update({ editor_comment: editorCommentNew })
    .eq('id', vRow.id)
    .select('id, creative_id, version_num, round_stage, recorded_by, editor_comment, editor_submitted_at, director_commented_at, created_at')
    .single();
  if (upErr) {
    return res.status(500).json({ error: upErr.message });
  }

  res.json({ ok: true, edited_at: editedAtIso, version: updated });

  // 7) 通知再送（fire-and-forget）
  setImmediate(async () => {
    try {
      const notif = require('../notifications');
      // 受け手側を解決
      const { data: detail } = await supabase
        .from('creatives')
        .select(`
          id, file_name, project_id, team_id,
          teams(id, director_id, producer_id),
          projects(id, name, slack_channel_url, chatwork_room_id, director_id, producer_id, clients(id, name, slack_channel_url, chatwork_room_id)),
          creative_assignments(role, users(id, full_name, slack_dm_id, chatwork_dm_id, nickname))
        `)
        .eq('id', creativeId)
        .maybeSingle();
      if (!detail) return;
      const project = detail.projects || null;
      const channelUrl = project?.slack_channel_url || project?.clients?.slack_channel_url || null;

      // actor 名（誰が編集したか）
      let actorName = '(不明)';
      if (req.user?.id) {
        const { data: u } = await supabase
          .from('users').select('full_name, nickname').eq('id', req.user.id).maybeSingle();
        actorName = u?.nickname || u?.full_name || actorName;
      }

      // 受け手の解決:
      //   d_check: directorAssignees > projects.director_id > teams.director_id
      //   p_check: producerAssignees > projects.producer_id
      //   cl_check: クライアントチェック中なので Slack channel への投稿を主とする
      const directorAssignees = (detail.creative_assignments || [])
        .filter(a => a.role === 'director').map(a => a.users).filter(Boolean);
      const producerAssignees = (detail.creative_assignments || [])
        .filter(a => a.role === 'producer').map(a => a.users).filter(Boolean);
      let recipients = [];
      if (vRow.round_stage === 'd_check') {
        recipients = directorAssignees.length > 0
          ? directorAssignees
          : (project?.director_id ? [{ id: project.director_id }] : (detail.teams?.director_id ? [{ id: detail.teams.director_id }] : []));
      } else if (vRow.round_stage === 'p_check') {
        recipients = producerAssignees.length > 0
          ? producerAssignees
          : (project?.producer_id ? [{ id: project.producer_id }] : []);
      }
      // cl_check は人ベースの recipient 解決が難しいので channel 投稿のみ

      // recipient の id しか分からない場合は users から補う
      const recipientIds = recipients.map(r => r?.id).filter(Boolean);
      if (recipientIds.length > 0) {
        const { data: us } = await supabase
          .from('users')
          .select('id, full_name, nickname, slack_dm_id, chatwork_dm_id')
          .in('id', recipientIds);
        recipients = us || [];
      }

      // 本文（先頭 80 文字を含める）
      const fileName = detail.file_name || '';
      const projectName = project?.name || '';
      const snippet = editorCommentNew.length > 80
        ? `${editorCommentNew.slice(0, 80)}…`
        : editorCommentNew;
      const stageLabel = vRow.round_stage === 'd_check' ? 'Dチェック'
                        : vRow.round_stage === 'p_check' ? 'Pチェック'
                        : 'クライアントチェック中';
      const baseUrl = process.env.APP_URL || process.env.PUBLIC_URL || '';
      const linkUrl = baseUrl
        ? `${baseUrl}/haruka.html?creative=${creativeId}`
        : `/haruka.html?creative=${creativeId}`;
      const slackBody =
        `✏️ 提出時メモ・連絡事項が修正されました\n` +
        `案件: ${projectName}\n` +
        `クリエイティブ: ${fileName}\n` +
        `ラウンド: ${stageLabel}\n` +
        `修正者: ${actorName}\n` +
        `修正後コメント:\n${snippet}\n` +
        `URL: ${linkUrl}`;

      // Slack DM (recipients) — 個別メンションで集約 1 投稿
      if (channelUrl) {
        const slackUsers = (recipients || []).filter(u => u && u.slack_dm_id && u.id !== req.user?.id);
        if (slackUsers.length > 0) {
          const mentions = slackUsers.map(u => `<@${u.slack_dm_id}>`).join(' ');
          await notif.sendSlackChannel(channelUrl, `${mentions}\n\n${slackBody}`);
        } else if (vRow.round_stage === 'cl_check') {
          // CL チェック中は recipients 解決が難しいので channel 投稿のみ
          await notif.sendSlackChannel(channelUrl, slackBody);
        }
      }

      // アプリ内通知（受信者本人がいる場合）
      const { createBulkNotifications } = require('../utils/notification');
      const inAppRecipients = (recipients || []).filter(u => u && u.id && u.id !== req.user?.id);
      if (inAppRecipients.length > 0) {
        const seen = new Set();
        const rows = [];
        for (const u of inAppRecipients) {
          if (seen.has(u.id)) continue;
          seen.add(u.id);
          rows.push({
            user_id: u.id,
            notification_type: 'creative_status',
            title: '提出時メモ・連絡事項が修正されました',
            body: projectName ? `${fileName}（${projectName}）` : fileName,
            link_url: `/creatives/${creativeId}`,
            meta: {
              creative_id: creativeId,
              project_id: detail.project_id || null,
              file_name: fileName,
              round_stage: vRow.round_stage,
              version_num: vRow.version_num,
              edited_by: req.user?.id || null,
              kind: 'editor_comment_edited',
            },
            sender_id: req.user?.id || null,
          });
        }
        if (rows.length > 0) {
          await createBulkNotifications(rows);
        }
      }
    } catch (e) {
      console.warn('[creative_version_history] re-notify failed:', e?.message || e);
    }
  });
});

// バージョン履歴保存
router.post('/creative-versions', async (req, res) => {
  const { creative_id, version_num, director_comment, client_comment } = req.body;
  if (!creative_id || !version_num) return res.status(400).json({ error: 'creative_id と version_num は必須です' });
  const { data, error } = await supabase
    .from('creative_version_history')
    .insert({ creative_id, version_num: parseInt(version_num), director_comment: director_comment || null, client_comment: client_comment || null })
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ============================================================
// ファイルコメント（レビュー・ナレッジ）
// ============================================================

// category_id → master_items 情報を別クエリで補完するヘルパー
async function enrichCommentCategories(comments) {
  const ids = [...new Set((comments || []).map(c => c.category_id).filter(Boolean))];
  if (!ids.length) return comments;
  const { data: items } = await supabase.from('master_items').select('id, name, code').in('id', ids);
  const map = {};
  (items || []).forEach(i => { map[i.id] = i; });
  return comments.map(c => ({ ...c, master_items: c.category_id ? (map[c.category_id] || null) : null }));
}

// 列欠損検出（schema-sync 失敗 / migration 未適用ケースのフォールバック判定）
const _isMissingCfcColumn = (err) => {
  if (!err) return false;
  const msg = err.message || '';
  return /column .+ does not exist/.test(msg) || /Could not find the .+ column/.test(msg) || err.code === 'PGRST204';
};

// bbox の正規化座標バリデーション ({x, y, w, h} すべて 0..1 の数値)
function _validateBbox(bbox) {
  if (bbox == null) return { ok: true, value: null };
  if (typeof bbox !== 'object') return { ok: false, error: 'bbox は object である必要があります' };
  const { x, y, w, h } = bbox;
  const inRange = (v) => typeof v === 'number' && isFinite(v) && v >= 0 && v <= 1;
  if (!inRange(x) || !inRange(y) || !inRange(w) || !inRange(h)) {
    return { ok: false, error: 'bbox は {x,y,w,h} すべて 0..1 の数値である必要があります' };
  }
  if (w <= 0 || h <= 0) return { ok: false, error: 'bbox の w/h は 0 より大きい必要があります' };
  if (x + w > 1.0001 || y + h > 1.0001) return { ok: false, error: 'bbox が範囲外です' };
  return { ok: true, value: { x, y, w, h } };
}

// ファイルのコメント一覧
//
// レスポンスには parent_comment_id を含む（フロント側でツリー化する flat 設計）。
// migration 未適用環境では parent_comment_id 列が無いため、同じ _isMissingCfcColumn
// フォールバックで列指定取得に切り替える。
router.get('/creative-files/:fid/comments', requireAuth, async (req, res) => {
  let { data, error } = await supabase
    .from('creative_file_comments')
    .select('*, users(id, full_name, role, avatar_url)')
    .eq('creative_file_id', req.params.fid)
    .order('created_at', { ascending: true });
  // bbox / parent_comment_id 列が無い環境向けフォールバック（'*' で取得しているため通常は到達しないが、PostgREST の schema cache 由来エラー時に保険）
  if (_isMissingCfcColumn(error)) {
    console.warn('[creative-file-comments] 列欠損疑い → 明示列指定で再取得:', error.message);
    ({ data, error } = await supabase
      .from('creative_file_comments')
      .select('id, creative_file_id, user_id, comment, timecode, is_knowledge, category_id, created_at, users(id, full_name, role, avatar_url)')
      .eq('creative_file_id', req.params.fid)
      .order('created_at', { ascending: true }));
  }
  if (error) return res.status(500).json({ error: error.message });
  res.json(await enrichCommentCategories(data));
});

// コメント追加（返信対応）
//
// parent_comment_id を受け取った場合は返信扱い:
//   ・親コメントが同じ creative_file_id に属することを検証（クロスファイル参照防止）
//   ・通知は親コメント投稿者に飛ばす（自分自身への返信は除外）
// parent_comment_id が無い場合は新規ルートコメント:
//   ・通知は creative_assignments の編集者全員に飛ばす（自分自身は除外）
router.post('/creative-files/:fid/comments', requireAuth, async (req, res) => {
  const { comment, timecode, is_knowledge, category_id, bbox, parent_comment_id } = req.body;
  if (!comment?.trim()) return res.status(400).json({ error: 'コメントを入力してください' });
  const bboxCheck = _validateBbox(bbox);
  if (!bboxCheck.ok) return res.status(400).json({ error: bboxCheck.error });

  // 返信の場合: 親コメントが同じファイルに属することを確認
  let parentComment = null;
  if (parent_comment_id) {
    const { data: parent, error: pErr } = await supabase
      .from('creative_file_comments')
      .select('id, creative_file_id, user_id, comment')
      .eq('id', parent_comment_id)
      .maybeSingle();
    if (pErr) return res.status(500).json({ error: pErr.message });
    if (!parent) return res.status(400).json({ error: '返信先のコメントが見つかりません' });
    if (parent.creative_file_id !== req.params.fid) {
      return res.status(400).json({ error: '返信先のコメントが別ファイルに属しています' });
    }
    parentComment = parent;
  }

  const basePayload = {
    creative_file_id: req.params.fid,
    user_id: req.user?.id || null,
    comment: comment.trim(),
    timecode: timecode || null,
    is_knowledge: !!is_knowledge,
    category_id: category_id || null,
  };
  if (parent_comment_id) basePayload.parent_comment_id = parent_comment_id;
  const fullPayload = bboxCheck.value
    ? { ...basePayload, bbox: bboxCheck.value }
    : basePayload;

  let { data, error } = await supabase
    .from('creative_file_comments')
    .insert(fullPayload)
    .select('*, users(id, full_name, role, avatar_url)')
    .single();
  // bbox / parent_comment_id 列が未追加の環境では順番にフォールバック（500を返さない）
  if (_isMissingCfcColumn(error)) {
    console.warn('[creative-file-comments] 列欠損 → 列を外して再試行:', error.message);
    // まず parent_comment_id を外す（migration 未適用ケース）
    const fallbackPayload = { ...fullPayload };
    delete fallbackPayload.parent_comment_id;
    ({ data, error } = await supabase
      .from('creative_file_comments')
      .insert(fallbackPayload)
      .select('*, users(id, full_name, role, avatar_url)')
      .single());
    // それでもダメなら bbox も外す
    if (_isMissingCfcColumn(error) && bboxCheck.value) {
      ({ data, error } = await supabase
        .from('creative_file_comments')
        .insert(basePayload)
        .select('*, users(id, full_name, role, avatar_url)')
        .single());
    }
  }
  if (error) return res.status(500).json({ error: error.message });
  const [enriched] = await enrichCommentCategories([data]);

  // 通知発火（主処理は止めない — 失敗は console.warn）
  // 返信なら親コメント投稿者へ、新規なら担当者全員へ
  (async () => {
    try {
      const senderId = req.user?.id || null;
      const senderName = req.user?.nickname || req.user?.full_name || '誰か';
      const excerpt = (data.comment || '').length > 80
        ? data.comment.slice(0, 80) + '…'
        : (data.comment || '');

      // creative_id を引きにいく（link_url / 通知タイトル用）
      const { data: cf } = await supabase
        .from('creative_files')
        .select('creative_id, creatives(id, file_name)')
        .eq('id', req.params.fid)
        .maybeSingle();
      const creativeId = cf?.creative_id || null;
      const creativeName = cf?.creatives?.file_name || null;
      const linkUrl = creativeId ? `/haruka.html?creative=${creativeId}` : '/haruka.html';

      if (parentComment && parentComment.user_id && parentComment.user_id !== senderId) {
        // 返信通知 → 親コメント投稿者へ
        await createNotification({
          userId: parentComment.user_id,
          type: 'post_comment',
          title: `${senderName}さんがあなたのコメントに返信しました`,
          body: excerpt,
          linkUrl,
          meta: {
            creative_id: creativeId,
            creative_file_id: req.params.fid,
            comment_id: data.id,
            parent_comment_id: parentComment.id,
            kind: 'creative_file_comment_reply',
          },
          senderId,
        });
      } else if (!parent_comment_id && creativeId) {
        // 新規コメント通知 → creative_assignments の担当者全員へ（自分は除外）
        const { data: assignees } = await supabase
          .from('creative_assignments')
          .select('user_id')
          .eq('creative_id', creativeId);
        const recipientIds = Array.from(new Set(
          (assignees || [])
            .map(a => a.user_id)
            .filter(uid => uid && uid !== senderId)
        ));
        if (recipientIds.length > 0) {
          const titleBase = creativeName
            ? `${senderName}さんが「${creativeName}」にコメントしました`
            : `${senderName}さんがクリエイティブにコメントしました`;
          await Promise.all(recipientIds.map(uid => createNotification({
            userId: uid,
            type: 'post_comment',
            title: titleBase,
            body: excerpt,
            linkUrl,
            meta: {
              creative_id: creativeId,
              creative_file_id: req.params.fid,
              comment_id: data.id,
              kind: 'creative_file_comment_new',
            },
            senderId,
          })));
        }
      }
    } catch (e) {
      console.warn('[creative-file-comments] 通知発火失敗:', e.message);
    }
  })();

  res.json(enriched);
});

// コメント編集（投稿者本人のみ）
router.patch('/creative-file-comments/:id', requireAuth, async (req, res) => {
  const userId = req.user?.id;
  const { comment } = req.body || {};
  if (!comment || typeof comment !== 'string' || !comment.trim()) {
    return res.status(400).json({ error: 'comment は必須です' });
  }
  const { data: existing } = await supabase
    .from('creative_file_comments')
    .select('user_id')
    .eq('id', req.params.id)
    .single();
  if (!existing) return res.status(404).json({ error: 'コメントが見つかりません' });
  if (existing.user_id !== userId) return res.status(403).json({ error: '自分の投稿のみ編集できます' });
  const { data, error } = await supabase
    .from('creative_file_comments')
    .update({ comment: comment.trim() })
    .eq('id', req.params.id)
    .select('*, users(id, full_name, role, avatar_url)')
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// コメント削除（自分のコメントのみ / admin は全件）
router.delete('/creative-file-comments/:id', requireAuth, async (req, res) => {
  const userId = req.user?.id;
  const { data: comment } = await supabase.from('creative_file_comments').select('user_id').eq('id', req.params.id).single();
  if (!comment) return res.status(404).json({ error: '見つかりません' });
  // user_roles 経由 + dual-read fallback で staff 判定
  const isAdmin = (await isStaffRequester(req)) || (await userIsStaff(userId));
  if (comment.user_id !== userId && !isAdmin) return res.status(403).json({ error: '権限がありません' });
  const { error } = await supabase.from('creative_file_comments').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ナレッジ一覧（is_knowledge=true、カテゴリーフィルター対応）
router.get('/knowledge', requireAuth, async (req, res) => {
  const { category_id } = req.query;
  let query = supabase
    .from('creative_file_comments')
    .select('*, users(id, full_name, role, avatar_url), creative_files(id, generated_name, drive_file_id, drive_url, creative_id, creatives(file_name, creative_type, projects(name, clients(name))))')
    .eq('is_knowledge', true)
    .order('created_at', { ascending: false });
  if (category_id) query = query.eq('category_id', category_id);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(await enrichCommentCategories(data));
});

// ==================== ナレッジ：動画視聴 ====================
// 勉強会・障害対応・チーム事例・バズ動画など、URL ベースの動画ライブラリ。
// 投稿は全員可、削除は投稿者本人 or admin。再生回数 (view_count) は admin のみ集計付与。

// URL から YouTube videoId を抽出（標準 / shorts / youtu.be / 共有パラメータ対応）
function extractYouTubeId(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    if (host === 'youtu.be') return u.pathname.slice(1).split('/')[0] || null;
    if (host === 'youtube.com' || host === 'm.youtube.com') {
      if (u.pathname === '/watch') return u.searchParams.get('v');
      const m = u.pathname.match(/^\/(?:shorts|embed|live)\/([^/?]+)/);
      if (m) return m[1];
    }
  } catch (_) { /* invalid URL */ }
  return null;
}

function deriveAutoThumbnail(url) {
  const ytId = extractYouTubeId(url);
  if (ytId) return `https://img.youtube.com/vi/${ytId}/hqdefault.jpg`;
  return null;
}

// カテゴリ一覧
router.get('/learning-video-categories', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('learning_video_categories')
    .select('*')
    .order('sort_order', { ascending: true })
    .order('name', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// カテゴリ追加（admin のみ）
router.post('/learning-video-categories', requireAuth, async (req, res) => {
  if (!(await requesterHasAnyRole(req, ['admin']))) {
    return res.status(403).json({ error: '権限がありません（admin のみ）' });
  }
  const { name, sort_order } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'name は必須です' });
  const { data, error } = await supabase
    .from('learning_video_categories')
    .insert({ name: String(name).trim(), sort_order: Number(sort_order) || 0 })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// カテゴリ削除（admin のみ）
router.delete('/learning-video-categories/:id', requireAuth, async (req, res) => {
  if (!(await requesterHasAnyRole(req, ['admin']))) {
    return res.status(403).json({ error: '権限がありません（admin のみ）' });
  }
  const { error } = await supabase
    .from('learning_video_categories')
    .delete()
    .eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// 動画一覧（admin のみ view_count を付与）
router.get('/learning-videos', requireAuth, async (req, res) => {
  const { category_id, q } = req.query;
  let query = supabase
    .from('learning_videos')
    .select('*, learning_video_categories(id, name), poster:posted_by(id, full_name, avatar_url, role)')
    .eq('is_archived', false)
    .order('created_at', { ascending: false });
  if (category_id) query = query.eq('category_id', category_id);
  if (q) query = query.ilike('title', `%${q}%`);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  const isAdmin = await requesterHasAnyRole(req, ['admin']);
  let countMap = {};
  if (isAdmin && (data || []).length > 0) {
    const ids = data.map(d => d.id);
    const { data: views } = await supabase
      .from('learning_video_views')
      .select('video_id')
      .in('video_id', ids);
    (views || []).forEach(v => { countMap[v.video_id] = (countMap[v.video_id] || 0) + 1; });
  }
  const enriched = (data || []).map(v => ({
    ...v,
    view_count: isAdmin ? (countMap[v.id] || 0) : null,
  }));
  res.json(enriched);
});

// 動画追加（全員可）
router.post('/learning-videos', requireAuth, async (req, res) => {
  const { title, url, thumbnail_url, description, category_id } = req.body || {};
  if (!title || !String(title).trim()) return res.status(400).json({ error: 'title は必須です' });
  if (!url || !String(url).trim())   return res.status(400).json({ error: 'url は必須です' });
  try { new URL(url); } catch (_) { return res.status(400).json({ error: 'url の形式が不正です' }); }

  const finalThumb = thumbnail_url && String(thumbnail_url).trim()
    ? String(thumbnail_url).trim()
    : deriveAutoThumbnail(url);

  const { data, error } = await supabase
    .from('learning_videos')
    .insert({
      title: String(title).trim(),
      url: String(url).trim(),
      thumbnail_url: finalThumb,
      description: description ? String(description).trim() : null,
      category_id: category_id || null,
      posted_by: req.user.id,
    })
    .select('*, learning_video_categories(id, name), poster:posted_by(id, full_name, avatar_url, role)')
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// 動画更新（投稿者 or admin）
router.put('/learning-videos/:id', requireAuth, async (req, res) => {
  const { data: existing, error: e1 } = await supabase
    .from('learning_videos').select('id, posted_by').eq('id', req.params.id).single();
  if (e1) return res.status(404).json({ error: '動画が見つかりません' });
  const isAdmin = await requesterHasAnyRole(req, ['admin']);
  if (existing.posted_by !== req.user.id && !isAdmin) {
    return res.status(403).json({ error: '権限がありません' });
  }
  const { title, url, thumbnail_url, description, category_id } = req.body || {};
  const patch = { updated_at: new Date().toISOString() };
  if (title !== undefined)         patch.title = String(title).trim();
  if (url !== undefined)           patch.url = String(url).trim();
  if (thumbnail_url !== undefined) patch.thumbnail_url = thumbnail_url ? String(thumbnail_url).trim() : null;
  if (description !== undefined)   patch.description = description ? String(description).trim() : null;
  if (category_id !== undefined)   patch.category_id = category_id || null;
  const { data, error } = await supabase
    .from('learning_videos').update(patch).eq('id', req.params.id)
    .select('*, learning_video_categories(id, name), poster:posted_by(id, full_name, avatar_url, role)')
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// 動画削除（投稿者 or admin）
router.delete('/learning-videos/:id', requireAuth, async (req, res) => {
  const { data: existing, error: e1 } = await supabase
    .from('learning_videos').select('id, posted_by').eq('id', req.params.id).single();
  if (e1) return res.status(404).json({ error: '動画が見つかりません' });
  const isAdmin = await requesterHasAnyRole(req, ['admin']);
  if (existing.posted_by !== req.user.id && !isAdmin) {
    return res.status(403).json({ error: '権限がありません' });
  }
  const { error } = await supabase.from('learning_videos').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// 再生ログ記録（カードクリック時に呼ぶ。誰でも POST 可、集計は admin のみ閲覧）
router.post('/learning-videos/:id/view', requireAuth, async (req, res) => {
  const { error } = await supabase
    .from('learning_video_views')
    .insert({ video_id: req.params.id, user_id: req.user.id });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ==================== Premiere Pro マーカー出力 ====================
// タイムコード文字列（HH:MM:SS:FF or MM:SS or HH:MM:SS）を秒数に変換
function _tcToSeconds(tc) {
  if (!tc) return null;
  const parts = String(tc).split(':').map(Number);
  if (parts.some(isNaN)) return null;
  if (parts.length === 4) return parts[0]*3600 + parts[1]*60 + parts[2] + parts[3]/30;
  if (parts.length === 3) return parts[0]*3600 + parts[1]*60 + parts[2];
  if (parts.length === 2) return parts[0]*60 + parts[1];
  return null;
}

router.get('/creative-files/:fid/markers.jsx', requireAuth, async (req, res) => {
  const { data: comments, error } = await supabase
    .from('creative_file_comments')
    .select('comment, timecode, users(full_name)')
    .eq('creative_file_id', req.params.fid)
    .not('timecode', 'is', null)
    .order('created_at', { ascending: true });

  if (error) return res.status(500).json({ error: error.message });

  const markers = (comments || [])
    .map(c => ({ sec: _tcToSeconds(c.timecode), name: c.timecode, comment: `${c.users?.full_name || '不明'}: ${c.comment}` }))
    .filter(m => m.sec !== null);

  const lines = markers.map(m =>
    `  { tc: ${m.sec.toFixed(4)}, name: ${JSON.stringify(m.name)}, comment: ${JSON.stringify(m.comment)}, color: 1 }`
  ).join(',\n');

  const jsx = `// HARUKA FILM SYSTEM — Premiere Pro マーカー挿入スクリプト
// 生成日時: ${new Date().toISOString()}
// ファイルID: ${req.params.fid}
// ※ Premiere Pro で File > Scripts > Run Script File から実行してください

var seq = app.project.activeSequence;
if (!seq) { alert("アクティブなシーケンスがありません"); exit(); }

var markers = [
${lines}
];

var added = 0;
for (var i = 0; i < markers.length; i++) {
  var m = markers[i];
  var mk = seq.markers.createMarker(m.tc);
  mk.name = m.name;
  mk.comments = m.comment;
  mk.colorByIndex = m.color;
  added++;
}
alert("マーカーを " + added + " 件追加しました");
`;

  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="haruka_markers_${req.params.fid.slice(0,8)}.jsx"`);
  res.send(jsx);
});

// Premiere紐づけ登録
router.post('/creative-files/:fid/link-premiere', requireAuth, async (req, res) => {
  const { premiere_project_id } = req.body;
  if (!premiere_project_id) return res.status(400).json({ error: 'premiere_project_id is required' });
  const { error } = await supabase
    .from('creative_files')
    .update({ premiere_project_id })
    .eq('id', req.params.fid);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// Premiere用マーカーJSON（UXPパネルから呼ばれる）
router.get('/creative-files/:fid/markers', requireAuth, async (req, res) => {
  const { data: comments, error } = await supabase
    .from('creative_file_comments')
    .select('comment, timecode, users(full_name)')
    .eq('creative_file_id', req.params.fid)
    .not('timecode', 'is', null)
    .order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  const markers = (comments || [])
    .map(c => {
      const timeSec = _tcToSeconds(c.timecode);
      if (timeSec === null) return null;
      return {
        timeSec,
        name: c.timecode,
        comment: `${c.users?.full_name || '不明'}: ${c.comment}`,
      };
    })
    .filter(Boolean);
  res.json({ markers });
});

// ==================== チェックリストマスター ====================

// 基本チェックリスト一覧
router.get('/checklist-masters', requireAuth, async (req, res) => {
  const { data, error } = await supabase.from('checklist_masters')
    .select('*').order('sort_order').order('created_at');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// 基本チェックリスト追加
router.post('/checklist-masters', requireAuth, requirePermission('master.page'), async (req, res) => {
  const { title, description, sort_order, target_type } = req.body;
  if (!title) return res.status(400).json({ error: 'タイトルは必須です' });
  const { data, error } = await supabase.from('checklist_masters')
    .insert({ title, description, sort_order: sort_order || 0, target_type: target_type || 'all' }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// 基本チェックリスト更新
router.put('/checklist-masters/:id', requireAuth, requirePermission('master.page'), async (req, res) => {
  const { title, description, sort_order, is_active, target_type } = req.body;
  const { data, error } = await supabase.from('checklist_masters')
    .update({ title, description, sort_order, is_active, target_type: target_type || 'all', updated_at: new Date().toISOString() })
    .eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// 基本チェックリスト削除
router.delete('/checklist-masters/:id', requireAuth, requirePermission('master.page'), async (req, res) => {
  const { error } = await supabase.from('checklist_masters').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ==================== 案件チェックリスト ====================

// 案件チェックリスト一覧
router.get('/projects/:projectId/checklist-items', requireAuth, async (req, res) => {
  const { data, error } = await supabase.from('project_checklist_items')
    .select('*').eq('project_id', req.params.projectId).order('sort_order').order('created_at');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// 案件チェックリスト追加
router.post('/projects/:projectId/checklist-items', requireAuth, async (req, res) => {
  const { title, description, sort_order } = req.body;
  if (!title) return res.status(400).json({ error: 'タイトルは必須です' });
  const { data, error } = await supabase.from('project_checklist_items')
    .insert({ project_id: req.params.projectId, title, description, sort_order: sort_order || 0 }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// 案件チェックリスト更新
router.put('/projects/:projectId/checklist-items/:id', requireAuth, async (req, res) => {
  const { title, description, sort_order, is_active } = req.body;
  const { data, error } = await supabase.from('project_checklist_items')
    .update({ title, description, sort_order, is_active, updated_at: new Date().toISOString() })
    .eq('id', req.params.id).eq('project_id', req.params.projectId).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// 案件チェックリスト削除
router.delete('/projects/:projectId/checklist-items/:id', requireAuth, async (req, res) => {
  const { error } = await supabase.from('project_checklist_items')
    .delete().eq('id', req.params.id).eq('project_id', req.params.projectId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ==================== クリエイティブファイルのチェック結果 ====================

// ファイルのチェックリスト（グローバル+案件固有）＋チェック済み状態を返す
router.get('/creative-files/:fileId/checklist', requireAuth, async (req, res) => {
  try {
    // creative_file → creative → project_id, creative_type を取得
    const { data: fileRec } = await supabase.from('creative_files')
      .select('id, creative_id, creatives(project_id, creative_type)').eq('id', req.params.fileId).single();
    const projectId    = fileRec?.creatives?.project_id;
    const creativeType = fileRec?.creatives?.creative_type || '';
    const isDesign     = creativeType.startsWith('design');

    // グローバルチェックリスト（target_typeでフィルタリング）
    const { data: globalsRaw } = await supabase.from('checklist_masters')
      .select('*').eq('is_active', true).order('sort_order').order('created_at');
    const globals = (globalsRaw || []).filter(g => {
      const t = g.target_type || 'all';
      if (t === 'all') return true;
      if (t === 'design') return isDesign;
      if (t === 'video')  return !isDesign;
      return true;
    });

    // 案件固有チェックリスト
    const projectItems = projectId
      ? (await supabase.from('project_checklist_items')
          .select('*').eq('project_id', projectId).eq('is_active', true).order('sort_order').order('created_at')).data
      : [];

    // チェック済み状態
    const { data: results } = await supabase.from('creative_checklist_results')
      .select('*, users(full_name)').eq('creative_file_id', req.params.fileId);

    const resultMap = {};
    (results || []).forEach(r => { resultMap[`${r.item_type}:${r.item_id}`] = r; });

    res.json({
      project_id: projectId,
      globals: (globals || []).map(g => ({ ...g, result: resultMap[`global:${g.id}`] || null })),
      project_items: (projectItems || []).map(p => ({ ...p, result: resultMap[`project:${p.id}`] || null })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// チェックアイテムのトグル（チェック/アンチェック）
router.post('/creative-files/:fileId/checklist/toggle', requireAuth, async (req, res) => {
  const { item_id, item_type } = req.body; // item_type: 'global' | 'project'
  if (!item_id || !item_type) return res.status(400).json({ error: 'item_id, item_type は必須' });

  const existing = await supabase.from('creative_checklist_results')
    .select('id, is_checked').eq('creative_file_id', req.params.fileId)
    .eq('item_id', item_id).eq('item_type', item_type).maybeSingle();

  const userId = req.user?.id;
  const now    = new Date().toISOString();

  let result;
  if (existing.data) {
    const newChecked = !existing.data.is_checked;
    const { data, error } = await supabase.from('creative_checklist_results')
      .update({ is_checked: newChecked, checked_by: newChecked ? userId : null, checked_at: newChecked ? now : null, updated_at: now })
      .eq('id', existing.data.id).select('*, users(full_name)').single();
    if (error) return res.status(500).json({ error: error.message });
    result = data;
  } else {
    const { data, error } = await supabase.from('creative_checklist_results')
      .insert({ creative_file_id: req.params.fileId, item_id, item_type, is_checked: true, checked_by: userId, checked_at: now })
      .select('*, users(full_name)').single();
    if (error) return res.status(500).json({ error: error.message });
    result = data;
  }
  res.json(result);
});

// ロールマスタ取得（全ユーザーがアクセス可能・フロント表示・ソート用）
// Stage 0 / Step 2 PR3 (ADR 003):
//   フロント (public/haruka.html) のハードコード ROLE_RANK / ROLE_SORT_ORDER /
//   ROLE_LABEL_SHORT / VIEW AS ボタン などを roles マスタ駆動に切り替えるための入口。
//   archived_at IS NULL のみ返す。並び順は sort_order 昇順。
router.get('/roles', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('roles')
    .select('id, code, label, category, sort_order, is_creator, is_internal, archived_at')
    .is('archived_at', null)
    .order('sort_order', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// ロール権限取得（全ユーザーがアクセス可能。自身のUIのために必要）
// Stage 0 / Step 2 (ADR 003): role_id (UUID) と roles.code を JOIN して返す。
//   後方互換: 旧 role TEXT 列もそのまま返す（フロントは当面 role を読み続ける）。
//   合成値 'producer_director' の行は role_id NULL のまま残るので、フロントは
//   role TEXT で識別できる。
router.get('/role-permissions', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('role_permissions')
    .select('role, permission_key, allowed, role_id, roles(code, label)');
  if (error) return res.status(500).json({ error: error.message });
  // 互換のためフラットに展開（roles.code を role_code として並走）
  const flat = (data || []).map(r => ({
    role: r.role,
    role_id: r.role_id,
    role_code: r.roles ? r.roles.code : null,
    role_label: r.roles ? r.roles.label : null,
    permission_key: r.permission_key,
    allowed: !!r.allowed,
  }));
  res.json(flat);
});

// 有効なロール／権限キーのホワイトリスト
const VALID_ROLES = new Set(['admin','secretary','producer','producer_director','director','editor','designer']);
const VALID_PERMISSION_KEYS = new Set([
  'dashboard.sales_summary','dashboard.monthly_forecast',
  'project.create_edit','project.unit_price_view','project.fee_view','project.delete',
  'creative.all_projects_view','creative.rank_price_column','creative.csv_import','creative.sos_others',
  'member.list','member.edit_password','member.deactivate','member.delete',
  'team.manage','team.assign','team.delete',
  'invoice.own','invoice.all_view',
  'master.page','master.sys_config',
  'system.view_as',
  'analytics.view',
  'analytics.bug_reports.view',
]);

// ロール権限保存（最高管理者のみ・ホワイトリスト検証あり）
// Stage 0 / Step 2 (ADR 003): dual-write 化。
//   - 旧 role TEXT 列に書く（既存の onConflict 'role,permission_key' を維持）
//   - 同時に roles マスタを引いて role_id を埋める（'producer_director' は roles
//     マスタに無いので role_id NULL のまま）
router.put('/role-permissions', requireAuth, requireSuperAdmin, async (req, res) => {
  const { permissions } = req.body; // [{role, permission_key, allowed}, ...]
  if (!Array.isArray(permissions)) return res.status(400).json({ error: 'permissions配列が必要です' });
  // ホワイトリスト検証
  for (const p of permissions) {
    if (!VALID_ROLES.has(p.role)) return res.status(400).json({ error: `不正なロール: ${p.role}` });
    if (!VALID_PERMISSION_KEYS.has(p.permission_key)) return res.status(400).json({ error: `不正な権限キー: ${p.permission_key}` });
  }
  // role_id 解決のため roles マスタを 1 回だけ引く
  const { data: rolesData, error: rolesErr } = await supabase
    .from('roles').select('id, code');
  if (rolesErr) return res.status(500).json({ error: rolesErr.message });
  const roleIdByCode = new Map((rolesData || []).map(r => [r.code, r.id]));

  const now = new Date().toISOString();
  const rows = permissions.map(p => ({
    role: p.role,
    role_id: roleIdByCode.get(p.role) || null, // 'producer_director' は null のまま
    permission_key: p.permission_key,
    allowed: !!p.allowed,
    updated_at: now,
  }));
  const { error } = await supabase
    .from('role_permissions').upsert(rows, { onConflict: 'role,permission_key' });
  if (error) return res.status(500).json({ error: error.message });
  invalidatePermissionsCache(); // 即時反映
  res.json({ ok: true, count: rows.length });
});

// パスワードリセット（自分自身 or member.edit_password 権限を持つユーザーのみ）
router.post('/users/:id/reset-password', requireAuth, async (req, res) => {
  const isSelf = req.user.id === req.params.id;
  // VIEW AS 中は実効ロールで判定（最高管理者のみ X-View-As が有効）
  const canEditOthers = await userHasPermission(getEffectiveRole(req), 'member.edit_password');
  if (!isSelf && !canEditOthers) return res.status(403).json({ error: '他のユーザーのパスワードを変更する権限がありません' });
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 8) return res.status(400).json({ error: 'パスワードは8文字以上必要です' });
  const hash = await bcrypt.hash(newPassword, 12);
  const { error } = await supabase.from('users').update({ password_hash: hash }).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ==================== 品目名マスター（見積明細のクイック選択用） ====================
// 詳細: migrations/2026-05-02_item_name_master.sql

// 一覧取得
//   ?category=video|design  カテゴリ絞り込み（未指定=全件）
//   ?active_only=true|false  アクティブのみ（既定 true）
router.get('/item-name-master', async (req, res) => {
  const { category, active_only } = req.query;
  let q = supabase.from('item_name_master').select('*');
  if (category) {
    if (!['video', 'design'].includes(category)) {
      return res.status(400).json({ error: 'category は video または design を指定してください' });
    }
    q = q.eq('category', category);
  }
  // active_only は明示的に 'false' を指定しない限り true 扱い
  if (active_only !== 'false') q = q.eq('is_active', true);
  q = q.order('sort_order', { ascending: true }).order('name', { ascending: true });
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// 新規作成
router.post('/item-name-master', requireAuth, requirePermission('project.create_edit'), async (req, res) => {
  const { category, name, default_unit, default_unit_price, sort_order } = req.body || {};
  if (!category || !['video', 'design'].includes(category)) {
    return res.status(400).json({ error: 'category は video または design を指定してください' });
  }
  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: '品目名は必須です' });
  }
  let priceVal = null;
  if (default_unit_price !== undefined && default_unit_price !== null && default_unit_price !== '') {
    const n = parseInt(default_unit_price);
    if (!Number.isFinite(n) || n < 0) {
      return res.status(400).json({ error: '既定単価は0以上の整数で指定してください' });
    }
    priceVal = n;
  }
  const { data, error } = await supabase.from('item_name_master')
    .insert({
      category,
      name: String(name).trim(),
      default_unit: default_unit ? String(default_unit).trim() : null,
      default_unit_price: priceVal,
      sort_order: parseInt(sort_order) || 0,
      is_active: true
    })
    .select().single();
  if (error) {
    if (error.code === '23505') {
      return res.status(409).json({ error: `品目「${name}」は既に同じカテゴリに登録されています` });
    }
    return res.status(500).json({ error: error.message });
  }
  res.json(data);
});

// 更新
router.put('/item-name-master/:id', requireAuth, requirePermission('project.create_edit'), async (req, res) => {
  const { category, name, default_unit, default_unit_price, sort_order, is_active } = req.body || {};
  const updateData = { updated_at: new Date().toISOString() };
  if (category !== undefined) {
    if (!['video', 'design'].includes(category)) {
      return res.status(400).json({ error: 'category は video または design を指定してください' });
    }
    updateData.category = category;
  }
  if (name !== undefined) {
    const trimmed = String(name).trim();
    if (!trimmed) return res.status(400).json({ error: '品目名は必須です' });
    updateData.name = trimmed;
  }
  if (default_unit !== undefined) {
    updateData.default_unit = default_unit ? String(default_unit).trim() : null;
  }
  if (default_unit_price !== undefined) {
    if (default_unit_price === null || default_unit_price === '') {
      updateData.default_unit_price = null;
    } else {
      const n = parseInt(default_unit_price);
      if (!Number.isFinite(n) || n < 0) {
        return res.status(400).json({ error: '既定単価は0以上の整数で指定してください' });
      }
      updateData.default_unit_price = n;
    }
  }
  if (sort_order !== undefined) updateData.sort_order = parseInt(sort_order) || 0;
  if (is_active !== undefined) updateData.is_active = !!is_active;
  const { data, error } = await supabase.from('item_name_master')
    .update(updateData)
    .eq('id', req.params.id)
    .select().single();
  if (error) {
    if (error.code === '23505') {
      return res.status(409).json({ error: `品目「${name}」は既に同じカテゴリに登録されています` });
    }
    return res.status(500).json({ error: error.message });
  }
  res.json(data);
});

// ==================== エラー報告 ====================
// 画面右下の 🐛 ボタンから呼ばれる。スクリーンショット + メタ情報 + ユーザーコメントを
// Slack の専用チャンネルに投稿する。
//   送信先: 環境変数 ERROR_REPORT_SLACK_CHANNEL_URL（slack_workspaces から bot_token 解決）
//   bot に files:write / chat:write スコープが必要。
const errorReportUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });
const _errorReportLastSentAt = new Map(); // userId -> ms; 連投抑制
router.post('/error-report', requireAuth, errorReportUpload.single('screenshot'), async (req, res) => {
  const channelUrl = process.env.ERROR_REPORT_SLACK_CHANNEL_URL;
  if (!channelUrl) return res.status(503).json({ error: 'エラー通知チャンネル未設定' });

  const userId = req.user?.id;
  const now = Date.now();
  const last = _errorReportLastSentAt.get(userId) || 0;
  if (now - last < 10000) {
    return res.status(429).json({ error: 'しばらく待ってから再送信してください' });
  }

  let metadata = {};
  try { if (req.body?.metadata) metadata = JSON.parse(req.body.metadata); } catch (_) { metadata = {}; }
  const description = String(req.body?.description || '').trim();
  const screenshot = req.file;

  const u = req.user || {};
  const reporter = `${u.full_name || u.email || u.id || 'unknown'} (${u.email || 'no-email'}) / role:${u.role || '?'}`;
  const ts = new Date().toISOString();
  const url = String(metadata.url || '').slice(0, 500);
  const ua = String(metadata.userAgent || '').slice(0, 300);
  const size = metadata.viewport ? `${metadata.viewport.w}x${metadata.viewport.h}` : '';
  const recentErrors = Array.isArray(metadata.recentErrors) ? metadata.recentErrors : [];
  const recentApis = Array.isArray(metadata.recentFailedApis) ? metadata.recentFailedApis : [];
  const fmtErr = recentErrors.length
    ? recentErrors.map(e => {
        const t = e.ts || '';
        const head = `[${t}] ${e.type || ''}`;
        return `${head} ${String(e.msg || '').slice(0, 300)}${e.src ? ` @ ${e.src}:${e.line || ''}` : ''}`;
      }).join('\n').slice(0, 1500)
    : '（なし）';
  const fmtApi = recentApis.length
    ? recentApis.map(a => `[${a.ts || ''}] ${a.status || ''} ${a.url || ''} ${String(a.body || '').slice(0, 200)}`).join('\n').slice(0, 1500)
    : '（なし）';

  const text =
`🐛 エラー報告
*報告者*: ${reporter}
*発生時刻*: ${ts}
*URL*: ${url}
*User-Agent*: ${ua}
*画面サイズ*: ${size}

*ユーザーコメント*:
${description || '（記入なし）'}

*直近のコンソールエラー*:
\`\`\`${fmtErr}\`\`\`

*直近の失敗API*:
\`\`\`${fmtApi}\`\`\``;

  let result;
  if (screenshot && screenshot.buffer && screenshot.buffer.length) {
    result = await notif.sendSlackChannelWithFile(channelUrl, text, screenshot.buffer, 'screenshot.png');
  } else {
    // スクリーンショットが無くても通知は送る
    result = await notif.sendSlackChannel(channelUrl, text);
  }
  if (!result?.ok) {
    return res.status(500).json({ error: `Slack送信失敗: ${result?.reason || 'unknown'}` });
  }
  _errorReportLastSentAt.set(userId, now);
  res.json({ ok: true });
});

// ==================== 自動エラー通知（フロント発信） ====================
// クライアント側 window.onerror / unhandledrejection / fetch 5xx をここに送る。
// requireAuth は付けない（未ログイン時のエラー、login.html での例外も拾うため）。
// 代わりに以下の安全策で乱用・DoS を抑止する:
//   - IP ベースのレート制限（同 IP 10 秒で 5 回まで）
//   - notifyAutoError 内部で signature 5 分 dedupe
//   - ENV 未設定時は 200 で {skipped:'no-channel'}（フロントの暴走再送を防ぐ）
//
// クライアントは fetch(... { keepalive: true }) で fire-and-forget するため、
// 200 を素早く返すことを優先する。
const _autoErrorIpHits = new Map(); // ip -> [ts, ts, ...]（直近10秒のみ保持）
const AUTO_ERROR_IP_WINDOW_MS = 10 * 1000;
const AUTO_ERROR_IP_MAX = 5;
function _autoErrorRateLimited(ip) {
  if (!ip) return false;
  const now = Date.now();
  const arr = (_autoErrorIpHits.get(ip) || []).filter(t => now - t < AUTO_ERROR_IP_WINDOW_MS);
  if (arr.length >= AUTO_ERROR_IP_MAX) {
    _autoErrorIpHits.set(ip, arr);
    return true;
  }
  arr.push(now);
  _autoErrorIpHits.set(ip, arr);
  // たまに掃除
  if (_autoErrorIpHits.size > 1000) {
    for (const [k, v] of _autoErrorIpHits) {
      const filtered = v.filter(t => now - t < AUTO_ERROR_IP_WINDOW_MS);
      if (filtered.length === 0) _autoErrorIpHits.delete(k);
      else _autoErrorIpHits.set(k, filtered);
    }
  }
  return false;
}
router.post('/auto-error', express.json({ limit: '32kb' }), async (req, res) => {
  const ip = (req.headers['x-forwarded-for']?.split(',')[0]?.trim()) || req.ip || '';
  if (_autoErrorRateLimited(ip)) {
    return res.status(200).json({ ok: true, skipped: 'rate-limited-ip' });
  }
  // body は JSON もしくは text(JSON)。keepalive 経由で application/json になる前提だが、念のため両対応。
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  const message = String(body.message || '').trim();
  if (!message) {
    return res.status(400).json({ error: 'message is required' });
  }

  // ユーザー情報があれば付与（未ログインでも可）
  const userEmail = body.userEmail || req.user?.email || null;
  const result = await notif.notifyAutoError({
    source: body.source === 'server' ? 'server' : 'client',
    kind: String(body.kind || 'unknown').slice(0, 64),
    message: message.slice(0, 4000),
    stack: body.stack ? String(body.stack).slice(0, 4000) : null,
    url: body.url ? String(body.url).slice(0, 500) : null,
    userAgent: body.userAgent ? String(body.userAgent).slice(0, 300) : null,
    statusCode: body.statusCode || null,
    apiPath: body.apiPath ? String(body.apiPath).slice(0, 300) : null,
    // 原因特定用の追加情報（PR: エラー原因特定の構造改革）
    filename: body.filename ? String(body.filename).slice(0, 500) : null,
    lineno: body.lineno ?? null,
    colno: body.colno ?? null,
    trace: body.trace && typeof body.trace === 'object' ? body.trace : null,
    // breadcrumbs はフロントから配列で送られてくる。最大 8 件 × 各 ~200B 程度。
    breadcrumbs: Array.isArray(body.breadcrumbs) ? body.breadcrumbs.slice(0, 16) : null,
    clientBuild: body.clientBuild ? String(body.clientBuild).slice(0, 80) : null,
    serverBuild: process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_COMMIT_SHA || process.env.COMMIT_SHA || null,
    userEmail,
  });
  if (result?.skipped) return res.json({ ok: true, skipped: result.skipped });
  if (!result?.ok)     return res.json({ ok: false, reason: result?.reason || 'unknown' });
  return res.json({ ok: true });
});

// 削除（既定は論理削除 = is_active=false。?hard=true で物理削除）
router.delete('/item-name-master/:id', requireAuth, requirePermission('project.create_edit'), async (req, res) => {
  if (req.query.hard === 'true') {
    const { error } = await supabase.from('item_name_master').delete().eq('id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ ok: true, hard: true });
  }
  const { data, error } = await supabase.from('item_name_master')
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, data });
});

// ==================== Verup情報（システム改訂履歴） ====================
// 設計: 管理者が画面から追加・編集できる changelog。
//   - 一覧はログイン中ユーザーの role で target_roles を絞る（'all' は全員）
//   - revision_no は GitHub の PR 番号と一致させる運用に統一（CI: post-version-log.js）。
//     画面からの手動追加は PR 番号と衝突しないよう MANUAL_REVISION_OFFSET (1,000,000) を加算する。
//   - 既読は version_log_reads(user_id, version_log_id) にレコードがあれば既読扱い
//   - 非表示（is_hidden=true）は admin が全体から隠す機能。admin のみ参照・操作可
const MANUAL_REVISION_OFFSET = 1000000;
const VERSION_LOG_CATEGORIES = ['feature', 'improvement', 'bugfix', 'spec_change'];
const VERSION_LOG_IMPORTANCES = ['high', 'normal', 'low'];

function normalizeVersionLogPayload(body) {
  const out = {};
  if (body.version_label !== undefined) out.version_label = body.version_label || null;
  if (body.released_at !== undefined && body.released_at) out.released_at = new Date(body.released_at).toISOString();
  if (body.screen !== undefined) out.screen = String(body.screen || '').trim();
  if (body.feature !== undefined) out.feature = String(body.feature || '').trim();
  if (body.description !== undefined) out.description = String(body.description || '').trim();
  if (body.before_text !== undefined) out.before_text = body.before_text || null;
  if (body.after_text !== undefined) out.after_text = body.after_text || null;
  if (body.use_case !== undefined) out.use_case = body.use_case || null;
  if (body.category !== undefined) {
    const c = String(body.category || '').trim();
    out.category = VERSION_LOG_CATEGORIES.includes(c) ? c : 'improvement';
  }
  if (body.importance !== undefined) {
    const i = String(body.importance || '').trim();
    out.importance = VERSION_LOG_IMPORTANCES.includes(i) ? i : 'normal';
  }
  if (body.target_roles !== undefined) {
    const arr = Array.isArray(body.target_roles) ? body.target_roles : [];
    out.target_roles = arr.length ? arr.map(String) : ['all'];
  }
  if (body.tags !== undefined) {
    const arr = Array.isArray(body.tags) ? body.tags : [];
    out.tags = arr.map(s => String(s).trim()).filter(Boolean);
  }
  if (body.related_url !== undefined) out.related_url = body.related_url || null;
  if (body.is_hidden !== undefined) out.is_hidden = !!body.is_hidden;
  if (body.reporter_user_id !== undefined) {
    const v = body.reporter_user_id;
    out.reporter_user_id = (v === '' || v == null) ? null : String(v);
  }
  return out;
}

router.get('/version-logs', requireAuth, async (req, res) => {
  try {
    const isAdmin = await requesterHasAnyRole(req, ['admin']);
    let q = supabase
      .from('version_logs')
      .select('*, reporter:reporter_user_id ( id, full_name, nickname, avatar_url )')
      .order('revision_no', { ascending: false });
    if (!isAdmin) q = q.eq('is_hidden', false);
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });

    let myRoleCodes = await getRequesterRoleCodes(req);
    if (myRoleCodes.length === 0 && req.user?.role) myRoleCodes = [req.user.role];

    const userId = req.user?.id;
    let readSet = new Set();
    if (userId) {
      const { data: reads } = await supabase
        .from('version_log_reads').select('version_log_id').eq('user_id', userId);
      readSet = new Set((reads || []).map(r => r.version_log_id));
    }

    const filtered = (data || []).filter(row => {
      if (isAdmin) return true; // admin は role 制限を受けない
      const tr = row.target_roles || ['all'];
      if (tr.includes('all')) return true;
      return tr.some(r => myRoleCodes.includes(r));
    }).map(row => ({ ...row, is_read: readSet.has(row.id) }));

    res.json(filtered);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/version-logs/unread-count', requireAuth, async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.json({ count: 0 });

    const { data: logs, error } = await supabase
      .from('version_logs').select('id, target_roles, is_hidden').eq('is_hidden', false);
    if (error) return res.status(500).json({ error: error.message });

    let myRoleCodes = await getRequesterRoleCodes(req);
    if (myRoleCodes.length === 0 && req.user?.role) myRoleCodes = [req.user.role];

    const visibleIds = (logs || [])
      .filter(l => {
        const tr = l.target_roles || ['all'];
        if (tr.includes('all')) return true;
        return tr.some(r => myRoleCodes.includes(r));
      })
      .map(l => l.id);

    if (visibleIds.length === 0) return res.json({ count: 0 });

    const { data: reads } = await supabase
      .from('version_log_reads').select('version_log_id').eq('user_id', userId).in('version_log_id', visibleIds);
    const readSet = new Set((reads || []).map(r => r.version_log_id));
    const unread = visibleIds.filter(id => !readSet.has(id)).length;
    res.json({ count: unread });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/version-logs', requireAuth, async (req, res) => {
  try {
    const isAdmin = await requesterHasAnyRole(req, ['admin']);
    if (!isAdmin) return res.status(403).json({ error: '管理者のみ追加できます' });

    const payload = normalizeVersionLogPayload(req.body || {});
    if (!payload.screen || !payload.feature || !payload.description) {
      return res.status(400).json({ error: '画面 / 機能 / 修正内容は必須です' });
    }

    // 手動追加分は PR 番号と衝突しないよう MANUAL_REVISION_OFFSET 以上の領域を使う
    const { data: maxRow } = await supabase
      .from('version_logs')
      .select('revision_no')
      .gte('revision_no', MANUAL_REVISION_OFFSET)
      .order('revision_no', { ascending: false })
      .limit(1)
      .maybeSingle();
    const nextNo = (maxRow?.revision_no || MANUAL_REVISION_OFFSET) + 1;

    const insertRow = {
      revision_no: nextNo,
      version_label: payload.version_label ?? null,
      released_at: payload.released_at || new Date().toISOString(),
      screen: payload.screen,
      feature: payload.feature,
      description: payload.description,
      before_text: payload.before_text ?? null,
      after_text: payload.after_text ?? null,
      use_case: payload.use_case ?? null,
      category: payload.category || 'improvement',
      importance: payload.importance || 'normal',
      target_roles: payload.target_roles || ['all'],
      tags: payload.tags || [],
      related_url: payload.related_url ?? null,
      is_hidden: payload.is_hidden || false,
      reporter_user_id: payload.reporter_user_id ?? null,
      created_by: req.user?.id || null,
    };

    const { data, error } = await supabase.from('version_logs').insert(insertRow).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/version-logs/:id', requireAuth, async (req, res) => {
  try {
    const isAdmin = await requesterHasAnyRole(req, ['admin']);
    if (!isAdmin) return res.status(403).json({ error: '管理者のみ編集できます' });

    const payload = normalizeVersionLogPayload(req.body || {});
    payload.updated_at = new Date().toISOString();

    const { data, error } = await supabase
      .from('version_logs').update(payload).eq('id', req.params.id).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/version-logs/:id', requireAuth, async (req, res) => {
  try {
    const isAdmin = await requesterHasAnyRole(req, ['admin']);
    if (!isAdmin) return res.status(403).json({ error: '管理者のみ削除できます' });
    const { error } = await supabase.from('version_logs').delete().eq('id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 既読化（既存があれば 200 OK でスキップ）
router.post('/version-logs/:id/read', requireAuth, async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'unauth' });
    const { error } = await supabase
      .from('version_log_reads')
      .upsert({ user_id: userId, version_log_id: req.params.id, read_at: new Date().toISOString() },
              { onConflict: 'user_id,version_log_id' });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 全件既読化（自分の見えるものすべて）
router.post('/version-logs/read-all', requireAuth, async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'unauth' });

    const { data: logs } = await supabase
      .from('version_logs').select('id, target_roles, is_hidden').eq('is_hidden', false);
    let myRoleCodes = await getRequesterRoleCodes(req);
    if (myRoleCodes.length === 0 && req.user?.role) myRoleCodes = [req.user.role];

    const ids = (logs || [])
      .filter(l => {
        const tr = l.target_roles || ['all'];
        if (tr.includes('all')) return true;
        return tr.some(r => myRoleCodes.includes(r));
      }).map(l => l.id);

    if (ids.length === 0) return res.json({ ok: true, count: 0 });
    const rows = ids.map(id => ({ user_id: userId, version_log_id: id, read_at: new Date().toISOString() }));
    const { error } = await supabase.from('version_log_reads').upsert(rows, { onConflict: 'user_id,version_log_id' });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true, count: ids.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 表示/非表示切替（admin のみ）— 非表示にすると全ユーザーから見えなくなる
router.post('/version-logs/:id/visibility', requireAuth, async (req, res) => {
  try {
    const isAdmin = await requesterHasAnyRole(req, ['admin']);
    if (!isAdmin) return res.status(403).json({ error: '管理者のみ切替できます' });
    const is_hidden = !!req.body?.is_hidden;
    const { data, error } = await supabase
      .from('version_logs').update({ is_hidden, updated_at: new Date().toISOString() })
      .eq('id', req.params.id).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// バグ報告システム (bug_reports)
// ============================================================
// PR #188 の /api/error-report (Slack 投稿のみ・対応管理なし) とは独立。
// 対応者割当・ステータス管理・履歴閲覧ができる管理対象のバグ報告。
// 匿名フラグ true の場合は reporter_user_id = null で保存（誰が報告したか記録しない）。
// ============================================================

const BUG_REPORT_SEVERITIES = ['low', 'normal', 'high', 'critical'];
// 'implemented' (実装済み) は workflow が PR本文の Bug-Report-Id trailer を見て
// 自動セットする中間ステータス。人による検証が完了したら admin が 'resolved' に進める。
const BUG_REPORT_STATUSES = ['open', 'in_progress', 'implemented', 'resolved', 'wont_fix', 'duplicate'];

// data URL の最大サイズ（base64 で約 8MB ≒ 元画像 6MB）。
// クライアント側で 1600px に縮小してから送る前提。
const BUG_REPORT_DATA_URL_MAX = 8 * 1024 * 1024;

function normalizeBugReportPayload(body, { isCreate }) {
  const out = {};
  if (body.title !== undefined) out.title = String(body.title || '').trim().slice(0, 200);
  if (body.description !== undefined) out.description = body.description ? String(body.description).slice(0, 5000) : null;
  if (body.url !== undefined) out.url = body.url ? String(body.url).slice(0, 1000) : null;
  if (body.screen_label !== undefined) out.screen_label = body.screen_label ? String(body.screen_label).slice(0, 100) : null;
  if (body.severity !== undefined) {
    const v = String(body.severity || '').trim();
    out.severity = BUG_REPORT_SEVERITIES.includes(v) ? v : 'normal';
  }
  if (body.is_urgent !== undefined) out.is_urgent = !!body.is_urgent;
  if (body.status !== undefined) {
    const v = String(body.status || '').trim();
    out.status = BUG_REPORT_STATUSES.includes(v) ? v : 'open';
  }
  if (body.assignee_user_id !== undefined) {
    const v = body.assignee_user_id;
    out.assignee_user_id = (v === '' || v == null) ? null : String(v);
  }
  if (body.screenshot_data_url !== undefined) {
    const v = body.screenshot_data_url;
    if (!v) out.screenshot_data_url = null;
    else {
      const s = String(v);
      if (s.length > BUG_REPORT_DATA_URL_MAX) {
        const err = new Error('スクリーンショットが大きすぎます（8MB上限）');
        err.statusCode = 413;
        throw err;
      }
      if (!s.startsWith('data:image/')) {
        const err = new Error('スクリーンショットの形式が不正です');
        err.statusCode = 400;
        throw err;
      }
      out.screenshot_data_url = s;
    }
  }
  if (body.annotations !== undefined) out.annotations = body.annotations || null;
  if (body.browser_info !== undefined) out.browser_info = body.browser_info || null;
  if (body.improved !== undefined) out.__improved = !!body.improved;
  if (body.improvement_version_log_id !== undefined) {
    const v = body.improvement_version_log_id;
    out.improvement_version_log_id = (v === '' || v == null) ? null : String(v);
  }
  // duplicate_of_id は新規作成時のみ受け付け、以降は不変（親子関係を後から付け替えできない）
  if (isCreate && body.duplicate_of_id !== undefined) {
    const v = body.duplicate_of_id;
    out.duplicate_of_id = (v === '' || v == null) ? null : String(v);
  }
  if (isCreate) {
    out.is_anonymous = !!body.is_anonymous;
    if (!out.title) {
      const err = new Error('タイトルは必須です');
      err.statusCode = 400;
      throw err;
    }
  }
  // resolved_at はステータス遷移時に自動設定
  // improved_at / improved_by_user_id は PUT 内で __improved フラグを見て自動設定
  return out;
}

// POST /api/haruka/bug-reports - 新規バグ報告（誰でも可・匿名対応）
router.post('/bug-reports', requireAuth, express.json({ limit: '10mb' }), async (req, res) => {
  try {
    let payload;
    try { payload = normalizeBugReportPayload(req.body || {}, { isCreate: true }); }
    catch (e) { return res.status(e.statusCode || 400).json({ error: e.message }); }

    // 匿名なら reporter_user_id を一切記録しない
    const reporterUserId = payload.is_anonymous ? null : (req.user?.id || null);

    // 「これと同じです」で投稿された場合、duplicate_of_id を持って status='duplicate' で新規作成。
    // この場合 reporter のレコードは残るが、集計上はノーカウント扱いになる。
    const isDup = !!payload.duplicate_of_id;

    const insertRow = {
      reporter_user_id: reporterUserId,
      is_anonymous: !!payload.is_anonymous,
      title: payload.title,
      description: payload.description ?? null,
      url: payload.url ?? null,
      screen_label: payload.screen_label ?? null,
      severity: payload.severity || 'normal',
      is_urgent: !!payload.is_urgent,
      status: isDup ? 'duplicate' : 'open',
      assignee_user_id: payload.assignee_user_id ?? null,
      screenshot_data_url: payload.screenshot_data_url ?? null,
      annotations: payload.annotations ?? null,
      browser_info: payload.browser_info ?? null,
      duplicate_of_id: payload.duplicate_of_id ?? null,
    };

    const { data, error } = await supabase
      .from('bug_reports').insert(insertRow).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/haruka/bug-reports - 一覧（全員閲覧可）
router.get('/bug-reports', requireAuth, async (req, res) => {
  try {
    const { status, assignee_user_id, mine } = req.query;
    let q = supabase
      .from('bug_reports')
      .select('id, is_anonymous, title, description, url, screen_label, severity, is_urgent, status, assignee_user_id, created_at, updated_at, resolved_at, reporter_user_id, screenshot_data_url, improved_at, improved_by_user_id, improvement_version_log_id, triage_decision, triage_decided_at, triage_decided_by_user_id, last_updated_by_user_id, duplicate_of_id, reporter:reporter_user_id ( id, full_name, nickname, avatar_url ), assignee:assignee_user_id ( id, full_name, nickname, avatar_url ), improver:improved_by_user_id ( id, full_name, nickname, avatar_url ), improvement_log:improvement_version_log_id ( id, revision_no, screen, feature, description ), triage_decider:triage_decided_by_user_id ( id, full_name, nickname, avatar_url ), last_updater:last_updated_by_user_id ( id, full_name, nickname, avatar_url ), duplicate_parent:duplicate_of_id ( id, title, status )')
      .order('created_at', { ascending: false });
    if (status) q = q.eq('status', status);
    if (assignee_user_id) q = q.eq('assignee_user_id', assignee_user_id);
    if (mine === 'true' && req.user?.id) q = q.eq('reporter_user_id', req.user.id);
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    // 匿名報告は reporter 情報をマスク
    const sanitized = (data || []).map(r => {
      if (r.is_anonymous) {
        return { ...r, reporter_user_id: null, reporter: null };
      }
      return r;
    });
    res.json(sanitized);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/haruka/bug-reports/:id - 詳細（screenshot_data_url 含む）
router.get('/bug-reports/:id', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('bug_reports')
      .select('*, reporter:reporter_user_id ( id, full_name, nickname, avatar_url ), assignee:assignee_user_id ( id, full_name, nickname, avatar_url ), improver:improved_by_user_id ( id, full_name, nickname, avatar_url ), improvement_log:improvement_version_log_id ( id, revision_no, screen, feature, description ), triage_decider:triage_decided_by_user_id ( id, full_name, nickname, avatar_url ), last_updater:last_updated_by_user_id ( id, full_name, nickname, avatar_url ), duplicate_parent:duplicate_of_id ( id, title, status )')
      .eq('id', req.params.id)
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: 'not found' });
    if (data.is_anonymous) {
      data.reporter_user_id = null;
      data.reporter = null;
    }
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/haruka/bug-reports/:id - 更新（admin or assignee or 報告者本人）
router.put('/bug-reports/:id', requireAuth, express.json({ limit: '10mb' }), async (req, res) => {
  try {
    const { data: row, error: getErr } = await supabase
      .from('bug_reports').select('id, reporter_user_id, assignee_user_id, status, is_anonymous, improved_at').eq('id', req.params.id).maybeSingle();
    if (getErr) return res.status(500).json({ error: getErr.message });
    if (!row) return res.status(404).json({ error: 'not found' });

    const isAdmin = await requesterHasAnyRole(req, ['admin']);
    const isReporter = !row.is_anonymous && row.reporter_user_id && req.user?.id === row.reporter_user_id;
    const isAssignee = row.assignee_user_id && req.user?.id === row.assignee_user_id;
    if (!isAdmin && !isReporter && !isAssignee) {
      return res.status(403).json({ error: '編集権限がありません（報告者本人 or 対応者 or 管理者のみ）' });
    }

    let payload;
    try { payload = normalizeBugReportPayload(req.body || {}, { isCreate: false }); }
    catch (e) { return res.status(e.statusCode || 400).json({ error: e.message }); }

    // 改善済みチェックは admin のみ
    if (Object.prototype.hasOwnProperty.call(payload, '__improved')) {
      if (!isAdmin) {
        return res.status(403).json({ error: '改善済みチェックは管理者のみ可能です' });
      }
      const wantImproved = !!payload.__improved;
      delete payload.__improved;
      if (wantImproved) {
        // 既に improved 済みなら timestamp は触らない（ログ的に最初のチェック時刻を保持）
        if (!row.improved_at) {
          payload.improved_at = new Date().toISOString();
          payload.improved_by_user_id = req.user?.id || null;
        }
      } else {
        payload.improved_at = null;
        payload.improved_by_user_id = null;
        payload.improvement_version_log_id = null;
      }
    }

    payload.updated_at = new Date().toISOString();
    // 最終更新者を記録（reporter_user_id = 入力者は不変・上書きしない）
    payload.last_updated_by_user_id = req.user?.id || null;

    // ステータスが resolved に遷移したら resolved_at を自動セット
    if (payload.status && payload.status !== row.status) {
      if (payload.status === 'resolved' || payload.status === 'wont_fix') {
        payload.resolved_at = new Date().toISOString();
      } else {
        payload.resolved_at = null;
      }
    }

    const { data, error } = await supabase
      .from('bug_reports').update(payload).eq('id', req.params.id).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// バグ報告: 対応方針 (triage_decision) 更新
// ============================================================
// admin 専用。
//   body: { triage_decision: 'to_fix'|'hold'|'wont_fix', comment?: string }
// 副作用:
//   - bug_reports.triage_decision / triage_decided_at / triage_decided_by_user_id 更新
//   - status を方針に合わせて自動遷移:
//       'to_fix'   → status を in_progress に進める（既に resolved/wont_fix なら触らない）
//       'hold'     → status は open のまま
//       'wont_fix' → status を wont_fix に遷移、resolved_at を設定
//   - bug_report_comments に system 種別のコメントを自動 INSERT
//   - admin が任意でコメントも添えていれば、続けて comment 種別を INSERT
// ============================================================
router.patch('/bug-reports/:id/triage', requireAuth, express.json(), async (req, res) => {
  try {
    const isAdmin = await requesterHasAnyRole(req, ['admin']);
    if (!isAdmin) return res.status(403).json({ error: '管理者のみ対応方針を決定できます' });

    const { triage_decision, comment } = req.body || {};
    const allowed = ['to_fix', 'hold', 'wont_fix'];
    if (!allowed.includes(triage_decision)) {
      return res.status(400).json({ error: 'triage_decision は to_fix / hold / wont_fix のいずれか' });
    }

    const { data: row, error: getErr } = await supabase
      .from('bug_reports')
      .select('id, status, title, assignee_user_id, reporter_user_id, is_anonymous')
      .eq('id', req.params.id)
      .maybeSingle();
    if (getErr) return res.status(500).json({ error: getErr.message });
    if (!row) return res.status(404).json({ error: 'not found' });

    const nowIso = new Date().toISOString();
    const updates = {
      triage_decision,
      triage_decided_at: nowIso,
      triage_decided_by_user_id: req.user?.id || null,
      // 最終更新者も合わせて記録
      last_updated_by_user_id: req.user?.id || null,
      updated_at: nowIso,
    };

    // status の自動遷移ルール
    if (triage_decision === 'to_fix') {
      if (row.status === 'open') updates.status = 'in_progress';
    } else if (triage_decision === 'wont_fix') {
      updates.status = 'wont_fix';
      updates.resolved_at = nowIso;
    }
    // 'hold' は status を触らない

    const { error: updErr } = await supabase
      .from('bug_reports').update(updates).eq('id', req.params.id);
    if (updErr) return res.status(500).json({ error: updErr.message });

    // システムコメントの自動 INSERT
    const decisionLabel = { to_fix: '対応する', hold: '保留', wont_fix: '却下' }[triage_decision];
    const sysBody = `[対応方針: ${decisionLabel}]`;
    await supabase.from('bug_report_comments').insert({
      bug_report_id: req.params.id,
      author_user_id: req.user?.id || null,
      body: sysBody,
      kind: 'system',
    });

    // 任意の admin コメントが添えられていればさらに INSERT
    // ここで入る kind='comment' は「人が手で書いた本物のコメント」なので、
    // POST /comments と同じく報告者+入力者へ内部通知を飛ばす。
    // （直前の system コメントは通知対象外）
    const trimmed = (comment || '').trim();
    if (trimmed) {
      await supabase.from('bug_report_comments').insert({
        bug_report_id: req.params.id,
        author_user_id: req.user?.id || null,
        body: trimmed,
        kind: 'comment',
      });
      await _notifyBugReportComment(row, trimmed, req.user);
    }

    res.json({ ok: true, triage_decision, status: updates.status || row.status });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// バグ報告: コメント GET / POST
// ============================================================
// 全員投稿可（つぶやき的な議論場所）。system 種別もそのまま返す。
// ============================================================
router.get('/bug-reports/:id/comments', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('bug_report_comments')
      .select('id, bug_report_id, author_user_id, body, kind, created_at, author:author_user_id ( id, full_name, nickname, avatar_url )')
      .eq('bug_report_id', req.params.id)
      .order('created_at', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/bug-reports/:id/comments', requireAuth, express.json(), async (req, res) => {
  try {
    const body = (req.body?.body || '').trim();
    if (!body) return res.status(400).json({ error: '本文は必須です' });
    if (body.length > 2000) return res.status(400).json({ error: '本文は2000文字以内' });

    // 親レコード存在チェック（通知のため title / 報告者情報も一緒に取得）
    const { data: parent, error: pErr } = await supabase
      .from('bug_reports')
      .select('id, title, assignee_user_id, reporter_user_id, is_anonymous')
      .eq('id', req.params.id)
      .maybeSingle();
    if (pErr) return res.status(500).json({ error: pErr.message });
    if (!parent) return res.status(404).json({ error: 'バグ報告が見つかりません' });

    const { data, error } = await supabase
      .from('bug_report_comments')
      .insert({
        bug_report_id: req.params.id,
        author_user_id: req.user?.id || null,
        body,
        kind: 'comment',
      })
      .select('id, bug_report_id, author_user_id, body, kind, created_at, author:author_user_id ( id, full_name, nickname, avatar_url )')
      .single();
    if (error) return res.status(500).json({ error: error.message });

    // 内部通知（🔔 ベル）を発火（system kind は呼び出し元で除外）
    await _notifyBugReportComment(parent, body, req.user);

    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// バグ報告のコメント投稿時に「報告者」と「入力者」へ内部通知を飛ばす共通ヘルパー
//   parent: bug_reports の id, title, assignee_user_id, reporter_user_id, is_anonymous を含む行
//   body:   コメント本文
//   actor:  req.user（投稿者本人。本人には通知しない）
// system kind のコメントには使わない（呼び出し側で分岐）
async function _notifyBugReportComment(parent, body, actor) {
  if (!parent || !body) return;
  try {
    const commenterId = actor?.id || null;
    const targetIds = new Set();
    if (parent.assignee_user_id && parent.assignee_user_id !== commenterId) {
      targetIds.add(parent.assignee_user_id);
    }
    if (!parent.is_anonymous && parent.reporter_user_id && parent.reporter_user_id !== commenterId) {
      targetIds.add(parent.reporter_user_id);
    }
    if (targetIds.size === 0) return;
    const commenterLabel = actor?.nickname || actor?.full_name || '誰か';
    const titleShort = (parent.title || '').slice(0, 40);
    const bodySnippet = body.length > 80 ? `${body.slice(0, 80)}…` : body;
    const linkUrl = `/haruka.html?bug-report=${encodeURIComponent(parent.id)}`;
    for (const targetId of targetIds) {
      await createNotification({
        userId: targetId,
        type: 'global',
        title: `💬 バグ報告にコメント: ${titleShort}`,
        body: `${commenterLabel}: ${bodySnippet}`,
        linkUrl,
        senderId: commenterId,
        meta: { bug_report_id: parent.id, kind: 'bug_report_comment' },
      });
    }
  } catch (notifErr) {
    console.error('[bug-comments notify失敗（投稿は成功扱い）]', notifErr.message);
  }
}

// PATCH /api/haruka/bug-report-comments/:commentId
// 編集権限: 投稿者本人 or admin
// system kind は編集不可（運用ログとして immutable）
router.patch('/bug-report-comments/:commentId', requireAuth, express.json(), async (req, res) => {
  try {
    const body = (req.body?.body || '').trim();
    if (!body) return res.status(400).json({ error: '本文は必須です' });
    if (body.length > 2000) return res.status(400).json({ error: '本文は2000文字以内' });

    const { data: row, error: getErr } = await supabase
      .from('bug_report_comments')
      .select('id, author_user_id, kind')
      .eq('id', req.params.commentId)
      .maybeSingle();
    if (getErr) return res.status(500).json({ error: getErr.message });
    if (!row) return res.status(404).json({ error: 'コメントが見つかりません' });
    if (row.kind === 'system') return res.status(403).json({ error: 'システムコメントは編集できません' });

    const isAdmin = await requesterHasAnyRole(req, ['admin']);
    const isAuthor = row.author_user_id && req.user?.id === row.author_user_id;
    if (!isAdmin && !isAuthor) return res.status(403).json({ error: '編集権限がありません（投稿者または管理者のみ）' });

    const { data, error } = await supabase
      .from('bug_report_comments')
      .update({ body })
      .eq('id', req.params.commentId)
      .select('id, bug_report_id, author_user_id, body, kind, created_at, author:author_user_id ( id, full_name, nickname, avatar_url )')
      .single();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/haruka/bug-report-comments/:commentId
// 削除権限: 投稿者本人 or admin
// system kind は削除不可
router.delete('/bug-report-comments/:commentId', requireAuth, async (req, res) => {
  try {
    const { data: row, error: getErr } = await supabase
      .from('bug_report_comments')
      .select('id, author_user_id, kind')
      .eq('id', req.params.commentId)
      .maybeSingle();
    if (getErr) return res.status(500).json({ error: getErr.message });
    if (!row) return res.status(404).json({ error: 'コメントが見つかりません' });
    if (row.kind === 'system') return res.status(403).json({ error: 'システムコメントは削除できません' });

    const isAdmin = await requesterHasAnyRole(req, ['admin']);
    const isAuthor = row.author_user_id && req.user?.id === row.author_user_id;
    if (!isAdmin && !isAuthor) return res.status(403).json({ error: '削除権限がありません（投稿者または管理者のみ）' });

    const { error } = await supabase
      .from('bug_report_comments')
      .delete()
      .eq('id', req.params.commentId);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/haruka/bug-reports/:id - 削除（admin のみ）
router.delete('/bug-reports/:id', requireAuth, async (req, res) => {
  try {
    const isAdmin = await requesterHasAnyRole(req, ['admin']);
    if (!isAdmin) return res.status(403).json({ error: '管理者のみ削除できます' });
    const { error } = await supabase.from('bug_reports').delete().eq('id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// router を主エクスポートにしつつ、ヘルパー関数も同じ object 経由で取り出せるようにする
// 用途:
//   const harukaRouter = require('./routes/haruka');                 // ルーター本体
//   const { syncBallHolderId, getBallHolder } = require('./routes/haruka'); // ヘルパー
router.syncBallHolderId = syncBallHolderId;
router.getBallHolder    = getBallHolder;
module.exports = router;
