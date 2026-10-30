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

/** 支払月の納付期限（翌月10日・JST）'YYYY-MM-DD' */
function paymentDueDate(year, month) {
  const next = month === 12 ? { y: year + 1, m: 1 } : { y: year, m: month + 1 };
  return `${next.y}-${String(next.m).padStart(2, '0')}-10`;
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
function buildLedgerRow(payment) {
  const p = payment || {};
  const user = p.user || {};
  const inv = p.invoice || null;
  const reasons = [];
  const notes = [];

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
    const amt = toInt(p.invoice_amount);
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
    needs_review: reasons.length > 0,
    review_reasons: reasons,
    notes,
  };
}

/** 支払行の配列 → 台帳行（支払日→氏名の順） */
function buildLedgerRows(payments) {
  const rows = (payments || []).map(buildLedgerRow);
  rows.sort((a, b) =>
    String(a.paid_date || '9999').localeCompare(String(b.paid_date || '9999'))
    || String(a.user_name).localeCompare(String(b.user_name), 'ja'));
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
  return [
    ['支払年月', '区分', '人数', '支払件数', '支払金額（税込）', '源泉徴収税額', '差引支払額', '要確認件数', '納付期限'],
    [ymLabel(year, month), CATEGORY_LABEL, s.payee_count, s.payment_count, s.gross_total, s.withholding_total, s.net_total, s.needs_review_count, paymentDueDate(year, month)],
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
    r.source === 'invoice_exclusive' ? '税抜' : r.source === 'invoice_inclusive' ? '内税' : '請求書なし',
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

// ---------- 月初リマインド本文（Chatwork・管理者マイチャット） ----------

function fmtYen(n) {
  return `${Number(n || 0).toLocaleString('ja-JP')}円`;
}

/**
 * @param {{ year:number, month:number, summary:object, pageUrl?:string, warnings?:string[] }} p
 */
function buildWithholdingReminderText({ year, month, summary, pageUrl, warnings }) {
  const s = summary || summarizeMonth([]);
  const lines = [];
  lines.push(`対象: ${ymLabel(year, month)}支払分（支払日ベース）`);
  if (s.payment_count === 0) {
    lines.push('支払の記録がありません（振込管理の消し込みが済んでいるか確認してください）');
  } else {
    lines.push(`人数: ${s.payee_count}名（${s.payment_count}件）`);
    lines.push(`支払金額（税込）: ${fmtYen(s.gross_total)}`);
    lines.push(`源泉徴収税額: ${fmtYen(s.withholding_total)}`);
    lines.push(`差引支払額: ${fmtYen(s.net_total)}`);
    if (s.needs_review_count > 0) lines.push(`⚠ 要確認: ${s.needs_review_count}件（請求書なし・金額不整合）`);
  }
  lines.push(`納付期限: ${paymentDueDate(year, month)}（支払月の翌月10日）`);
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
  entityTypeLabel,
  buildLedgerRow,
  buildLedgerRows,
  summarizeMonth,
  summarizeYearByPayee,
  buildMonthlySheetRows,
  buildYearlySheetRows,
  buildLedgerSheetRows,
  buildWithholdingReminderText,
};
