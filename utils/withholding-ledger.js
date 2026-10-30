// utils/withholding-ledger.js
// =============================================================
// 🧾 源泉徴収台帳（ADR 054 §5 Stage D）— 純関数のみ（DB・Google API に触らない）
//
// 「支払日ベース」で集計する（源泉所得税は支払った月の翌月10日に納付する）。
// 入力の支払行（payment）は routes/withholding.js（utils/withholding-ledger-source.js）が
// payout_transfer_items（あおぞら API 振込・completed）と payout_records（手動振込・paid）を
// invoices（同 issuer_id/year/month・提出済/承認済）に結合して組み立てる。
//
// payment = {
//   user:           users 行（id, full_name, nickname, address, postal_code, business_type, invoice_registration_number）
//   paid_at:        支払日時（ISO・UTC で保存されているので JST に直して日付にする）
//   paid_via:       'manual' | 'aozora_api' | null（null は旧データ＝手動）
//   invoice:        invoices 行 | null
//   invoice_amount: payout_records.invoice_amount（請求書が無いときだけ使う・税込扱い）
//   apply_no:       総合振込の受付番号 | null
//   payout_record_id / transfer_item_id: 追跡用（任意）
// }
//
// 金額の決め方（ADR 054 §1-5 / §5）:
//   exclusive（新方式）… subtotal_amount / tax_amount / withholding_amount / payout_amount の4列
//   inclusive（旧方式）… total_amount のみ（源泉 0）
//   請求書なし          … invoice_amount を税込として源泉 0。needs_review=true
//
// 月の境界・支払日はすべて Asia/Tokyo 固定（サーバーが TZ=UTC でも同じ結果になる）。
// =============================================================

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

const CATEGORY_LABEL = '報酬・料金等（所得税法204条1項）';
// 業務種別（デザイン料／映像制作費 など）は HFS に持っていないので固定文言。支払調書の細目欄に使う
const DETAIL_LABEL = '制作業務の報酬';

const BUSINESS_TYPE_LABEL = {
  individual: '個人',
  sole_proprietor: '個人',
  corporation: '法人',
};

const PAID_VIA_LABEL = { manual: '手動', aozora_api: 'API' };

function toInt(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
}

/** ISO → 'YYYY-MM-DD'（JST）。不正値は null */
function isoToJstYmd(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
}

/** JST の月初 0:00 を UTC ISO で返す（DB 範囲検索用） */
function jstMonthStartIso(year, month) {
  return new Date(Date.UTC(year, month - 1, 1, 0, 0, 0) - JST_OFFSET_MS).toISOString();
}

/** 対象月の [start, end) を UTC ISO で返す。month 省略時は年全体 */
function jstRange(year, month = null) {
  const y = Number(year);
  if (!Number.isInteger(y)) throw new Error('year が不正です');
  if (month == null) {
    return { startIso: jstMonthStartIso(y, 1), endIso: jstMonthStartIso(y + 1, 1) };
  }
  const m = Number(month);
  if (!Number.isInteger(m) || m < 1 || m > 12) throw new Error('month が不正です');
  const next = m === 12 ? { y: y + 1, m: 1 } : { y, m: m + 1 };
  return { startIso: jstMonthStartIso(y, m), endIso: jstMonthStartIso(next.y, next.m) };
}

/** 'YYYY-MM' の前月（JST の現在日付から前月を求めるときに使う） */
function prevMonthOf(year, month) {
  return month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
}

/** 支払月の納付期限（翌月10日・JST）'YYYY-MM-DD'（土日祝の繰り下げなし＝法定の基準日） */
function paymentDueDate(year, month) {
  const next = month === 12 ? { y: year + 1, m: 1 } : { y: year, m: month + 1 };
  return `${next.y}-${String(next.m).padStart(2, '0')}-10`;
}

