// utils/cost-ledger-sync.js
// 案件費用台帳 ⇄ Google スプレッドシート 双方向同期（友好フォーマット版・ADR 024 改訂）。
//
// フォーマット: 「1行 = 案件 × 区分(カテゴリ)」。ランクA/B/C は **価格の列**（制作支払単価）。
//   #, クライアント, 請求区分, 案件名, 区分, クライアント請求, ディレクション費, ランクA, ランクB, ランクC
//   ＋ 非表示の突き合わせ列: project_id, client_id, category_id, creative_type
//
// 書き戻し対象:
//   - クライアント請求 → その案件×区分の見積行 client_unit_price（全行に反映）
//   - ランクA/B/C       → その案件×区分の rank=A/B/C 行の「制作（編集者/デザイナー）支払単価」(line_costs)
//                          ※ 該当ランク行が無ければ **見積行＋コストを自動作成** する
//   - ディレクション費   → project_director_rates(project_id, creative_type)
//   - 請求区分          → clients.billing_org（クライアント単位・矛盾時はスキップ）
//
// インポート反映は「シート再読込→再計算→DB反映」で冪等。プレビューはクライアントを信用せず再計算する。
// 同期先は対象スプレッドシートの **先頭シート**。hidden ID 列が無い行は クライアント名+案件名 でマッチ（後方互換）。

const { google } = require('googleapis');
const supabase = require('../supabase');

const DEFAULT_SHEET_URL = 'https://docs.google.com/spreadsheets/d/1ZaXgACFf0UQheI1hC7dcfFmJQR0aQD8sLj3t7CgNHo0/edit';

const BILLING_LABELS = { haruka: 'HARUKA FILM（自社）', gnd: 'GND' };
const billingCodeToLabel = code => (code && BILLING_LABELS[code] ? BILLING_LABELS[code] : '');
function billingLabelToCode(label) {
  const s = String(label || '').replace(/^[^\p{L}\p{N}]+/u, '').trim();
  if (!s) return null;
  if (/haruka|HARUKA|自社/i.test(s)) return 'haruka';
  if (/gnd|GOOD\s*NEW/i.test(s)) return 'gnd';
  return null;
}
const CAT_ICON = { video: '🎬', image: '🖼️', hp: '🌐', lp: '📄', line: '💬' };
const creativeTypeOf = code => (code === 'video' ? 'video' : code === 'image' ? 'design' : null);
const creatorRoleCode = code => (code === 'video' ? 'editor' : 'designer');
const RANKS = ['A', 'B', 'C'];
const DASH = '—';

const HEADER = [
  '#', 'クライアント', '請求区分', '案件名', '案件区分', '区分', 'クライアント請求', 'ディレクション費',
  'ランクA', 'ランクB', 'ランクC',
  'project_id', 'client_id', 'category_id', 'creative_type',
];
// 案件区分(index4) = その案件のカテゴリ(主区分名)。エクスポート専用の参照列で、インポート(コンバート)では読まない。
const COL = { billing: 2, ankenKubun: 4, kubun: 5, clientCharge: 6, directionFee: 7, rankA: 8, rankB: 9, rankC: 10,
  projectId: 11, clientId: 12, categoryId: 13, creativeType: 14 };
const ID_COL_START = 11;
const N_COLS = HEADER.length;

const num = v => {
  if (v == null || v === '' || v === DASH) return null;
  const n = Number(String(v).replace(/[,¥円\s]/g, ''));
  return Number.isFinite(n) ? Math.round(n) : null;
};
const cellNum = v => (v == null ? DASH : v);
const stripIcon = v => String(v == null ? '' : v).replace(/^[^\p{L}\p{N}]+/u, '').trim();

