// utils/invoice-sheet-draft.js
// 📄 請求書テンプレ（スプレッドシート）へ納品済み分を下書き出力する — ADR 046
//
// 役割:
//   - 純関数: 対象クリエイティブの「納品済み」判定・役割解決・枠（明細ブロック）へのグルーピング・
//             ヘッダー／合計系数式・Sheets batchUpdate リクエストの組み立て（jest でテスト）
//   - Google API 呼び出し: テンプレのコピー作成（同名があれば再利用）と、コピーへの一括書き込み
//
// ⚠️ ルール（2026-09-28 さとるさん決定・変更しない）
//   - 税抜単価（H 列）は空欄のまま。単価は絶対に取り込まない
//   - 源泉区分（L 列）は全ブロック「対象」
//   - 発行者区分（D8）は空欄（本人が選択）
//   - テンプレ本体は一切変更しない（コピーだけを書き換える）
//
// ⚠️ 時刻ルール: 日付はすべて JST。TIMESTAMPTZ は toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' })
//   で 'YYYY-MM-DD' にしてから扱う。月末日などの計算は Date.UTC で行い、サーバーローカル TZ に依存しない。
//   Sheets へは「日付シリアル値」（1899-12-30 起点の日数）で書き込み、実際の日付値として入れる。
'use strict';

const { snapshotDirectorId, snapshotProducerId } = require('./my-stats');

// 既定のテンプレ（system_settings.invoice_sheet_template_id で上書き可）
const DEFAULT_TEMPLATE_ID = '1VuKNpoqTkmczbvSP3oTLL-LXcE6Z0fvgQbbTPj7hfm8';

// ---------- テンプレのレイアウト（2026-09-28 時点のテンプレを SA で実測） ----------
const INVOICE_SHEET_TITLE = '請求書';
const MASTER_SHEET_TITLE = 'マスタ';
const META_SHEET_TITLE = '_hfs';
const FIRST_ITEM_ROW = 18;          // 明細 1 枠目の先頭行（1-based）
const BLOCK_ROWS = 4;               // 1 枠 = 4 行（結合セル）
const TEMPLATE_BLOCKS = 8;          // テンプレの枠数（18〜49 行）
const TEMPLATE_LAST_ITEM_ROW = FIRST_ITEM_ROW + BLOCK_ROWS * TEMPLATE_BLOCKS - 1; // 49
const MASTER_TEMPLATE_LAST_ROW = 60; // 案件名プルダウンの参照範囲 'マスタ'!$A$2:$A$60
const ID_COL_INDEX = 13;            // N 列（非表示）: 枠ごとのクリエイティブ ID
const LAST_COL_INDEX = 13;          // 枠のコピー対象は A〜N
const MAX_LISTED_NAMES = 15;        // 内訳に並べるファイル名の上限（超えたら「ほか N 件」）

// レイアウト確認用: 17 行目の見出し（テンプレが想定外に変わっていたら書き込まずに止める）
const EXPECTED_HEADERS = {
  A: '納品日', B: '区分', C: '案件名', E: '品目・内訳',
  H: '税抜単価', I: '数量', J: '単位', K: '税抜金額', L: '源泉区分',
};

const ACCOUNT_TYPES = ['普通', '当座', '貯蓄'];

// ---------- 日付（JST 固定） ----------

/** TIMESTAMPTZ ISO → JST 'YYYY-MM-DD'。不正値は null */
function jstYmdOfIso(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
}

/** 'YYYY-MM-DD' → Sheets の日付シリアル値（1899-12-30 = 0） */
function ymdToSheetSerial(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd || ''));
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Math.round(ms / 86400000) + 25569; // 25569 = 1970-01-01 のシリアル値
}

/** その月の末日（日）。Date.UTC で計算するので TZ 非依存 */
function lastDayOfMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function ymd(year, month, day) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** 請求日（対象月の末日）と支払期限（翌月末日）を 'YYYY-MM-DD' で返す */
function invoiceDates(year, month) {
  const ny = month === 12 ? year + 1 : year;
  const nm = month === 12 ? 1 : month + 1;
  return {
    issueYmd: ymd(year, month, lastDayOfMonth(year, month)),
    dueYmd: ymd(ny, nm, lastDayOfMonth(ny, nm)),
  };
}

// ---------- 対象判定・分類 ----------

