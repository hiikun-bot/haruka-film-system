// routes/haruka.js — HARUKA FILM SYSTEM API
const express = require('express');
const router = express.Router();
const supabase = require('../supabase');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const { requireAuth, requireRole, requireLevel, requirePermission, requireSuperAdmin, userHasPermission, getEffectiveRole, invalidatePermissionsCache } = require('../auth');
const { google } = require('googleapis');
const { Readable } = require('stream');
const { createSheetWithData, extractSpreadsheetId, readSheetData } = require('../sheets');
const { generateFaststart, isVideoCandidate: faststartIsVideoCandidate, isEnabled: faststartIsEnabled } = require('../lib/faststart');
const { shareForClientReview } = require('../lib/drive-share');

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
  const { name, client_code, note, sales_start_date, status, persona, slack_channel_url, chatwork_room_id } = req.body;
  if (!name) return res.status(400).json({ error: 'クライアント名は必須です' });
  const code = client_code ? client_code.toUpperCase().slice(0, 3) : null;
  const insertData = { name, client_code: code, note, sales_start_date: sales_start_date || null, status: status || '提案中', persona: persona || null };
  if (slack_channel_url !== undefined) insertData.slack_channel_url = slack_channel_url || null;
  if (chatwork_room_id !== undefined) insertData.chatwork_room_id = chatwork_room_id || null;
  LINK_FIELDS.forEach(f => { if (req.body[f] !== undefined) insertData[f] = req.body[f] || null; });
  const { data, error } = await supabase
    .from('clients')
    .insert(insertData)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  if (data && req.body.team_ids !== undefined) {
    await syncClientTeams(data.id, req.body.team_ids);
  }
  res.json({ ...data, team_ids: Array.isArray(req.body.team_ids) ? req.body.team_ids : [] });
});

// クライアント更新
router.put('/clients/:id', requireAuth, requirePermission('project.create_edit'), async (req, res) => {
  const { name, client_code, note, sales_start_date, status, persona, slack_channel_url, chatwork_room_id } = req.body;
  const code = client_code ? client_code.toUpperCase().slice(0, 3) : null;
  const updateData = { name, client_code: code, note, sales_start_date: sales_start_date || null, status: status || '提案中', persona: persona || null, updated_at: new Date().toISOString() };
  if (slack_channel_url !== undefined) updateData.slack_channel_url = slack_channel_url || null;
  if (chatwork_room_id !== undefined) updateData.chatwork_room_id = chatwork_room_id || null;
  LINK_FIELDS.forEach(f => { if (req.body[f] !== undefined) updateData[f] = req.body[f] || null; });
  const { data, error } = await supabase
    .from('clients')
    .update(updateData)
    .eq('id', req.params.id)
    .select()
    .single();
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

// 案件一覧取得
// has_rates / has_estimates は「単価設定済み」「見積作成済み」の判定フラグ。
// UI 側で「単価」「見積」ボタンに設定済みかどうかを示すために返す。
router.get('/projects', async (req, res) => {
  const { data, error } = await supabase
    .from('projects')
    .select(`
      *,
      clients(id, name),
      producer:users!projects_producer_id_fkey(id, full_name),
      director:users!projects_director_id_fkey(id, full_name)
    `)
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });

  // 単価／見積の設定有無を一括取得（DISTINCT project_id をクライアント側でセット化）
  const [ratesRes, estRes] = await Promise.all([
    supabase.from('project_rates').select('project_id'),
    supabase.from('project_estimates').select('project_id'),
  ]);
  const ratesSet = new Set((ratesRes.data || []).map(r => r.project_id));
  const estSet   = new Set((estRes.data   || []).map(r => r.project_id));

  const enriched = (data || []).map(p => ({
    ...p,
    has_rates: ratesSet.has(p.id),
    has_estimates: estSet.has(p.id),
  }));
  res.json(enriched);
});

