// utils/withholding-ledger-source.js
// =============================================================
// 🧾 源泉徴収台帳（ADR 054 §5 Stage D）— データ源（Supabase）から支払行を組み立てる
//
// 対象は「支払日ベース」:
//   1) payout_transfer_items（あおぞら API 総合振込・status='completed'）
//        支払日 = batch.transfer_designated_date（振込指定日・JST 0:00）。Stage B が payout_records.paid_at に
//        入れる値と同じにする（batch.completed_at は HFS が完了に気づいた時刻なので月またぎでズレる）。無ければ completed_at
//        金額 = 明細の凍結値 gross_amount / tax_amount / withholding_amount / amount（依頼時に請求書から転記・Stage B）
//               → 無ければ対応する payout_records.ledger_snapshot → それも無ければ現在の請求書（注記付き）
//        ※ テーブルは Stage A（#1275）で作成済み。無い環境では空扱いにして落とさない
//   2) payout_records（手動振込・status='paid' かつ paid_via が 'manual' か NULL）
//        支払日 = paid_at。金額 = ledger_snapshot（Stage A2・支払時点で凍結）→ 無ければ現在の請求書（注記付き）
//        paid_via / ledger_snapshot 列が無い環境では列を減らしながら再問い合わせ
//   請求書の選別は Stage B の loadLedgerSnapshotForRecord と同じ:
//        invoices.issuer_id = user_id ／ 同 year・month ／ invoice_type IS NULL ／ status IN (submitted, approved)
//
// 純粋な計算（行の組み立て・差額行・集計・シート行）は utils/withholding-ledger.js。
// routes/withholding.js（API）と workers/withholding-monthly-reminder.js（月初リマインド）が共用する。
// =============================================================

const supabase = require('../supabase');
const ledger = require('./withholding-ledger');

const INVOICE_STATUSES = ['submitted', 'approved'];
const INVOICE_COLUMNS = 'id, issuer_id, year, month, status, tax_mode, invoice_number, invoice_type, subtotal_amount, tax_amount, withholding_amount, payout_amount, total_amount, withholding_enabled, submitted_at';
const USER_COLUMNS = 'id, full_name, nickname, address, postal_code, business_type, invoice_registration_number';
const ITEM_COLUMNS = 'id, batch_id, payout_record_id, user_id, invoice_id, amount, amount_source, gross_amount, tax_amount, withholding_amount, status, created_at, batch:payout_transfer_batches!inner(id, apply_no, year, month, status, completed_at, transfer_designated_date)';

function isMissingRelation(err) {
  const msg = String(err?.message || '');
  return err?.code === 'PGRST205' || err?.code === '42P01'
    || /could not find the table/i.test(msg) || /relation .* does not exist/i.test(msg);
}
function isMissingColumn(err) {
  const msg = String(err?.message || '');
  return err?.code === '42703' || /column .* does not exist/i.test(msg) || /could not find the .* column/i.test(msg);
}

/** 振込指定日（DATE・JST の暦日）→ その日の 0:00 JST を UTC ISO で */
function jstDateToIso(ymd) {
  const [y, m, d] = String(ymd || '').split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(Date.UTC(y, m - 1, d, 0, 0, 0) - 9 * 3600 * 1000).toISOString();
}

/** API 明細の支払日: 振込指定日 → batch.completed_at の順（純関数・テスト対象） */
function resolveItemPaidAt(item) {
  const b = item?.batch || {};
  if (b.transfer_designated_date) {
    const iso = jstDateToIso(b.transfer_designated_date);
    if (iso) return iso;
  }
  if (b.completed_at) return b.completed_at;
  return null;
}

function filterItemsByRange(items, startIso, endIso) {
  return items
    .map(it => ({ ...it, _paid_at: resolveItemPaidAt(it) }))
    .filter(it => it._paid_at && it._paid_at >= startIso && it._paid_at < endIso);
}