/**
 * 下書きに載せる「実際に納品済み」か。
 *   on_first_draft 案件: 初稿提出済み（first_draft_submitted_at あり）
 *   それ以外           : delivered_at あり / status='納品'（納品完了モード=force_delivered も status='納品' になる）/ force_delivered
 * 締切が当月なだけの未納品は載せない（ADR 046）。
 */
function isDeliveredForDraft(creative) {
  if (!creative) return false;
  const project = creative.projects || null;
  if (project && project.billing_timing === 'on_first_draft') {
    return !!creative.first_draft_submitted_at;
  }
  return !!creative.delivered_at || creative.status === '納品' || creative.force_delivered === true;
}

/**
 * 支払対象外（is_payable=false かつ special_payable でない）か。
 * 請求書生成（/invoices/generate の案件指定）と同じ「is_payable OR special_payable」基準。
 * on_first_draft 案件は納品前（is_payable=false のまま）に計上するので対象外判定しない。
 */
function isExcludedAsNotPayable(creative) {
  if (!creative) return true;
  const project = creative.projects || null;
  if (project && project.billing_timing === 'on_first_draft') return false;
  return creative.is_payable === false && !creative.special_payable;
}

/** 下書きの「納品日」（JST 'YYYY-MM-DD'）。on_first_draft は初稿提出日 */
function deliveredYmdForDraft(creative) {
  if (!creative) return null;
  const project = creative.projects || null;
  if (project && project.billing_timing === 'on_first_draft') {
    return jstYmdOfIso(creative.first_draft_submitted_at);
  }
  return jstYmdOfIso(creative.delivered_at)
    || (creative.final_deadline ? String(creative.final_deadline).slice(0, 10) : null)
    || (creative.draft_deadline ? String(creative.draft_deadline).slice(0, 10) : null);
}

/** 種別（動画/静止画）と単位。creative_type: video* → 動画/本、design*・image*・デザイン → 静止画/枚、その他 → 件 */
function classifyCreativeType(creativeType) {
  const ct = String(creativeType || '');
  if (ct.startsWith('video') || ct.includes('動画')) return { kind: '動画', unit: '本' };
  if (ct.startsWith('design') || ct.startsWith('image') || ct.includes('デザイン') || ct.includes('静止画')) {
    return { kind: '静止画', unit: '枚' };
  }
  return { kind: 'その他', unit: '件' };
}

/** clients.billing_org → 区分（HF / GND）。未設定は空（本人が選ぶ） */
function billingOrgLabel(org) {
  if (org === 'gnd') return 'GND';
  if (org === 'haruka') return 'HF';
  return '';
}

const ROLE_LABELS = {
  editor: '編集',
  director_as_editor: '編集',
  designer: 'デザイン',
  director: 'ディレクション',
  producer: 'プロデュース',
};
const ROLE_ORDER = ['編集', 'デザイン', 'ディレクション', 'プロデュース'];

function roleLabel(role) {
  return ROLE_LABELS[role] || String(role || '');
}

/**
 * この creative での uid の役割ラベル一覧（重複なし）。
 *   - creative_assignments の自分の行の role（Wチェック担当 'wcheck' は請求対象外として除く）
 *   - 納品時スナップショット優先のディレクター / プロデューサー（ADR 009・preview-items と同じ解決）
 */
function resolveRoleLabelsForUser(creative, uid) {
  const labels = [];
  const push = (l) => { if (l && !labels.includes(l)) labels.push(l); };
  for (const a of (creative?.creative_assignments || [])) {
    if (!a) continue;
    const mine = a.user_id === uid || (a.users && a.users.id === uid);
    if (!mine || !a.role || a.role === 'wcheck') continue;
    push(roleLabel(a.role));
  }
  if (snapshotDirectorId(creative) === uid) push(roleLabel('director'));
  if (snapshotProducerId(creative) === uid) push(roleLabel('producer'));
  return labels;
}

const KUBUN_ORDER = { HF: 0, GND: 1, '': 2 };

/**
 * 対象クリエイティブを「区分 × 案件 × 役割 × 種別」で枠にまとめる。
 * @param {object[]} creatives - collectInvoiceCandidateCreatives の結果（当月計上分）
 * @param {string} uid
 * @returns {{ groups: object[], creativeCount: number }}
 */
