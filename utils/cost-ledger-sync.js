// utils/cost-ledger-sync.js
// 案件費用台帳 ⇄ Google スプレッドシート 双方向同期。
//
// - エクスポート: DB → スプレッドシート（タブ「費用台帳」）に「1行=1見積行（＋ID列）」で書き出す。
// - インポート(プレビュー): シートを読み、DB と突き合わせて差分を返す（書き込みはしない）。
// - インポート(反映): シートを読み直し、差分を DB に反映する（プレビューはクライアントを信用せず再計算）。
//
// 書き戻し対象（ADR 024）:
//   行単位（line_id で一意）: クライアント請求(client_unit_price) / 予定数(planned_count) /
//                            ランク(rank) / 制作支払単価(line_costs.unit_price)
//   クライアント単位        : 請求区分(clients.billing_org)
//   案件×制作種別単位       : ディレクション費(project_director_rates.director_fee)
//   ※ クライアント/案件単位の値は行をまたいで重複するため、矛盾があれば conflict として反映をスキップする。

const { google } = require('googleapis');
const supabase = require('../supabase');

const TAB_TITLE = '費用台帳';
// system_settings 未設定時のデフォルト同期先（既存の費用台帳シート）
const DEFAULT_SHEET_URL = 'https://docs.google.com/spreadsheets/d/1ZaXgACFf0UQheI1hC7dcfFmJQR0aQD8sLj3t7CgNHo0/edit';

// 請求区分（clients.billing_org）コード ⇄ 表示ラベル
const BILLING_LABELS = { haruka: 'HARUKA FILM（自社）', gnd: 'GND' };
function billingCodeToLabel(code) { return code && BILLING_LABELS[code] ? BILLING_LABELS[code] : ''; }
function billingLabelToCode(label) {
  const s = String(label || '').replace(/^[^\p{L}\p{N}]+/u, '').trim();
  if (!s) return null;
  if (/haruka|HARUKA|自社/i.test(s)) return 'haruka';
  if (/gnd|GOOD\s*NEW/i.test(s)) return 'gnd';
  return null; // 不明な値は「変更なし」扱い（誤反映防止）
}

const CAT_ICON = { video: '🎬', image: '🖼️', hp: '🌐', lp: '📄', line: '💬' };
const stripIcon = v => String(v == null ? '' : v).replace(/^[^\p{L}\p{N}]+/u, '').trim();
const creativeTypeOf = code => (code === 'video' ? 'video' : code === 'image' ? 'design' : null);
const creatorRoleCode = code => (code === 'video' ? 'editor' : 'designer');

// 表示用ヘッダー（A..K が編集対象/参照、L以降が突き合わせ用ID列）
const HEADER = [
  '#', 'クライアント', '請求区分', '案件名', '区分', '見積行名',
  'ランク', '予定数', 'クライアント請求', '制作支払単価', 'ディレクション費',
  'line_id', 'project_id', 'client_id', 'creative_type', 'creator_cost_id', 'creator_role_id',
];
const COL = { // 0-based 列インデックス
  rank: 6, planned: 7, clientCharge: 8, creatorPay: 9, directionFee: 10, billing: 2,
  lineId: 11, projectId: 12, clientId: 13, creativeType: 14, creatorCostId: 15, creatorRoleId: 16,
};
const N_COLS = HEADER.length;
const ID_COL_START = 11; // L 列以降は ID（非表示）

function getAuth() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
  if (credentials.private_key) credentials.private_key = credentials.private_key.replace(/\\n/g, '\n');
  return new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/spreadsheets'],
  });
}
function extractSpreadsheetId(url) {
  const m = String(url || '').match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return m ? m[1] : (url && /^[a-zA-Z0-9-_]{20,}$/.test(url) ? url : null);
}

async function getSheetUrl() {
  const { data } = await supabase.from('system_settings').select('value').eq('key', 'cost_ledger_sheet_url').maybeSingle();
  return (data && data.value) || DEFAULT_SHEET_URL;
}

