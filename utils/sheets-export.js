// utils/sheets-export.js
// ADR 008 Phase 1: クリエイティブ管理シート出力（片方向同期 → Google Sheets）
//
// 設計原本: docs/design/decisions/008-system-as-master-sheet-export.md
//
// 役割:
//   - system_settings からマッピング JSON / マスターテンプレ URL を取得
//   - creatives + creative_versions を読み込み、マッピングに従って 2D 配列を構築
//   - Google Sheets API でタブごとに上書き書き込み
//   - 未設定なら master template をコピー作成して projects.creatives_export_sheet_url を埋める

const { google } = require('googleapis');
const supabase = require('../supabase');

// ---------- DEFAULT_MAPPING（あるるシートを参考） ----------
const DEFAULT_MAPPING = {
  fixed_columns: [
    { header: '案件番号',   system_field: 'internal_code',   sync: 'to_sheet' },
    { header: '編集者',     system_field: 'assignee_name',   sync: 'to_sheet' },
    { header: 'ファイル名', system_field: 'file_name',       sync: 'to_sheet' },
    { header: '納期',       system_field: 'final_deadline',  sync: 'to_sheet' },
    { header: 'ステータス', system_field: 'status',          sync: 'to_sheet' },
    { header: 'Frame.io',   system_field: 'frameio_url',     sync: 'to_sheet' },
    { header: '編集者からのコメント',         system_field: 'editor_comment',   sync: 'to_sheet' },
    { header: 'ディレクターからの修正点',     system_field: 'director_comment', sync: 'to_sheet' },
    { header: 'クライアントへの初稿URL',       system_field: 'delivery_url',     sync: 'to_sheet' },
    { header: 'あるるさんへの初稿の説明や質問など', system_field: 'client_comment', sync: 'to_sheet' },
  ],
  version_block: {
    max_versions: 5,
    columns_per_version: [
      { header_tpl: 'URL({n}回目)',                      system_field: 'version.preview_url',     sync: 'to_sheet' },
      { header_tpl: '編集者からのコメント({n}回目)',     system_field: 'version.editor_comment',   sync: 'to_sheet' },
      { header_tpl: 'ディレクターからの修正点({n}回目)', system_field: 'version.director_comment', sync: 'to_sheet' },
      { header_tpl: '修正指示({n}回目)',                 system_field: 'version.client_comment',   sync: 'to_sheet' },
    ],
  },
  final_column: { header: '最終納品', system_field: 'final_delivery_url', sync: 'to_sheet' },
  tabs: {
    '動画管理':   { creative_type_filter: '動画' },
    '静止画管理': { creative_type_filter: '静止画' },
  },
};

// ---------- Google auth ----------
function getAuth() {
  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!keyJson) throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY が設定されていません');
  const credentials = JSON.parse(keyJson);
  return new google.auth.GoogleAuth({
    credentials,
    scopes: [
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/spreadsheets',
    ],
  });
}

function extractSpreadsheetId(url) {
  if (!url) return null;
  const m = String(url).match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return m ? m[1] : null;
}

// ---------- system_settings からマッピング取得 ----------
async function getMasterMapping() {
  const { data, error } = await supabase
    .from('system_settings')
    .select('key, value')
    .in('key', ['creatives_export_mapping_json', 'creatives_export_master_template_url']);
  if (error) throw new Error(`system_settings 取得失敗: ${error.message}`);

  const map = {};
  (data || []).forEach((r) => { map[r.key] = r.value; });

  let mapping = DEFAULT_MAPPING;
  if (map.creatives_export_mapping_json) {
    try {
      const parsed = JSON.parse(map.creatives_export_mapping_json);
      if (parsed && typeof parsed === 'object') mapping = parsed;
    } catch (e) {
      console.warn('[sheets-export] mapping JSON parse error, fallback to DEFAULT:', e.message);
    }
  }
  return {
    mapping,
    masterTemplateUrl: map.creatives_export_master_template_url || null,
  };
}

// ---------- creative の system_field を解決 ----------
function resolveCreativeField(creative, field) {
  if (!field) return '';
  switch (field) {
    case 'internal_code':      return creative.internal_code || '';
    case 'file_name':          return creative.file_name || '';
    case 'final_deadline':     return creative.final_deadline || '';
    case 'draft_deadline':     return creative.draft_deadline || '';
    case 'status':             return creative.status || '';
    case 'frameio_url':        return creative.frameio_url || '';
    case 'delivery_url':       return creative.delivery_url || '';
    case 'final_delivery_url': return creative.final_delivery_url || '';
    case 'client_review_url':  return creative.client_review_url || '';
    case 'script_url':         return creative.script_url || '';
    case 'editor_comment':     return creative.editor_comment || '';
    case 'director_comment':   return creative.director_comment || '';
    case 'client_comment':     return creative.client_comment || '';
    case 'memo':               return creative.memo || '';
    case 'creative_type':      return creative.creative_type || '';
    case 'project_name':       return creative.projects?.name || '';
    case 'client_name':        return creative.projects?.clients?.name || '';
    case 'assignee_name': {
      // 編集者（editor）優先。なければ creative_assignments の先頭ユーザー名。
      const editors = (creative.creative_assignments || []).filter((a) => a.role === 'editor' || a.role === '編集者');
      const target = editors.length ? editors : (creative.creative_assignments || []);
      return target.map((a) => a.users?.full_name || a.users?.nickname || '').filter(Boolean).join(' / ');
    }
    default:
      // ネスト解決（projects.name 等）
      if (field.includes('.')) {
        return field.split('.').reduce((obj, k) => (obj == null ? '' : obj[k]), creative) || '';
      }
      return creative[field] ?? '';
  }
}

