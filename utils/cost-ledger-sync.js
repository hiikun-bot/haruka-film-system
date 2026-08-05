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
//   - ディレクション費   → その案件×区分の全グループの role=director の line_cost（1本あたり単価）
//                          ※ 案件編集モーダルの「🎬 ディレクター費 → 全グループに反映」と同じ反映先。
//                            旧 project_director_rates は誰も読まない孤立テーブルだったため 2026-08-06 に切替
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
  '#', 'クライアント', '請求区分', '案件名', '案件区分', 'クライアント請求', 'ディレクション費',
  'ランクA', 'ランクB', 'ランクC',
  'project_id', 'client_id', 'category_id', 'creative_type',
];
// 案件区分(index4) = その案件のカテゴリ(主区分名＋アイコン)。エクスポート専用の参照列で、インポート(コンバート)では読まない。
// ※ 旧「区分」列(各行の制作物カテゴリ)は案件区分と一致するため廃止（2026-07-02）。行の実カテゴリは非表示 category_id で解決する。
const COL = { billing: 2, ankenKubun: 4, clientCharge: 5, directionFee: 6, rankA: 7, rankB: 8, rankC: 9,
  projectId: 10, clientId: 11, categoryId: 12, creativeType: 13 };
const ID_COL_START = 10;
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
  const [clients, projects, cats, lines, costs, roles] = await Promise.all([
    fetchAll('clients', 'id,name,billing_org'),
    fetchAll('projects', 'id,client_id,name,created_at,primary_category_id,is_hidden'),
    fetchAll('creative_categories', 'id,code,name'),
    fetchAll('project_estimate_lines', 'id,project_id,category_id,name,planned_count,client_unit_price,rank,sort_order'),
    fetchAll('project_estimate_line_costs', 'id,line_id,role_id,user_id,unit_price,pricing_type'),
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
    costsByLine: {}, linesByProj: {}, projByName: {},
  };
  for (const c of costs) (m.costsByLine[c.line_id] ||= []).push(c);
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
// ディレクター単価はロール固定行（user_id なし）だけを見る。UNIQUE(line_id, role_id, user_id) により最大1件。
function directorCostOfLine(line, m) {
  return (m.costsByLine[line.id] || [])
    .find(c => !c.user_id && m.roleById[c.role_id]?.code === 'director') || null;
}
// 案件×区分のグループから「1本あたり」ディレクション費を読む。
// 時給行（ADR 028 の時間制ディレクター費）は per-unit の意味を持たないので台帳には出さない。
// グループ間で値が揃っていない場合は最大値を代表値にする（クライアント請求列と同じ扱い）。
function directorFeeOfGroup(grp, m) {
  const vals = [];
  for (const l of grp) {
    const c = directorCostOfLine(l, m);
    if (!c) continue;
    if ((c.pricing_type || 'fixed_per_unit') !== 'fixed_per_unit') continue;
    vals.push(Number(c.unit_price) || 0);
  }
  if (!vals.length) return null;
  return Math.max(...vals);
}
function meaningfulCategoryIds(p, m) {
  const pls = m.linesByProj[p.id] || [];
  const byCat = {};
  for (const l of pls) (byCat[l.category_id] ||= []).push(l);
  // ADR 027: 主カテゴリ設定済みの案件は主カテゴリの行だけ台帳に出す。
  // 温存された移行遺産の不一致 line（納品済みクリエイティブの単価根拠として DB には残す）は
  // 「現在の受発注単価表」である台帳には出さない。
  if (p.primary_category_id) {
    return byCat[p.primary_category_id] ? [p.primary_category_id] : [];
  }
  let ids = Object.keys(byCat).filter(cid => byCat[cid].some(l =>
    (l.planned_count || 0) > 0 || (l.client_unit_price || 0) > 0 || (m.costsByLine[l.id] || []).some(c => (c.unit_price || 0) > 0)));
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
      // 出す区分は「主区分 ＋ 請求額>0 の実データがある区分」だけに絞る。
      // 旧 project_rates 由来の phantom 行（planned/costのみ・請求0）を除外して重複表示を防ぐ。
      const primaryCid = (p.primary_category_id && catIds.includes(p.primary_category_id)) ? p.primary_category_id : catIds[0];
      const emitCids = catIds.filter(cid => cid === primaryCid || (m.linesByProj[p.id] || []).some(l => l.category_id === cid && (l.client_unit_price || 0) > 0));
      const pcat = m.catById[primaryCid];
      for (const cid of emitCids) {
        // 案件区分ラベル：本物の複数区分ケースは行のカテゴリ、単一なら主区分（アイコン付き）。
        const labelCat = emitCids.length > 1 ? (m.catById[cid] || pcat) : pcat;
        const ankenKubun = labelCat ? (CAT_ICON[labelCat.code] ? CAT_ICON[labelCat.code] + ' ' : '') + labelCat.name : '';
        const code = m.catById[cid]?.code;
        const grp = (m.linesByProj[p.id] || []).filter(l => l.category_id === cid);
        const nz = grp.map(l => l.client_unit_price).filter(v => v > 0);
        const charge = nz.length ? Math.max(...nz) : 0;
        const ct = creativeTypeOf(code);
        const dfee = directorFeeOfGroup(grp, m);
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
    { repeatCell: { range: { sheetId, startRowIndex: 1, startColumnIndex: 5, endColumnIndex: 10 }, cell: { userEnteredFormat: { numberFormat: { type: 'NUMBER', pattern: '#,##0' } } }, fields: 'userEnteredFormat.numberFormat' } },
    { updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: ID_COL_START, endIndex: N_COLS }, properties: { hiddenByUser: true }, fields: 'hiddenByUser' } },
    // 見切れ防止のため列幅を明示指定（autoResize は日本語・絵文字で狭くなりヘッダーが切れるため使わない）
    // A#/B クライアント/C 請求区分/D 案件名/E 案件区分/F クライアント請求/G ディレクション費/H ランクA/I ランクB/J ランクC
    ...[46, 210, 180, 190, 96, 120, 132, 86, 86, 86].map((px, i) => (
      { updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: i, endIndex: i + 1 }, properties: { pixelSize: px }, fields: 'pixelSize' } }
    )),
  ] } });
  return { url, sheet_url: url, count: rows.length - 1 };
}