/** 1) あおぞら API 振込の明細（completed）。テーブル未作成なら [] */
async function loadTransferItems({ startIso, endIso, warnings }) {
  const yearFrom = Number(startIso.slice(0, 4)) - 1;
  const yearTo = Number(endIso.slice(0, 4)) + 1;
  const { data, error } = await supabase
    .from('payout_transfer_items')
    .select(ITEM_COLUMNS)
    .eq('status', 'completed')
    .gte('batch.year', yearFrom)
    .lte('batch.year', yearTo)
    .limit(5000);
  if (error) {
    if (isMissingRelation(error)) {
      warnings.push('API 振込の明細テーブル（payout_transfer_items）は未作成のため、手動振込（振込管理の消し込み）だけを集計しています');
      return [];
    }
    throw new Error(`payout_transfer_items 取得失敗: ${error.message}`);
  }
  return filterItemsByRange(data || [], startIso, endIso);
}

/**
 * 2) 手動振込の payout_records（paid）。
 *    Stage A の paid_via / transfer_item_id、Stage A2 の ledger_snapshot（支払時点の凍結額）は
 *    無い環境でも動くように、列を減らしながら順に試す。
 */
const PAYOUT_RECORD_SELECTS = [
  { cols: 'id, user_id, year, month, invoice_amount, amount_source, status, paid_at, paid_via, transfer_item_id, ledger_snapshot', hasPaidVia: true, hasSnapshot: true },
  { cols: 'id, user_id, year, month, invoice_amount, amount_source, status, paid_at, paid_via, transfer_item_id', hasPaidVia: true, hasSnapshot: false },
  { cols: 'id, user_id, year, month, invoice_amount, amount_source, status, paid_at, ledger_snapshot', hasPaidVia: false, hasSnapshot: true },
  { cols: 'id, user_id, year, month, invoice_amount, amount_source, status, paid_at', hasPaidVia: false, hasSnapshot: false },
];
async function queryPayoutRecords(applyFilter) {
  let lastErr = null;
  for (const v of PAYOUT_RECORD_SELECTS) {
    const { data, error } = await applyFilter(supabase.from('payout_records').select(v.cols));
    if (!error) return { data: data || [], hasPaidVia: v.hasPaidVia, hasSnapshot: v.hasSnapshot };
    if (!isMissingColumn(error)) throw new Error(`payout_records 取得失敗: ${error.message}`);
    lastErr = error;
  }
  throw new Error(`payout_records 取得失敗: ${lastErr?.message || 'unknown'}`);
}
async function loadManualPayoutRecords({ startIso, endIso }) {
  const r = await queryPayoutRecords(q => q.eq('status', 'paid').gte('paid_at', startIso).lt('paid_at', endIso).limit(5000));
  const records = r.hasPaidVia ? r.data.filter(x => !x.paid_via || x.paid_via === 'manual') : r.data;
  return { records, hasPaidVia: r.hasPaidVia, hasSnapshot: r.hasSnapshot };
}
/** API 明細に紐づく payout_records（ledger_snapshot を補助に使う）。status は問わない */
async function loadRecordsByIds(ids) {
  if (!ids.length) return new Map();
  const r = await queryPayoutRecords(q => q.in('id', ids));
  return new Map(r.data.map(x => [x.id, x]));
}