function getAuth() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
  if (credentials.private_key) credentials.private_key = credentials.private_key.replace(/\\n/g, '\n');
  return new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/spreadsheets'] });
}
function extractSpreadsheetId(url) {
  const m = String(url || '').match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return m ? m[1] : (url && /^[a-zA-Z0-9-_]{20,}$/.test(url) ? url : null);
}
async function getSheetUrl() {
  const { data } = await supabase.from('system_settings').select('value').eq('key', 'cost_ledger_sheet_url').maybeSingle();
  return (data && data.value) || DEFAULT_SHEET_URL;
}

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
    fetchAll('projects', 'id,client_id,name,created_at,primary_category_id,is_hidden'),
    fetchAll('creative_categories', 'id,code,name'),
    fetchAll('project_estimate_lines', 'id,project_id,category_id,name,planned_count,client_unit_price,rank,sort_order'),
    fetchAll('project_estimate_line_costs', 'id,line_id,role_id,unit_price'),
    fetchAll('project_director_rates', 'project_id,creative_type,director_fee'),
    fetchAll('roles', 'id,code,category'),
  ]);
  const m = {
    clients, projects, cats, lines,
    roleById: Object.fromEntries(roles.map(r => [r.id, r])),
    roleByCode: Object.fromEntries(roles.map(r => [r.code, r])),
    catById: Object.fromEntries(cats.map(c => [c.id, c])),
    catByName: Object.fromEntries(cats.map(c => [c.name, c])),
    clientById: Object.fromEntries(clients.map(c => [c.id, c])),
    projById: Object.fromEntries(projects.map(p => [p.id, p])),
    costsByLine: {}, dirByKey: {}, linesByProj: {}, projByName: {},
  };
  for (const c of costs) (m.costsByLine[c.line_id] ||= []).push(c);
  for (const d of dirRates) m.dirByKey[d.project_id + '|' + d.creative_type] = d.director_fee;
  for (const l of m.lines) (m.linesByProj[l.project_id] ||= []).push(l);
  for (const p of projects) { const cl = m.clientById[p.client_id]; m.projByName[(cl ? cl.name : '') + '｜' + (p.name || '')] = p; }
  return m;
}

const rankOf = line => {
  if (line.rank) return line.rank;
  const mm = String(line.name || '').match(/([ABC])\s*ランク/);
  return mm ? mm[1] : null;
};
function creatorCostOfLine(line, m) {
  const cs = m.costsByLine[line.id] || [];
  const want = creatorRoleCode(m.catById[line.category_id]?.code);
  return cs.find(c => m.roleById[c.role_id]?.code === want)
    || cs.find(c => m.roleById[c.role_id]?.category === 'creator') || null;
}
function meaningfulCategoryIds(p, m) {
  const pls = m.linesByProj[p.id] || [];
  const byCat = {};
  for (const l of pls) (byCat[l.category_id] ||= []).push(l);
  let ids = Object.keys(byCat).filter(cid => byCat[cid].some(l =>
    (l.planned_count || 0) > 0 || (l.client_unit_price || 0) > 0 || (m.costsByLine[l.id] || []).some(c => (c.unit_price || 0) > 0)));
  if (ids.length === 0 && p.primary_category_id && byCat[p.primary_category_id]) ids = [p.primary_category_id];
  if (ids.length === 0 && Object.keys(byCat).length) ids = [Object.keys(byCat)[0]];
  ids.sort((a, b) => (m.catById[a]?.code || '').localeCompare(m.catById[b]?.code || ''));
  return ids;
}