const intOrNull = v => {
  if (v === '' || v == null) return null;
  const n = Number(String(v).replace(/[, ¥円]/g, ''));
  return Number.isFinite(n) ? Math.round(n) : null;
};
const DASH = '—';
const cellNum = v => (v == null ? DASH : v);

// ---- DB から明細行モデルを構築（エクスポート/インポート両用） ----
async function loadModel() {
  const fetchAll = async (table, sel) => {
    let out = [], from = 0, step = 1000;
    for (;;) {
      const { data, error } = await supabase.from(table).select(sel).range(from, from + step - 1);
      if (error) throw new Error(`${table}: ${error.message}`);
      out = out.concat(data || []);
      if (!data || data.length < step) break;
      from += step;
    }
    return out;
  };
  const [clients, projects, cats, lines, costs, dirRates, roles] = await Promise.all([
    fetchAll('clients', 'id,name,billing_org'),
    fetchAll('projects', 'id,client_id,name,created_at,primary_category_id'),
    fetchAll('creative_categories', 'id,code,name'),
    fetchAll('project_estimate_lines', 'id,project_id,category_id,name,planned_count,client_unit_price,rank'),
    fetchAll('project_estimate_line_costs', 'id,line_id,role_id,unit_price'),
    fetchAll('project_director_rates', 'project_id,creative_type,director_fee'),
    fetchAll('roles', 'id,code,category'),
  ]);
  const roleById = Object.fromEntries(roles.map(r => [r.id, r]));
  const roleByCode = Object.fromEntries(roles.map(r => [r.code, r]));
  const catById = Object.fromEntries(cats.map(c => [c.id, c]));
  const clientById = Object.fromEntries(clients.map(c => [c.id, c]));
  const projById = Object.fromEntries(projects.map(p => [p.id, p]));
  const costsByLine = {}; for (const c of costs) (costsByLine[c.line_id] ||= []).push(c);
  const dirByKey = {}; for (const d of dirRates) dirByKey[d.project_id + '|' + d.creative_type] = d.director_fee;
  return { clients, projects, cats, lines, costsByLine, dirByKey, roleById, roleByCode, catById, clientById, projById };
}

// 1見積行の「制作（編集者/デザイナー）」コストを1つ選ぶ
function pickCreatorCost(line, m) {
  const cs = m.costsByLine[line.id] || [];
  const want = creatorRoleCode(m.catById[line.category_id]?.code);
  return cs.find(c => m.roleById[c.role_id]?.code === want)
    || cs.find(c => m.roleById[c.role_id]?.category === 'creator')
    || cs.find(c => !['director', 'producer', 'sub_director', 'sub_producer'].includes(m.roleById[c.role_id]?.code))
    || null;
}
// 空でない（意味のある）見積行か
function isMeaningfulLine(line, m) {
  if ((line.planned_count || 0) > 0) return true;
  if ((line.client_unit_price || 0) > 0) return true;
  const cs = m.costsByLine[line.id] || [];
  return cs.some(c => (c.unit_price || 0) > 0);
}
function rankOf(line) {
  if (line.rank) return line.rank;
  const mm = String(line.name || '').match(/([ABC])\s*ランク/);
  return mm ? mm[1] : '';
}

