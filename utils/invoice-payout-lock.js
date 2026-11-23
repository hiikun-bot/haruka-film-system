// utils/invoice-payout-lock.js
// 「振込済み・振込依頼中の請求書は本人が直せる状態へ戻さない」の判定（ADR 046 追補 2026-11-22）。
//
// 請求書を戻す（status='rejected'）と、提出時に置いた PDF がゴミ箱へ行き、請求書は振込管理・源泉徴収台帳の
// 集計（submitted / approved）から外れる。すでに振り込んだ月・総合振込を依頼中の月でそれをやると、
// 払った額と請求書がずれるので止める。
//
//   payoutLockOf()            … 純関数（jest あり）
//   loadInvoicePayoutLock()   … Supabase から読んで payoutLockOf に渡す
//
// 対象はメンバー請求書（invoice_type が 'member' または NULL）だけ。
// 進行中の総合振込の判定は utils/bank-transfer-plan.js（BLOCKING_BATCH_STATUSES / blockedUserIdsFromItems）と同じ。

const { isMemberInvoice } = require('./invoice-unlock');
const plan = require('./bank-transfer-plan');

const PAYOUT_LOCK_MESSAGES = {
  paid: 'この月はすでに振込済みのため、請求書を戻せません',
  transfer_in_progress: 'この月は総合振込を依頼中のため、請求書を戻せません（依頼を取り消すか、結果が出てから操作してください）',
};

/**
 * @param {object} p
 * @param {object} p.invoice                     { issuer_id, year, month, invoice_type }
 * @param {Array<object>} [p.payoutRecords]      同じ本人・年月の payout_records（{ user_id, year, month, status }）
 * @param {Array<object>} [p.batches]            同じ年月の payout_transfer_batches（{ id, status }）
 * @param {Array<object>} [p.items]              それらの明細（{ batch_id, user_id, status }）
 * @returns {null | { code: 'paid'|'transfer_in_progress', error: string }}
 */
function payoutLockOf({ invoice, payoutRecords, batches, items } = {}) {
  if (!invoice || !isMemberInvoice(invoice) || !invoice.issuer_id) return null;
  const uid = String(invoice.issuer_id);
  const sameMonth = (r) => Number(r.year) === Number(invoice.year) && Number(r.month) === Number(invoice.month);
  const paid = (payoutRecords || []).some(r => r && String(r.user_id) === uid && sameMonth(r) && String(r.status) === 'paid');
  if (paid) return { code: 'paid', error: PAYOUT_LOCK_MESSAGES.paid };
  const blocked = plan.blockedUserIdsFromItems(batches || [], (items || []).filter(it => it && String(it.user_id) === uid));
  if (blocked.size > 0) return { code: 'transfer_in_progress', error: PAYOUT_LOCK_MESSAGES.transfer_in_progress };
  return null;
}

// テーブルが無い（migration 未適用）ことを表すエラーか。PostgREST: PGRST205 / Postgres: 42P01
function isMissingTableError(error) {
  if (!error) return false;
  const code = String(error.code || '');
  if (code === '42P01' || code === 'PGRST205') return true;
  return /does not exist|could not find the table|schema cache/i.test(String(error.message || ''));
}

/**
 * 請求書が「振込済み・振込依頼中」で戻せないかを DB から調べる。
 * テーブルが無い環境（振込管理・総合振込の migration 未適用）は「該当なし」として扱う。
 * それ以外の読み出しエラーは throw（判定できないまま戻さない）。
 * @returns {Promise<null | { code: string, error: string }>}
 */
async function loadInvoicePayoutLock(supabase, invoice) {
  if (!invoice || !isMemberInvoice(invoice) || !invoice.issuer_id || invoice.year == null || invoice.month == null) return null;

  const { data: payoutRecords, error: pErr } = await supabase
    .from('payout_records').select('user_id, year, month, status')
    .eq('user_id', invoice.issuer_id).eq('year', invoice.year).eq('month', invoice.month);
  if (pErr && !isMissingTableError(pErr)) throw new Error(`payout_records 取得失敗: ${pErr.message}`);
  const paidLock = payoutLockOf({ invoice, payoutRecords: pErr ? [] : payoutRecords });
  if (paidLock) return paidLock;

  const { data: batches, error: bErr } = await supabase
    .from('payout_transfer_batches').select('id, status')
    .eq('year', invoice.year).eq('month', invoice.month).in('status', plan.BLOCKING_BATCH_STATUSES);
  if (bErr) {
    if (isMissingTableError(bErr)) return null;
    throw new Error(`payout_transfer_batches 取得失敗: ${bErr.message}`);
  }
  const batchIds = (batches || []).map(b => b.id);
  if (!batchIds.length) return null;
  const { data: items, error: iErr } = await supabase
    .from('payout_transfer_items').select('batch_id, user_id, status')
    .in('batch_id', batchIds).eq('user_id', invoice.issuer_id);
  if (iErr) {
    if (isMissingTableError(iErr)) return null;
    throw new Error(`payout_transfer_items 取得失敗: ${iErr.message}`);
  }
  return payoutLockOf({ invoice, payoutRecords: [], batches, items });
}

module.exports = { payoutLockOf, loadInvoicePayoutLock, isMissingTableError, PAYOUT_LOCK_MESSAGES };
