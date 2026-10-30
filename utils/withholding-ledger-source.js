// utils/withholding-ledger-source.js
// =============================================================
// 🧾 源泉徴収台帳（ADR 054 §5 Stage D）— データ源（Supabase）から支払行を組み立てる
//
// 対象は「支払日ベース」:
//   1) payout_transfer_items（あおぞら API 総合振込・status='completed'）
//        支払日 = item.completed_at → 無ければ batch.completed_at → 無ければ batch.transfer_designated_date
//        ※ テーブルは Stage A（migration）で作られる。存在しない環境では空扱いにして落とさない
//   2) payout_records（手動振込・status='paid' かつ paid_via が 'manual' か NULL）
//        支払日 = paid_at。paid_via 列も Stage A で増えるので、無い環境では列なしで再問い合わせ
//   両方を invoices（issuer_id=user_id・同 year/month・submitted/approved）に結合する。
//
// 純粋な計算（行の組み立て・集計・シート行）は utils/withholding-ledger.js。
// routes/withholding.js（API）と workers/withholding-monthly-reminder.js（月初リマインド）が共用する。
// =============================================================

const supabase = require('../supabase');
const ledger = require('./withholding-ledger');

const INVOICE_STATUSES = ['submitted', 'approved'];
const INVOICE_COLUMNS = 'id, issuer_id, year, month, status, tax_mode, invoice_number, invoice_type, subtotal_amount, tax_amount, withholding_amount, payout_amount, total_amount, withholding_enabled, submitted_at';
const USER_COLUMNS = 'id, full_name, nickname, address, postal_code, business_type, invoice_registration_number';

function isMissingRelation(err) {
  const msg = String(err?.message || '');
  return err?.code === 'PGRST205' || err?.code === '42P01'
    || /could not find the table/i.test(msg) || /relation .* does not exist/i.test(msg);
}
function isMissingColumn(err) {
  const msg = String(err?.message || '');
  return err?.code === '42703' || /column .* does not exist/i.test(msg) || /could not find the .* column/i.test(msg);
}

/** 1) あおぞら API 振込の明細（completed）。テーブル未作成なら [] */
async function loadTransferItems({ startIso, endIso, warnings }) {
  const yearFrom = Number(startIso.slice(0, 4)) - 1;
  const yearTo = Number(endIso.slice(0, 4)) + 1;
  const { data, error } = await supabase
    .from('payout_transfer_items')
    .select('id, batch_id, payout_record_id, user_id, invoice_id, amount, gross_amount, tax_amount, withholding_amount, status, completed_at, batch:payout_transfer_batches!inner(id, apply_no, year, month, status, completed_at, transfer_designated_date)')
    .eq('status', 'completed')
    .gte('batch.year', yearFrom)
    .lte('batch.year', yearTo)
    .limit(5000);
  if (error) {
    if (isMissingRelation(error)) {
      warnings.push('API 振込の明細テーブル（payout_transfer_items）は未作成のため、手動振込（振込管理の消し込み）だけを集計しています');
      return [];
    }
    if (isMissingColumn(error)) {
      // completed_at が明細側に無い版の Stage A でも動くように、列を絞って再取得
      const retry = await supabase
        .from('payout_transfer_items')
        .select('id, batch_id, payout_record_id, user_id, invoice_id, amount, gross_amount, tax_amount, withholding_amount, status, batch:payout_transfer_batches!inner(id, apply_no, year, month, status, completed_at, transfer_designated_date)')
        .eq('status', 'completed')
        .gte('batch.year', yearFrom)
        .lte('batch.year', yearTo)
        .limit(5000);
      if (retry.error) throw new Error(`payout_transfer_items 取得失敗: ${retry.error.message}`);
      return filterItemsByRange(retry.data || [], startIso, endIso);
    }
    throw new Error(`payout_transfer_items 取得失敗: ${error.message}`);
  }
  return filterItemsByRange(data || [], startIso, endIso);
}