function addDaysYmd(ymd, n) {
  const d = new Date(`${ymd}T12:00:00Z`); // UTC 正午なので日付は TZ に依らず不変
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * 実際の納付期限: 翌月10日が土日祝なら翌営業日へ繰り下げ。
 * 祝日表（lib/japanese-holidays）にその年が無ければ土日だけ繰り下げて holiday_checked=false を返す
 * （呼び出し側で「祝日は要確認」と注記する）。
 * @returns {{ date: string, base: string, holiday_checked: boolean, shifted: boolean }}
 */
function taxPaymentDueDate(year, month) {
  const base = paymentDueDate(year, month);
  let holidays = null;
  try { holidays = require('../lib/japanese-holidays'); } catch (_) { holidays = null; }
  const yearCovered = !!(holidays && holidays.HOLIDAYS && Object.keys(holidays.HOLIDAYS).some(k => k.startsWith(base.slice(0, 4))));
  const isOff = (ymd) => {
    const wd = new Date(`${ymd}T12:00:00Z`).getUTCDay();
    if (wd === 0 || wd === 6) return true;
    return yearCovered && holidays.isJapanHoliday(ymd);
  };
  let date = base;
  for (let i = 0; i < 10 && isOff(date); i++) date = addDaysYmd(date, 1);
  return { date, base, holiday_checked: yearCovered, shifted: date !== base };
}

/** 'YYYY-MM-DD' → 'YYYY/MM/DD'（通知・様式向け） */
function ymdSlash(ymd) {
  return ymd ? String(ymd).replace(/-/g, '/') : '';
}

/**
 * 徴収高計算書に載せる「源泉対象の支払」だけの集計（源泉 0 の法人・旧方式・請求書なしは数えない）。
 * @returns {{ payee_count, payment_count, gross_total, withholding_total, first_paid_date, last_paid_date, excluded_count }}
 */
function summarizeWithholdingTargets(rows) {
  const list = rows || [];
  const targets = list.filter(r => (r.withholding || 0) > 0);
  const payees = new Set();
  let gross = 0, wh = 0;
  for (const r of targets) {
    if (r.user_id) payees.add(r.user_id);
    gross += r.gross || 0;
    wh += r.withholding || 0;
  }
  const dates = (targets.length ? targets : list).map(r => r.paid_date).filter(Boolean).sort();
  return {
    payee_count: payees.size,
    payment_count: targets.length,
    gross_total: gross,
    withholding_total: wh,
    first_paid_date: dates[0] || null,
    last_paid_date: dates[dates.length - 1] || null,
    excluded_count: list.length - targets.length,
  };
}

function userLabel(user) {
  if (!user) return '';
  return user.full_name || user.nickname || '';
}

function entityTypeLabel(user) {
  const t = user?.business_type;
  return BUSINESS_TYPE_LABEL[t] || (t ? t : '不明');
}

/**
 * 支払 1 件 → 台帳 1 行。
 * @returns {{
 *   user_id, user_name, paid_at, paid_date, paid_month,
 *   invoice_id, invoice_number, tax_mode, source,
 *   subtotal, tax, withholding, gross, net,
 *   paid_via, paid_via_label, apply_no,
 *   needs_review, review_reasons: string[], notes: string[]
 * }}
 */
/**
 * payout_records.ledger_snapshot（支払時点で凍結した請求書の金額・ADR 054 追補 2026-10-30）を
 * invoices 行と同じ形に直す。snapshot が無ければ null。
 *   { amount, invoice_id, invoice_number, subtotal_amount, tax_amount, withholding_amount, payout_amount, snapshot_at }
 *   subtotal_amount があれば exclusive、無くて invoice_id があれば inclusive（payout_amount＝税込）、どちらも無ければ請求書なし
 */
function invoiceFromSnapshot(snap) {
  if (!snap || typeof snap !== 'object') return null;
  if (!snap.invoice_id && snap.subtotal_amount == null && snap.payout_amount == null) return null;
  const subtotal = toInt(snap.subtotal_amount);
  const tax = toInt(snap.tax_amount);
  const withholding = toInt(snap.withholding_amount);
  const payout = toInt(snap.payout_amount);
  const totalSnap = toInt(snap.total_amount);
  const count = toInt(snap.invoice_count);
  const base = {
    id: snap.invoice_id || null,
    invoice_number: snap.invoice_number || null,
    invoice_count: count != null && count > 1 ? count : null, // Stage B は同月の請求書を合算して凍結する
  };
  if (subtotal != null) {
    const total = totalSnap ?? (subtotal + (tax ?? 0));
    return {
      ...base, tax_mode: 'exclusive',
      subtotal_amount: subtotal, tax_amount: tax ?? 0, total_amount: total,
      withholding_amount: withholding ?? 0, payout_amount: payout ?? (total - (withholding ?? 0)),
      withholding_enabled: (withholding ?? 0) > 0 ? true : null,
    };
  }
  return { ...base, tax_mode: 'inclusive', total_amount: totalSnap ?? payout ?? toInt(snap.amount) ?? 0 };
}

/**
 * payout_transfer_items（API 振込の明細）→ 凍結値のスナップショット。
 * Stage B は依頼時に gross_amount（税込）/ tax_amount（消費税・inclusive と請求書なしは null）/ withholding_amount /
 * amount（振込額＝差引）を請求書から転記して保存するので、台帳はこれを優先して使う（後から請求書を直しても変わらない）。
 * gross_amount が無い行（旧データ）は null を返し、呼び出し側が payout_records.ledger_snapshot → 現在の請求書の順で補う。
 */
function snapshotFromTransferItem(item, invoiceNumber = null) {
  if (!item) return null;
  const gross = toInt(item.gross_amount);
  if (gross == null) return null;
  const amount = toInt(item.amount);
  const tax = toInt(item.tax_amount);
  const withholding = toInt(item.withholding_amount) ?? 0;
  const common = { amount: amount ?? gross, snapshot_at: item.completed_at || item.created_at || null };
  if (!item.invoice_id) {
    // 請求書なし（PDF 抽出額）: 税込＝amount、請求書列は空
    return { ...common, invoice_id: null, invoice_number: null, subtotal_amount: null, tax_amount: null, withholding_amount: 0, payout_amount: null, total_amount: null };
  }
  if (tax == null) {
    // inclusive（内税・源泉なし）
    return { ...common, invoice_id: item.invoice_id, invoice_number: invoiceNumber, subtotal_amount: null, tax_amount: null, withholding_amount: 0, payout_amount: gross, total_amount: gross };
  }
  return {
    ...common, invoice_id: item.invoice_id, invoice_number: invoiceNumber,
    subtotal_amount: gross - tax, tax_amount: tax, withholding_amount: withholding,
    payout_amount: amount ?? (gross - withholding), total_amount: gross,
  };
}

const DUP_INVOICE_REASON = '同じ月に提出済みの請求書が複数あります';

/**
 * 同月に提出済み請求書が複数あった支払（dupKeys: 'pr:<payout_record_id>' / 'ti:<transfer_item_id>' の Set）を
 * 要確認にする（差額行は除く・O(n)）。どちらの請求書を引くべきか人が決める。
 */
function applyDupReasons(rows, dupKeys) {
  if (!dupKeys || !dupKeys.size) return rows;
  return (rows || []).map(r => {
    if (r.source === 'extra' || r.from_snapshot) return r; // 凍結済みの行は依頼時点で確定している
    const hit = (r.payout_record_id && dupKeys.has(`pr:${r.payout_record_id}`)) || (r.transfer_item_id && dupKeys.has(`ti:${r.transfer_item_id}`));
    if (!hit) return r;
    return { ...r, needs_review: true, review_reasons: [...r.review_reasons, DUP_INVOICE_REASON] };
  });
}

function buildLedgerRow(payment) {
  const p = payment || {};
  const user = p.user || {};
  const reasons = [];
  const notes = [];

  // 支払時点のスナップショット（API 明細の凍結値 → payout_records.ledger_snapshot）優先。
  // 無い行だけ現在の請求書から組み立てる（請求書の後編集で変わりうる）ので注記を付ける
  const snapInv = invoiceFromSnapshot(p.snapshot);
  const fromSnapshot = !!snapInv;
  const inv = snapInv || p.invoice || null;
  if (!fromSnapshot && inv) notes.push('スナップショット無し（請求書の後編集で変わる可能性）');
  if (fromSnapshot && inv.invoice_count) notes.push(`同月の請求書 ${inv.invoice_count} 枚を合算`);

  const paidDate = isoToJstYmd(p.paid_at);
  if (!paidDate) reasons.push('支払日が未設定');

  let subtotal = null, tax = null, withholding = 0, gross = 0, net = 0;
  let source = 'none';
  let taxMode = inv?.tax_mode || null;

  if (inv && inv.tax_mode === 'exclusive') {
    source = 'invoice_exclusive';
    subtotal = toInt(inv.subtotal_amount) ?? 0;
    tax = toInt(inv.tax_amount) ?? 0;
    withholding = toInt(inv.withholding_amount) ?? 0;
    gross = toInt(inv.total_amount) ?? (subtotal + tax);
    net = toInt(inv.payout_amount) ?? (gross - withholding);
    if (subtotal + tax !== gross) reasons.push('請求書の税抜＋消費税と税込額が一致しない');
    if (gross - withholding !== net) reasons.push('請求書の税込−源泉と差引額が一致しない');
    if (inv.withholding_enabled === true && withholding === 0 && subtotal > 0) reasons.push('源泉ありの請求書なのに源泉額が0');
    if (inv.withholding_enabled === false) notes.push('源泉なし（法人・対象外）');
  } else if (inv) {
    source = 'invoice_inclusive';
    taxMode = 'inclusive';
    gross = toInt(inv.total_amount) ?? 0;
    net = gross;
    withholding = 0;
    notes.push('旧方式（内税）・源泉なし');
  } else {
    source = 'pdf';
    const amt = toInt(p.snapshot?.amount) ?? toInt(p.paid_amount) ?? toInt(p.invoice_amount);
    if (amt == null) {
      reasons.push('請求書なし・金額不明');
    } else {
      gross = amt;
      net = amt;
      reasons.push('請求書なし（PDF抽出額を税込として計上）');
    }
  }

  if (gross <= 0 && !reasons.some(r => r.includes('金額不明'))) reasons.push('支払金額が0以下');

  const paidVia = p.paid_via === 'aozora_api' ? 'aozora_api' : 'manual';
  return {
    user_id: user.id || p.user_id || null,
    user_name: userLabel(user),
    paid_at: p.paid_at || null,
    paid_date: paidDate,
    paid_month: paidDate ? paidDate.slice(0, 7) : null,
    invoice_id: inv?.id || null,
    invoice_number: inv?.invoice_number || null,
    tax_mode: taxMode,
    source,
    subtotal,
    tax,
    withholding,
    gross,
    net,
    paid_via: paidVia,
    paid_via_label: PAID_VIA_LABEL[paidVia],
    apply_no: p.apply_no || null,
    payout_record_id: p.payout_record_id || null,
    transfer_item_id: p.transfer_item_id || null,
    from_snapshot: fromSnapshot,
    // 実際に支払った額（消し込み額／振込額）。請求書の差引と違えば buildLedgerRows が差額行を足す
    paid_amount: toInt(p.snapshot?.amount) ?? toInt(p.paid_amount) ?? null,
    needs_review: reasons.length > 0,
    review_reasons: reasons,
    notes,
  };
}

const EXTRA_REASON = '請求書外の支払（PDF 抽出額との差額）';

/**
 * 支払額（消し込み額）と請求書の差引額が一致しない支払 → 差額の独立行（税込＝差額・源泉 0・要確認）。
 * 差額が負（請求書より少なく払った）も負の行で出す。差額を黙って落とさない（ADR 054 追補 2026-10-30）。
 */
function buildExtraRow(base) {
  const diff = base.paid_amount - base.net;
  const reasons = [EXTRA_REASON];
  if (diff < 0) reasons.push('請求書の差引額より少なく支払っています');
  return {
    ...base,
    invoice_id: null,
    invoice_number: null,
    tax_mode: null,
    source: 'extra',
    subtotal: null,
    tax: null,
    withholding: 0,
    gross: diff,
    net: diff,
    paid_amount: null,
    extra_of_payout_record_id: base.payout_record_id || null,
    needs_review: true,
    review_reasons: reasons,
    notes: [`請求書 ${base.invoice_number || '(番号なし)'} の差引 ${base.net.toLocaleString('ja-JP')}円 に対し支払 ${base.paid_amount.toLocaleString('ja-JP')}円`],
  };
}

/** 支払行の配列 → 台帳行（支払日→氏名の順）。請求書と支払額がずれた分は差額行を続けて出す */
function buildLedgerRows(payments) {
  const rows = [];
  for (const p of payments || []) {
    const row = buildLedgerRow(p);
    rows.push(row);
    const hasInvoice = row.source === 'invoice_exclusive' || row.source === 'invoice_inclusive';
    if (hasInvoice && row.paid_amount != null && row.paid_amount !== row.net) rows.push(buildExtraRow(row));
  }
  rows.sort((a, b) =>
    String(a.paid_date || '9999').localeCompare(String(b.paid_date || '9999'))
    || String(a.user_name).localeCompare(String(b.user_name), 'ja')
    || (a.source === 'extra') - (b.source === 'extra'));
  return rows;
}

/** 月次（納付用）の合計 */
function summarizeMonth(rows) {
  const list = rows || [];
  const payees = new Set();
  let gross = 0, withholding = 0, net = 0, review = 0;
  for (const r of list) {
    if (r.user_id) payees.add(r.user_id);
    gross += r.gross || 0;
    withholding += r.withholding || 0;
    net += r.net || 0;
    if (r.needs_review) review++;
  }
  return {
    payee_count: payees.size,
    payment_count: list.length,
    gross_total: gross,
    withholding_total: withholding,
    net_total: net,
    // 実際に支払った額の合計（差額行込み）。net_total と同値だが「実支払＝台帳」を明示するために別名で返す
    paid_total: net,
    needs_review_count: review,
  };
}

/**
 * 年次（支払調書用）: 支払先ごとの年間合計。
 * users の行は rows に含まれないので usersById（Map または {id: user}）を渡す。
 */
function summarizeYearByPayee(rows, usersById) {
  const lookup = (id) => {
    if (!usersById) return null;
    if (typeof usersById.get === 'function') return usersById.get(id) || null;
    return usersById[id] || null;
  };
  const byUser = new Map();
  for (const r of rows || []) {
    const key = r.user_id || `__noid__:${r.user_name}`;
    if (!byUser.has(key)) {
      const u = lookup(r.user_id) || {};
      byUser.set(key, {
        user_id: r.user_id || null,
        user_name: r.user_name || userLabel(u),
        postal_code: u.postal_code || '',
        address: u.address || '',
        category: CATEGORY_LABEL,
        detail: DETAIL_LABEL,
        gross_total: 0,
        withholding_total: 0,
        net_total: 0,
        payment_count: 0,
        needs_review_count: 0,
        entity_type: entityTypeLabel(u),
        business_type: u.business_type || null,
        invoice_registration_number: u.invoice_registration_number || '',
      });
    }
    const agg = byUser.get(key);
    agg.gross_total += r.gross || 0;
    agg.withholding_total += r.withholding || 0;
    agg.net_total += r.net || 0;
    agg.payment_count += 1;
    if (r.needs_review) agg.needs_review_count += 1;
  }
  const list = [...byUser.values()];
  list.sort((a, b) => String(a.user_name).localeCompare(String(b.user_name), 'ja'));
  return list;
}

// ---------- スプレッドシート用 2D 配列 ----------

function ymLabel(year, month) {
  return `${year}年${month}月`;
}

/** (a) 月次 納付用 */
function buildMonthlySheetRows({ year, month, summary }) {
  const s = summary || summarizeMonth([]);
  const due = taxPaymentDueDate(year, month);
  const dueNote = due.shifted
    ? `${due.base} が土日${due.holiday_checked ? '祝' : ''}のため翌営業日${due.holiday_checked ? '' : '（祝日は要確認）'}`
    : (due.holiday_checked ? '支払月の翌月10日' : '支払月の翌月10日（祝日は要確認）');
  return [
    ['支払年月', '区分', '人数', '支払件数', '支払金額（税込）', '源泉徴収税額', '差引支払額', '要確認件数', '納付期限', '納付期限の注記'],
    [ymLabel(year, month), CATEGORY_LABEL, s.payee_count, s.payment_count, s.gross_total, s.withholding_total, s.net_total, s.needs_review_count, due.date, dueNote],
    [],
    ['※ 支払日（JST）ベースで集計。源泉徴収税額は提出済み・承認済みの請求書（税抜方式）の源泉欄の合計です。'],
    ['※ 「要確認」は請求書なし・金額不整合の支払です。支払台帳タブで内容を確認してください。'],
    ['※ 納期の特例（半年ごと納付）の適用可否は税理士に確認してください。マイナンバーは HFS では扱いません。'],
  ];
}

/** (b) 年次 支払調書用 */
function buildYearlySheetRows({ year, payees }) {
  const header = ['氏名', '郵便番号', '住所', '区分', '細目', '年間支払金額（税込）', '年間源泉徴収税額', '差引支払額', '支払件数', '個人/法人', 'インボイス登録番号', '要確認件数'];
  const body = (payees || []).map(p => [
    p.user_name, p.postal_code, p.address, p.category, p.detail,
    p.gross_total, p.withholding_total, p.net_total, p.payment_count,
    p.entity_type, p.invoice_registration_number, p.needs_review_count,
  ]);
  const totals = (payees || []).reduce((a, p) => {
    a.gross += p.gross_total; a.wh += p.withholding_total; a.net += p.net_total; a.cnt += p.payment_count; a.rev += p.needs_review_count; return a;
  }, { gross: 0, wh: 0, net: 0, cnt: 0, rev: 0 });
  return [
    header,
    ...body,
    ['合計', '', '', '', '', totals.gross, totals.wh, totals.net, totals.cnt, '', '', totals.rev],
    [],
    [`※ ${year}年1月〜12月の支払日（JST）ベース。支払調書の提出要否（年間5万円超など）・マイナンバーは税理士側で確認・管理します。`],
    ['※ 住所・氏名は HFS のメンバー情報（基本情報）から転記しています。空欄は本人に登録を依頼してください。'],
  ];
}

/** (c) 支払台帳 */
function buildLedgerSheetRows({ rows }) {
  const header = ['支払日', '氏名', '請求書番号', '方式', '税抜', '消費税', '源泉徴収税額', '税込', '差引支払額', '経路', '受付番号', '要確認', '備考'];
  const body = (rows || []).map(r => [
    r.paid_date || '', r.user_name, r.invoice_number || 'なし',
    r.source === 'invoice_exclusive' ? '税抜' : r.source === 'invoice_inclusive' ? '内税' : r.source === 'extra' ? '請求書外' : '請求書なし',
    r.subtotal ?? '', r.tax ?? '', r.withholding, r.gross, r.net,
    r.paid_via_label, r.apply_no || '',
    r.needs_review ? '⚠' : '',
    [...r.review_reasons, ...r.notes].join(' / '),
  ]);
  const s = summarizeMonth(rows);
  return [
    header,
    ...body,
    ['合計', `${s.payee_count}名 / ${s.payment_count}件`, '', '', '', '', s.withholding_total, s.gross_total, s.net_total, '', '', s.needs_review_count ? `${s.needs_review_count}件` : '', ''],
  ];
}

// ---------- (d) 徴収高計算書 転記用（e-Tax「報酬・料金等の所得税徴収高計算書」の入力順） ----------

const TAX_FORM_CATEGORY = '原稿料・講演料等';   // 国税庁様式の区分名。コード番号は様式で確認して入れる
const TAX_FORM_CATEGORY_CODE = '';               // 未確認のため空欄（セル注記「様式で確認」）

/**
 * 徴収高計算書に打ち込む項目を同じ並びで 2 列（項目・値）＋注記列に並べる。
 * 人員・支払額・税額は「源泉対象の支払（源泉 > 0）」だけを数える（源泉 0 の法人・旧方式・請求書なしは含めない）。
 * @param {object} summary  summarizeMonth(rows) の結果（要確認件数に使う）
 * @param {object[]} rows   buildLedgerRows の結果
 * @param {{year:number, month:number}} p
 */
function buildTaxPaymentFormRows(summary, rows, { year, month }) {
  const s = summary || summarizeMonth(rows);
  const t = summarizeWithholdingTargets(rows);
  const due = taxPaymentDueDate(year, month);
  const ym = `${year}-${String(month).padStart(2, '0')}`;
  const period = t.first_paid_date
    ? (t.first_paid_date === t.last_paid_date ? ymdSlash(t.first_paid_date) : `${ymdSlash(t.first_paid_date)}〜${ymdSlash(t.last_paid_date)}`)
    : '';
  const dueNote = due.shifted
    ? `${ymdSlash(due.base)} が土日${due.holiday_checked ? '祝' : ''}のため翌営業日に繰り下げ${due.holiday_checked ? '' : '（祝日表なし・祝日は要確認）'}`
    : (due.holiday_checked ? '' : '祝日は要確認（祝日表にこの年がありません）');
  const reviewNote = s.needs_review_count
    ? `要確認 ${s.needs_review_count}件（請求書なし・源泉 0 で計上）。源泉対象なら支払台帳タブを見て人員・支払額・税額を手で足してください`
    : '要確認 0件';
  return [
    ['項目', '値', '注記'],
    ['納期等の区分（支払年月）', ym, '支払日（JST）ベース'],
    ['区分', TAX_FORM_CATEGORY, '国税庁様式の区分名。デザイン・映像制作の報酬をここに含めてよいかは税理士に確認'],
    ['区分コード', TAX_FORM_CATEGORY_CODE, '様式で確認'],
    ['支払年月日', period, t.payment_count ? `源泉対象の支払 ${t.payment_count}件の最初〜最後の支払日` : '源泉対象の支払なし'],
    ['人員', t.payee_count, '源泉対象の支払があった人数（源泉 0 の法人・旧方式・請求書なしは数えない）'],
    ['支払額', t.gross_total, '源泉対象者への税込支払額の合計'],
    ['税額', t.withholding_total, '源泉徴収税額の合計'],
    ['本税', t.withholding_total, ''],
    ['延滞税', 0, ''],
    ['合計額', t.withholding_total, '本税＋延滞税'],
    ['納付の目的（摘要）', `${year}年${month}月分報酬`, ''],
    ['納付期限', ymdSlash(due.date), dueNote || '支払月の翌月10日'],
    [],
    [reviewNote],
    [`※ 源泉 0 で台帳に載っている支払 ${t.excluded_count}件（法人・旧方式・請求書なし）は上の人員・支払額に含めていません`],
    ['※ 納期の特例（半年ごと納付）の適用可否は税理士に確認してから運用を決めてください'],
  ];
}

// ---------- 月初リマインド本文（Chatwork・管理者マイチャット） ----------

function fmtYen(n) {
  return `${Number(n || 0).toLocaleString('ja-JP')}円`;
}

/**
 * @param {{ year:number, month:number, summary:object, pageUrl?:string, warnings?:string[] }} p
 */
function buildWithholdingReminderText({ year, month, summary, rows, pageUrl, warnings }) {
  const s = summary || summarizeMonth(rows || []);
  const t = summarizeWithholdingTargets(rows || []);
  const due = taxPaymentDueDate(year, month);
  const lines = [];
  lines.push(`対象: ${ymLabel(year, month)}支払分（支払日ベース）`);
  // 徴収高計算書に打ち込む 3 つ（源泉対象の支払だけ）は必ず入れる
  lines.push(`人員: ${t.payee_count}名`);
  lines.push(`支払額: ${fmtYen(t.gross_total)}`);
  lines.push(`税額: ${fmtYen(t.withholding_total)}`);
  if (s.payment_count === 0) {
    lines.push('支払の記録がありません（振込管理の消し込みが済んでいるか確認してください）');
  } else {
    lines.push(`（台帳全体: ${s.payee_count}名・${s.payment_count}件 ／ 支払金額（税込） ${fmtYen(s.gross_total)} ／ 差引支払額 ${fmtYen(s.net_total)}）`);
    if (s.needs_review_count > 0) lines.push(`⚠ 要確認: ${s.needs_review_count}件（請求書なし・金額不整合。源泉 0 で計上しているので対象なら手で足す）`);
  }
  const dueShift = due.shifted ? `（${ymdSlash(due.base)} が土日${due.holiday_checked ? '祝' : ''}のため繰り下げ）` : '';
  lines.push(`納付期限 ${ymdSlash(due.date)}${dueShift}（e-Tax で徴収高計算書を送信→ダイレクト納付/ペイジー）`);
  if (!due.holiday_checked) lines.push('※ 祝日表にこの年が無いため、納付期限が祝日に当たらないか要確認');
  lines.push('※ 納期の特例（半年ごと）の適用可否は税理士に確認してから運用を決めてください');
  for (const w of warnings || []) lines.push(`※ ${w}`);
  if (pageUrl) lines.push(`台帳・出力: ${pageUrl}`);
  return `[info][title]🧾 源泉所得税の納付リマインド（${ymLabel(year, month)}支払分）[/title]${lines.join('\n')}[/info]`;
}

module.exports = {
  CATEGORY_LABEL,
  DETAIL_LABEL,
  PAID_VIA_LABEL,
  isoToJstYmd,
  jstRange,
  jstMonthStartIso,
  prevMonthOf,
  paymentDueDate,
  taxPaymentDueDate,
  summarizeWithholdingTargets,
  TAX_FORM_CATEGORY,
  TAX_FORM_CATEGORY_CODE,
  buildTaxPaymentFormRows,
  entityTypeLabel,
  EXTRA_REASON,
  DUP_INVOICE_REASON,
  invoiceFromSnapshot,
  snapshotFromTransferItem,
  applyDupReasons,
  buildLedgerRow,
  buildLedgerRows,
  summarizeMonth,
  summarizeYearByPayee,
  buildMonthlySheetRows,
  buildYearlySheetRows,
  buildLedgerSheetRows,
  buildWithholdingReminderText,
};