// ===== エクスポート =====
function buildRows(m) {
  const billRank = b => (b === 'haruka' ? 0 : b === 'gnd' ? 1 : 2);
  const clientOrder = m.clients.slice().sort((a, b) => billRank(a.billing_org) - billRank(b.billing_org) || (a.name || '').localeCompare(b.name || '', 'ja'));
  const rows = [HEADER.slice()];
  let seq = 0;
  for (const cl of clientOrder) {
    // is_hidden（アプリ非表示）の案件は台帳に出さない。システム表示と一致させる。
    const projs = m.projects.filter(p => p.client_id === cl.id && !p.is_hidden).sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));
    for (const p of projs) {
      const catIds = meaningfulCategoryIds(p, m);
      // 案件区分 = その案件のカテゴリ(主区分名)。案件内の全行で同一。主区分未設定なら先頭カテゴリ名。
      const ankenKubun = m.catById[p.primary_category_id]?.name || m.catById[catIds[0]]?.name || '';
      for (const cid of catIds) {
        const code = m.catById[cid]?.code;
        const grp = (m.linesByProj[p.id] || []).filter(l => l.category_id === cid);
        const nz = grp.map(l => l.client_unit_price).filter(v => v > 0);
        const charge = nz.length ? Math.max(...nz) : 0;
        const ct = creativeTypeOf(code);
        const dfee = ct ? m.dirByKey[p.id + '|' + ct] : undefined;
        const rankPrice = {};
        for (const rk of RANKS) {
          const line = grp.find(l => rankOf(l) === rk);
          const cc = line ? creatorCostOfLine(line, m) : null;
          rankPrice[rk] = cc ? cc.unit_price : null;
        }
        seq++;
        rows.push([
          seq, cl.name, billingCodeToLabel(cl.billing_org), p.name || '',
          ankenKubun,
          (CAT_ICON[code] ? CAT_ICON[code] + ' ' : '') + (m.catById[cid]?.name || ''),
          cellNum(charge), (dfee == null ? DASH : dfee),
          cellNum(rankPrice.A), cellNum(rankPrice.B), cellNum(rankPrice.C),
          p.id, cl.id, cid, ct || '',
        ]);
      }
    }
  }
  return rows;
}

async function firstSheet(sheetsApi, spreadsheetId) {
  const meta = await sheetsApi.spreadsheets.get({ spreadsheetId });
  const sh = meta.data.sheets[0];
  return { title: sh.properties.title, sheetId: sh.properties.sheetId };
}

async function exportLedger() {
  const url = await getSheetUrl();
  const spreadsheetId = extractSpreadsheetId(url);
  if (!spreadsheetId) throw new Error('費用台帳シートのURLが不正です: ' + url);
  const sheetsApi = google.sheets({ version: 'v4', auth: getAuth() });
  const m = await loadModel();
  const rows = buildRows(m);
  const { title, sheetId } = await firstSheet(sheetsApi, spreadsheetId);
  await sheetsApi.spreadsheets.values.clear({ spreadsheetId, range: `${title}!A1:Z2000` });
  await sheetsApi.spreadsheets.values.update({ spreadsheetId, range: `${title}!A1`, valueInputOption: 'USER_ENTERED', requestBody: { values: rows } });
  await sheetsApi.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: [
    { updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } },
    { repeatCell: { range: { sheetId, startRowIndex: 0, endRowIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: 'userEnteredFormat.textFormat.bold' } },
    { repeatCell: { range: { sheetId, startRowIndex: 1, startColumnIndex: 6, endColumnIndex: 11 }, cell: { userEnteredFormat: { numberFormat: { type: 'NUMBER', pattern: '#,##0' } } }, fields: 'userEnteredFormat.numberFormat' } },
    { updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: ID_COL_START, endIndex: N_COLS }, properties: { hiddenByUser: true }, fields: 'hiddenByUser' } },
    { autoResizeDimensions: { dimensions: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: ID_COL_START } } },
  ] } });
  return { url, sheet_url: url, count: rows.length - 1 };
}

async function readLedger() {
  const url = await getSheetUrl();
  const spreadsheetId = extractSpreadsheetId(url);
  if (!spreadsheetId) throw new Error('費用台帳シートのURLが不正です: ' + url);
  const sheetsApi = google.sheets({ version: 'v4', auth: getAuth() });
  const { title } = await firstSheet(sheetsApi, spreadsheetId);
  const res = await sheetsApi.spreadsheets.values.get({ spreadsheetId, range: `${title}!A1:O2000` });
  return (res.data.values || []).slice(1).filter(r => r && (r[3] || r[COL.projectId]));
}

function resolveRow(r, m) {
  let p = null, cid = null;
  const pid = String(r[COL.projectId] || '').trim();
  if (pid && m.projById[pid]) p = m.projById[pid];
  if (!p) p = m.projByName[`${(r[1] || '').trim()}｜${(r[3] || '').trim()}`] || null;
  if (!p) return null;
  const cidH = String(r[COL.categoryId] || '').trim();
  if (cidH && m.catById[cidH]) cid = cidH;
  if (!cid) { const c = m.catByName[stripIcon(r[COL.kubun])]; cid = c ? c.id : null; }
  if (!cid) return null;
  return { project: p, categoryId: cid };
}