async function readLedger() {
  const url = await getSheetUrl();
  const spreadsheetId = extractSpreadsheetId(url);
  if (!spreadsheetId) throw new Error('費用台帳シートのURLが不正です: ' + url);
  const sheetsApi = google.sheets({ version: 'v4', auth: getAuth() });
  const { title } = await firstSheet(sheetsApi, spreadsheetId);
  const res = await sheetsApi.spreadsheets.values.get({ spreadsheetId, range: `${title}!A1:N2000` });
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
  if (!cid) { const c = m.catByName[stripIcon(r[COL.ankenKubun])]; cid = c ? c.id : null; }
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

    // ADR 027: 案件の主カテゴリと不一致の区分の行は取り込まない（行＋コスト自動作成で
    // 不一致 line が復活するのを防ぐ）。エクスポート側も不一致行を出さないため、
    // ここに来るのは手書き追加か削除前の古いシートの行だけ。
    if (p.primary_category_id && cid !== p.primary_category_id) {
      const primaryName = m.catById[p.primary_category_id]?.name || '不明';
      errors.push(`主カテゴリ不一致のためスキップ: ${ctx} — この案件の主カテゴリは【${primaryName}】です（ADR 027）。必要な場合は別案件として登録してください`);
      continue;
    }
    const grp = (m.linesByProj[p.id] || []).filter(l => l.category_id === cid);

    // ランク列で新しく作る成果物グループにも引き継ぐディレクション費（シート値優先・空欄なら現状値）
    const sheetDirFee = num(r[COL.directionFee]);
    const carryDirFee = sheetDirFee != null ? sheetDirFee : directorFeeOfGroup(grp, m);

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
          _apply: { kind: 'line_and_cost', projectId: p.id, categoryId: cid, rank: rk, catName, roleId: creatorRole.id, value: price, charge: newCharge,
            dirRoleId: m.roleByCode['director']?.id || null, dirFee: carryDirFee } });
      }
    }
    if (sheetDirFee != null) {
      (projDirFee[p.id + '|' + cid] ||= { fees: new Set(), projId: p.id, cid, name: p.name, catName, ctx }).fees.add(sheetDirFee);
    }
    const billCode = billingLabelToCode(r[COL.billing]);
    if (billCode) (clientBilling[p.client_id] ||= { codes: new Set(), name: m.clientById[p.client_id]?.name }).codes.add(billCode);
  }

  for (const [clientId, info] of Object.entries(clientBilling)) {
    const cl = m.clientById[clientId]; if (!cl) continue;
    if (info.codes.size > 1) { conflicts.push({ label: `請求区分 (${info.name})`, values: [...info.codes].map(billingCodeToLabel) }); continue; }
    const code = [...info.codes][0];
    if (code !== (cl.billing_org || null)) changes.push({ scope: 'client', label: `請求区分 (${cl.name})`, before: billingCodeToLabel(cl.billing_org) || DASH, after: billingCodeToLabel(code), _apply: { kind: 'client', id: clientId, value: code } });
  }
  const directorRole = m.roleByCode['director'];
  for (const [, info] of Object.entries(projDirFee)) {
    if (info.fees.size > 1) { conflicts.push({ label: `ディレクション費 (${info.ctx})`, values: [...info.fees] }); continue; }
    const fee = [...info.fees][0];
    if (!directorRole) { errors.push(`ディレクターロールが roles マスタに無いためディレクション費を反映できません: ${info.ctx}`); continue; }
    const grp = (m.linesByProj[info.projId] || []).filter(l => l.category_id === info.cid);
    const cur = directorFeeOfGroup(grp, m);
    // 未設定(—) のまま 0 を書いても実体は変わらないので差分に出さない
    if (cur === null && fee === 0) continue;
    if (cur === fee) continue;
    changes.push({
      scope: 'dir',
      label: `ディレクション費 (${info.ctx})`,
      before: (cur == null ? DASH : cur),
      after: fee,
      // 反映先の line は apply 時に引き直す（同じ反映ランでランク列から自動作成された
      // 成果物グループにも同時にディレクション費が乗るようにするため）
      _apply: { kind: 'dir_fee', projectId: info.projId, categoryId: info.cid, roleId: directorRole.id, value: fee },
    });
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
        // status を明示しないと DB default の 'draft' になり、ADR 005 の集計対象
        // （contracted/in_progress/delivered）から外れて売上・粗利に載らない。
        // 台帳から作られた行は「単価が確定した有効なグループ」なので contracted で作る
        // （案件モーダルの「プリセットから一括生成」と同じ扱い）。
        const ins = await supabase.from('project_estimate_lines').insert({ project_id: a.projectId, category_id: a.categoryId, rank: a.rank, name: `${a.catName} ${a.rank}ランク`, planned_count: 0, client_unit_price: a.charge || 0, currency: 'JPY', status: 'contracted', status_changed_at: new Date().toISOString() }).select('id').single();
        if (ins.error) throw new Error(ins.error.message);
        resp = await supabase.from('project_estimate_line_costs').insert({ line_id: ins.data.id, role_id: a.roleId, unit_price: a.value, currency: 'JPY', pricing_type: 'fixed_per_unit' });
        // 案件共通のディレクション費は自動作成したグループにも引き継ぐ（案件モーダルの
        // 「プリセットから一括生成」と同じ挙動。引き継がないと新ランクだけ ¥0 になる）
        if (!resp.error && a.dirRoleId && a.dirFee > 0) {
          const dirIns = await supabase.from('project_estimate_line_costs')
            .insert({ line_id: ins.data.id, role_id: a.dirRoleId, unit_price: a.dirFee, currency: 'JPY', pricing_type: 'fixed_per_unit' });
          if (dirIns.error) throw new Error(dirIns.error.message);
        }
      }
      else if (a.kind === 'client') resp = await supabase.from('clients').update({ billing_org: a.value }).eq('id', a.id);
      else if (a.kind === 'dir_fee') {
        // 案件編集モーダルの「🎬 ディレクター費 → 全グループに反映」と同じ挙動:
        // その案件×区分の全グループの role=director 行（user_id なし）へ 1本あたり単価を揃える。
        // 時給行は「⏱ 時給」モード・内訳での明示操作のみで変えるため、ここでは触らない。
        const { data: lines, error: linesErr } = await supabase
          .from('project_estimate_lines').select('id')
          .eq('project_id', a.projectId).eq('category_id', a.categoryId);
        if (linesErr) throw new Error(linesErr.message);
        if (!lines || !lines.length) throw new Error('反映先の成果物グループがありません（先にランク単価を入れてグループを作ってください）');
        for (const line of lines) {
          const { data: existing, error: exErr } = await supabase
            .from('project_estimate_line_costs').select('id, pricing_type')
            .eq('line_id', line.id).eq('role_id', a.roleId).is('user_id', null).maybeSingle();
          if (exErr) throw new Error(exErr.message);
          if (existing && existing.pricing_type === 'hourly') continue;
          if (a.value > 0) {
            const r2 = existing
              ? await supabase.from('project_estimate_line_costs')
                  .update({ unit_price: a.value, pricing_type: 'fixed_per_unit', percentage: null, actual_hours: null })
                  .eq('id', existing.id)
              : await supabase.from('project_estimate_line_costs')
                  .insert({ line_id: line.id, role_id: a.roleId, unit_price: a.value, pricing_type: 'fixed_per_unit', currency: 'JPY' });
            if (r2.error) throw new Error(r2.error.message);
          } else if (existing && existing.pricing_type === 'fixed_per_unit') {
            const r2 = await supabase.from('project_estimate_line_costs').delete().eq('id', existing.id);
            if (r2.error) throw new Error(r2.error.message);
          }
        }
        resp = null;
      }
      if (resp && resp.error) throw new Error(resp.error.message);
      applied++;
    } catch (e) { failures.push(`${ch.label}: ${e.message}`); }
  }
  return { applied, total: changes.length, conflicts, errors, failures };
}

module.exports = { exportLedger, computeChanges, applyChanges, getSheetUrl, TAB_TITLE: '（先頭シート）', directorFeeOfGroup };