function resolveItemPaidAt(item) {
  const b = item.batch || {};
  if (item.completed_at) return item.completed_at;
  if (b.completed_at) return b.completed_at;
  if (b.transfer_designated_date) {
    // 振込指定日（date）は JST の日付 → その日の 0:00 JST
    const [y, m, d] = String(b.transfer_designated_date).split('-').map(Number);
    if (y && m && d) return new Date(Date.UTC(y, m - 1, d, 0, 0, 0) - 9 * 3600 * 1000).toISOString();
  }
  return null;
}

function filterItemsByRange(items, startIso, endIso) {
  return items
    .map(it => ({ ...it, _paid_at: resolveItemPaidAt(it) }))
    .filter(it => it._paid_at && it._paid_at >= startIso && it._paid_at < endIso);
}

/** 2) 手動振込の payout_records（paid）。paid_via 列が無い環境でも動く */
async function loadManualPayoutRecords({ startIso, endIso }) {
  const q1 = supabase.from('payout_records')
    .select('id, user_id, year, month, invoice_amount, amount_source, status, paid_at, paid_via, transfer_item_id')
    .eq('status', 'paid').gte('paid_at', startIso).lt('paid_at', endIso).limit(5000);
  const { data, error } = await q1;
  if (!error) {
    return { records: (data || []).filter(r => !r.paid_via || r.paid_via === 'manual'), hasPaidVia: true };
  }
  if (!isMissingColumn(error)) throw new Error(`payout_records 取得失敗: ${error.message}`);
  const q2 = supabase.from('payout_records')
    .select('id, user_id, year, month, invoice_amount, amount_source, status, paid_at')
    .eq('status', 'paid').gte('paid_at', startIso).lt('paid_at', endIso).limit(5000);
  const r2 = await q2;
  if (r2.error) throw new Error(`payout_records 取得失敗: ${r2.error.message}`);
  return { records: r2.data || [], hasPaidVia: false };
}

/** 3) invoices を (issuer_id, year, month) と id で引けるように取得 */
async function loadInvoices({ userIds, years, invoiceIds }) {
  const byKey = new Map();   // `${issuer}|${year}|${month}` → invoice（複数あれば submitted_at 降順の先頭）
  const dupKeys = new Set();
  const byId = new Map();
  const put = (inv) => {
    byId.set(inv.id, inv);
    const key = `${inv.issuer_id}|${inv.year}|${inv.month}`;
    const cur = byKey.get(key);
    if (!cur) { byKey.set(key, inv); return; }
    dupKeys.add(key);
    if (String(inv.submitted_at || '') > String(cur.submitted_at || '')) byKey.set(key, inv);
  };
  if (userIds.length && years.length) {
    const { data, error } = await supabase.from('invoices')
      .select(INVOICE_COLUMNS)
      .in('issuer_id', userIds)
      .in('year', years)
      .in('status', INVOICE_STATUSES)
      .limit(10000);
    if (error) throw new Error(`invoices 取得失敗: ${error.message}`);
    // メンバー請求書のみ（クライアント宛て 'client' は除外。NULL は旧データなので含める）
    for (const inv of data || []) if (inv.invoice_type !== 'client') put(inv);
  }
  const missingIds = invoiceIds.filter(id => id && !byId.has(id));
  if (missingIds.length) {
    const { data, error } = await supabase.from('invoices').select(INVOICE_COLUMNS).in('id', missingIds);
    if (error) throw new Error(`invoices 取得失敗: ${error.message}`);
    for (const inv of data || []) byId.set(inv.id, inv);
  }
  return { byKey, byId, dupKeys };
}

async function loadUsers(userIds) {
  if (!userIds.length) return new Map();
  const { data, error } = await supabase.from('users').select(USER_COLUMNS).in('id', userIds);
  if (error) throw new Error(`users 取得失敗: ${error.message}`);
  return new Map((data || []).map(u => [u.id, u]));
}

/**
 * 期間内の支払行（utils/withholding-ledger.js の payment 形式）を組み立てる。
 * @param {{ startIso: string, endIso: string }} range
 * @returns {Promise<{ payments: object[], usersById: Map, warnings: string[] }>}
 */