function resolveVersionField(version, field) {
  // 'version.preview_url' → 'preview_url'
  const key = field.startsWith('version.') ? field.slice('version.'.length) : field;
  if (!version) return '';
  return version[key] ?? '';
}

// ---------- 1 タブ分の 2D 配列を構築 ----------
function buildSheetRows({ creatives, mapping }) {
  const fixedCols = mapping.fixed_columns || [];
  const versionBlock = mapping.version_block || { max_versions: 0, columns_per_version: [] };
  const finalCol = mapping.final_column || null;

  // 実際に使われているバージョン数の最大値（最低 1 を確保）
  let maxVersionsUsed = 1;
  for (const c of creatives) {
    const versions = c.creative_versions || [];
    if (versions.length === 0) continue;
    const maxN = Math.max(...versions.map((v) => v.version_number || 0));
    // version_number は 0=初稿, 1〜N=修正回。表示列は max(version_number) +1 個分
    maxVersionsUsed = Math.max(maxVersionsUsed, maxN + 1);
  }
  const maxVersions = Math.min(maxVersionsUsed, versionBlock.max_versions || 5);

  // ---------- ヘッダー行 ----------
  const header = [];
  for (const col of fixedCols) header.push(col.header);
  for (let n = 1; n <= maxVersions; n++) {
    for (const c of (versionBlock.columns_per_version || [])) {
      header.push(String(c.header_tpl || '').replace(/\{n\}/g, String(n)));
    }
  }
  if (finalCol) header.push(finalCol.header);

  // ---------- データ行 ----------
  const rows = [header];
  for (const cr of creatives) {
    const row = [];
    for (const col of fixedCols) {
      row.push(resolveCreativeField(cr, col.system_field));
    }
    // バージョン列：cr.creative_versions[i] (i=0..maxVersions-1, version_number=i)
    const byVer = new Map();
    for (const v of (cr.creative_versions || [])) byVer.set(v.version_number, v);
    for (let n = 0; n < maxVersions; n++) {
      const v = byVer.get(n) || null;
      for (const c of (versionBlock.columns_per_version || [])) {
        row.push(resolveVersionField(v, c.system_field));
      }
    }
    if (finalCol) row.push(resolveCreativeField(cr, finalCol.system_field));
    rows.push(row);
  }
  return { rows, maxVersionsUsed: maxVersions };
}

// ---------- マスターテンプレ URL からシートをコピー作成 ----------
async function copyMasterTemplate(drive, templateSpreadsheetId, projectName) {
  const folderId = process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID || null;
  const requestBody = {
    name: `クリエイティブ管理_${projectName || ''}_${new Date().toISOString().slice(0, 10)}`,
  };
  if (folderId) requestBody.parents = [folderId];

  const copy = await drive.files.copy({
    fileId: templateSpreadsheetId,
    requestBody,
    supportsAllDrives: true,
    fields: 'id, webViewLink',
  });
  return { id: copy.data.id, url: copy.data.webViewLink };
}

// ---------- 新規スプレッドシート作成（テンプレ URL 未設定時のフォールバック） ----------
async function createBlankSpreadsheet(drive, sheets, projectName, tabNames) {
  const folderId = process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID || null;
  const requestBody = {
    name: `クリエイティブ管理_${projectName || ''}_${new Date().toISOString().slice(0, 10)}`,
    mimeType: 'application/vnd.google-apps.spreadsheet',
  };
  if (folderId) requestBody.parents = [folderId];

  const file = await drive.files.create({
    requestBody,
    supportsAllDrives: true,
    fields: 'id, webViewLink',
  });
  // 必要なタブを作る（デフォルトの「シート1」をリネーム + 追加分は addSheet）
  const meta = await sheets.spreadsheets.get({ spreadsheetId: file.data.id, fields: 'sheets.properties' });
  const existingFirst = meta.data.sheets?.[0]?.properties;
  const requests = [];
  if (existingFirst && tabNames[0] && existingFirst.title !== tabNames[0]) {
    requests.push({
      updateSheetProperties: {
        properties: { sheetId: existingFirst.sheetId, title: tabNames[0] },
        fields: 'title',
      },
    });
  }
  for (let i = 1; i < tabNames.length; i++) {
    requests.push({ addSheet: { properties: { title: tabNames[i] } } });
  }
  if (requests.length) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: file.data.id,
      requestBody: { requests },
    });
  }
  return { id: file.data.id, url: file.data.webViewLink };
}