// エクスポート用 2D 配列を構築
function buildRows(m) {
  const billRank = b => (b === 'haruka' ? 0 : b === 'gnd' ? 1 : 2);
  const linesByProj = {}; for (const l of m.lines) (linesByProj[l.project_id] ||= []).push(l);
  const clientOrder = m.clients.slice().sort((a, b) => billRank(a.billing_org) - billRank(b.billing_org) || (a.name || '').localeCompare(b.name || '', 'ja'));
  const rows = [HEADER.slice()];
  let seq = 0;
  for (const cl of clientOrder) {
    const projs = m.projects.filter(p => p.client_id === cl.id).sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));
    for (const p of projs) {
      const pls = (linesByProj[p.id] || []).filter(l => isMeaningfulLine(l, m));
      // 区分(category)→sort、その中で rank A,B,C 順
      pls.sort((a, b) => (m.catById[a.category_id]?.code || '').localeCompare(m.catById[b.category_id]?.code || '') || String(rankOf(a)).localeCompare(String(rankOf(b))));
      for (const l of pls) {
        const code = m.catById[l.category_id]?.code;
        const cc = pickCreatorCost(l, m);
        const ct = creativeTypeOf(code);
        const dfee = ct ? m.dirByKey[p.id + '|' + ct] : undefined;
        const creatorRole = m.roleByCode[creatorRoleCode(code)];
        seq++;
        const catName = m.catById[l.category_id]?.name || '';
        rows.push([
          seq, cl.name, billingCodeToLabel(cl.billing_org), p.name || '',
          (CAT_ICON[code] ? CAT_ICON[code] + ' ' : '') + catName,
          l.name || '', rankOf(l), cellNum(l.planned_count), cellNum(l.client_unit_price),
          cc ? cellNum(cc.unit_price) : DASH, (dfee == null ? DASH : dfee),
          l.id, p.id, cl.id, ct || '', cc ? cc.id : '', creatorRole ? creatorRole.id : '',
        ]);
      }
    }
  }
  return rows;
}

async function ensureTab(sheetsApi, spreadsheetId) {
  const meta = await sheetsApi.spreadsheets.get({ spreadsheetId });
  let tab = (meta.data.sheets || []).find(s => s.properties.title === TAB_TITLE);
  if (!tab) {
    const add = await sheetsApi.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: TAB_TITLE } } }] },
    });
    return add.data.replies[0].addSheet.properties.sheetId;
  }
  return tab.properties.sheetId;
}

// ===== エクスポート =====
async function exportLedger() {
  const url = await getSheetUrl();
  const spreadsheetId = extractSpreadsheetId(url);
  if (!spreadsheetId) throw new Error('費用台帳シートのURLが不正です: ' + url);
  const auth = getAuth();
  const sheetsApi = google.sheets({ version: 'v4', auth });
  const m = await loadModel();
  const rows = buildRows(m);
  const sheetId = await ensureTab(sheetsApi, spreadsheetId);
  await sheetsApi.spreadsheets.values.clear({ spreadsheetId, range: `${TAB_TITLE}!A1:Z2000` });
  await sheetsApi.spreadsheets.values.update({
    spreadsheetId, range: `${TAB_TITLE}!A1`, valueInputOption: 'USER_ENTERED', requestBody: { values: rows },
  });
  // 体裁: ヘッダー固定・太字、金額カンマ、ID列(L以降)を非表示、列幅自動
  await sheetsApi.spreadsheets.batchUpdate({
    spreadsheetId, requestBody: { requests: [
      { updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } },
      { repeatCell: { range: { sheetId, startRowIndex: 0, endRowIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: 'userEnteredFormat.textFormat.bold' } },
      { repeatCell: { range: { sheetId, startRowIndex: 1, startColumnIndex: 7, endColumnIndex: 11 }, cell: { userEnteredFormat: { numberFormat: { type: 'NUMBER', pattern: '#,##0' } } }, fields: 'userEnteredFormat.numberFormat' } },
      { updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: ID_COL_START, endIndex: N_COLS }, properties: { hiddenByUser: true }, fields: 'hiddenByUser' } },
      { autoResizeDimensions: { dimensions: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: ID_COL_START } } },
    ] },
  });
  return { url, sheet_url: url, count: rows.length - 1 };
}