/** 3) invoices を (issuer_id, year, month) と id で引けるように取得（Stage B と同じ選別条件） */
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
      .is('invoice_type', null)              // メンバー請求書のみ（'client' はクライアント宛て）
      .in('status', INVOICE_STATUSES)
      .limit(10000);
    if (error) throw new Error(`invoices 取得失敗: ${error.message}`);
    for (const inv of data || []) put(inv);
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
 * @returns {Promise<{ payments: object[], usersById: Map, dupKeys: Set<string>, warnings: string[] }>}
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
  if (!manual.hasSnapshot) {
    warnings.push('payout_records.ledger_snapshot 列は未作成のため、台帳は現在の請求書から組み立てています（請求書の後編集で源泉額が変わる可能性）');
  }
  // API 振込で消し込まれた payout_records は明細側で数える（二重計上防止）
  const itemRecordIds = [...new Set(items.map(it => it.payout_record_id).filter(Boolean))];
  const itemRecordIdSet = new Set(itemRecordIds);
  const manualRecords = manual.records.filter(r => !itemRecordIdSet.has(r.id) && !r.transfer_item_id);

  const userIds = [...new Set([...items.map(it => it.user_id), ...manualRecords.map(r => r.user_id)].filter(Boolean))];
  const years = [...new Set([
    ...items.map(it => it.batch?.year),
    ...manualRecords.map(r => r.year),
  ].filter(y => Number.isInteger(y)))];
  const invoiceIds = [...new Set(items.map(it => it.invoice_id).filter(Boolean))];

  const [usersById, invoices, recordsById] = await Promise.all([
    loadUsers(userIds),
    loadInvoices({ userIds, years, invoiceIds }),
    // 明細に凍結値が無い旧データのために ledger_snapshot を引く（列が無ければ空）
    items.some(it => it.gross_amount == null) ? loadRecordsByIds(itemRecordIds) : Promise.resolve(new Map()),
  ]);

  const dupKeys = new Set(); // 'pr:<id>' / 'ti:<id>'
  const payments = [];
  for (const it of items) {
    const b = it.batch || {};
    const key = `${it.user_id}|${b.year}|${b.month}`;
    const invById = it.invoice_id ? invoices.byId.get(it.invoice_id) || null : null;
    const inv = invById || invoices.byKey.get(key) || null;
    // 凍結値: 明細の gross/tax/withholding/amount → payout_records.ledger_snapshot → 無し（現在の請求書＋注記）
    const snapshot = ledger.snapshotFromTransferItem(it, (invById || inv)?.invoice_number || null)
      || recordsById.get(it.payout_record_id)?.ledger_snapshot
      || null;
    if (!invById && invoices.dupKeys.has(key)) dupKeys.add(`ti:${it.id}`);
    payments.push({
      user: usersById.get(it.user_id) || { id: it.user_id },
      user_id: it.user_id,
      paid_at: it._paid_at,
      paid_via: 'aozora_api',
      invoice: inv,
      invoice_amount: inv ? null : (it.gross_amount ?? it.amount ?? null),
      paid_amount: it.amount ?? null,       // 実際の振込額。請求書の差引とずれていれば差額行になる
      snapshot,
      apply_no: b.apply_no || null,
      payout_record_id: it.payout_record_id || null,
      transfer_item_id: it.id,
      target_year: b.year, target_month: b.month,
    });
  }
  for (const r of manualRecords) {
    const key = `${r.user_id}|${r.year}|${r.month}`;
    const inv = invoices.byKey.get(key) || null;
    if (invoices.dupKeys.has(key)) dupKeys.add(`pr:${r.id}`);
    payments.push({
      user: usersById.get(r.user_id) || { id: r.user_id },
      user_id: r.user_id,
      paid_at: r.paid_at,
      paid_via: 'manual',
      invoice: inv,
      invoice_amount: inv ? null : (r.invoice_amount ?? null),
      paid_amount: r.invoice_amount ?? null,                 // 消し込み額（HFS 請求書＋外部 PDF の合算もここ）
      snapshot: r.ledger_snapshot || null,                   // 支払時点で凍結した請求書の金額（Stage A2）。あれば優先
      apply_no: null,
      payout_record_id: r.id,
      transfer_item_id: null,
      target_year: r.year, target_month: r.month,
    });
  }
  return { payments, usersById, dupKeys, warnings };
}

/** 月次: 台帳行＋集計 */
async function buildMonthReport(year, month) {
  const range = ledger.jstRange(year, month);
  const { payments, usersById, dupKeys, warnings } = await loadPayments(range);
  const rows = ledger.applyDupReasons(ledger.buildLedgerRows(payments), dupKeys);
  return { year, month, rows, summary: ledger.summarizeMonth(rows), usersById, warnings, range };
}

/** 年次: 台帳行＋支払先別集計 */
async function buildYearReport(year) {
  const range = ledger.jstRange(year);
  const { payments, usersById, dupKeys, warnings } = await loadPayments(range);
  const rows = ledger.applyDupReasons(ledger.buildLedgerRows(payments), dupKeys);
  return { year, rows, summary: ledger.summarizeMonth(rows), payees: ledger.summarizeYearByPayee(rows, usersById), usersById, warnings, range };
}

module.exports = {
  loadPayments,
  buildMonthReport,
  buildYearReport,
  // テスト用
  isMissingRelation,
  isMissingColumn,
  resolveItemPaidAt,
  jstDateToIso,
};