// ---------- 既存スプレッドシートに同名タブが無ければ追加 ----------
async function ensureTabsExist(sheets, spreadsheetId, tabNames) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties' });
  const existing = new Set((meta.data.sheets || []).map((s) => s.properties?.title));
  const missing = tabNames.filter((t) => !existing.has(t));
  if (missing.length === 0) return;
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: missing.map((t) => ({ addSheet: { properties: { title: t } } })),
    },
  });
}

// ---------- メインエントリ ----------
async function syncToSheet(projectId /* , userId */) {
  if (!projectId) throw new Error('projectId は必須です');

  // 1) project + creatives + versions をまとめて取得
  const { data: project, error: projErr } = await supabase
    .from('projects')
    .select('id, name, creatives_export_sheet_url, clients(id, name)')
    .eq('id', projectId)
    .single();
  if (projErr || !project) throw new Error(`案件取得失敗: ${projErr?.message || 'not found'}`);

  // creatives を creative_versions / projects / clients / assignments とともに取得
  const SELECT = `
    id, project_id, file_name, status, creative_type,
    internal_code, draft_deadline, final_deadline,
    script_url, frameio_url, delivery_url, final_delivery_url, client_review_url,
    editor_comment, director_comment, client_comment, memo,
    created_at, updated_at,
    projects(id, name, clients(id, name)),
    creative_assignments(role, users(id, full_name, nickname)),
    creative_versions(id, version_number, preview_url, editor_comment, director_comment, client_comment, created_at, updated_at)
  `;
  const { data: creatives, error: cErr } = await supabase
    .from('creatives')
    .select(SELECT)
    .eq('project_id', projectId)
    .order('internal_code', { ascending: true })
    .order('created_at', { ascending: true });
  if (cErr) throw new Error(`クリエイティブ取得失敗: ${cErr.message}`);

  // 2) マッピング取得
  const { mapping, masterTemplateUrl } = await getMasterMapping();

  // 3) タブごとに行を構築
  const tabs = mapping.tabs || {};
  const tabNames = Object.keys(tabs);
  if (tabNames.length === 0) throw new Error('mapping.tabs が空です');

  const tabData = {}; // {タブ名: {rows, count}}
  for (const tabName of tabNames) {
    const cfg = tabs[tabName] || {};
    const filter = cfg.creative_type_filter;
    const filtered = filter
      ? (creatives || []).filter((c) => (c.creative_type || '').includes(filter))
      : (creatives || []);
    const { rows } = buildSheetRows({ creatives: filtered, mapping });
    tabData[tabName] = { rows, count: filtered.length };
  }

  // 4) Sheets API クライアント
  const auth = getAuth();
  const drive = google.drive({ version: 'v3', auth });
  const sheets = google.sheets({ version: 'v4', auth });

  // 5) 同期先 URL を確定（未設定なら作成）
  let sheetUrl = project.creatives_export_sheet_url || null;
  let spreadsheetId = extractSpreadsheetId(sheetUrl);

  if (!spreadsheetId) {
    if (masterTemplateUrl) {
      const tmplId = extractSpreadsheetId(masterTemplateUrl);
      if (!tmplId) throw new Error(`creatives_export_master_template_url が不正: ${masterTemplateUrl}`);
      const copied = await copyMasterTemplate(drive, tmplId, project.name || '');
      spreadsheetId = copied.id;
      sheetUrl = copied.url;
    } else {
      const created = await createBlankSpreadsheet(drive, sheets, project.name || '', tabNames);
      spreadsheetId = created.id;
      sheetUrl = created.url;
    }
    // projects.creatives_export_sheet_url を保存
    const { error: upErr } = await supabase
      .from('projects')
      .update({ creatives_export_sheet_url: sheetUrl, updated_at: new Date().toISOString() })
      .eq('id', projectId);
    if (upErr) console.warn('[sheets-export] sheet_url 保存失敗:', upErr.message);
  } else {
    // 既存シートに必要タブが存在するか確認・補完
    await ensureTabsExist(sheets, spreadsheetId, tabNames);
  }

  // 6) タブごとに書き込み（ヘッダー含めてクリア → 上書き）
  const writtenRows = {};
  for (const tabName of tabNames) {
    const { rows, count } = tabData[tabName];
    // 旧データをクリア
    await sheets.spreadsheets.values.clear({
      spreadsheetId,
      range: `${tabName}!A:ZZ`,
    });
    if (rows && rows.length) {
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${tabName}!A1`,
        valueInputOption: 'RAW',
        requestBody: { values: rows },
      });
    }
    writtenRows[tabName] = count;
  }

  return {
    sheet_url: sheetUrl,
    written_rows: writtenRows,
    written_at: new Date().toISOString(),
  };
}

module.exports = {
  DEFAULT_MAPPING,
  getMasterMapping,
  buildSheetRows,
  syncToSheet,
};