// 案件詳細取得
router.get('/projects/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('projects')
    .select(`
      *,
      clients(id, name),
      producer:users!projects_producer_id_fkey(id, full_name),
      director:users!projects_director_id_fkey(id, full_name),
      project_rates(*),
      director_rates(*)
    `)
    .eq('id', req.params.id)
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// 案件作成
router.post('/projects', requireAuth, requirePermission('project.create_edit'), async (req, res) => {
  const {
    client_id, name, status, producer_id, director_id,
    sheet_url, regulation_url, admin_note, start_date, end_date,
    chatwork_room_id,
    slack_channel_url,
    deadline_unit, deadline_weekday,
    project_type
  } = req.body;
  if (!client_id || !name) return res.status(400).json({ error: 'クライアントと案件名は必須です' });
  const normalizedProjectType = (project_type === 'design') ? 'design' : 'video';
  const { data, error } = await supabase
    .from('projects')
    .insert({
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
      project_type: normalizedProjectType
    })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
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
    project_type
  } = req.body;
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
  if (project_type !== undefined) {
    updateData.project_type = (project_type === 'design') ? 'design' : 'video';
  }
  const { data, error } = await supabase
    .from('projects')
    .update(updateData)
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
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

// ==================== 単価設定 ====================

const RATE_CREATIVE_TYPES = new Set(['video', 'design']);
const RATE_RANKS = new Set(['A', 'B', 'C']);
function normalizeRateCreativeType(type) {
  if (typeof type !== 'string') return '';
  const normalized = type.trim().toLowerCase();
  if (normalized.startsWith('video')) return 'video';
  if (normalized.startsWith('design')) return 'design';
  return normalized;
}

// 単価一覧取得
router.get('/projects/:id/rates', async (req, res) => {
  const { data, error } = await supabase
    .from('project_rates')
    .select('*')
    .eq('project_id', req.params.id)
    .order('creative_type')
    .order('rank');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// 単価一括保存
router.post('/projects/:id/rates/bulk', requireAuth, requirePermission('project.unit_price_view'), async (req, res) => {
  const projectId = req.params.id;
  const { rates } = req.body;
  if (!rates || !rates.length) return res.json([]);
  const rows = rates.map(r => ({
    project_id: projectId,
    creative_type: normalizeRateCreativeType(r.creative_type),
    rank: r.rank,
    base_fee: r.base_fee || 0,
    script_fee: r.script_fee || 0,
    ai_fee: r.ai_fee || 0,
    other_fee: 0,
    updated_at: new Date().toISOString()
  }));
  const invalid = rows.find(r => !RATE_CREATIVE_TYPES.has(r.creative_type) || !RATE_RANKS.has(r.rank));
  if (invalid) {
    return res.status(400).json({ error: '単価種別は video / design、ランクは A / B / C で保存してください' });
  }
  const { data, error } = await supabase
    .from('project_rates')
    .upsert(rows, { onConflict: 'project_id,creative_type,rank' })
    .select();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// 単価設定・更新（個別upsert、後方互換）
router.post('/projects/:id/rates', requireAuth, requirePermission('project.unit_price_view'), async (req, res) => {
  const { rank, base_fee, script_fee, ai_fee, other_fee, other_fee_note } = req.body;
  const creative_type = normalizeRateCreativeType(req.body.creative_type);
  if (!creative_type || !rank) return res.status(400).json({ error: '種別・ランクは必須です' });
  if (!RATE_CREATIVE_TYPES.has(creative_type)) {
    return res.status(400).json({ error: '単価種別は video / design で保存してください' });
  }
  if (!RATE_RANKS.has(rank)) {
    return res.status(400).json({ error: '単価ランクは A / B / C で保存してください' });
  }
  const { data: existing } = await supabase
    .from('project_rates')
    .select('id')
    .eq('project_id', req.params.id)
    .eq('creative_type', creative_type)
    .eq('rank', rank)
    .maybeSingle();
  let query;
  if (existing) {
    query = supabase.from('project_rates')
      .update({ base_fee: base_fee || 0, script_fee: script_fee || 0, ai_fee: ai_fee || 0, other_fee: other_fee || 0, other_fee_note, updated_at: new Date().toISOString() })
      .eq('id', existing.id).select().single();
  } else {
    query = supabase.from('project_rates')
      .insert({ project_id: req.params.id, creative_type, rank, base_fee: base_fee || 0, script_fee: script_fee || 0, ai_fee: ai_fee || 0, other_fee: other_fee || 0, other_fee_note, updated_at: new Date().toISOString() })
      .select().single();
  }
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// その他単価一覧
router.get('/projects/:id/rate-extras', async (req, res) => {
  const { data, error } = await supabase
    .from('project_rate_extras')
    .select('*')
    .eq('project_id', req.params.id)
    .order('created_at');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// その他単価一括保存（全削除→再挿入）
router.post('/projects/:id/rate-extras', async (req, res) => {
  const { extras } = req.body;
  const projectId = req.params.id;
  const { error: delError } = await supabase
    .from('project_rate_extras')
    .delete()
    .eq('project_id', projectId);
  if (delError) return res.status(500).json({ error: delError.message });
  if (!extras || !extras.length) return res.json([]);
  const rows = extras.map(e => ({
    project_id: projectId,
    creative_type: e.creative_type,
    name: e.name,
    fee: e.fee || 0
  }));
  const { data, error } = await supabase
    .from('project_rate_extras')
    .insert(rows)
    .select();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// クライアント報酬設定 取得
router.get('/projects/:id/client-fee', async (req, res) => {
  const { data, error } = await supabase
    .from('project_client_fees')
    .select('*')
    .eq('project_id', req.params.id)
    .single();
  if (error && error.code !== 'PGRST116') return res.status(500).json({ error: error.message });
  res.json(data || null);
});

// クライアント報酬設定 保存（upsert）- スーパーアドミンのみ
router.post('/projects/:id/client-fee', async (req, res) => {
  const SUPER_ADMIN_EMAILS = ['hiikun.ascs@gmail.com', 'satoru.takahashi@haruka-film.com'];
  if (!SUPER_ADMIN_EMAILS.includes(req.user?.email)) {
    return res.status(403).json({ error: '報酬設定の変更は最高管理者のみ可能です' });
  }
  const { video_unit_price, design_unit_price, fixed_budget, use_fixed_budget, note } = req.body;
  const { data, error } = await supabase
    .from('project_client_fees')
    .upsert({
      project_id: req.params.id,
      video_unit_price: video_unit_price || 0,
      design_unit_price: design_unit_price || 0,
      fixed_budget: fixed_budget || null,
      use_fixed_budget: use_fixed_budget || false,
      note: note || null,
      updated_at: new Date().toISOString()
    }, { onConflict: 'project_id' })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ダッシュボード用：今月の案件売上サマリー
router.get('/dashboard/revenue-summary', async (req, res) => {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59).toISOString();

  // 今月納期のクリエイティブを取得
  const { data: creatives, error: cErr } = await supabase
    .from('creatives')
    .select('id, project_id, status, creative_type, final_deadline')
    .gte('final_deadline', startOfMonth)
    .lte('final_deadline', endOfMonth);
  if (cErr) return res.status(500).json({ error: cErr.message });

  // クライアント報酬設定を取得
  const projectIds = [...new Set((creatives || []).map(c => c.project_id))];
  let fees = [];
  if (projectIds.length) {
    const { data: feeData } = await supabase
      .from('project_client_fees')
      .select('*')
      .in('project_id', projectIds);
    fees = feeData || [];
  }

  // 集計
  const feeMap = {};
  fees.forEach(f => { feeMap[f.project_id] = f; });

  let plannedRevenue = 0;
  let actualRevenue = 0;
  let totalCreatives = 0;
  let completedCreatives = 0;

  (creatives || []).forEach(c => {
    const fee = feeMap[c.project_id];
    if (!fee) return;
    const unitPrice = c.creative_type === 'design' ? fee.design_unit_price : fee.video_unit_price;
    const price = fee.use_fixed_budget ? 0 : (unitPrice || 0); // 固定予算は別途集計
    totalCreatives++;
    plannedRevenue += price;
    if (c.status === '納品') {
      completedCreatives++;
      actualRevenue += price;
    }
  });

  // 固定予算案件の集計（重複カウント防止）
  const fixedProjects = fees.filter(f => f.use_fixed_budget && f.fixed_budget);
  fixedProjects.forEach(f => {
    plannedRevenue += f.fixed_budget;
    const projectCreatives = (creatives || []).filter(c => c.project_id === f.project_id);
    const allDone = projectCreatives.length > 0 && projectCreatives.every(c => c.status === '納品');
    if (allDone) actualRevenue += f.fixed_budget;
  });

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

// 月次売上・粗利ダッシュボード
//
// 売上(確定): invoice_type='client' の当月 invoices.total_amount 合計
// 売上(見込み): 当月納期で未納品 creatives × project_client_fees の単価
// 原価(確定): スタッフ請求書（invoice_type が NULL）の当月 total_amount 合計
// 原価(見込み): 当月納期で未納品 creatives × project_rates の rank別単価合計
async function aggregateMonthlyRevenue({ year, month }) {
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

  // 見込み: 当月納期で未納品 creatives
  const { data: forecastCreatives } = await supabase
    .from('creatives')
    .select(`
      id, status, creative_type, project_id, final_deadline,
      projects!inner(id, client_id, clients(id, name)),
      creative_assignments(role, rank_applied, users(id, rank))
    `)
    .gte('final_deadline', startDate.toISOString())
    .lt('final_deadline', endDate.toISOString())
    .neq('status', '納品');

  const fcProjectIds = Array.from(new Set((forecastCreatives || []).map(c => c.project_id).filter(Boolean)));
  const clientFeeByProject = new Map();
  const ratesByProject = new Map();
  if (fcProjectIds.length) {
    const [{ data: fees }, { data: rates }] = await Promise.all([
      supabase.from('project_client_fees').select('*').in('project_id', fcProjectIds),
      supabase.from('project_rates').select('*').in('project_id', fcProjectIds),
    ]);
    (fees || []).forEach(f => clientFeeByProject.set(f.project_id, f));
    (rates || []).forEach(r => {
      if (!ratesByProject.has(r.project_id)) ratesByProject.set(r.project_id, []);
      ratesByProject.get(r.project_id).push(r);
    });
  }
  const findRate = (pid, baseType, rank) => {
    const list = ratesByProject.get(pid) || [];
    return list.find(r => r.creative_type === baseType && r.rank === rank)
        || list.find(r => r.creative_type === baseType) || null;
  };
  const calcRateAmount = (rate) => rate ? ((rate.base_fee||0)+(rate.script_fee||0)+(rate.ai_fee||0)+(rate.other_fee||0)) : 0;

  let forecastRevenue = 0, forecastCost = 0;
  for (const c of (forecastCreatives || [])) {
    const baseType = c.creative_type?.startsWith('video') ? 'video'
                   : c.creative_type?.startsWith('design') ? 'design' : 'video';
    const fee = clientFeeByProject.get(c.project_id);
    const unitClient = (fee && !fee.use_fixed_budget)
      ? (baseType === 'video' ? (fee.video_unit_price || 0) : (fee.design_unit_price || 0))
      : 0;
    forecastRevenue += unitClient;
    if (c.projects?.client_id) ensureClient(c.projects.client_id, c.projects?.clients?.name).forecast_revenue += unitClient;

    const assignees = (c.creative_assignments || [])
      .filter(a => a.users && ['editor','designer','director_as_editor'].includes(a.role));
    let costForCreative = 0;
    for (const a of assignees) {
      const rank = a.rank_applied || a.users?.rank || null;
      costForCreative += calcRateAmount(findRate(c.project_id, baseType, rank));
    }
    forecastCost += costForCreative;
    if (c.projects?.client_id) ensureClient(c.projects.client_id, c.projects?.clients?.name).forecast_cost += costForCreative;
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

// クリエイター別作成本数 + 単価 + 合計金額の集計
// 1 creative の単価 = project_rates(project_id, creative_type, rank).{base_fee+script_fee+ai_fee+other_fee}
// 同一クリエイティブに複数担当者がいる場合、それぞれ「フルカウント」する（既存の project×assignee ビューと整合）
async function aggregateCreatorSummary({ year, month, statusFilter }) {
  const startDate = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0));
  const endDate   = new Date(Date.UTC(year, month, 1, 0, 0, 0));
  const dateColForFilter = statusFilter === 'delivered' ? 'final_deadline' : 'created_at';

  let q = supabase
    .from('creatives')
    .select(`
      id, file_name, status, creative_type, project_id,
      final_deadline, created_at,
      projects!inner(id, name, client_id, clients(id, name)),
      creative_assignments(role, rank_applied, users(id, full_name, nickname, role, rank))
    `)
    .gte(dateColForFilter, startDate.toISOString())
    .lt(dateColForFilter, endDate.toISOString());
  if (statusFilter === 'delivered') q = q.eq('status', '納品');

  const { data: creatives, error } = await q;
  if (error) throw new Error(error.message);

  // 関連 project_rates をまとめて取得（in クエリ）
  const projectIds = Array.from(new Set((creatives || []).map(c => c.project_id).filter(Boolean)));
  let ratesByProject = new Map();
  if (projectIds.length > 0) {
    const { data: rates } = await supabase
      .from('project_rates').select('*').in('project_id', projectIds);
    for (const r of (rates || [])) {
      if (!ratesByProject.has(r.project_id)) ratesByProject.set(r.project_id, []);
      ratesByProject.get(r.project_id).push(r);
    }
  }
  const findRate = (projectId, baseType, rank) => {
    const list = ratesByProject.get(projectId) || [];
    return list.find(r => r.creative_type === baseType && r.rank === rank)
        || list.find(r => r.creative_type === baseType)
        || null;
  };
  const calcUnitPrice = (rate) => {
    if (!rate) return 0;
    return (rate.base_fee || 0) + (rate.script_fee || 0) + (rate.ai_fee || 0) + (rate.other_fee || 0);
  };

  // ユーザーごとに集計
  const userMap = new Map(); // user_id -> aggregate
  const ensureUser = (u) => {
    if (!userMap.has(u.id)) {
      userMap.set(u.id, {
        id: u.id,
        full_name: u.full_name || '(不明)',
        nickname: u.nickname || null,
        role: u.role || '-',
        rank: u.rank || null,
        video_count: 0,
        design_count: 0,
        video_total: 0,
        design_total: 0,
        grand_total: 0,
        rate_unknown_count: 0, // 単価不明として扱った件数（参考表示用）
      });
    }
    return userMap.get(u.id);
  };

  for (const c of (creatives || [])) {
    const baseType = c.creative_type?.startsWith('video') ? 'video'
                   : c.creative_type?.startsWith('design') ? 'design'
                   : (c.creative_type || 'video');
    const isVideo = baseType === 'video';
    const assignees = (c.creative_assignments || [])
      .filter(a => a.users && ['editor','designer','director_as_editor'].includes(a.role));
    if (assignees.length === 0) continue;
    for (const a of assignees) {
      const user = ensureUser(a.users);
      const rank = a.rank_applied || a.users?.rank || null;
      const rate = findRate(c.project_id, baseType, rank);
      const unitPrice = calcUnitPrice(rate);
      if (isVideo) { user.video_count++; user.video_total += unitPrice; }
      else         { user.design_count++; user.design_total += unitPrice; }
      user.grand_total += unitPrice;
      if (!rate) user.rate_unknown_count++;
    }
  }

  const summary = Array.from(userMap.values())
    .sort((a, b) => b.grand_total - a.grand_total
      || (b.video_count + b.design_count) - (a.video_count + a.design_count)
      || (a.full_name || '').localeCompare(b.full_name || '', 'ja'));

  const total = summary.reduce((acc, u) => {
    acc.video_count += u.video_count;
    acc.design_count += u.design_count;
    acc.video_total  += u.video_total;
    acc.design_total += u.design_total;
    acc.grand_total  += u.grand_total;
    return acc;
  }, { video_count: 0, design_count: 0, video_total: 0, design_total: 0, grand_total: 0 });

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
    const headers = ['クリエイター', '役割', 'ランク', '動画本数', '動画金額', 'デザイン枚数', 'デザイン金額', '合計金額'];
    const dataRows = data.summary.map(u => [
      u.full_name + (u.nickname ? ` (${u.nickname})` : ''),
      u.role || '-',
      u.rank || '-',
      u.video_count,
      u.video_total,
      u.design_count,
      u.design_total,
      u.grand_total,
    ]);
    const totalRow = ['合計', '', '',
      data.total.video_count, data.total.video_total,
      data.total.design_count, data.total.design_total,
      data.total.grand_total];
    const sheetRows = [
      [`HARUKA FILM 分析: クリエイター別作成本数 (${year}年${month}月 / ${statusLabel})`],
      [`動画合計 ${data.total.video_count}本 / デザイン合計 ${data.total.design_count}枚 / 合計金額 ¥${data.total.grand_total.toLocaleString()}`],
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

// ==================== クリエイティブ ====================

// クリエイティブ一覧取得
// 一覧専用の軽量レスポンス: 必要列のみ select し、limit/offset/各種フィルタを DB 側で適用
// レスポンス: { data, total, limit, offset }
router.get('/creatives', async (req, res) => {
  const {
    project_id, cycle_id, status, ball_holder,
    client_id, assignee_id, q, include_done,
  } = req.query;

  // ページング (default 50 / max 200)
  const limit  = Math.min(Math.max(parseInt(req.query.limit, 10)  || 50, 1), 200);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

  // assignee_id フィルタは PostgREST の埋め込み JOIN で絞り込めないので、
  // 先に creative_assignments から該当 creative_id 集合を取得し .in() で絞る
  let assigneeCreativeIds = null;
  if (assignee_id) {
    const { data: caRows, error: caErr } = await supabase
      .from('creative_assignments')
      .select('creative_id')
      .eq('user_id', assignee_id);
    if (caErr) return res.status(500).json({ error: caErr.message });
    assigneeCreativeIds = Array.from(new Set((caRows || []).map(r => r.creative_id))).filter(Boolean);
    // ヒット 0 件なら以降の本体クエリ自体スキップ
    if (assigneeCreativeIds.length === 0) {
      return res.json({ data: [], total: 0, limit, offset });
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
    creative_type, team_id, project_id, updated_at${includeOptional ? ',\n    ' + OPTIONAL_COLS.join(', ') : ''},
    ${projectsRel}(id, name, client_id, producer_id, director_id, sheet_url, regulation_url, clients(id, name, status)),
    project_cycles(id, year, month),
    creative_assignments(
      id, role, rank_applied,
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

// クリエイティブ単体取得
router.get('/creatives/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('creatives')
    .select(`
      *,
      projects(id, name, producer_id, director_id, regulation_url, clients(id, name, client_code, status)),
      project_cycles(id, year, month),
      creative_assignments(
        id, role, rank_applied,
        users(id, full_name, nickname, role, team_id, avatar_url)
      )
    `)
    .eq('id', req.params.id)
    .single();
  if (error) return res.status(500).json({ error: error.message });

  // teams を別クエリで取得（FK 不要にするため PostgREST の埋め込みは使わない）
  if (data && data.team_id) {
    const { data: teamData } = await supabase
      .from('teams')
      .select('id, team_code, team_name')
      .eq('id', data.team_id)
      .maybeSingle();
    data.teams = teamData || null;
  } else if (data) {
    data.teams = null;
  }

  res.json(data);
});

// 一括登録プレビュー（DBには保存しない）
router.post('/creatives/bulk-preview', async (req, res) => {
  const { project_id, creative_type, appeal_type_id, count, draft_deadline, final_deadline,
          product_code, media_code, creative_fmt, creative_size } = req.body;
  // 訴求軸（appeal_type_id）は任意化: 未確定状態でもプレビュー可（ファイル名は空欄部分を詰めて生成される）
  if (!project_id || !creative_type || !count) {
    return res.status(400).json({ error: '案件・種別・本数は必須です' });
  }
  const { data: project } = await supabase
    .from('projects').select('*, clients(id, name, client_code)').eq('id', project_id).single();
  let appealType = null;
  if (appeal_type_id) {
    const { data: at } = await supabase
      .from('client_appeal_axes').select('*').eq('id', appeal_type_id).single();
    appealType = at;
  }
  if (!project) return res.status(400).json({ error: '案件が見つかりません' });
  if (appeal_type_id && !appealType) return res.status(400).json({ error: '訴求軸が見つかりません' });

  const { data: existingCreatives } = await supabase
    .from('creatives').select('internal_code, file_name, appeal_type_id').eq('project_id', project_id);
  const usedSeqs = (existingCreatives || []).map(c => {
    if (c.internal_code) { const m = c.internal_code.match(/^(\d{3})_/); if (m) return Number(m[1]); }
    const fn = c.file_name || '';
    const m7 = fn.match(/_(\d{7})$/); if (m7) return Number(m7[1]);
    const m3 = fn.match(/^(\d{3})_/); return m3 ? Number(m3[1]) : null;
  }).filter(n => n !== null);

  const today = new Date();
  const dateStr = `${String(today.getFullYear()).slice(2)}${String(today.getMonth()+1).padStart(2,'0')}${String(today.getDate()).padStart(2,'0')}`;

  const previews = [];
  let nextSeq = 1;
  for (let i = 0; i < count; i++) {
    while (usedSeqs.includes(nextSeq)) nextSeq++;
    const seqStr7 = String(nextSeq).padStart(7, '0');
    const appealCode = appealType ? appealType.code : '';
    const parts = [dateStr, product_code, media_code, creative_fmt, appealCode, creative_size, seqStr7]
      .map(p => (p||'').toString().trim()).filter(Boolean);
    const fileName = parts.join('_');
    previews.push({ file_name: fileName, draft_deadline: draft_deadline || null, final_deadline: final_deadline || null });
    usedSeqs.push(nextSeq);
    nextSeq++;
  }
  res.json({ previews });
});

// クリエイティブ作成
// 一括登録
router.post('/creatives/bulk', async (req, res) => {
  const {
    project_id, creative_type, appeal_type_id,
    count, draft_deadline, final_deadline, note,
    product_id, product_code, media_code, creative_fmt, creative_size,
    assignee_id, team_id
  } = req.body;
  // 訴求軸（appeal_type_id）は任意化: 未確定状態でも一括登録できるようにする
  if (!project_id || !creative_type || !count) {
    return res.status(400).json({ error: '案件・種別・本数は必須です' });
  }
  if (count < 1 || count > 100) {
    return res.status(400).json({ error: '本数は1〜100の間で指定してください' });
  }
  const { data: project } = await supabase
    .from('projects').select('*, clients(id, name, client_code)').eq('id', project_id).single();
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
  const { data: existingCreatives } = await supabase
    .from('creatives').select('internal_code, file_name, appeal_type_id').eq('project_id', project_id);
  const usedSeqs = (existingCreatives || []).map(c => {
    if (c.internal_code) { const m = c.internal_code.match(/^(\d{3})_/); if (m) return Number(m[1]); }
    const fn = c.file_name || '';
    const m7 = fn.match(/_(\d{7})$/); if (m7) return Number(m7[1]);
    const m3 = fn.match(/^(\d{3})_/); return m3 ? Number(m3[1]) : null;
  }).filter(n => n !== null);

  const today = new Date();
  const dateStr = `${String(today.getFullYear()).slice(2)}${String(today.getMonth()+1).padStart(2,'0')}${String(today.getDate()).padStart(2,'0')}`;

  const inserts = [];
  let nextSeq = 1;
  for (let i = 0; i < count; i++) {
    while (usedSeqs.includes(nextSeq)) nextSeq++;
    const seqStr7 = String(nextSeq).padStart(7, '0');
    const appealCode = appealType ? appealType.code : '';
    const parts = [dateStr, product_code, media_code, creative_fmt, appealCode, creative_size, seqStr7]
      .map(p => (p||'').toString().trim()).filter(Boolean);
    const fileName = parts.join('_');
    const insert = { project_id, file_name: fileName, creative_type,
      appeal_type_id: appeal_type_id || null,
      draft_deadline: draft_deadline || null, final_deadline: final_deadline || null,
      note: note || null, status: '未着手',
      product_id: product_id || null, media_code: media_code || null,
      creative_fmt: creative_fmt || null, creative_size: creative_size || null,
      team_id: team_id || null };
    inserts.push(insert);
    usedSeqs.push(nextSeq);
    nextSeq++;
  }
  const { data, error } = await supabase.from('creatives').insert(inserts).select();
  if (error) return res.status(500).json({ error: error.message });
  await supabase.from('projects').update({ seq_counter: Math.max(...usedSeqs) }).eq('id', project_id);
  res.json({ ok: true, count: data.length, creatives: data });
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

  const { data, error } = await supabase.from('creatives').insert({
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
  }).select().single();
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
    force_delivered_reason
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
  if (director_comment !== undefined) updateData.director_comment = director_comment;
  if (client_comment !== undefined) updateData.client_comment = client_comment;
  if (editor_comment !== undefined) updateData.editor_comment = editor_comment;
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

  // ステータス変更を検知するため、更新前の値を取得
  let beforeStatus = null;
  if (updateData.status !== undefined) {
    const { data: before } = await supabase
      .from('creatives').select('status').eq('id', req.params.id).maybeSingle();
    beforeStatus = before?.status || null;
  }

  const { data, error } = await supabase
    .from('creatives')
    .update(updateData)
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });

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

  // ball_holder_id キャッシュ更新（status または assignee が変わった場合のみ）
  // 派生計算を実列にUPDATEして notify_ball_returned トリガーで通知が発火する。
  if (updateData.status !== undefined || assignee_id !== undefined) {
    syncBallHolderId(req.params.id).catch(e => console.warn('[ball_holder_id] sync failed:', e.message));
  }

  res.json(data);
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

  const { data: creative, error: cErr } = await supabase
    .from('creatives').select('id, status').eq('id', req.params.id).maybeSingle();
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
  const { data, error } = await supabase
    .from('creative_files')
    .select('*')
    .eq('creative_id', req.params.id)
    .order('uploaded_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ファイルアップロード（Google Drive）
router.post('/creatives/:id/upload', upload.single('file'), async (req, res) => {
  const creativeId = req.params.id;
  const { width, height, generated_name } = req.body;
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'ファイルが選択されていません' });

  // バージョン採番: フロントから明示的に有効な version が指定されない場合、
  // 既存 creative_files の MAX(version) + 1 を採番する（既存ファイル削除や手動編集でズレるのを防ぐ）
  let version = parseInt(req.body.version, 10);
  if (!version || version < 1) {
    const { data: maxRow } = await supabase
      .from('creative_files')
      .select('version')
      .eq('creative_id', creativeId)
      .order('version', { ascending: false })
      .limit(1)
      .maybeSingle();
    version = (maxRow?.version || 0) + 1;
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

  res.json({ ok: true, file: fileRecord, drive_url: driveUrl, drive_error: driveError });

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
  if (req.user?.role !== 'admin') return res.status(403).json({ error: '管理者のみ実行できます' });
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
  if (req.user?.role !== 'admin') return res.status(403).json({ error: '管理者のみ実行できます' });
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
  const baseColsWith    = 'id, email, full_name, nickname, role, job_type, rank, team_id, slack_dm_id, chatwork_dm_id, is_active, left_at, left_reason, weekday_hours, weekend_hours, holiday_weekdays, note, avatar_url, hide_birth_year, camera_model, tripod_info, lighting_info';
  const baseColsWithout = 'id, email, full_name, nickname, role, job_type, rank, team_id, slack_dm_id, chatwork_dm_id, is_active, left_at, left_reason, weekday_hours, weekend_hours, holiday_weekdays, note, avatar_url, camera_model, tripod_info, lighting_info';
  // 列が無い環境向けの最終フォールバック（migration 未適用 / schema-sync 失敗時）
  const baseColsLegacy  = 'id, email, full_name, nickname, role, job_type, rank, team_id, slack_dm_id, chatwork_dm_id, is_active, left_at, left_reason, weekday_hours, weekend_hours, note, avatar_url';
  const sensitiveCols = ', birthday, bank_name, bank_code, branch_name, branch_code, account_type, account_number, account_holder_kana, phone, postal_code, address';
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
      console.warn('[members] hide_birth_year列なし → fallback で再取得:', error.message);
      ({ data, error } = await supabase.from('users')
        .select(baseColsWithout + sensitiveCols).eq('id', req.user.id).maybeSingle());
    }
    if (isMissingCol(error)) {
      console.warn('[members] holiday_weekdays/camera等の追加列なし → legacy fallback:', error.message);
      ({ data, error } = await supabase.from('users')
        .select(baseColsLegacy + sensitiveCols).eq('id', req.user.id).maybeSingle());
    }
    if (error) return res.status(500).json({ error: error.message });
    return res.json(data ? [data] : []);
  }
  const colsWith = canSeeSensitive ? baseColsWith + sensitiveCols : baseColsWith;
  const colsWithout = canSeeSensitive ? baseColsWithout + sensitiveCols : baseColsWithout;
  const colsLegacy = canSeeSensitive ? baseColsLegacy + sensitiveCols : baseColsLegacy;
  let { data, error } = await supabase.from('users').select(colsWith).order('full_name');
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
    const { data: self } = await supabase.from('users')
      .select('id, birthday, bank_name, bank_code, branch_name, branch_code, account_type, account_number, account_holder_kana, phone, postal_code, address')
      .eq('id', req.user.id).maybeSingle();
    if (self) {
      const idx = data.findIndex(m => m.id === self.id);
      if (idx >= 0) Object.assign(data[idx], self);
    }
  }
  res.json(data);
});

// メンバー作成
router.post('/members', requireAuth, requirePermission('member.edit_password'), async (req, res) => {
  const { email, full_name, role, job_type, rank, team_id, slack_dm_id, chatwork_dm_id,
          birthday, weekday_hours, weekend_hours } = req.body;
  if (!email || !full_name || !role) return res.status(400).json({ error: 'メール・名前・ロールは必須です' });
  const { data, error } = await supabase
    .from('users')
    .insert({ email, full_name, role, job_type, rank: rank || null, team_id: team_id || null,
              slack_dm_id: slack_dm_id || null, chatwork_dm_id: chatwork_dm_id || null,
              birthday: birthday || null,
              weekday_hours: weekday_hours || [{from:9,to:18}],
              weekend_hours: weekend_hours || null })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

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
    const { error } = await supabase.from('users').insert({
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
    });
    if (error) { failed++; errors.push({ email, reason: error.message }); }
    else { created++; existingEmails.add(String(email).toLowerCase()); }
  }
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
const MEMBER_ROLE_RANK = { admin:6, secretary:5, producer:5, producer_director:4, director:3, designer:2, editor:1 };
router.put('/members/:id', requireAuth, async (req, res) => {
  const requester = req.user;
  const requesterRole = requester.role;
  const requesterLevel = MEMBER_ROLE_RANK[requesterRole] || 0;

  // 対象メンバーを取得して権限チェック
  const { data: target } = await supabase.from('users').select('id,role').eq('id', req.params.id).maybeSingle();
  if (!target) return res.status(404).json({ error: 'メンバーが見つかりません' });

  const targetLevel = MEMBER_ROLE_RANK[target.role] || 0;
  const isAdmin = await userHasPermission(requesterRole, 'member.edit_password');
  const isSelf = requester.id === target.id;

  // 権限チェック: member.edit_password 保有者は全員編集可。producer は自分+下位ランク。それ以外は自分のみ
  if (!isAdmin) {
    const canEdit = (requesterRole === 'producer' || requesterRole === 'producer_director')
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
    phone, postal_code, address,
    // feedback batch 002: カメラ機材 / 休日曜日
    camera_model, tripod_info, lighting_info, holiday_weekdays
  } = req.body;

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
    updateData.phone = phone || null;
    updateData.postal_code = postal_code || null;
    updateData.address = address || null;
  }
  // ロール変更・在籍ステータスは member.edit_password のみ
  if (isAdmin) {
    updateData.role = role;
    updateData.is_active = is_active;
    updateData.left_at = left_at || null;
    updateData.left_reason = left_reason || null;
  }
  // ランク変更は member.edit_password 保有者または producer/PD
  if (isAdmin || requesterRole === 'producer' || requesterRole === 'producer_director') {
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
  let { data, error } = await supabase.from('users').update(attempt).eq('id', req.params.id).select().single();
  // 最大 N 回まで「missing col を 1 個ずつ落として再試行」
  for (let i = 0; i < 10 && isMissingColErr(error); i++) {
    const col = extractMissingCol(error);
    if (col && col in attempt) {
      console.warn(`[members:update] ${col} 列なし → fallback で再保存:`, error.message);
      delete attempt[col];
    } else {
      // 列名が抽出できなければ、追加で入れた可能性のある列をまとめて落として最後の挑戦
      console.warn('[members:update] 列名抽出不可 → 追加カラム一括除外で再保存:', error.message);
      ['hide_birth_year','holiday_weekdays','camera_model','tripod_info','lighting_info',
       'bank_name','bank_code','branch_name','branch_code','account_type','account_number',
       'account_holder_kana','phone','postal_code','address','nickname','note','birthday']
        .forEach(k => { if (k in attempt) delete attempt[k]; });
    }
    ({ data, error } = await supabase.from('users').update(attempt).eq('id', req.params.id).select().single());
  }
  if (error) return res.status(500).json({ error: error.message });
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
  const fullSelect = `*, projects(id,name,clients(id,name)), issuer:issuer_id(id,full_name), invoice_items(id,total_amount,is_special,special_reason,original_unit_price,price_change_reason,label,quantity,unit,unit_price,sort_order,cost_type,creative_label,creative_id,creatives(id,file_name,creative_type,final_deadline,draft_deadline,updated_at),invoice_item_details(*))`;
  const fallbackSelect = `*, projects(id,name,clients(id,name)), issuer:issuer_id(id,full_name), invoice_items(id,total_amount,is_special,special_reason,label,quantity,unit,unit_price,sort_order,cost_type,creative_label,creative_id,creatives(id,file_name,creative_type,final_deadline,draft_deadline,updated_at),invoice_item_details(*))`;
  let { data, error } = await buildQuery(fullSelect);
  if (error && /original_unit_price|price_change_reason/.test(error.message || '')) {
    console.warn('[invoices] 監査列未反映のためフォールバック select を使用:', error.message);
    ({ data, error } = await buildQuery(fallbackSelect));
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

  // 自分がアサインされたクリエイティブを取得（月フィルタなし、全部取得してJS側でフィルタ）
  const { data: creatives, error: cErr } = await supabase
    .from('creatives')
    .select(`
      id, file_name, status, creative_type, final_deadline, draft_deadline,
      project_id, is_payable, special_payable, special_payable_reason,
      projects(id, name, clients(name, client_code)),
      creative_assignments(user_id, role, rank_applied, users(id, full_name, role))
    `)
    .not('creative_assignments', 'is', null);
  if (cErr) return res.status(500).json({ error: cErr.message });

  // 自分のアサインのみ、かつ当月final_deadlineまたは当月作成
  const startDate = new Date(year, month - 1, 1).toISOString().slice(0, 10);
  const endDate   = new Date(year, month, 0).toISOString().slice(0, 10);

  const myCreatives = (creatives || []).filter(c => {
    const mine = c.creative_assignments?.some(a => a.user_id === uid);
    if (!mine) return false;
    const dl = c.final_deadline || c.draft_deadline || '';
    return dl >= startDate && dl <= endDate;
  });

  // 対象案件の単価をまとめて取得
  const projectIds = [...new Set(myCreatives.map(c => c.project_id))];
  let ratesMap = {};
  if (projectIds.length) {
    const { data: rates } = await supabase
      .from('project_rates')
      .select('*')
      .in('project_id', projectIds);
    (rates || []).forEach(r => {
      const key = `${r.project_id}__${r.creative_type}__${r.rank}`;
      ratesMap[key] = r;
    });
  }

  // ユーザーの現在のランクを取得（rank_appliedがNULLの古いデータ用）
  const { data: currentUser } = await supabase.from('users').select('rank').eq('id', uid).single();
  const currentRank = currentUser?.rank || null;

  const PREVIEW_COST_TYPE_LABELS = {
    base_fee:   '編集',
    script_fee: '台本作成',
    ai_fee:     'AI生成（ナレーション含む）',
    other_fee:  'その他',
  };

  const result = myCreatives.map(c => {
    const assignment = c.creative_assignments?.find(a => a.user_id === uid);
    const rankApplied = assignment?.rank_applied ?? currentRank;
    // creative_type (video_short等) をproject_ratesのカテゴリ (video/design) に正規化
    const baseType = c.creative_type?.startsWith('video') ? 'video'
                   : c.creative_type?.startsWith('design') ? 'design'
                   : c.creative_type;
    const rateKey     = `${c.project_id}__${baseType}__${rankApplied}`;
    const fallbackKey = `${c.project_id}__${baseType}__null`;
    const anyKey      = Object.keys(ratesMap).find(k => k.startsWith(`${c.project_id}__${baseType}__`));
    const anyProjectKey = Object.keys(ratesMap).find(k => k.startsWith(`${c.project_id}__`));
    const rate = ratesMap[rateKey] || ratesMap[fallbackKey] || (anyKey ? ratesMap[anyKey] : null) || (anyProjectKey ? ratesMap[anyProjectKey] : null);
    console.log(`[rate] ${c.file_name} type=${c.creative_type}→${baseType} rank=${rankApplied} found=${!!rate}`);
    const rateObj = rate ? {
      base_fee:   rate.base_fee   || 0,
      script_fee: rate.script_fee || 0,
      ai_fee:     rate.ai_fee     || 0,
      other_fee:  rate.other_fee  || 0,
    } : null;
    const breakdown = rateObj ? [
      { cost_type: 'base_fee',   label: PREVIEW_COST_TYPE_LABELS.base_fee,   unit_price: rateObj.base_fee   },
      { cost_type: 'script_fee', label: PREVIEW_COST_TYPE_LABELS.script_fee, unit_price: rateObj.script_fee },
      { cost_type: 'ai_fee',     label: PREVIEW_COST_TYPE_LABELS.ai_fee,     unit_price: rateObj.ai_fee     },
      { cost_type: 'other_fee',  label: PREVIEW_COST_TYPE_LABELS.other_fee,  unit_price: rateObj.other_fee  },
    ].filter(b => b.unit_price > 0) : [];
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
      assignment_role: assignment?.role,
      rank_applied: assignment?.rank_applied || currentRank,
      rate: rateObj,
      breakdown,
      total: rateObj ? (rateObj.base_fee||0)+(rateObj.script_fee||0)+(rateObj.ai_fee||0)+(rateObj.other_fee||0) : 0,
    };
  });

  res.json(result);
});

// 請求書詳細（PDF印刷用）― preview-items より後に定義
router.get('/invoices/:id', requireAuth, async (req, res) => {
  const buildSelect = (auditCols) => `
      *,
      projects(id, name, clients(id, name, client_code)),
      issuer:issuer_id(
        id, full_name, email,
        bank_name, bank_code, branch_name, branch_code,
        account_type, account_number, account_holder_kana
      ),
      invoice_items(
        id, total_amount, is_special, special_reason,
        ${auditCols ? 'original_unit_price, price_change_reason,' : ''}
        label, quantity, unit, unit_price, sort_order,
        cost_type, creative_label, creative_id,
        creatives(id, file_name, creative_type, final_deadline, draft_deadline, updated_at,
          projects(id, name, clients(id, name, client_code))
        ),
        invoice_item_details(cost_type, unit_price, amount)
      )
    `;
  let { data, error } = await supabase.from('invoices').select(buildSelect(true)).eq('id', req.params.id).single();
  if (error && /original_unit_price|price_change_reason/.test(error.message || '')) {
    console.warn('[invoices/:id] 監査列未反映のためフォールバック select を使用:', error.message);
    ({ data, error } = await supabase.from('invoices').select(buildSelect(false)).eq('id', req.params.id).single());
  }
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: '請求書が見つかりません' });
  if (data.issuer_id !== req.user?.id && !['admin','secretary'].includes(req.user?.role)) {
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
    lines.push(`\`期限: ${d.toLocaleString('ja-JP', { dateStyle: 'medium', timeStyle: 'short' })}\``);
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
router.delete('/announcements/:id', requireAuth, requirePermission('member.list'), async (req, res) => {
  const { error } = await supabase.from('announcements')
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// 完了をマーク
router.post('/announcements/:id/ack', requireAuth, async (req, res) => {
  const { error } = await supabase.from('announcement_acks')
    .upsert({ announcement_id: req.params.id, user_id: req.user.id, done_at: new Date().toISOString() },
            { onConflict: 'announcement_id,user_id' });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, done_at: new Date().toISOString() });
});

// 完了を取り消し
router.delete('/announcements/:id/ack', requireAuth, async (req, res) => {
  const { error } = await supabase.from('announcement_acks')
    .delete().eq('announcement_id', req.params.id).eq('user_id', req.user.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
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
  const { data: acks, error: kErr } = await supabase.from('announcement_acks')
    .select('user_id, done_at').eq('announcement_id', req.params.id);
  if (kErr) return res.status(500).json({ error: kErr.message });
  // チーム情報を取得（director_id/producer_id でリーダー判定。team_code 昇順で表示）
  const { data: teams, error: tErr } = await supabase.from('teams')
    .select('id, team_code, team_name, director_id, producer_id').order('team_code');
  if (tErr) return res.status(500).json({ error: tErr.message });

  const ackMap = new Map((acks || []).map(a => [a.user_id, a.done_at]));
  const baseMember = (m) => ({
    user_id: m.id,
    full_name: m.full_name,
    role: m.role,
    avatar_url: m.avatar_url,
    team_id: m.team_id,
    done_at: ackMap.get(m.id) || null,
  });

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

  // 各チーム内の並び: ディレクター → プロデューサー → 残り（名前順）
  const ROLE_RANK = { admin: 0, secretary: 1, producer: 2, producer_director: 2, director: 3, designer: 4, editor: 5 };
  function sortTeamMembers(arr, team) {
    return arr.slice().sort((a, b) => {
      const aIsDir = a.user_id === team.director_id;
      const bIsDir = b.user_id === team.director_id;
      if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
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
      const sorted = sortTeamMembers(byTeam.get(t.id), t);
      return {
        team_id: t.id,
        team_code: t.team_code,
        team_name: t.team_name,
        director_id: t.director_id,
        producer_id: t.producer_id,
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

// 自分のいいね状態 + いいね件数を含む一覧
router.get('/tweets', requireAuth, async (req, res) => {
  const { data: list, error } = await supabase
    .from('tweets')
    .select('id, user_id, body, image_data, expires_at, is_pinned, created_at, users(id, full_name, avatar_url, role)')
    .or(`is_pinned.eq.true,expires_at.gt.${new Date().toISOString()}`)
    .order('is_pinned', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) return res.status(500).json({ error: error.message });
  if (!list || list.length === 0) return res.json([]);
  const ids = list.map(t => t.id);
  // いいね件数
  const { data: allLikes } = await supabase.from('tweet_likes')
    .select('tweet_id, user_id').in('tweet_id', ids);
  const countMap = new Map();
  const myLikedSet = new Set();
  (allLikes || []).forEach(l => {
    countMap.set(l.tweet_id, (countMap.get(l.tweet_id) || 0) + 1);
    if (l.user_id === req.user.id) myLikedSet.add(l.tweet_id);
  });
  res.json(list.map(t => ({
    ...t,
    like_count: countMap.get(t.id) || 0,
    my_liked: myLikedSet.has(t.id),
  })));
});

// つぶやき投稿（写真は任意 + 本文）
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
  const { data, error } = await supabase.from('tweets')
    .insert({ user_id: req.user.id, body, image_data: dataUrl })
    .select('id, user_id, body, image_data, expires_at, is_pinned, created_at')
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ...data, like_count: 0, my_liked: false });
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

// いいね追加
router.post('/tweets/:id/like', requireAuth, async (req, res) => {
  const { error } = await supabase.from('tweet_likes')
    .upsert({ tweet_id: req.params.id, user_id: req.user.id }, { onConflict: 'tweet_id,user_id' });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// いいね取消
router.delete('/tweets/:id/like', requireAuth, async (req, res) => {
  const { error } = await supabase.from('tweet_likes')
    .delete().eq('tweet_id', req.params.id).eq('user_id', req.user.id);
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
  if (inv.issuer_id !== req.user?.id && !['admin','secretary'].includes(req.user?.role))
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
  const { cycle_id, selected_creative_ids, selected_items } = req.body;
  let { project_id } = req.body;
  // admin/secretary のみ代理発行可能、それ以外はログインユーザー本人に固定
  const issuer_id = (['admin', 'secretary'].includes(req.user?.role) && req.body.issuer_id)
    ? req.body.issuer_id
    : req.user.id;
  if (!issuer_id) return res.status(400).json({ error: '発行者は必須です' });

  // selected_items のバリデーションと正規化
  const ALLOWED_COST_TYPES = new Set(['base_fee', 'script_fee', 'ai_fee', 'other_fee']);
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
  const OPTIONAL_COLS = ['force_delivered', 'force_delivered_reason', 'force_delivered_at'];
  const buildSelect = (includeOptional) => `*${includeOptional ? ', ' + OPTIONAL_COLS.join(', ') : ''}, creative_assignments(user_id, role, rank_applied, users(id, full_name))`;

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

  // selected_creative_ids使用時はproject_idを最初のクリエイティブから補完
  if (!project_id && creatives.length) project_id = creatives[0].project_id;

  // 対象案件の単価をまとめて取得
  const projectIds = [...new Set(creatives.map(c => c.project_id))];
  const { data: allRates } = await supabase
    .from('project_rates')
    .select('*')
    .in('project_id', projectIds);
  const rates = allRates || [];

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
    base_fee:   '編集',
    script_fee: '台本作成',
    ai_fee:     'AI生成（ナレーション含む）',
    other_fee:  'その他',
  };
  let totalAmount = 0;
  const itemRows = [];   // 実際に invoice_items に INSERT する行
  let sortCounter = 0;

  for (const creative of creatives) {
    const assignment = creative.creative_assignments?.find(
      a => a.user_id === issuer_id
    );
    if (!assignment) continue;

    const creativeLabel = creative.file_name || '';
    let breakdown;

    // デフォルト単価（project_rates由来）を算出
    const baseType = creative.creative_type?.startsWith('video') ? 'video'
                   : creative.creative_type?.startsWith('design') ? 'design'
                   : creative.creative_type;
    const defaultRate = rates?.find(
      r => r.project_id === creative.project_id && r.creative_type === baseType && r.rank === assignment.rank_applied
    ) || rates?.find(
      r => r.project_id === creative.project_id && r.creative_type === baseType
    );
    const defaultUnitPriceMap = {
      base_fee:   defaultRate?.base_fee   || 0,
      script_fee: defaultRate?.script_fee || 0,
      ai_fee:     defaultRate?.ai_fee     || 0,
      other_fee:  defaultRate?.other_fee  || 0,
    };

    if (overrideMap) {
      breakdown = overrideMap.get(creative.id) || [];
    } else {
      if (!defaultRate) continue;
      breakdown = [
        { cost_type: 'base_fee',   unit_price: defaultUnitPriceMap.base_fee   },
        { cost_type: 'script_fee', unit_price: defaultUnitPriceMap.script_fee },
        { cost_type: 'ai_fee',     unit_price: defaultUnitPriceMap.ai_fee     },
        { cost_type: 'other_fee',  unit_price: defaultUnitPriceMap.other_fee  },
      ].filter(b => b.unit_price > 0);
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
  if (inv.issuer_id !== req.user?.id && !['admin','secretary'].includes(req.user?.role))
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
    'クライアントチェック後修正': { holder: `${editorName}・${directorName}・プロデューサー`, type: 'all', user_ids: [editorId, directorId].filter(Boolean) },
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
    // user_id（編集者・ディレクター）は単数 / user_ids（クライアントチェック後修正）は配列
    // キャッシュ列は単数なので、user_ids の場合は先頭（編集者）を採用する
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

  let nextSeq = 1;
  while (usedSeqs.includes(nextSeq)) nextSeq++;

  // 訴求タイプの連番
  const nextAppealSeq = (allCreatives || []).filter(c => c.appeal_type_id === appeal_type_id).length + 1;

  const seqStr3 = String(nextSeq).padStart(3, '0');
  const seqStr7 = String(nextSeq).padStart(7, '0');
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

  // 新ファイル名: {YYMMDD}_{商材}_{媒体}_{FMT}_{訴求軸}_{サイズ}_{7桁seq}
  const parts = [dateStr, product_code, media_code, creative_fmt, appealType.code, creative_size, seqStr7]
    .map(p => (p || '').toString().trim())
    .filter(Boolean);
  const newFileName = parts.join('_');

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
  const { data, error } = await supabase
    .from('teams')
    .select(`
      *,
      director:users!teams_director_id_fkey(id, full_name),
      producer:users!teams_producer_id_fkey(id, full_name),
      team_members(user_id)
    `)
    .order('team_code');
  if (error) return res.status(500).json({ error: error.message });
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
    .select('id, full_name, email, role, rank, is_active, last_seen_at, login_count, created_at')
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

// 今月の予実サマリー
router.get('/dashboard/monthly-forecast', async (req, res) => {
  const year = parseInt(req.query.year) || new Date().getFullYear();
  const month = parseInt(req.query.month) || (new Date().getMonth() + 1);

  const { data: cycles, error: cyclesError } = await supabase
    .from('project_cycles')
    .select(`
      *,
      projects (id, name, client_id, clients(name)),
      project_client_fees (video_unit_price, design_unit_price, fixed_budget, use_fixed_budget)
    `)
    .eq('year', year)
    .eq('month', month);

  if (cyclesError) return res.status(500).json({ error: cyclesError.message });

  // N+1解消: cycle_id IN (…) で一括取得してJS側でグループ化
  const cycleIds = (cycles || []).map(c => c.id);
  const { data: allCreatives } = cycleIds.length
    ? await supabase.from('creatives').select('cycle_id, creative_type').in('cycle_id', cycleIds)
    : { data: [] };
  const creativesByCycle = {};
  (allCreatives || []).forEach(c => {
    if (!creativesByCycle[c.cycle_id]) creativesByCycle[c.cycle_id] = [];
    creativesByCycle[c.cycle_id].push(c);
  });

  const result = (cycles || []).map(cycle => {
    const creatives = creativesByCycle[cycle.id] || [];
    const videoCount = creatives.filter(c =>
      c.creative_type && (c.creative_type.includes('動画') || c.creative_type.toLowerCase().includes('video'))
    ).length;
    const designCount = creatives.filter(c =>
      c.creative_type && (c.creative_type.includes('デザイン') || c.creative_type.toLowerCase().includes('design'))
    ).length;

    const fee = cycle.project_client_fees;
    const videoUnitPrice = fee?.video_unit_price || 0;
    const designUnitPrice = fee?.design_unit_price || 0;

    let planned;
    if (fee?.use_fixed_budget && fee?.fixed_budget) {
      planned = fee.fixed_budget;
    } else {
      planned = (cycle.planned_video_count || 0) * videoUnitPrice
              + (cycle.planned_design_count || 0) * designUnitPrice;
    }

    const actual = videoCount * videoUnitPrice + designCount * designUnitPrice;

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

// ファイルのコメント一覧
router.get('/creative-files/:fid/comments', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('creative_file_comments')
    .select('*, users(id, full_name, role, avatar_url)')
    .eq('creative_file_id', req.params.fid)
    .order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(await enrichCommentCategories(data));
});

// コメント追加
router.post('/creative-files/:fid/comments', requireAuth, async (req, res) => {
  const { comment, timecode, is_knowledge, category_id } = req.body;
  if (!comment?.trim()) return res.status(400).json({ error: 'コメントを入力してください' });
  const { data, error } = await supabase
    .from('creative_file_comments')
    .insert({
      creative_file_id: req.params.fid,
      user_id: req.user?.id || null,
      comment: comment.trim(),
      timecode: timecode || null,
      is_knowledge: !!is_knowledge,
      category_id: category_id || null,
    })
    .select('*, users(id, full_name, role, avatar_url)')
    .single();
  if (error) return res.status(500).json({ error: error.message });
  const [enriched] = await enrichCommentCategories([data]);
  res.json(enriched);
});

// コメント削除（自分のコメントのみ / admin は全件）
router.delete('/creative-file-comments/:id', requireAuth, async (req, res) => {
  const userId = req.user?.id;
  const { data: comment } = await supabase.from('creative_file_comments').select('user_id').eq('id', req.params.id).single();
  if (!comment) return res.status(404).json({ error: '見つかりません' });
  const userRow = await supabase.from('users').select('role').eq('id', userId).single();
  const isAdmin = ['admin', 'secretary'].includes(userRow.data?.role);
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

// ロール権限取得（全ユーザーがアクセス可能。自身のUIのために必要）
router.get('/role-permissions', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('role_permissions').select('role, permission_key, allowed');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
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
]);

// ロール権限保存（最高管理者のみ・ホワイトリスト検証あり）
router.put('/role-permissions', requireAuth, requireSuperAdmin, async (req, res) => {
  const { permissions } = req.body; // [{role, permission_key, allowed}, ...]
  if (!Array.isArray(permissions)) return res.status(400).json({ error: 'permissions配列が必要です' });
  // ホワイトリスト検証
  for (const p of permissions) {
    if (!VALID_ROLES.has(p.role)) return res.status(400).json({ error: `不正なロール: ${p.role}` });
    if (!VALID_PERMISSION_KEYS.has(p.permission_key)) return res.status(400).json({ error: `不正な権限キー: ${p.permission_key}` });
  }
  const rows = permissions.map(p => ({
    role: p.role, permission_key: p.permission_key, allowed: !!p.allowed, updated_at: new Date().toISOString()
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

// router を主エクスポートにしつつ、ヘルパー関数も同じ object 経由で取り出せるようにする
// 用途:
//   const harukaRouter = require('./routes/haruka');                 // ルーター本体
//   const { syncBallHolderId, getBallHolder } = require('./routes/haruka'); // ヘルパー
router.syncBallHolderId = syncBallHolderId;
router.getBallHolder    = getBallHolder;
module.exports = router;
