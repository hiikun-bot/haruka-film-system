// routes/haruka.js — HARUKA FILM SYSTEM API
const express = require('express');
const router = express.Router();
const supabase = require('../supabase');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const { requireAuth, requireLevel } = require('../auth');
const { google } = require('googleapis');
const { Readable } = require('stream');

// FFmpeg（画質変換用）
let ffmpegPath, ffmpeg;
try {
  ffmpegPath = require('ffmpeg-static');
  ffmpeg     = require('fluent-ffmpeg');
  ffmpeg.setFfmpegPath(ffmpegPath);
} catch(e) { /* ffmpeg-static 未インストール時はスキップ */ }

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 500 * 1024 * 1024 } });

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
  res.json(data);
});

// クライアント作成
router.post('/clients', async (req, res) => {
  const { name, client_code, note, sales_start_date, status } = req.body;
  if (!name) return res.status(400).json({ error: 'クライアント名は必須です' });
  const code = client_code ? client_code.toUpperCase().slice(0, 3) : null;
  const { data, error } = await supabase
    .from('clients')
    .insert({ name, client_code: code, note, sales_start_date: sales_start_date || null, status: status || '提案中' })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// クライアント更新
router.put('/clients/:id', async (req, res) => {
  const { name, client_code, note, sales_start_date, status } = req.body;
  const code = client_code ? client_code.toUpperCase().slice(0, 3) : null;
  const { data, error } = await supabase
    .from('clients')
    .update({ name, client_code: code, note, sales_start_date: sales_start_date || null, status: status || '提案中', updated_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ==================== 案件 ====================

// 案件一覧取得
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
  res.json(data);
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
router.post('/projects', async (req, res) => {
  const {
    client_id, name, status, producer_id, director_id,
    sheet_url, regulation_url, admin_note, start_date, end_date,
    chatwork_room_id, slack_team_id, slack_channel_id,
    deadline_unit, deadline_weekday
  } = req.body;
  if (!client_id || !name) return res.status(400).json({ error: 'クライアントと案件名は必須です' });
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
      slack_team_id: slack_team_id || null,
      slack_channel_id: slack_channel_id || null,
      is_hidden: false,
      deadline_unit: deadline_unit || 'monthly',
      deadline_weekday: deadline_weekday ?? null
    })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// 案件更新
router.put('/projects/:id', async (req, res) => {
  const {
    name, status, producer_id, director_id,
    sheet_url, regulation_url, admin_note, start_date, end_date,
    chatwork_room_id, slack_team_id, slack_channel_id, is_hidden,
    sync_products, sync_appeal_axes,
    deadline_unit, deadline_weekday
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
    slack_team_id: slack_team_id || null,
    slack_channel_id: slack_channel_id || null,
    is_hidden: is_hidden ?? false,
    updated_at: new Date().toISOString(),
    deadline_unit: deadline_unit || 'monthly',
    deadline_weekday: deadline_weekday ?? null
  };
  if (sync_products !== undefined) updateData.sync_products = sync_products;
  if (sync_appeal_axes !== undefined) updateData.sync_appeal_axes = sync_appeal_axes;
  const { data, error } = await supabase
    .from('projects')
    .update(updateData)
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
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
router.post('/projects/:id/cycles', async (req, res) => {
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
router.post('/projects/:id/rates/bulk', async (req, res) => {
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
router.post('/projects/:id/rates', async (req, res) => {
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

// ==================== クリエイティブ ====================

// クリエイティブ一覧取得
router.get('/creatives', async (req, res) => {
  const { project_id, cycle_id, status, ball_holder } = req.query;
  let query = supabase
    .from('creatives')
    .select(`
      *,
      projects(id, name, clients(id, name)),
      project_cycles(id, year, month),
      creative_assignments(
        id, role, rank_applied,
        users(id, full_name, role, rank, team_id)
      )
    `)
    .order('final_deadline', { ascending: true, nullsFirst: false });

  if (project_id) query = query.eq('project_id', project_id);
  if (cycle_id) query = query.eq('cycle_id', cycle_id);
  if (status) query = query.eq('status', status);

  const [{ data, error }, { data: teamsRaw }] = await Promise.all([
    query,
    supabase.from('teams').select('id, director_id, director:director_id(full_name), team_members(user_id)'),
  ]);
  if (error) return res.status(500).json({ error: error.message });

  // チーム逆引きMap（ディレクター名解決用）
  const directorByTeamId  = new Map();
  const directorByUserId  = new Map();
  (teamsRaw || []).forEach(t => {
    const name = t.director?.full_name || '';
    if (t.director_id) directorByTeamId.set(t.id, name);
    (t.team_members || []).forEach(tm => {
      if (tm.user_id && !directorByUserId.has(tm.user_id)) directorByUserId.set(tm.user_id, name);
    });
  });

  // ボール保持者を付与
  const withBall = data.map(c => ({
    ...c,
    ball_holder: getBallHolder(c.status, c.creative_assignments, directorByTeamId, directorByUserId)
  }));

  res.json(withBall);
});

// クリエイティブ単体取得
router.get('/creatives/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('creatives')
    .select(`
      *,
      projects(id, name, producer_id, director_id, regulation_url, clients(id, name, client_code)),
      project_cycles(id, year, month),
      creative_assignments(
        id, role, rank_applied,
        users(id, full_name, role, team_id)
      )
    `)
    .eq('id', req.params.id)
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// 一括登録プレビュー（DBには保存しない）
router.post('/creatives/bulk-preview', async (req, res) => {
  const { project_id, creative_type, appeal_type_id, count, draft_deadline, final_deadline,
          product_code, media_code, creative_fmt, creative_size } = req.body;
  if (!project_id || !creative_type || !appeal_type_id || !count) {
    return res.status(400).json({ error: '案件・種別・訴求タイプ・本数は必須です' });
  }
  const { data: project } = await supabase
    .from('projects').select('*, clients(id, name, client_code)').eq('id', project_id).single();
  const { data: appealType } = await supabase
    .from('client_appeal_axes').select('*').eq('id', appeal_type_id).single();
  if (!project || !appealType) return res.status(400).json({ error: '案件または訴求タイプが見つかりません' });

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
    const parts = [dateStr, product_code, media_code, creative_fmt, appealType.code, creative_size, seqStr7]
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
  if (!project_id || !creative_type || !appeal_type_id || !count) {
    return res.status(400).json({ error: '案件・種別・訴求タイプ・本数は必須です' });
  }
  if (count < 1 || count > 100) {
    return res.status(400).json({ error: '本数は1〜100の間で指定してください' });
  }
  const { data: project } = await supabase
    .from('projects').select('*, clients(id, name, client_code)').eq('id', project_id).single();
  const { data: appealType } = await supabase
    .from('client_appeal_axes').select('*').eq('id', appeal_type_id).single();
  if (!project || !appealType) {
    return res.status(400).json({ error: '案件または訴求タイプが見つかりません' });
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
    const parts = [dateStr, product_code, media_code, creative_fmt, appealType.code, creative_size, seqStr7]
      .map(p => (p||'').toString().trim()).filter(Boolean);
    const fileName = parts.join('_');
    const insert = { project_id, file_name: fileName, creative_type, appeal_type_id,
      draft_deadline: draft_deadline || null, final_deadline: final_deadline || null,
      note: note || null, status: '未着手',
      product_id: product_id || null, media_code: media_code || null,
      creative_fmt: creative_fmt || null, creative_size: creative_size || null };
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
    assignee_id, internal_code, production_date, talent_flag
  } = req.body;
  if (!project_id || !file_name || !creative_type) {
    return res.status(400).json({ error: '案件・ファイル名・種別は必須です' });
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
  res.json(data);
});

// クリエイティブ更新
router.put('/creatives/:id', async (req, res) => {
  const {
    file_name, status, deadline, draft_deadline, final_deadline, script_url,
    frameio_url, delivery_url, final_delivery_url,
    help_flag, talent_flag, note, revision_count,
    director_comment, client_comment,
    creative_type, appeal_type_id, product_id, media_code, creative_fmt, creative_size,
    assignee_id
  } = req.body;
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
  if (help_flag !== undefined) updateData.help_flag = help_flag;
  if (talent_flag !== undefined) updateData.talent_flag = talent_flag;
  if (note !== undefined) updateData.note = note;
  if (revision_count !== undefined) updateData.revision_count = revision_count;
  if (director_comment !== undefined) updateData.director_comment = director_comment;
  if (client_comment !== undefined) updateData.client_comment = client_comment;
  if (creative_type !== undefined) updateData.creative_type = creative_type;
  if (appeal_type_id !== undefined) updateData.appeal_type_id = appeal_type_id || null;
  if (product_id !== undefined) updateData.product_id = product_id || null;
  if (media_code !== undefined) updateData.media_code = media_code || null;
  if (creative_fmt !== undefined) updateData.creative_fmt = creative_fmt || null;
  if (creative_size !== undefined) updateData.creative_size = creative_size || null;

  // 納品完了時に支払い可能フラグを自動オン
  if (status === '納品') updateData.is_payable = true;

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

  res.json(data);
});

// クリエイティブ削除（複数対応）
router.delete('/creatives', requireAuth, async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'ids は必須です' });
  // 関連レコードを先に削除
  await supabase.from('creative_assignments').delete().in('creative_id', ids);
  await supabase.from('creative_files').delete().in('creative_id', ids);
  const { error } = await supabase.from('creatives').delete().in('id', ids);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, deleted: ids.length });
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
  const { width, height, version, generated_name } = req.body;
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'ファイルが選択されていません' });

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
  const uploadedBy = req.user?.id || null;
  const { data: fileRecord, error: fErr } = await supabase
    .from('creative_files')
    .insert({
      creative_id: creativeId,
      original_name: file.originalname,
      generated_name: generated_name || file.originalname,
      width: parseInt(width) || null,
      height: parseInt(height) || null,
      version: parseInt(version) || 1,
      drive_file_id: driveFileId,
      drive_url: driveUrl,
      uploaded_by: uploadedBy,
    })
    .select()
    .single();
  if (fErr) return res.status(500).json({ error: fErr.message });

  res.json({ ok: true, file: fileRecord, drive_url: driveUrl, drive_error: driveError });
});

// Google Drive ファイルストリーミングプロキシ（Range リクエスト対応・動画シーク可能）
router.get('/files/:fileId/stream', async (req, res) => {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_KEY) return res.status(503).json({ error: 'Drive未設定' });
  try {
    const drive = await getDriveService();

    // メタ情報（mimeType, サイズ）を取得
    const meta = await drive.files.get({
      fileId: req.params.fileId,
      fields: 'mimeType,size',
      supportsAllDrives: true,
    });
    const mimeType = meta.data.mimeType || 'video/mp4';
    const fileSize = parseInt(meta.data.size || '0', 10);

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
        { fileId: req.params.fileId, alt: 'media', supportsAllDrives: true },
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
        { fileId: req.params.fileId, alt: 'media', supportsAllDrives: true },
        { responseType: 'stream' }
      );
      streamRes.data.pipe(res);
    }
  } catch (e) {
    console.error('Drive stream error:', e.message);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
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
  res.json(data);
});

// アサイン削除
router.delete('/assignments/:id', async (req, res) => {
  const { error } = await supabase
    .from('creative_assignments')
    .delete()
    .eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ==================== メンバー ====================

// メンバー一覧
router.get('/members', async (req, res) => {
  const { data, error } = await supabase
    .from('users')
    .select('id, email, full_name, nickname, role, job_type, rank, team_id, slack_dm_id, chatwork_dm_id, is_active, left_at, left_reason, birthday, weekday_hours, weekend_hours, note, bank_name, bank_code, branch_name, branch_code, account_type, account_number, account_holder_kana, phone, postal_code, address')
    .order('full_name');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// メンバー作成
router.post('/members', async (req, res) => {
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

// メンバー一括登録
router.post('/members/bulk', async (req, res) => {
  const { members } = req.body;
  if (!members?.length) return res.status(400).json({ error: 'データがありません' });

  // チームコード→IDのマップを取得
  const { data: teams } = await supabase.from('teams').select('id, team_code');
  const teamMap = {};
  (teams || []).forEach(t => { teamMap[t.team_code] = t.id; });

  let created = 0, failed = 0;
  for (const m of members) {
    const { full_name, email, role, job_type, rank, team_code, birthday,
            nickname, slack_dm_id, chatwork_dm_id, phone, postal_code, address, note } = m;
    if (!full_name || !email || !role) { failed++; continue; }
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
    if (error) { failed++; } else { created++; }
  }
  res.json({ created, failed });
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
  const isAdmin = requesterRole === 'admin' || requesterRole === 'secretary';
  const isSelf = requester.id === target.id;

  // 権限チェック: admin/secretary は全員編集可。producer は自分+下位ランク。director/editor/designer は自分のみ
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
    birthday, weekday_hours, weekend_hours, note,
    bank_name, bank_code, branch_name, branch_code,
    account_type, account_number, account_holder_kana,
    phone, postal_code, address
  } = req.body;

  const updateData = {
    full_name, nickname: nickname || null, job_type,
    team_id: team_id || null,
    slack_dm_id: slack_dm_id || null,
    chatwork_dm_id: chatwork_dm_id || null,
    birthday: birthday || null,
    weekday_hours: weekday_hours || null,
    weekend_hours: weekend_hours || null,
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
    updated_at: new Date().toISOString()
  };
  // ロール変更は admin/secretary のみ
  if (isAdmin) {
    updateData.role = role;
    updateData.is_active = is_active;
    updateData.left_at = left_at || null;
    updateData.left_reason = left_reason || null;
  }
  // ランク変更は admin/secretary/producer のみ
  if (isAdmin || requesterRole === 'producer' || requesterRole === 'producer_director') {
    updateData.rank = rank || null;
  }

  const { data, error } = await supabase.from('users').update(updateData).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// メンバー完全削除（admin のみ・自分自身は不可）
router.delete('/members/:id', requireAuth, requireLevel('admin'), async (req, res) => {
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
router.post('/members/:id/deactivate', requireAuth, requireLevel('admin'), async (req, res) => {
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
router.post('/members/:id/reactivate', requireAuth, requireLevel('admin'), async (req, res) => {
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

// ==================== 請求書 ====================

// 請求書一覧
router.get('/invoices', async (req, res) => {
  const { issuer_id, year, month, status } = req.query;
  let query = supabase
    .from('invoices')
    .select(`*, projects(id,name,clients(id,name)), issuer:issuer_id(id,full_name), invoice_items(id,total_amount,is_special,special_reason,creatives(id,file_name,creative_type),invoice_item_details(*))`)
    .order('created_at', { ascending: false });
  if (issuer_id) query = query.eq('issuer_id', issuer_id);
  if (year) query = query.eq('year', parseInt(year));
  if (month) query = query.eq('month', parseInt(month));
  if (status) query = query.eq('status', status);
  const { data, error } = await query;
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
    return {
      id: c.id,
      file_name: c.file_name,
      status: c.status,
      creative_type: c.creative_type,
      final_deadline: c.final_deadline,
      is_payable: c.is_payable,
      special_payable: c.special_payable,
      project_id: c.project_id,
      project_name: c.projects?.name || '',
      client_name: c.projects?.clients?.name || '',
      assignment_role: assignment?.role,
      rank_applied: assignment?.rank_applied || currentRank,
      rate: rate ? {
        base_fee:   rate.base_fee   || 0,
        script_fee: rate.script_fee || 0,
        ai_fee:     rate.ai_fee     || 0,
        other_fee:  rate.other_fee  || 0,
      } : null,
      total: rate ? (rate.base_fee||0)+(rate.script_fee||0)+(rate.ai_fee||0)+(rate.other_fee||0) : 0,
    };
  });

  res.json(result);
});

// 請求書詳細（PDF印刷用）― preview-items より後に定義
router.get('/invoices/:id', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('invoices')
    .select(`
      *,
      projects(id, name, clients(id, name, client_code)),
      issuer:issuer_id(
        id, full_name, email,
        bank_name, bank_code, branch_name, branch_code,
        account_type, account_number, account_holder_kana
      ),
      invoice_items(
        id, total_amount, is_special, special_reason,
        creatives(id, file_name, creative_type,
          projects(id, name, clients(id, name, client_code))
        ),
        invoice_item_details(cost_type, unit_price, amount)
      )
    `)
    .eq('id', req.params.id)
    .single();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: '請求書が見つかりません' });
  if (data.issuer_id !== req.user?.id && !['admin','secretary'].includes(req.user?.role)) {
    return res.status(403).json({ error: 'アクセス権限がありません' });
  }
  res.json(data);
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
    .insert(items.map(item => ({
      invoice_id: invoice.id,
      creative_id: item.creative_id,
      total_amount: item.client_fee,
      is_special: false,
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
  const { notes } = req.body;
  const { data: inv, error: fetchErr } = await supabase
    .from('invoices').select('issuer_id, status').eq('id', req.params.id).single();
  if (fetchErr || !inv) return res.status(404).json({ error: '請求書が見つかりません' });
  if (inv.issuer_id !== req.user?.id && !['admin','secretary'].includes(req.user?.role))
    return res.status(403).json({ error: 'アクセス権限がありません' });
  const { data, error } = await supabase
    .from('invoices').update({ notes: notes ?? null }).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// 請求書作成（選択クリエイティブから生成）
router.post('/invoices/generate', requireAuth, async (req, res) => {
  const { cycle_id, selected_creative_ids } = req.body;
  let { project_id } = req.body;
  // admin/secretary のみ代理発行可能、それ以外はログインユーザー本人に固定
  const issuer_id = (['admin', 'secretary'].includes(req.user?.role) && req.body.issuer_id)
    ? req.body.issuer_id
    : req.user.id;
  if (!issuer_id) return res.status(400).json({ error: '発行者は必須です' });

  // 請求可能なクリエイティブを取得
  let query = supabase
    .from('creatives')
    .select(`*, creative_assignments(user_id, role, rank_applied, users(id, full_name))`)
    .not('creative_assignments', 'is', null);

  if (selected_creative_ids && selected_creative_ids.length) {
    query = query.in('id', selected_creative_ids);
  } else if (project_id) {
    query = query.eq('project_id', project_id).or('is_payable.eq.true,special_payable.eq.true');
  } else {
    return res.status(400).json({ error: '請求対象クリエイティブを選択してください' });
  }
  if (cycle_id) query = query.eq('cycle_id', cycle_id);

  const { data: creatives, error: cErr } = await query;
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
  let totalAmount = 0;
  const items = [];

  for (const creative of creatives) {
    const assignment = creative.creative_assignments?.find(
      a => a.user_id === issuer_id
    );
    if (!assignment) continue;

    const baseType = creative.creative_type?.startsWith('video') ? 'video'
                   : creative.creative_type?.startsWith('design') ? 'design'
                   : creative.creative_type;
    const rate = rates?.find(
      r => r.project_id === creative.project_id && r.creative_type === baseType && r.rank === assignment.rank_applied
    ) || rates?.find(
      r => r.project_id === creative.project_id && r.creative_type === baseType
    );
    if (!rate) continue;

    const itemTotal = (rate.base_fee || 0) + (rate.script_fee || 0) +
                      (rate.ai_fee || 0) + (rate.other_fee || 0);
    totalAmount += itemTotal;

    items.push({
      creative_id: creative.id,
      total_amount: itemTotal,
      is_special: creative.special_payable || false,
      special_reason: creative.special_payable_reason || null,
      details: [
        { cost_type: 'base_fee', unit_price: rate.base_fee || 0, amount: rate.base_fee || 0 },
        { cost_type: 'script_fee', unit_price: rate.script_fee || 0, amount: rate.script_fee || 0 },
        { cost_type: 'ai_fee', unit_price: rate.ai_fee || 0, amount: rate.ai_fee || 0 },
        { cost_type: 'other_fee', unit_price: rate.other_fee || 0, amount: rate.other_fee || 0 },
      ].filter(d => d.amount > 0)
    });
  }

  if (!items.length) return res.status(400).json({ error: '該当するアサインが見つかりません' });

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

  // 明細を一括保存（N+1 → 2クエリに削減）
  const { data: invItems, error: itemsErr } = await supabase
    .from('invoice_items')
    .insert(items.map(item => ({
      invoice_id: invoice.id,
      creative_id: item.creative_id,
      total_amount: item.total_amount,
      is_special: item.is_special,
      special_reason: item.special_reason,
    })))
    .select('id, creative_id');
  if (itemsErr) return res.status(500).json({ error: itemsErr.message });

  // 明細詳細を一括保存
  const allDetails = (invItems || []).flatMap(invItem => {
    const orig = items.find(i => i.creative_id === invItem.creative_id);
    return (orig?.details || []).map(d => ({ ...d, invoice_item_id: invItem.id }));
  });
  if (allDetails.length) {
    const { error: detErr } = await supabase.from('invoice_item_details').insert(allDetails);
    if (detErr) return res.status(500).json({ error: detErr.message });
  }

  res.json({ ok: true, invoice_number: invoiceNumber, total_amount: totalAmount, items_count: items.length });
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
  const { data, error } = await supabase
    .from('invoices')
    .update({ status: 'submitted', submitted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
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
  if (inv.status !== 'draft') return res.status(400).json({ error: '下書き以外は削除できません' });
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

function getBallHolder(status, assignments, directorByTeamId, directorByUserId) {
  const editor   = assignments?.find(a => ['editor','designer','director_as_editor'].includes(a.role));
  const dirAssign = assignments?.find(a => a.role === 'director');

  const editorName = editor?.users?.full_name || '編集者';

  // ディレクター名：assignment直接 → チームID逆引き → メンバーID逆引き → フォールバック
  let directorName = dirAssign?.users?.full_name;
  if (!directorName && editor?.users) {
    const u = editor.users;
    directorName = (u.team_id && directorByTeamId?.get(u.team_id))
      || (u.id && directorByUserId?.get(u.id))
      || '';
  }
  directorName = directorName || 'ディレクター';

  const ballMap = {
    '未着手': { holder: editorName, type: 'editor' },
    '制作中（初稿提出前）': { holder: editorName, type: 'editor' },
    '台本制作': { holder: editorName, type: 'editor' },
    '素材・ナレ作成': { holder: editorName, type: 'editor' },
    '編集': { holder: editorName, type: 'editor' },
    'Dチェック': { holder: directorName, type: 'director' },
    'Dチェック後修正': { holder: editorName, type: 'editor' },
    'Pチェック': { holder: 'プロデューサー', type: 'producer' },
    'Pチェック後修正': { holder: editorName, type: 'editor' },
    'クライアントチェック中': { holder: 'クライアント', type: 'client' },
    'クライアントチェック後修正': { holder: `${editorName}・${directorName}・プロデューサー`, type: 'all' },
    '納品': { holder: '完了', type: 'done' },
  };
  return ballMap[status] || { holder: '不明', type: 'unknown' };
}

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
router.post('/projects/:id/appeal-types', async (req, res) => {
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
router.delete('/projects/:id/appeal-types/:patId', async (req, res) => {
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
router.post('/teams', async (req, res) => {
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
router.put('/teams/:id', async (req, res) => {
  const { team_name, team_type, director_id, producer_id, is_active, member_ids } = req.body;
  const { data, error } = await supabase
    .from('teams')
    .update({
      team_name, team_type,
      director_id: director_id || null,
      producer_id: producer_id || null,
      is_active,
      updated_at: new Date().toISOString()
    })
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });

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
router.post('/clients/:id/products', async (req, res) => {
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
router.put('/clients/:id/products/:pid', async (req, res) => {
  const { code, name, note, expires_at, sort_order, is_active } = req.body;
  const { data, error } = await supabase.from('client_products')
    .update({ code, name, note: note||null, expires_at: expires_at||null, sort_order: parseInt(sort_order)||0, is_active, updated_at: new Date().toISOString() })
    .eq('id', req.params.pid).eq('client_id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});
// クライアント商材削除
router.delete('/clients/:id/products/:pid', async (req, res) => {
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
router.post('/clients/:id/appeal-axes', async (req, res) => {
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
router.put('/clients/:id/appeal-axes/:aid', async (req, res) => {
  const { code, name, note, expires_at, sort_order, is_active } = req.body;
  const { data, error } = await supabase.from('client_appeal_axes')
    .update({ code, name, note: note||null, expires_at: expires_at||null, sort_order: parseInt(sort_order)||0, is_active, updated_at: new Date().toISOString() })
    .eq('id', req.params.aid).eq('client_id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});
// クライアント訴求軸削除
router.delete('/clients/:id/appeal-axes/:aid', async (req, res) => {
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
router.post('/projects/:id/products', async (req, res) => {
  const { code, name, note, sort_order } = req.body;
  if (!code || !name) return res.status(400).json({ error: 'コードと名称は必須です' });
  const { data, error } = await supabase.from('project_products')
    .insert({ project_id: req.params.id, code, name, note: note||null, sort_order: parseInt(sort_order)||0 })
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});
router.put('/projects/:id/products/:pid', async (req, res) => {
  const { code, name, note, sort_order, is_active } = req.body;
  const { data, error } = await supabase.from('project_products')
    .update({ code, name, note: note||null, sort_order: parseInt(sort_order)||0, is_active, updated_at: new Date().toISOString() })
    .eq('id', req.params.pid).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});
router.delete('/projects/:id/products/:pid', async (req, res) => {
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
router.post('/projects/:id/appeal-axes', async (req, res) => {
  const { code, name, note, sort_order } = req.body;
  if (!code || !name) return res.status(400).json({ error: 'コードと名称は必須です' });
  const { data, error } = await supabase.from('project_appeal_axes')
    .insert({ project_id: req.params.id, code, name, note: note||null, sort_order: parseInt(sort_order)||0 })
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});
router.put('/projects/:id/appeal-axes/:aid', async (req, res) => {
  const { code, name, note, sort_order, is_active } = req.body;
  const { data, error } = await supabase.from('project_appeal_axes')
    .update({ code, name, note: note||null, sort_order: parseInt(sort_order)||0, is_active, updated_at: new Date().toISOString() })
    .eq('id', req.params.aid).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});
router.delete('/projects/:id/appeal-axes/:aid', async (req, res) => {
  const { error } = await supabase.from('project_appeal_axes').delete().eq('id', req.params.aid);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// クライアントマスターから案件へコピー（商材）
router.post('/projects/:id/products/copy-from-client', async (req, res) => {
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
router.post('/projects/:id/appeal-axes/copy-from-client', async (req, res) => {
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
router.post('/master/categories', async (req, res) => {
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
router.put('/master/categories/:id', async (req, res) => {
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
router.delete('/master/categories/:id', async (req, res) => {
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
router.post('/master/items', async (req, res) => {
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
router.put('/master/items/:id', async (req, res) => {
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
router.delete('/master/items/:id', async (req, res) => {
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
    .select('*, users(full_name, role)')
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
    .select('*, users(full_name, role)')
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
    .select('*, users(full_name, role), creative_files(id, generated_name, creative_id, creatives(file_name, projects(name, clients(name))))')
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
router.post('/checklist-masters', requireAuth, async (req, res) => {
  const { title, description, sort_order, target_type } = req.body;
  if (!title) return res.status(400).json({ error: 'タイトルは必須です' });
  const { data, error } = await supabase.from('checklist_masters')
    .insert({ title, description, sort_order: sort_order || 0, target_type: target_type || 'all' }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// 基本チェックリスト更新
router.put('/checklist-masters/:id', requireAuth, async (req, res) => {
  const { title, description, sort_order, is_active, target_type } = req.body;
  const { data, error } = await supabase.from('checklist_masters')
    .update({ title, description, sort_order, is_active, target_type: target_type || 'all', updated_at: new Date().toISOString() })
    .eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// 基本チェックリスト削除
router.delete('/checklist-masters/:id', requireAuth, async (req, res) => {
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

// パスワードリセット（管理者は全員分、一般ユーザーは自分のみ）
router.post('/users/:id/reset-password', requireAuth, async (req, res) => {
  const isSelf = req.user.id === req.params.id;
  const ROLE_LEVEL = { admin: 6, secretary: 5, producer: 5, producer_director: 4, director: 3, designer: 2, editor: 1 };
  const isAdmin = (ROLE_LEVEL[req.user.role] || 0) >= 5;
  if (!isSelf && !isAdmin) return res.status(403).json({ error: '他のユーザーのパスワードを変更する権限がありません' });
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 8) return res.status(400).json({ error: 'パスワードは8文字以上必要です' });
  const hash = await bcrypt.hash(newPassword, 12);
  const { error } = await supabase.from('users').update({ password_hash: hash }).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

module.exports = router;
