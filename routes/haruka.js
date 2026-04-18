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
      projects(id, name, producer_id, director_id, clients(id, name, client_code)),
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
    assignee_id, internal_code, production_date
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
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  // 担当者を creative_assignments に登録
  if (assignee_id) {
    await supabase.from('creative_assignments').insert({
      creative_id: data.id,
      user_id: assignee_id,
      role: 'editor',
    });
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
  if (rootFolderId && process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
    let driveStep = 'init';
    try {
      const drive = await getDriveService();

      // ルート → クライアント名 → 案件名 を自動作成
      const clientName = (project?.clients?.name || 'その他').replace(/[/\\?%*:|"<>]/g, '_');
      const projectName = (project?.name || '案件未設定').replace(/[/\\?%*:|"<>]/g, '_');

      driveStep = 'clientFolder';
      const clientFolderId = await getOrCreateFolder(drive, rootFolderId, clientName);
      if (!clientFolderId) throw new Error(`クライアントフォルダ作成失敗: ${clientName}`);

      driveStep = 'projectFolder';
      const baseFolderId = await getOrCreateFolder(drive, clientFolderId, projectName);
      if (!baseFolderId) throw new Error(`案件フォルダ作成失敗: ${projectName}`);

      const now = new Date();
      const yyyymm = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;

      // 動画か静止画かでフォルダ名を分ける
      const isVideo = file.mimetype.startsWith('video/');
      const typeFolder = isVideo ? '動画' : '静止画';

      // ファイル名から作業フォルダ名（サイズ・バージョン・拡張子を除いた部分）を生成
      const workFolderName = (generated_name || file.originalname)
        .replace(/\.[^.]+$/, '')
        .replace(/_\d+_\d+_v\d+$/, '');

      driveStep = 'monthFolder';
      const monthFolderId = await getOrCreateFolder(drive, baseFolderId, yyyymm);

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

      driveStep = 'workFolder';
      const workFolderId = await getOrCreateFolder(drive, typeFolderId, workFolderName);

      // ファイルをアップロード（PassThrough stream で安定化）
      driveStep = 'fileUpload';
      const { PassThrough } = require('stream');
      const passThrough = new PassThrough();
      passThrough.end(file.buffer);

      const uploadRes = await drive.files.create({
        requestBody: {
          name: generated_name || file.originalname,
          parents: [workFolderId],
        },
        media: { mimeType: file.mimetype, body: passThrough },
        fields: 'id, webViewLink',
        supportsAllDrives: true,
      });

      driveFileId = uploadRes.data.id;
      driveUrl    = uploadRes.data.webViewLink;

      driveStep = 'permission';
      try {
        await drive.permissions.create({
          fileId: driveFileId,
          supportsAllDrives: true,
          requestBody: { role: 'reader', type: 'anyone' },
        });
      } catch (permErr) {
        console.error('Drive permission error:', permErr.message);
      }
    } catch (e) {
      console.error(`Drive upload error [step=${driveStep}]:`, e.message);
      driveError = `[${driveStep}] ${e.message}`;
    }
  } else {
    driveError = rootFolderId ? null : 'drive_root_folder_id が未設定です';
    if (!process.env.GOOGLE_SERVICE_ACCOUNT_KEY) driveError = 'GOOGLE_SERVICE_ACCOUNT_KEY が未設定です';
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

  res.json({ ok: true, file: fileRecord, drive_url: driveUrl, drive_error: driveError });
});

// Google Drive ファイルストリーミングプロキシ（ネイティブ動画プレビュー用）
router.get('/files/:fileId/stream', async (req, res) => {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_KEY) return res.status(503).json({ error: 'Drive未設定' });
  try {
    const drive = await getDriveService();
    const meta = await drive.files.get({ fileId: req.params.fileId, fields: 'mimeType,name', supportsAllDrives: true });
    const mimeType = meta.data.mimeType || 'video/mp4';
    const streamRes = await drive.files.get(
      { fileId: req.params.fileId, alt: 'media', supportsAllDrives: true },
      { responseType: 'stream' }
    );
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    streamRes.data.pipe(res);
  } catch (e) {
    console.error('Drive stream error:', e.message);
    res.status(500).json({ error: e.message });
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
    .select('id, email, full_name, role, job_type, rank, team_id, slack_dm_id, chatwork_dm_id, is_active, left_at, left_reason, birthday, weekday_hours, weekend_hours, note, bank_name, bank_code, branch_name, branch_code, account_type, account_number, account_holder_kana')
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
    full_name, role, job_type, rank,
    team_id, slack_dm_id, chatwork_dm_id,
    is_active, left_at, left_reason,
    birthday, weekday_hours, weekend_hours, note,
    bank_name, bank_code, branch_name, branch_code,
    account_type, account_number, account_holder_kana
  } = req.body;

  const updateData = {
    full_name, job_type,
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

// 請求書プレビュー：自分のクリエイティブ一覧＋単価を返す
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

  const result = myCreatives.map(c => {
    const assignment = c.creative_assignments?.find(a => a.user_id === uid);
    const rateKey = `${c.project_id}__${c.creative_type}__${assignment?.rank_applied}`;
    const rate = ratesMap[rateKey] || null;
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
      rank_applied: assignment?.rank_applied,
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

// 請求書作成（選択クリエイティブから生成）
router.post('/invoices/generate', async (req, res) => {
  const { issuer_id, project_id, cycle_id, selected_creative_ids } = req.body;
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

    const rate = rates?.find(
      r => r.project_id === creative.project_id && r.creative_type === creative.creative_type && r.rank === assignment.rank_applied
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

// ==================== システム設定 ====================

const SUPER_ADMIN_EMAILS = ['hiikun.ascs@gmail.com', 'satoru.takahashi@haruka-film.com'];

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
      user_id: req.user?.supabase_user_id || null,
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
  const userId = req.user?.supabase_user_id;
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

module.exports = router;
