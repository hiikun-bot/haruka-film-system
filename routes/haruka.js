// routes/haruka.js — HARUKA FILM SYSTEM API
const express = require('express');
const router = express.Router();
const supabase = require('../supabase');
const multer = require('multer');
const { requireAuth, requireLevel } = require('../auth');
const { google } = require('googleapis');
const { Readable } = require('stream');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 500 * 1024 * 1024 } });

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
    sheet_url, drive_folder_url, regulation_url, admin_note, start_date, end_date,
    chatwork_room_id, slack_team_id, slack_channel_id
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
      drive_folder_url: drive_folder_url || null,
      regulation_url: regulation_url || null,
      admin_note: admin_note || null,
      start_date: start_date || null,
      end_date: end_date || null,
      chatwork_room_id: chatwork_room_id || null,
      slack_team_id: slack_team_id || null,
      slack_channel_id: slack_channel_id || null,
      is_hidden: false
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
    sheet_url, drive_folder_url, regulation_url, admin_note, start_date, end_date,
    chatwork_room_id, slack_team_id, slack_channel_id, is_hidden,
    sync_products, sync_appeal_axes
  } = req.body;
  const updateData = {
    name, status,
    producer_id: producer_id || null,
    director_id: director_id || null,
    sheet_url: sheet_url || null,
    drive_folder_url: drive_folder_url || null,
    regulation_url: regulation_url || null,
    admin_note: admin_note || null,
    start_date: start_date || null,
    end_date: end_date || null,
    chatwork_room_id: chatwork_room_id || null,
    slack_team_id: slack_team_id || null,
    slack_channel_id: slack_channel_id || null,
    is_hidden: is_hidden ?? false,
    updated_at: new Date().toISOString()
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

// 単価設定・更新（upsert）
router.post('/projects/:id/rates', async (req, res) => {
  const { creative_type, rank, base_fee, script_fee, ai_fee, other_fee, other_fee_note } = req.body;
  if (!creative_type || !rank) return res.status(400).json({ error: '種別・ランクは必須です' });
  const { data, error } = await supabase
    .from('project_rates')
    .upsert({
      project_id: req.params.id,
      creative_type, rank,
      base_fee: base_fee || 0,
      script_fee: script_fee || 0,
      ai_fee: ai_fee || 0,
      other_fee: other_fee || 0,
      other_fee_note,
      updated_at: new Date().toISOString()
    }, { onConflict: 'project_id,creative_type,rank' })
    .select()
    .single();
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

// クライアント報酬設定 保存（upsert）
router.post('/projects/:id/client-fee', async (req, res) => {
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
        users(id, full_name, role)
      )
    `)
    .order('final_deadline', { ascending: true, nullsFirst: false });

  if (project_id) query = query.eq('project_id', project_id);
  if (cycle_id) query = query.eq('cycle_id', cycle_id);
  if (status) query = query.eq('status', status);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  // ボール保持者を付与
  const withBall = data.map(c => ({
    ...c,
    ball_holder: getBallHolder(c.status, c.creative_assignments)
  }));

  res.json(withBall);
});

// クリエイティブ単体取得
router.get('/creatives/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('creatives')
    .select(`
      *,
      projects(id, name, drive_folder_url, clients(id, name, client_code)),
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

// クリエイティブ作成
// 一括登録
router.post('/creatives/bulk', async (req, res) => {
  const {
    project_id, creative_type, appeal_type_id,
    count, draft_deadline, final_deadline, note
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
    .from('appeal_types').select('*').eq('id', appeal_type_id).single();
  if (!project || !appealType) {
    return res.status(400).json({ error: '案件または訴求タイプが見つかりません' });
  }
  const clientCode = (project.clients?.client_code ||
    project.clients?.name?.slice(0, 3).toUpperCase() || 'UNK').toUpperCase().slice(0, 3);
  const { data: existingCreatives } = await supabase
    .from('creatives').select('file_name').eq('project_id', project_id);
  const usedSeqs = (existingCreatives || [])
    .map(c => c.file_name?.slice(0, 3)).filter(s => /^\d{3}$/.test(s)).map(Number);
  const { data: pat } = await supabase
    .from('project_appeal_types').select('*')
    .eq('project_id', project_id).eq('appeal_type_id', appeal_type_id).single();
  let appealSeq = pat?.seq_counter || 0;
  const inserts = [];
  let nextSeq = 1;
  for (let i = 0; i < count; i++) {
    while (usedSeqs.includes(nextSeq)) nextSeq++;
    appealSeq++;
    const seqStr = String(nextSeq).padStart(3, '0');
    const appealSeqStr = String(appealSeq).padStart(2, '0');
    const fileName = `${seqStr}_${clientCode}_${appealType.code}${appealSeqStr}_v1`;
    inserts.push({ project_id, file_name: fileName, creative_type,
      draft_deadline: draft_deadline || null, final_deadline: final_deadline || null,
      note: note || null, status: '未着手' });
    usedSeqs.push(nextSeq);
    nextSeq++;
  }
  const { data, error } = await supabase.from('creatives').insert(inserts).select();
  if (error) return res.status(500).json({ error: error.message });
  await supabase.from('projects').update({ seq_counter: Math.max(...usedSeqs) }).eq('id', project_id);
  if (pat) {
    await supabase.from('project_appeal_types').update({ seq_counter: appealSeq }).eq('id', pat.id);
  }
  res.json({ ok: true, count: data.length, creatives: data });
});

// 個別登録
router.post('/creatives', async (req, res) => {
  const {
    project_id, cycle_id, file_name, creative_type,
    draft_deadline, final_deadline, script_url, note, appeal_type_id
  } = req.body;
  if (!project_id || !file_name || !creative_type) {
    return res.status(400).json({ error: '案件・ファイル名・種別は必須です' });
  }
  const fileNamePattern = /^\d{3}_/;
  if (!fileNamePattern.test(file_name)) {
    return res.status(400).json({ error: 'ファイル名は先頭3桁が数字の連番で始まる必要があります（例：001_ARU_UGC01_v1）' });
  }
  const seqNum = file_name.slice(0, 3);
  const { data: allCreatives } = await supabase
    .from('creatives').select('file_name').eq('project_id', project_id).order('file_name', { ascending: true });
  const usedSeqs = (allCreatives || [])
    .map(c => c.file_name?.slice(0, 3)).filter(s => /^\d{3}$/.test(s)).map(Number);
  if (usedSeqs.includes(Number(seqNum))) {
    const existing = allCreatives.find(c => c.file_name?.startsWith(seqNum + '_'));
    let nextSeq = 1;
    while (usedSeqs.includes(nextSeq)) nextSeq++;
    return res.status(400).json({
      error: `連番「${seqNum}」はすでに使用されています（${existing?.file_name}）`,
      next_seq: String(nextSeq).padStart(3, '0')
    });
  }
  const { data, error } = await supabase.from('creatives').insert({
    project_id, cycle_id, file_name, creative_type,
    draft_deadline, final_deadline, script_url, note, status: '未着手'
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  if (appeal_type_id) {
    const { data: proj } = await supabase.from('projects').select('seq_counter').eq('id', project_id).single();
    await supabase.from('projects').update({ seq_counter: (proj?.seq_counter || 0) + 1 }).eq('id', project_id);
    const { data: pat } = await supabase.from('project_appeal_types').select('*')
      .eq('project_id', project_id).eq('appeal_type_id', appeal_type_id).single();
    if (pat) {
      await supabase.from('project_appeal_types').update({ seq_counter: (pat?.seq_counter || 0) + 1 }).eq('id', pat.id);
    }
  }
  res.json(data);
});

// クリエイティブ更新
router.put('/creatives/:id', async (req, res) => {
  const {
    file_name, status, deadline, draft_deadline, final_deadline, script_url,
    frameio_url, delivery_url, final_delivery_url,
    help_flag, note, revision_count,
    director_comment, client_comment
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
  if (note !== undefined) updateData.note = note;
  if (revision_count !== undefined) updateData.revision_count = revision_count;
  if (director_comment !== undefined) updateData.director_comment = director_comment;
  if (client_comment !== undefined) updateData.client_comment = client_comment;

  // 納品完了時に支払い可能フラグを自動オン
  if (status === '納品') updateData.is_payable = true;

  const { data, error } = await supabase
    .from('creatives')
    .update(updateData)
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
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
    .select('*, projects(id, name, drive_folder_url, clients(id, name, client_code))')
    .eq('id', creativeId)
    .single();
  if (cErr) return res.status(500).json({ error: cErr.message });

  const project = creative.projects;
  let driveFileId = null;
  let driveUrl = null;

  // Google Drive にアップロード（credentials が設定されている場合のみ）
  if (project?.drive_folder_url && process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
    try {
      const drive = await getDriveService();
      const baseFolderId = extractFolderIdFromUrl(project.drive_folder_url);
      if (!baseFolderId) throw new Error('Drive フォルダIDを取得できません');

      // サイクル: YYYYMM（当月）
      const now = new Date();
      const cycleFolder = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;

      // 動画か静止画かでフォルダ名を分ける
      const isVideo = file.mimetype.startsWith('video/');
      const typeFolder = isVideo ? '動画' : '静止画';

      // ファイル名から作業フォルダ名（サイズ・バージョン・拡張子を除いた部分）を生成
      // e.g. "001_ARU_UGC001_1080_1920_v1.mp4" → "001_ARU_UGC001"
      const workFolderName = (generated_name || file.originalname)
        .replace(/\.[^.]+$/, '')           // 拡張子除去
        .replace(/_\d+_\d+_v\d+$/, '');    // _W_H_vN 除去

      // フォルダ階層: {base}/{YYYYMM}/{動画|静止画}/{workFolder}/
      const cycleFolderId = await getOrCreateFolder(drive, baseFolderId, cycleFolder);
      const typeFolderId  = await getOrCreateFolder(drive, cycleFolderId, typeFolder);
      const workFolderId  = await getOrCreateFolder(drive, typeFolderId, workFolderName);

      // ファイルをアップロード
      const stream = new Readable();
      stream.push(file.buffer);
      stream.push(null);

      const uploadRes = await drive.files.create({
        requestBody: {
          name: generated_name || file.originalname,
          parents: [workFolderId],
        },
        media: { mimeType: file.mimetype, body: stream },
        fields: 'id, webViewLink',
        supportsAllDrives: true,
      });

      driveFileId = uploadRes.data.id;
      driveUrl    = uploadRes.data.webViewLink;
    } catch (e) {
      console.error('Drive upload error:', e.message);
      // Drive 失敗でも DB 記録は続ける（エラー内容をレスポンスに含める）
    }
  }

  // creative_files テーブルに記録
  const uploadedBy = req.user?.supabase_user_id || null;
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

  res.json({ ok: true, file: fileRecord, drive_url: driveUrl });
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
    .select('id, email, full_name, role, job_type, rank, team_id, slack_dm_id, chatwork_dm_id, is_active, left_at, left_reason, birthday, weekday_hours, weekend_hours')
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
    const { full_name, email, role, job_type, rank, team_code, birthday } = m;
    if (!full_name || !email || !role) { failed++; continue; }
    const { error } = await supabase.from('users').insert({
      full_name, email, role,
      job_type: job_type || null,
      rank: rank || null,
      team_id: team_code ? (teamMap[team_code] || null) : null,
      birthday: birthday || null,
      weekday_hours: [{from:9,to:18}]
    });
    if (error) { failed++; } else { created++; }
  }
  res.json({ created, failed });
});

// メンバー更新
router.put('/members/:id', async (req, res) => {
  const {
    full_name, role, job_type, rank,
    team_id, slack_dm_id, chatwork_dm_id,
    is_active, left_at, left_reason,
    birthday, weekday_hours, weekend_hours
  } = req.body;
  const { data, error } = await supabase
    .from('users')
    .update({
      full_name, role, job_type,
      rank: rank || null,
      team_id: team_id || null,
      slack_dm_id: slack_dm_id || null,
      chatwork_dm_id: chatwork_dm_id || null,
      is_active,
      left_at: left_at || null,
      left_reason: left_reason || null,
      birthday: birthday || null,
      weekday_hours: weekday_hours || null,
      weekend_hours: weekend_hours || null,
      updated_at: new Date().toISOString()
    })
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
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
    .select(`*, projects(id,name,clients(id,name)), issuer:users!invoices_issuer_id_fkey(id,full_name), recipient:users!invoices_recipient_id_fkey(id,full_name), invoice_items(id,total_amount,is_special,special_reason,creatives(id,file_name,creative_type),invoice_item_details(*))`)
    .order('created_at', { ascending: false });
  if (issuer_id) query = query.eq('issuer_id', issuer_id);
  if (year) query = query.eq('year', parseInt(year));
  if (month) query = query.eq('month', parseInt(month));
  if (status) query = query.eq('status', status);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// 請求書作成（納品完了クリエイティブから自動生成）
router.post('/invoices/generate', async (req, res) => {
  const { issuer_id, project_id, cycle_id } = req.body;
  if (!issuer_id || !project_id) return res.status(400).json({ error: '発行者・案件は必須です' });

  // 請求可能なクリエイティブを取得
  let query = supabase
    .from('creatives')
    .select(`
      *,
      creative_assignments(user_id, role, rank_applied, users(id, full_name))
    `)
    .eq('project_id', project_id)
    .or('is_payable.eq.true,special_payable.eq.true');

  if (cycle_id) query = query.eq('cycle_id', cycle_id);

  const { data: creatives, error: cErr } = await query;
  if (cErr) return res.status(500).json({ error: cErr.message });
  if (!creatives.length) return res.status(400).json({ error: '請求可能なクリエイティブがありません' });

  // 単価を取得
  const { data: rates } = await supabase
    .from('project_rates')
    .select('*')
    .eq('project_id', project_id);

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

    const rate = rates?.find(
      r => r.creative_type === creative.creative_type && r.rank === assignment.rank_applied
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
    })
    .select()
    .single();
  if (iErr) return res.status(500).json({ error: iErr.message });

  // 明細を保存
  for (const item of items) {
    const { data: invItem } = await supabase
      .from('invoice_items')
      .insert({
        invoice_id: invoice.id,
        creative_id: item.creative_id,
        total_amount: item.total_amount,
        is_special: item.is_special,
        special_reason: item.special_reason
      })
      .select()
      .single();

    if (item.details.length) {
      await supabase.from('invoice_item_details').insert(
        item.details.map(d => ({ ...d, invoice_item_id: invItem.id }))
      );
    }
  }

  res.json({ ok: true, invoice_number: invoiceNumber, total_amount: totalAmount, items_count: items.length });
});

// 請求書発行（draft → issued）
router.post('/invoices/:id/issue', async (req, res) => {
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
router.post('/invoices/:id/submit', async (req, res) => {
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
    .update({ status: 'approved', approved_at: new Date().toISOString(), approved_by: req.user?.supabase_user_id || null, updated_at: new Date().toISOString() })
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

// 請求書削除（draft のみ）
router.delete('/invoices/:id', async (req, res) => {
  const { error } = await supabase.from('invoices').delete().eq('id', req.params.id).eq('status', 'draft');
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ==================== ボール保持者判定 ====================

function getBallHolder(status, assignments) {
  const editor = assignments?.find(a => a.role === 'editor' || a.role === 'designer' || a.role === 'director_as_editor');
  const director = assignments?.find(a => a.role === 'director');

  const editorName = editor?.users?.full_name || '編集者';
  const directorName = director?.users?.full_name || 'ディレクター';

  const ballMap = {
    '未着手': { holder: editorName, type: 'editor' },
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
  const { appeal_type_id } = req.body;
  if (!appeal_type_id) return res.status(400).json({ error: '訴求タイプは必須です' });

  const { data: project, error: pErr } = await supabase
    .from('projects')
    .select(`*, clients(id, name, client_code)`)
    .eq('id', req.params.id)
    .single();
  if (pErr) return res.status(500).json({ error: pErr.message });

  const { data: appealType, error: aErr } = await supabase
    .from('appeal_types')
    .select('*')
    .eq('id', appeal_type_id)
    .single();
  if (aErr) return res.status(500).json({ error: aErr.message });

  const clientCode = (project.clients?.client_code ||
    project.clients?.name?.slice(0, 3).toUpperCase() || 'UNK')
    .toUpperCase().slice(0, 3);

  // 案件内の使用済みシーケンス番号を取得
  const { data: allCreatives } = await supabase
    .from('creatives')
    .select('file_name')
    .eq('project_id', req.params.id);

  const usedSeqs = (allCreatives || [])
    .map(c => c.file_name?.slice(0, 3))
    .filter(s => /^\d{3}$/.test(s))
    .map(Number);

  // 次に使える番号を計算（DBのseq_counterではなく実際の使用済み番号から計算）
  let nextSeq = 1;
  while (usedSeqs.includes(nextSeq)) nextSeq++;

  // 訴求タイプの連番
  const { data: pat } = await supabase
    .from('project_appeal_types')
    .select('*')
    .eq('project_id', req.params.id)
    .eq('appeal_type_id', appeal_type_id)
    .single();

  const nextAppealSeq = (pat?.seq_counter || 0) + 1;

  const seqStr = String(nextSeq).padStart(3, '0');
  const appealSeqStr = String(nextAppealSeq).padStart(2, '0');
  const fileName = `${seqStr}_${clientCode}_${appealType.code}${appealSeqStr}_v1`;

  // DBは更新しない
  res.json({
    file_name: fileName,
    seq: nextSeq,
    total: usedSeqs.length,
    appeal_seq: nextAppealSeq,
    client_code: clientCode,
    appeal_code: appealType.code
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
      producer:users!teams_producer_id_fkey(id, full_name)
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
  const { team_name, team_type, director_id, producer_id, is_active } = req.body;
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
  const { code, name, note, sort_order } = req.body;
  if (!code || !name) return res.status(400).json({ error: 'コードと名称は必須です' });
  const { data, error } = await supabase.from('client_products')
    .insert({ client_id: req.params.id, code, name, note: note||null, sort_order: parseInt(sort_order)||0 })
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});
// クライアント商材更新
router.put('/clients/:id/products/:pid', async (req, res) => {
  const { code, name, note, sort_order, is_active } = req.body;
  const { data, error } = await supabase.from('client_products')
    .update({ code, name, note: note||null, sort_order: parseInt(sort_order)||0, is_active, updated_at: new Date().toISOString() })
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
  const { code, name, note, sort_order } = req.body;
  if (!code || !name) return res.status(400).json({ error: 'コードと名称は必須です' });
  const { data, error } = await supabase.from('client_appeal_axes')
    .insert({ client_id: req.params.id, code, name, note: note||null, sort_order: parseInt(sort_order)||0 })
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});
// クライアント訴求軸更新
router.put('/clients/:id/appeal-axes/:aid', async (req, res) => {
  const { code, name, note, sort_order, is_active } = req.body;
  const { data, error } = await supabase.from('client_appeal_axes')
    .update({ code, name, note: note||null, sort_order: parseInt(sort_order)||0, is_active, updated_at: new Date().toISOString() })
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

// 区分マスター更新
router.put('/master/categories/:id', async (req, res) => {
  const { name, code, sort_order, is_active } = req.body;
  const { data, error } = await supabase
    .from('master_categories')
    .update({ name, code, sort_order: parseInt(sort_order) || 0, is_active, updated_at: new Date().toISOString() })
    .eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// 区分マスター削除
router.delete('/master/categories/:id', async (req, res) => {
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
  const { category_id, category_code } = req.query;
  const now = new Date().toISOString();
  let query = supabase
    .from('master_items')
    .select('*, master_categories(id, name, code)')
    .eq('is_active', true)
    .or(`expires_at.is.null,expires_at.gt.${now}`)
    .order('sort_order').order('created_at');
  if (category_id)   query = query.eq('category_id', category_id);
  if (category_code) query = query.eq('master_categories.code', category_code);
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

  const result = await Promise.all((cycles || []).map(async cycle => {
    const { data: creatives } = await supabase
      .from('creatives')
      .select('id, creative_type')
      .eq('cycle_id', cycle.id);

    const videoCount = (creatives || []).filter(c =>
      c.creative_type && (c.creative_type.includes('動画') || c.creative_type.toLowerCase().includes('video'))
    ).length;
    const designCount = (creatives || []).filter(c =>
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
  }));

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

module.exports = router;