function groupCreativesForDraft(creatives, uid) {
  const byKey = new Map();
  const usedCreativeIds = new Set();
  for (const c of (creatives || [])) {
    if (!isDeliveredForDraft(c)) continue;
    if (isExcludedAsNotPayable(c)) continue;
    const roles = resolveRoleLabelsForUser(c, uid);
    if (!roles.length) continue;
    const kubun = billingOrgLabel(c.projects?.clients?.billing_org);
    const projectName = c.projects?.name || '';
    const { kind, unit } = classifyCreativeType(c.creative_type);
    const dYmd = deliveredYmdForDraft(c);
    for (const role of roles) {
      const key = [kubun, c.project_id || projectName, role, kind].join('\u0001');
      if (!byKey.has(key)) {
        byKey.set(key, { kubun, projectId: c.project_id || null, projectName, role, kind, unit, latestYmd: null, creatives: [] });
      }
      const g = byKey.get(key);
      if (!g.creatives.some(x => x.id === c.id)) {
        g.creatives.push({ id: c.id, file_name: c.file_name || '', ymd: dYmd });
      }
      if (dYmd && (!g.latestYmd || dYmd > g.latestYmd)) g.latestYmd = dYmd;
    }
    usedCreativeIds.add(c.id);
  }
  const groups = Array.from(byKey.values());
  for (const g of groups) {
    // 内訳は納品日 → ファイル名の順
    g.creatives.sort((a, b) => String(a.ymd || '').localeCompare(String(b.ymd || '')) || String(a.file_name).localeCompare(String(b.file_name), 'ja'));
    g.count = g.creatives.length;
    g.itemText = buildItemText(g);
  }
  groups.sort((a, b) =>
    (KUBUN_ORDER[a.kubun] ?? 9) - (KUBUN_ORDER[b.kubun] ?? 9)
    || String(a.projectName).localeCompare(String(b.projectName), 'ja')
    || (ROLE_ORDER.indexOf(a.role) === -1 ? 99 : ROLE_ORDER.indexOf(a.role)) - (ROLE_ORDER.indexOf(b.role) === -1 ? 99 : ROLE_ORDER.indexOf(b.role))
    || String(a.kind).localeCompare(String(b.kind), 'ja'));
  return { groups, creativeCount: usedCreativeIds.size };
}

/** 品目・内訳セルの文字列。1 行目 = 品目（例: 「hertech_動画編集 編集（動画）」）、2 行目以降 = ファイル名 */
function buildItemText(group, maxListed = MAX_LISTED_NAMES) {
  const head = `${group.projectName} ${group.role}（${group.kind}）`.trim();
  const names = (group.creatives || []).map(c => c.file_name || '(名称未設定)');
  const listed = names.slice(0, maxListed);
  const lines = [head, ...listed];
  if (names.length > maxListed) lines.push(`ほか ${names.length - maxListed} 件`);
  return lines.join('\n');
}

// ---------- レイアウト・数式 ----------

/** 枠数 n に対する行配置。テンプレの 8 枠より多ければ最終枠の後ろに 4 行ずつ挿入する */
function layoutForGroups(groupCount) {
  const blockCount = Math.max(TEMPLATE_BLOCKS, groupCount);
  const extraBlocks = blockCount - TEMPLATE_BLOCKS;
  const shift = extraBlocks * BLOCK_ROWS;
  const blockStarts = [];
  for (let i = 0; i < blockCount; i++) blockStarts.push(FIRST_ITEM_ROW + i * BLOCK_ROWS);
  return {
    blockCount,
    extraBlocks,
    shift,
    blockStarts,
    lastItemRow: TEMPLATE_LAST_ITEM_ROW + shift,
    row: (templateRow) => (templateRow > TEMPLATE_LAST_ITEM_ROW ? templateRow + shift : templateRow),
  };
}

/** 明細 1 枠の税抜金額（テンプレと同一式） */
function blockAmountFormula(r) {
  return `=IF(OR(H${r}="",I${r}=""),"",ROUND(H${r}*I${r},0))`;
}

/**
 * 明細範囲を参照する数式をすべて組み直す（自動の範囲拡張には頼らない）。
 * 枠数 8 のときはテンプレの数式と完全一致する（jest で担保）。
 * @returns {Record<string, string>} A1 セル → 数式
 */