// ===== 差分計算 =====
async function computeChanges() {
  const m = await loadModel();
  const sheetRows = await readLedger();
  const changes = [], conflicts = [], errors = [];
  const clientBilling = {}, projDirFee = {};

  for (const r of sheetRows) {
    const resolved = resolveRow(r, m);
    if (!resolved) { errors.push(`未解決の行: ${(r[1] || '')} / ${(r[3] || '')}`); continue; }
    const { project: p, categoryId: cid } = resolved;
    const code = m.catById[cid]?.code;
    const catName = m.catById[cid]?.name || '';
    const ctx = `${m.clientById[p.client_id]?.name || ''} / ${p.name} / ${catName}`;
    const grp = (m.linesByProj[p.id] || []).filter(l => l.category_id === cid);

    const newCharge = num(r[COL.clientCharge]);
    if (newCharge != null) {
      const targets = grp.filter(l => (l.client_unit_price || 0) !== newCharge);
      const curMax = grp.map(l => l.client_unit_price || 0).reduce((a, b) => Math.max(a, b), 0);
      if (targets.length && curMax !== newCharge) {
        changes.push({ scope: 'charge', label: `クライアント請求 (${ctx})`, before: curMax, after: newCharge,
          _apply: { kind: 'charge', lineIds: targets.map(l => l.id), value: newCharge } });
      }
    }
    // 重複防止: rank無しの既存行（汎用行）は、不足ランクへの「昇格」に再利用する。
    // これにより「汎用行＋自動作成A/B/C」の二重化を防ぐ。1ランクにつき1行だけ消費。
    const usedGenericIds = new Set();
    for (const rk of RANKS) {
      const price = num(r[COL['rank' + rk]]);
      if (price == null) continue;
      const creatorRole = m.roleByCode[creatorRoleCode(code)];
      if (!creatorRole) { errors.push(`制作ロール未定義: ${catName}`); continue; }
      let line = grp.find(l => rankOf(l) === rk);
      let promote = false;
      if (!line) {
        // 既存の rank無し汎用行があれば、新規作成せずそれを当該ランクに昇格
        line = grp.find(l => !rankOf(l) && !usedGenericIds.has(l.id));
        if (line) { usedGenericIds.add(line.id); promote = true; }
      }
      const cc = line ? creatorCostOfLine(line, m) : null;
      const cur = cc ? cc.unit_price : null;
      if (!promote && cur === price) continue; // 変更なし（昇格時はrank更新があるので継続）
      if (line) {
        const label = promote
          ? `ランク${rk} 支払単価【既存行をランク${rk}に昇格】 (${ctx})`
          : (cc ? `ランク${rk} 支払単価 (${ctx})` : `ランク${rk} 支払単価【新規コスト】 (${ctx})`);
        changes.push({ scope: 'rank', label, before: (cc ? cur : DASH), after: price,
          _apply: { kind: 'line_cost', lineId: line.id, setRank: promote ? rk : null, costId: cc ? cc.id : null, roleId: creatorRole.id, value: price } });
      } else {
        changes.push({ scope: 'rank', label: `ランク${rk} 支払単価【行＋コスト自動作成】 (${ctx})`, before: DASH, after: price,
          _apply: { kind: 'line_and_cost', projectId: p.id, categoryId: cid, rank: rk, catName, roleId: creatorRole.id, value: price, charge: newCharge } });
      }
    }
    const ct = creativeTypeOf(code);
    const dfee = num(r[COL.directionFee]);
    if (ct && dfee != null) (projDirFee[p.id + '|' + ct] ||= { fees: new Set(), ct, projId: p.id, name: p.name }).fees.add(dfee);
    const billCode = billingLabelToCode(r[COL.billing]);
    if (billCode) (clientBilling[p.client_id] ||= { codes: new Set(), name: m.clientById[p.client_id]?.name }).codes.add(billCode);
  }

  for (const [clientId, info] of Object.entries(clientBilling)) {
    const cl = m.clientById[clientId]; if (!cl) continue;
    if (info.codes.size > 1) { conflicts.push({ label: `請求区分 (${info.name})`, values: [...info.codes].map(billingCodeToLabel) }); continue; }
    const code = [...info.codes][0];
    if (code !== (cl.billing_org || null)) changes.push({ scope: 'client', label: `請求区分 (${cl.name})`, before: billingCodeToLabel(cl.billing_org) || DASH, after: billingCodeToLabel(code), _apply: { kind: 'client', id: clientId, value: code } });
  }
  for (const [, info] of Object.entries(projDirFee)) {
    if (info.fees.size > 1) { conflicts.push({ label: `ディレクション費 (${info.name} / ${info.ct})`, values: [...info.fees] }); continue; }
    const fee = [...info.fees][0];
    const cur = m.dirByKey[info.projId + '|' + info.ct];
    if ((cur == null ? null : cur) !== fee) changes.push({ scope: 'dir', label: `ディレクション費 (${info.name} / ${info.ct})`, before: (cur == null ? DASH : cur), after: fee, _apply: { kind: 'dir_fee', projId: info.projId, ct: info.ct, value: fee } });
  }
  return { changes, conflicts, errors };
}