// シートを読み取り、line_id をキーに行を返す
async function readLedger() {
  const url = await getSheetUrl();
  const spreadsheetId = extractSpreadsheetId(url);
  if (!spreadsheetId) throw new Error('費用台帳シートのURLが不正です: ' + url);
  const auth = getAuth();
  const sheetsApi = google.sheets({ version: 'v4', auth });
  const res = await sheetsApi.spreadsheets.values.get({ spreadsheetId, range: `${TAB_TITLE}!A1:Q2000` });
  const values = res.data.values || [];
  return values.slice(1).filter(r => r && r[COL.lineId]); // ヘッダー除外・line_id ありのみ
}

// ===== 差分計算（プレビュー/反映 共通） =====
async function computeChanges() {
  const m = await loadModel();
  const lineById = Object.fromEntries(m.lines.map(l => [l.id, l]));
  const costById = {}; for (const arr of Object.values(m.costsByLine)) for (const c of arr) costById[c.id] = c;
  const sheetRows = await readLedger();

  const changes = [];   // {scope, key, field, label, target, before, after, _apply}
  const conflicts = []; // {scope, key, field, label, values}
  const errors = [];

  const clientBilling = {};   // clientId -> { code, names:Set }
  const projDirFee = {};      // projId|ct -> { fee, ct, projId }

  for (const r of sheetRows) {
    const lineId = String(r[COL.lineId]).trim();
    const line = lineById[lineId];
    if (!line) { errors.push(`未知の line_id（行は無視）: ${lineId}`); continue; }
    const ctx = `${r[1] || ''} / ${r[3] || ''} / ${stripIcon(r[4])} / ${r[5] || ''}`;

    // --- 行単位: クライアント請求 ---
    const newCharge = intOrNull(r[COL.clientCharge]);
    if (newCharge != null && newCharge !== (line.client_unit_price || 0)) {
      changes.push({ scope: 'line', key: lineId, field: 'client_unit_price', label: `クライアント請求 (${ctx})`,
        before: line.client_unit_price || 0, after: newCharge, _apply: { table: 'line', id: lineId, patch: { client_unit_price: newCharge } } });
    }
    // --- 行単位: 予定数 ---
    const newPlanned = intOrNull(r[COL.planned]);
    if (newPlanned != null && newPlanned !== (line.planned_count || 0)) {
      changes.push({ scope: 'line', key: lineId, field: 'planned_count', label: `予定数 (${ctx})`,
        before: line.planned_count || 0, after: newPlanned, _apply: { table: 'line', id: lineId, patch: { planned_count: newPlanned } } });
    }
    // --- 行単位: ランク ---
    const rawRank = String(r[COL.rank] || '').trim().toUpperCase();
    const newRank = ['A', 'B', 'C'].includes(rawRank) ? rawRank : (rawRank === '' ? null : undefined);
    if (newRank !== undefined && (newRank || null) !== (line.rank || null)) {
      changes.push({ scope: 'line', key: lineId, field: 'rank', label: `ランク (${ctx})`,
        before: line.rank || '—', after: newRank || '—', _apply: { table: 'line', id: lineId, patch: { rank: newRank } } });
    }
    // --- 行単位: 制作支払単価 ---
    const newPay = intOrNull(r[COL.creatorPay]);
    if (newPay != null) {
      const costId = String(r[COL.creatorCostId] || '').trim();
      const roleId = String(r[COL.creatorRoleId] || '').trim();
      if (costId && costById[costId]) {
        if (newPay !== (costById[costId].unit_price || 0)) {
          changes.push({ scope: 'cost', key: costId, field: 'unit_price', label: `制作支払単価 (${ctx})`,
            before: costById[costId].unit_price || 0, after: newPay, _apply: { table: 'cost_update', id: costId, patch: { unit_price: newPay } } });
        }
      } else if (roleId) {
        changes.push({ scope: 'cost', key: lineId, field: 'unit_price', label: `制作支払単価【新規】 (${ctx})`,
          before: '—', after: newPay, _apply: { table: 'cost_insert', lineId, roleId, unit_price: newPay } });
      }
    }
    // --- クライアント単位: 請求区分（集約・矛盾検出） ---
    const clientId = String(r[COL.clientId] || '').trim();
    const code = billingLabelToCode(r[COL.billing]);
    if (clientId && code) {
      const cur = clientBilling[clientId] || (clientBilling[clientId] = { codes: new Set(), name: r[1] });
      cur.codes.add(code);
    }
    // --- 案件×制作種別単位: ディレクション費（集約・矛盾検出） ---
    const projId = String(r[COL.projectId] || '').trim();
    const ct = String(r[COL.creativeType] || '').trim();
    const dfee = intOrNull(r[COL.directionFee]);
    if (projId && ct && dfee != null) {
      const k = projId + '|' + ct;
      const cur = projDirFee[k] || (projDirFee[k] = { fees: new Set(), ct, projId, name: r[3] });
      cur.fees.add(dfee);
    }
  }

  // 請求区分の確定
  for (const [clientId, info] of Object.entries(clientBilling)) {
    const cl = m.clientById[clientId]; if (!cl) continue;
    if (info.codes.size > 1) { conflicts.push({ scope: 'client', key: clientId, field: 'billing_org', label: `請求区分 (${info.name})`, values: [...info.codes].map(billingCodeToLabel) }); continue; }
    const code = [...info.codes][0];
    if (code !== (cl.billing_org || null)) {
      changes.push({ scope: 'client', key: clientId, field: 'billing_org', label: `請求区分 (${cl.name})`,
        before: billingCodeToLabel(cl.billing_org) || '—', after: billingCodeToLabel(code), _apply: { table: 'client', id: clientId, patch: { billing_org: code } } });
    }
  }
  // ディレクション費の確定
  for (const [k, info] of Object.entries(projDirFee)) {
    if (info.fees.size > 1) { conflicts.push({ scope: 'project', key: k, field: 'director_fee', label: `ディレクション費 (${info.name} / ${info.ct})`, values: [...info.fees] }); continue; }
    const fee = [...info.fees][0];
    const cur = m.dirByKey[k];
    if ((cur == null ? null : cur) !== fee) {
      changes.push({ scope: 'project', key: k, field: 'director_fee', label: `ディレクション費 (${info.name} / ${info.ct})`,
        before: (cur == null ? '—' : cur), after: fee, _apply: { table: 'dir_fee', projId: info.projId, ct: info.ct, director_fee: fee } });
    }
  }
  return { changes, conflicts, errors };
}