function buildTotalsFormulas(layout) {
  const L = layout.lastItemRow;
  const R = layout.row;
  const k52 = `K${R(52)}`, k53 = `K${R(53)}`, k54 = `K${R(54)}`, k55 = `K${R(55)}`, k56 = `K${R(56)}`, k57 = `K${R(57)}`;
  const eList = layout.blockStarts.map(r => `E${r}`).join(',');
  return {
    H14: `=IF(ISNUMBER(${k57}),${k57},"")`,
    A15: `=IF(COUNTA(H18:H${L},I18:I${L},E18:E${L})=0,"薄黄色の欄に入力してください。単価は税抜金額です。",IF(${k57}="要確認","入力確認：発行者区分・品目・税抜単価・数量・源泉区分をご確認ください。","下記のとおりご請求申し上げます。"))`,
    [k52]: `=IF(COUNT(K18:K${L})=0,"",SUM(K18:K${L}))`,
    [`C${R(53)}`]: `=${k52}`,
    [`E${R(53)}`]: `=${k53}`,
    [k53]: `=IF(${k52}="","",ROUNDDOWN(${k52}*$A$${R(53)},0))`,
    [k54]: `=IF(${k52}="","",${k52}+${k53})`,
    [k55]: `=IF(${k52}="","",IF(D8="法人（国内）",0,IF(D8="個人（居住者）",IF(COUNTIFS(K18:K${L},">=0",K18:K${L},"<>",L18:L${L},"対象")+COUNTIFS(K18:K${L},">=0",K18:K${L},"<>",L18:L${L},"対象外")=COUNT(K18:K${L}),SUMIF(L18:L${L},"対象",K18:K${L}),"要確認"),"要確認")))`,
    [k56]: `=IF(${k52}="","",IF(ISNUMBER(${k55}),ROUNDDOWN(MIN(${k55},1000000)*10.21%+MAX(${k55}-1000000,0)*20.42%,0),"要確認"))`,
    [k57]: `=IF(COUNTA(H18:H${L},I18:I${L},E18:E${L})=0,"",IF(OR(COUNT(K18:K${L})<>COUNT(H18:H${L}),COUNT(K18:K${L})<>COUNT(I18:I${L}),COUNT(K18:K${L})<>COUNTA(${eList}),NOT(ISNUMBER(${k56}))),"要確認",${k54}-${k56}))`,
  };
}

/** ヘッダー（発行者・期間・件名・日付・振込先）の書き込み内容。未登録項目は書かない（テンプレのまま） */
function buildHeaderCells(user, year, month, layout) {
  const R = layout.row;
  const cells = [];
  const str = (a1, v) => { const s = v == null ? '' : String(v).trim(); if (s) cells.push({ a1, value: s }); };
  const u = user || {};
  const last = lastDayOfMonth(year, month);
  const { issueYmd, dueYmd } = invoiceDates(year, month);

  cells.push({ a1: 'A6', value: `請求対象期間：${year}年${month}月1日〜${month}月${last}日` });
  cells.push({ a1: 'A11', value: `件名：${year}年${month}月分 業務委託費` });
  cells.push({ a1: 'K11', value: ymdToSheetSerial(issueYmd), isNumber: true });
  cells.push({ a1: 'K12', value: ymdToSheetSerial(dueYmd), isNumber: true });

  str('H5', u.full_name || u.nickname);
  if (u.postal_code && String(u.postal_code).trim()) {
    cells.push({ a1: 'H6', value: `〒${String(u.postal_code).trim().replace(/^〒\s*/, '')}` });
  }
  str('H7', u.address);
  if (u.phone && String(u.phone).trim()) cells.push({ a1: 'H8', value: `TEL：${String(u.phone).trim()}` });
  str('K9', u.invoice_registration_number);

  str(`C${R(59)}`, u.bank_name);
  str(`J${R(59)}`, u.bank_code);
  str(`C${R(60)}`, u.branch_name);
  str(`J${R(60)}`, u.branch_code);
  if (ACCOUNT_TYPES.includes(String(u.account_type || '').trim())) str(`C${R(61)}`, u.account_type);
  str(`H${R(61)}`, u.account_number);
  str(`C${R(62)}`, u.account_holder_kana);
  return cells;
}