// ===== 反映 =====
async function applyChanges() {
  const { changes, conflicts, errors } = await computeChanges();
  let applied = 0; const failures = [];
  for (const ch of changes) {
    const a = ch._apply;
    try {
      let resp;
      if (a.kind === 'charge') resp = await supabase.from('project_estimate_lines').update({ client_unit_price: a.value }).in('id', a.lineIds);
      else if (a.kind === 'cost_update') resp = await supabase.from('project_estimate_line_costs').update({ unit_price: a.value }).eq('id', a.id);
      else if (a.kind === 'cost_insert') resp = await supabase.from('project_estimate_line_costs').insert({ line_id: a.lineId, role_id: a.roleId, unit_price: a.value, currency: 'JPY', pricing_type: 'fixed_per_unit' });
      else if (a.kind === 'line_cost') {
        // 必要なら既存行のランクを昇格（rank無し→A/B/C）
        if (a.setRank) {
          const up = await supabase.from('project_estimate_lines').update({ rank: a.setRank }).eq('id', a.lineId);
          if (up.error) throw new Error(up.error.message);
        }
        // 制作コストを更新 or 新規
        if (a.costId) resp = await supabase.from('project_estimate_line_costs').update({ unit_price: a.value }).eq('id', a.costId);
        else resp = await supabase.from('project_estimate_line_costs').insert({ line_id: a.lineId, role_id: a.roleId, unit_price: a.value, currency: 'JPY', pricing_type: 'fixed_per_unit' });
      }
      else if (a.kind === 'line_and_cost') {
        const ins = await supabase.from('project_estimate_lines').insert({ project_id: a.projectId, category_id: a.categoryId, rank: a.rank, name: `${a.catName} ${a.rank}ランク`, planned_count: 0, client_unit_price: a.charge || 0, currency: 'JPY' }).select('id').single();
        if (ins.error) throw new Error(ins.error.message);
        resp = await supabase.from('project_estimate_line_costs').insert({ line_id: ins.data.id, role_id: a.roleId, unit_price: a.value, currency: 'JPY', pricing_type: 'fixed_per_unit' });
      }
      else if (a.kind === 'client') resp = await supabase.from('clients').update({ billing_org: a.value }).eq('id', a.id);
      else if (a.kind === 'dir_fee') resp = await supabase.from('project_director_rates').upsert({ project_id: a.projId, creative_type: a.ct, director_fee: a.value, updated_at: new Date().toISOString() }, { onConflict: 'project_id,creative_type' });
      if (resp && resp.error) throw new Error(resp.error.message);
      applied++;
    } catch (e) { failures.push(`${ch.label}: ${e.message}`); }
  }
  return { applied, total: changes.length, conflicts, errors, failures };
}

module.exports = { exportLedger, computeChanges, applyChanges, getSheetUrl, TAB_TITLE: '（先頭シート）' };