async function loadPayments(range) {
  const warnings = [];
  const [items, manual] = await Promise.all([
    loadTransferItems({ ...range, warnings }),
    loadManualPayoutRecords(range),
  ]);
  if (!manual.hasPaidVia) {
    warnings.push('payout_records.paid_via 列は未作成のため、振込済みはすべて手動振込として扱っています');
  }
  // API 振込で消し込まれた payout_records は明細側で数える（二重計上防止）
  const itemRecordIds = new Set(items.map(it => it.payout_record_id).filter(Boolean));
  const manualRecords = manual.records.filter(r => !itemRecordIds.has(r.id) && !r.transfer_item_id);

  const userIds = [...new Set([...items.map(it => it.user_id), ...manualRecords.map(r => r.user_id)].filter(Boolean))];
  const years = [...new Set([
    ...items.map(it => it.batch?.year),
    ...manualRecords.map(r => r.year),
  ].filter(y => Number.isInteger(y)))];
  const invoiceIds = [...new Set(items.map(it => it.invoice_id).filter(Boolean))];

  const [usersById, invoices] = await Promise.all([
    loadUsers(userIds),
    loadInvoices({ userIds, years, invoiceIds }),
  ]);

  const payments = [];
  for (const it of items) {
    const b = it.batch || {};
    const inv = (it.invoice_id && invoices.byId.get(it.invoice_id))
      || invoices.byKey.get(`${it.user_id}|${b.year}|${b.month}`) || null;
    payments.push({
      user: usersById.get(it.user_id) || { id: it.user_id },
      user_id: it.user_id,
      paid_at: it._paid_at,
      paid_via: 'aozora_api',
      invoice: inv,
      invoice_amount: inv ? null : (it.gross_amount ?? it.amount ?? null),
      apply_no: b.apply_no || null,
      payout_record_id: it.payout_record_id || null,
      transfer_item_id: it.id,
      target_year: b.year, target_month: b.month,
    });
  }
  for (const r of manualRecords) {
    const key = `${r.user_id}|${r.year}|${r.month}`;
    const inv = invoices.byKey.get(key) || null;
    payments.push({
      user: usersById.get(r.user_id) || { id: r.user_id },
      user_id: r.user_id,
      paid_at: r.paid_at,
      paid_via: 'manual',
      invoice: inv,
      invoice_amount: inv ? null : (r.invoice_amount ?? null),
      apply_no: null,
      payout_record_id: r.id,
      transfer_item_id: null,
      target_year: r.year, target_month: r.month,
      _dup_invoice: invoices.dupKeys.has(key),
    });
  }
  return { payments, usersById, warnings };
}

/** 月次: 台帳行＋集計 */
async function buildMonthReport(year, month) {
  const range = ledger.jstRange(year, month);
  const { payments, usersById, warnings } = await loadPayments(range);
  const rows = ledger.buildLedgerRows(payments).map(r => markDup(r, payments));
  return { year, month, rows, summary: ledger.summarizeMonth(rows), usersById, warnings, range };
}

/** 年次: 台帳行＋支払先別集計 */
async function buildYearReport(year) {
  const range = ledger.jstRange(year);
  const { payments, usersById, warnings } = await loadPayments(range);
  const rows = ledger.buildLedgerRows(payments).map(r => markDup(r, payments));
  return { year, rows, summary: ledger.summarizeMonth(rows), payees: ledger.summarizeYearByPayee(rows, usersById), usersById, warnings, range };
}

// 同月に提出済み請求書が複数あった支払は要確認に足す（どちらの請求書を引くべきか人が決める）
function markDup(row, payments) {
  const p = payments.find(x => x.payout_record_id && x.payout_record_id === row.payout_record_id && x._dup_invoice);
  if (!p) return row;
  return { ...row, needs_review: true, review_reasons: [...row.review_reasons, '同じ月に提出済みの請求書が複数あります'] };
}

module.exports = {
  loadPayments,
  buildMonthReport,
  buildYearReport,
  // テスト用
  isMissingRelation,
  isMissingColumn,
  resolveItemPaidAt,
};