/** 内訳セルに必要な高さ（px）を概算。全角=2・半角=1 の幅単位で折返し行数を数える */
function estimateItemHeightPx(text, fontSize) {
  const unitsPerLine = fontSize <= 9 ? 40 : 33; // E〜G 結合幅 245px の実測ベース
  const lineHeight = fontSize <= 9 ? 14 : 18;
  let lines = 0;
  for (const line of String(text || '').split('\n')) {
    let units = 0;
    for (const ch of line) units += /[\u0000-ÿ｡-ﾟ]/.test(ch) ? 1 : 2;
    lines += Math.max(1, Math.ceil(units / unitsPerLine));
  }
  return lines * lineHeight + 8;
}

// ---------- A1 / GridRange ヘルパー ----------

function colIndexOf(letters) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}
function a1ToCell(a1) {
  const m = /^([A-Z]+)(\d+)$/.exec(a1);
  if (!m) throw new Error(`bad A1: ${a1}`);
  return { col: colIndexOf(m[1]), row: Number(m[2]) - 1 };
}

function cellValue(v, opts = {}) {
  if (opts.formula) return { userEnteredValue: { formulaValue: v } };
  if (opts.isNumber) return { userEnteredValue: { numberValue: v } };
  return { userEnteredValue: { stringValue: String(v) } };
}

function updateCellReq(sheetId, a1, value, opts) {
  const { row, col } = a1ToCell(a1);
  return {
    updateCells: {
      range: { sheetId, startRowIndex: row, endRowIndex: row + 1, startColumnIndex: col, endColumnIndex: col + 1 },
      rows: [{ values: [cellValue(value, opts)] }],
      fields: 'userEnteredValue',
    },
  };
}

/**
 * コピーしたスプレッドシートへの batchUpdate リクエスト一式を組み立てる（純関数）。
 * @param {object} p
 * @param {number} p.invoiceSheetId
 * @param {number} p.masterSheetId
 * @param {number} p.metaSheetId         - 新規作成する非表示シート _hfs の sheetId
 * @param {object|null} p.cfRule         - 請求書シートの源泉区分 条件付き書式（{index, rule}）。null なら触らない
 * @param {object|null} p.projectValidation - C18 の dataValidation（案件名プルダウン）。範囲拡張時に流用
 * @param {object[]} p.groups
 * @param {object} p.user
 * @param {number} p.year
 * @param {number} p.month
 * @param {string[]} p.masterNames       - マスタ A2〜 に書く案件名（重複なし）
 * @param {object} p.meta                - { user_id, generated_at }
 */