// ===== 反映 =====
async function applyChanges() {
  const { changes, conflicts, errors } = await computeChanges();
  let applied = 0;
  const failures = [];
  for (const ch of changes) {
    const a = ch._apply;
    try {
      let resp;
      if (a.table === 'line') resp = await supabase.from('project_estimate_lines').update(a.patch).eq('id', a.id);
      else if (a.table === 'cost_update') resp = await supabase.from('project_estimate_line_costs').update(a.patch).eq('id', a.id);
      else if (a.table === 'cost_insert') resp = await supabase.from('project_estimate_line_costs').insert({ line_id: a.lineId, role_id: a.roleId, unit_price: a.unit_price, currency: 'JPY', pricing_type: 'fixed_per_unit' });
      else if (a.table === 'client') resp = await supabase.from('clients').update(a.patch).eq('id', a.id);
      else if (a.table === 'dir_fee') resp = await supabase.from('project_director_rates').upsert({ project_id: a.projId, creative_type: a.ct, director_fee: a.director_fee, updated_at: new Date().toISOString() }, { onConflict: 'project_id,creative_type' });
      if (resp && resp.error) throw new Error(resp.error.message);
      applied++;
    } catch (e) { failures.push(`${ch.label}: ${e.message}`); }
  }
  return { applied, total: changes.length, conflicts, errors, failures };
}

module.exports = { exportLedger, computeChanges, applyChanges, getSheetUrl, TAB_TITLE };