function buildDraftRequests(p) {
  const { invoiceSheetId, masterSheetId, metaSheetId, groups, user, year, month, masterNames, meta } = p;
  const layout = layoutForGroups(groups.length);
  const reqs = [];

  // 1. 枠が足りなければ、最終枠（46〜49 行）の直後に 4 行ずつ挿入し、書式・結合・入力規則・数式をコピー
  if (layout.extraBlocks > 0) {
    const srcStart = TEMPLATE_LAST_ITEM_ROW - BLOCK_ROWS; // 0-based 45（= 46 行目）
    reqs.push({
      insertDimension: {
        range: { sheetId: invoiceSheetId, dimension: 'ROWS', startIndex: TEMPLATE_LAST_ITEM_ROW, endIndex: TEMPLATE_LAST_ITEM_ROW + layout.shift },
        inheritFromBefore: true,
      },
    });
    for (let k = 0; k < layout.extraBlocks; k++) {
      const dst = TEMPLATE_LAST_ITEM_ROW + k * BLOCK_ROWS;
      reqs.push({
        copyPaste: {
          source: { sheetId: invoiceSheetId, startRowIndex: srcStart, endRowIndex: srcStart + BLOCK_ROWS, startColumnIndex: 0, endColumnIndex: LAST_COL_INDEX + 1 },
          destination: { sheetId: invoiceSheetId, startRowIndex: dst, endRowIndex: dst + BLOCK_ROWS, startColumnIndex: 0, endColumnIndex: LAST_COL_INDEX + 1 },
          pasteType: 'PASTE_NORMAL',
          pasteOrientation: 'NORMAL',
        },
      });
    }
    // 源泉区分の条件付き書式（L18:L49）を全枠へ広げる
    if (p.cfRule && p.cfRule.rule) {
      const rule = JSON.parse(JSON.stringify(p.cfRule.rule));
      rule.ranges = [{ sheetId: invoiceSheetId, startRowIndex: FIRST_ITEM_ROW - 1, endRowIndex: layout.lastItemRow, startColumnIndex: 11, endColumnIndex: 12 }];
      reqs.push({ updateConditionalFormatRule: { sheetId: invoiceSheetId, index: p.cfRule.index, rule } });
    }
  }

  // 2. マスタ（案件名プルダウンの参照先）を書き直す。テンプレの 59 行を超えたら入力規則の範囲も広げる
  const names = masterNames || [];
  const masterRows = Math.max(names.length, MASTER_TEMPLATE_LAST_ROW - 1);
  reqs.push({
    updateCells: {
      range: { sheetId: masterSheetId, startRowIndex: 1, endRowIndex: 1 + masterRows, startColumnIndex: 0, endColumnIndex: 1 },
      rows: Array.from({ length: masterRows }, (_, i) => ({ values: [i < names.length ? cellValue(names[i]) : {}] })),
      fields: 'userEnteredValue',
    },
  });
  const masterLastRow = Math.max(MASTER_TEMPLATE_LAST_ROW, 1 + names.length);
  if (masterLastRow !== MASTER_TEMPLATE_LAST_ROW || layout.extraBlocks > 0) {
    // 案件名セル（C 列）の入力規則を全枠で張り直す（参照範囲 'マスタ'!$A$2:$A$<末尾>）
    const baseRule = p.projectValidation ? JSON.parse(JSON.stringify(p.projectValidation)) : { strict: false, showCustomUi: true };
    baseRule.condition = { type: 'ONE_OF_RANGE', values: [{ userEnteredValue: `='${MASTER_SHEET_TITLE}'!$A$2:$A$${masterLastRow}` }] };
    for (const r of layout.blockStarts) {
      reqs.push({
        setDataValidation: {
          range: { sheetId: invoiceSheetId, startRowIndex: r - 1, endRowIndex: r, startColumnIndex: 2, endColumnIndex: 3 },
          rule: baseRule,
        },
      });
    }
  }

  // 3. ヘッダー・振込先
  for (const c of buildHeaderCells(user, year, month, layout)) {
    reqs.push(updateCellReq(invoiceSheetId, c.a1, c.value, { isNumber: c.isNumber }));
  }

  // 4. 明細ブロック（H=税抜単価 は書かない）
  layout.blockStarts.forEach((r, i) => {
    const g = groups[i];
    // 全枠の税抜金額式を張り直す（挿入枠もテンプレと同一式に揃える）
    reqs.push(updateCellReq(invoiceSheetId, `K${r}`, blockAmountFormula(r), { formula: true }));
    if (!g) return;
    const rowValues = [
      g.latestYmd ? cellValue(ymdToSheetSerial(g.latestYmd), { isNumber: true }) : {}, // A 納品日
      g.kubun ? cellValue(g.kubun) : {},                                               // B 区分
      g.projectName ? cellValue(g.projectName) : {},                                   // C 案件名
    ];
    reqs.push({
      updateCells: {
        range: { sheetId: invoiceSheetId, startRowIndex: r - 1, endRowIndex: r, startColumnIndex: 0, endColumnIndex: 3 },
        rows: [{ values: rowValues }],
        fields: 'userEnteredValue',
      },
    });
    reqs.push(updateCellReq(invoiceSheetId, `E${r}`, g.itemText));
    reqs.push(updateCellReq(invoiceSheetId, `I${r}`, g.count, { isNumber: true }));
    reqs.push(updateCellReq(invoiceSheetId, `J${r}`, g.unit));
    reqs.push(updateCellReq(invoiceSheetId, `L${r}`, '対象'));
    reqs.push(updateCellReq(invoiceSheetId, `N${r}`, g.creatives.map(c => c.id).join(',')));

    // 内訳が長い枠は文字を小さくして行を高くする（結合セルは自動で高さが変わらないため）
    const fontSize = g.count > 3 ? 9 : 11;
    if (fontSize !== 11) {
      reqs.push({
        repeatCell: {
          range: { sheetId: invoiceSheetId, startRowIndex: r - 1, endRowIndex: r, startColumnIndex: 4, endColumnIndex: 5 },
          cell: { userEnteredFormat: { textFormat: { fontSize } } },
          fields: 'userEnteredFormat.textFormat.fontSize',
        },
      });
    }
    const need = estimateItemHeightPx(g.itemText, fontSize);
    if (need > 20 * BLOCK_ROWS) {
      reqs.push({
        updateDimensionProperties: {
          range: { sheetId: invoiceSheetId, dimension: 'ROWS', startIndex: r - 1, endIndex: r - 1 + BLOCK_ROWS },
          properties: { pixelSize: Math.ceil(need / BLOCK_ROWS) },
          fields: 'pixelSize',
        },
      });
    }
  });

  // 5. 合計系の数式（明細範囲・E セル一覧を全枠で組み直し）
  const totals = buildTotalsFormulas(layout);
  for (const [a1, f] of Object.entries(totals)) reqs.push(updateCellReq(invoiceSheetId, a1, f, { formula: true }));

  // 6. N 列（クリエイティブ ID）を非表示に
  reqs.push({
    updateDimensionProperties: {
      range: { sheetId: invoiceSheetId, dimension: 'COLUMNS', startIndex: ID_COL_INDEX, endIndex: ID_COL_INDEX + 1 },
      properties: { hiddenByUser: true },
      fields: 'hiddenByUser',
    },
  });

  // 7. 非表示シート _hfs（生成メタ + 枠 → クリエイティブ ID）
  const metaRows = [
    ['key', 'value'],
    ['generator', 'HFS 請求書下書き（ADR 046）'],
    ['user_id', meta?.user_id || ''],
    ['year', String(year)],
    ['month', String(month)],
    ['generated_at', meta?.generated_at || ''],
    [],
    ['block', 'row', '区分', '案件名', '役割', '種別', '数量', 'creative_ids'],
    ...groups.map((g, i) => [String(i + 1), String(layout.blockStarts[i]), g.kubun, g.projectName, g.role, g.kind, String(g.count), g.creatives.map(c => c.id).join(',')]),
  ];
  reqs.push({
    addSheet: {
      properties: {
        sheetId: metaSheetId,
        title: META_SHEET_TITLE,
        hidden: true,
        gridProperties: { rowCount: Math.max(50, metaRows.length + 10), columnCount: 10 },
      },
    },
  });
  reqs.push({
    updateCells: {
      range: { sheetId: metaSheetId, startRowIndex: 0, endRowIndex: metaRows.length, startColumnIndex: 0, endColumnIndex: 8 },
      rows: metaRows.map(row => ({ values: Array.from({ length: 8 }, (_, ci) => (row[ci] != null && row[ci] !== '' ? cellValue(row[ci]) : {})) })),
      fields: 'userEnteredValue',
    },
  });

  return { requests: reqs, layout };
}

// ---------- Google API（コピー作成・書き込み） ----------

function escapeDriveQ(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function sheetUrl(fileId) {
  return `https://docs.google.com/spreadsheets/d/${fileId}/edit`;
}

/** 【株式会社HARUKA FILM】請求書_YYYY年MM月_氏名 */
function buildDraftFileName(year, month, displayName) {
  return `【株式会社HARUKA FILM】請求書_${year}年${String(month).padStart(2, '0')}月_${displayName}`;
}

/** フォルダ内の同名スプレッドシート（ゴミ箱以外）を探す */
async function findExistingDraft(drive, folderId, fileName) {
  const r = await drive.files.list({
    q: `name='${escapeDriveQ(fileName)}' and '${folderId}' in parents and trashed=false and mimeType='application/vnd.google-apps.spreadsheet'`,
    fields: 'files(id, name, webViewLink)',
    pageSize: 5,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  return (r.data.files || [])[0] || null;
}

async function copyTemplate(drive, templateId, folderId, fileName) {
  const r = await drive.files.copy({
    fileId: templateId,
    requestBody: { name: fileName, parents: [folderId] },
    fields: 'id, name, webViewLink',
    supportsAllDrives: true,
  });
  return r.data;
}

/**
 * コピー済みスプレッドシートに下書きを書き込む（読み取り 2 回 + batchUpdate 1 回）。
 * テンプレのレイアウトが想定と違えば何も書かずに例外を投げる。
 */
async function writeDraftToSpreadsheet(sheets, spreadsheetId, { groups, user, year, month, extraProjectNames, meta }) {
  const [metaRes, dataRes] = await Promise.all([
    sheets.spreadsheets.get({
      spreadsheetId,
      fields: 'sheets(properties(sheetId,title),conditionalFormats)',
    }),
    sheets.spreadsheets.get({
      spreadsheetId,
      ranges: [`${INVOICE_SHEET_TITLE}!A17:L18`, `${MASTER_SHEET_TITLE}!A2:A1000`],
      includeGridData: true,
      fields: 'sheets(properties(title),data(startRow,rowData(values(formattedValue,dataValidation))))',
    }),
  ]);
  const byTitle = new Map((metaRes.data.sheets || []).map(s => [s.properties.title, s]));
  const inv = byTitle.get(INVOICE_SHEET_TITLE);
  const master = byTitle.get(MASTER_SHEET_TITLE);
  if (!inv || !master) throw new Error(`テンプレに「${INVOICE_SHEET_TITLE}」「${MASTER_SHEET_TITLE}」シートが見つかりません`);
  if (byTitle.has(META_SHEET_TITLE)) throw new Error(`テンプレに既に「${META_SHEET_TITLE}」シートがあります`);

  // 見出し行（17 行目）でレイアウトを確認
  const invData = (dataRes.data.sheets || []).find(s => s.properties.title === INVOICE_SHEET_TITLE)?.data?.[0];
  const headerVals = invData?.rowData?.[0]?.values || [];
  for (const [col, label] of Object.entries(EXPECTED_HEADERS)) {
    const got = headerVals[colIndexOf(col)]?.formattedValue || '';
    if (got !== label) throw new Error(`請求書テンプレのレイアウトが想定と異なります（${col}17="${got}"、期待値="${label}"）。管理者に連絡してください`);
  }
  const projectValidation = invData?.rowData?.[1]?.values?.[2]?.dataValidation || null;

  // 源泉区分の条件付き書式（L 列の明細範囲）
  let cfRule = null;
  (inv.conditionalFormats || []).forEach((rule, index) => {
    if (cfRule) return;
    const hit = (rule.ranges || []).some(r => r.startColumnIndex === 11 && r.startRowIndex === FIRST_ITEM_ROW - 1);
    if (hit) cfRule = { index, rule };
  });

  // マスタ: テンプレ既存の案件名 ＋ 今回使う案件名 ＋ 進行中案件名（重複なし）
  const masterData = (dataRes.data.sheets || []).find(s => s.properties.title === MASTER_SHEET_TITLE)?.data?.[0];
  const existingNames = (masterData?.rowData || []).map(r => r.values?.[0]?.formattedValue || '').filter(Boolean);
  const masterNames = [];
  const add = (n) => { const s = String(n || '').trim(); if (s && !masterNames.includes(s)) masterNames.push(s); };
  existingNames.forEach(add);
  groups.forEach(g => add(g.projectName));
  (extraProjectNames || []).slice().sort((a, b) => String(a).localeCompare(String(b), 'ja')).forEach(add);

  const usedIds = new Set((metaRes.data.sheets || []).map(s => s.properties.sheetId));
  let metaSheetId = 460046;
  while (usedIds.has(metaSheetId)) metaSheetId++;

  const { requests, layout } = buildDraftRequests({
    invoiceSheetId: inv.properties.sheetId,
    masterSheetId: master.properties.sheetId,
    metaSheetId,
    cfRule,
    projectValidation,
    groups,
    user,
    year,
    month,
    masterNames,
    meta,
  });
  await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
  return { layout, masterCount: masterNames.length };
}

module.exports = {
  DEFAULT_TEMPLATE_ID,
  INVOICE_SHEET_TITLE,
  MASTER_SHEET_TITLE,
  META_SHEET_TITLE,
  FIRST_ITEM_ROW,
  BLOCK_ROWS,
  TEMPLATE_BLOCKS,
  jstYmdOfIso,
  ymdToSheetSerial,
  lastDayOfMonth,
  invoiceDates,
  isDeliveredForDraft,
  isExcludedAsNotPayable,
  deliveredYmdForDraft,
  classifyCreativeType,
  billingOrgLabel,
  roleLabel,
  resolveRoleLabelsForUser,
  groupCreativesForDraft,
  buildItemText,
  layoutForGroups,
  blockAmountFormula,
  buildTotalsFormulas,
  buildHeaderCells,
  estimateItemHeightPx,
  buildDraftRequests,
  buildDraftFileName,
  findExistingDraft,
  copyTemplate,
  writeDraftToSpreadsheet,
  sheetUrl,
};
