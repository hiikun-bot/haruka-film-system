'use strict';
// ADR 046 追補 2026-11-24（4）: 下書き・差し戻し中の請求書から明細を外し、合計を書き直す／請求書を明細ごと消す。
//   DB 側: migrations/2026-11-24b_invoice_remove_items_and_delete_fn.sql の
//     invoice_remove_items_recalc … 状態の確認 → 明細の削除 → 合計の書き込みを 1 トランザクションで
//     invoice_delete_editable     … 状態の確認 → 明細・請求書の削除を 1 トランザクションで
//   ロックの順は invoice_editor_submit と同じ（発行者の advisory lock → invoices FOR UPDATE → invoice_items）。
// 合計の計算は utils/invoice-editor.js の computeTotals が正。ここは「残る明細の指紋と合計を組み立てて関数に渡す」だけ。
// supabase は引数で受け取る（jest で偽物を渡すため）。

const REMOVE_FN = 'invoice_remove_items_recalc';
const DELETE_FN = 'invoice_delete_editable';
const MAX_ATTEMPTS = 3;
const ITEM_COLS = 'id, creative_id, cost_type, unit_price, quantity, total_amount';

function intOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}
function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 外したあとに残る明細の指紋（関数の p_remaining）。DB の列の値をそのまま送る（関数がロックの中で同じか確かめる） */
function remainingFingerprint(items, deleteIds) {
  const del = new Set((deleteIds || []).map(String));
  return (items || []).filter(it => !del.has(String(it.id))).map(it => ({
    id: it.id,
    creative_id: it.creative_id || null,
    cost_type: it.cost_type == null ? null : String(it.cost_type),
    unit_price: intOrNull(it.unit_price),
    quantity: numOrNull(it.quantity),
    total_amount: intOrNull(it.total_amount),
  }));
}

/**
 * 残る明細から計算した合計（関数の p_invoice）。
 *   新方式（exclusive）… 小計〜差引の 5 列（computeTotals。total_amount は報酬の税込＝エディタの保存と同じ）
 *   旧方式（inclusive）… 明細の total_amount の合計（従来どおり）
 */
function totalsArg(inv, remaining, IE) {
  if (inv && inv.tax_mode === 'exclusive') {
    const t = IE.computeTotals(remaining || [], { withholding_enabled: inv.withholding_enabled !== false });
    return {
      subtotal_amount: t.subtotal, tax_amount: t.tax, total_amount: t.total,
      withholding_amount: t.withholding, payout_amount: t.payout,
    };
  }
  return { total_amount: (remaining || []).reduce((s, x) => s + (intOrNull(x.total_amount) || 0), 0) };
}

function isMissingFunctionError(error, fnName) {
  if (!error) return false;
  const code = String(error.code || '');
  const msg = String(error.message || '');
  if (code === 'PGRST202') return true;
  if (code === '42883') return msg.includes(fnName);
  return /Could not find the function/i.test(msg);
}

function rpcResult(data) {
  const r = Array.isArray(data) ? data[0] : data;
  return r && typeof r === 'object' ? r : null;
}

/**
 * 請求書 1 件から明細を外し、合計を書き直す。指紋が合わなければ（その間に明細・設定が変わった）読み直して数回やり直す。
 * 読み取りに失敗したら関数を呼ばない（空の明細として 0 円の合計を書かない）。
 * @returns {Promise<{ result: 'ok'|'not_editable'|'not_found'|'failed', removedIds?: string[], status?: string, error?: string }>}
 */
async function removeItemsFromInvoice(supabase, IE, { invoiceId, itemIds, editableStatuses, maxAttempts = MAX_ATTEMPTS }) {
  let lastError = 'conflict';
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const [{ data: inv, error: invErr }, { data: items, error: itErr }] = await Promise.all([
      supabase.from('invoices').select('id, status, tax_mode, withholding_enabled').eq('id', invoiceId).maybeSingle(),
      supabase.from('invoice_items').select(ITEM_COLS).eq('invoice_id', invoiceId),
    ]);
    if (invErr || itErr) return { result: 'failed', error: (invErr || itErr).message };
    if (!inv) return { result: 'not_found' };
    if (!editableStatuses.includes(inv.status)) return { result: 'not_editable', status: inv.status };
    const wanted = new Set(itemIds.map(String));
    const present = (items || []).filter(it => wanted.has(String(it.id))).map(it => it.id);
    if (!present.length) return { result: 'ok', removedIds: [] };
    const remaining = remainingFingerprint(items, present);
    const { data, error } = await supabase.rpc(REMOVE_FN, {
      p_invoice_id: invoiceId,
      p_editable_statuses: editableStatuses,
      p_delete_ids: present,
      p_remaining: remaining,
      p_expected: { tax_mode: inv.tax_mode ?? null, withholding_enabled: inv.withholding_enabled ?? null },
      p_invoice: totalsArg(inv, remaining, IE),
    });
    if (error) {
      return {
        result: 'failed',
        error: isMissingFunctionError(error, REMOVE_FN)
          ? 'DB の更新（2026-11-24b_invoice_remove_items_and_delete_fn.sql）が未適用です'
          : error.message,
      };
    }
    const r = rpcResult(data);
    if (!r) return { result: 'failed', error: '関数の結果を読めませんでした' };
    if (r.ok) return { result: 'ok', removedIds: Array.isArray(r.deleted_ids) ? r.deleted_ids : present };
    if (r.code === 'NOT_EDITABLE') return { result: 'not_editable', status: r.status || null };
    if (r.code === 'NOT_FOUND') return { result: 'not_found' };
    lastError = String(r.code || 'conflict'); // STALE / CONFLICT … 読み直してやり直す
  }
  return { result: 'failed', error: `請求書の明細が更新中のため外せませんでした（${lastError}）` };
}

/**
 * 複数の請求書から明細を外す（admin-status・納品の取り消しで共用）。
 * @param {object} p
 * @param {string[]} p.itemIds 外したい明細 id
 * @param {string[]} p.invoiceIds その明細が載っている請求書 id
 * @param {string[]} p.editableStatuses 外してよい状態（draft / rejected の部分集合）
 * @param {boolean} [p.allOrNothing] true なら、始める前に全件の状態を確かめ、1 件でも外せない状態なら何も消さない
 *   （始めたあとに別の請求書が提出された場合はそこで止まる。その前の請求書から外した分は戻らない）
 * @returns {Promise<{ ok: boolean, code?: string, error?: string, skippedInvoiceIds: string[], failedInvoiceIds: string[], removedItemIds: string[] }>}
 *   ok=false は「始める前に止めた」（code='NOT_EDITABLE' か読み取りの失敗）。始めたあとの失敗は failedInvoiceIds に入る
 */
async function removeItemsFromEditableInvoices(supabase, IE, { itemIds, invoiceIds, editableStatuses, allOrNothing = false }) {
  const out = { ok: true, skippedInvoiceIds: [], failedInvoiceIds: [], removedItemIds: [], errors: [] };
  const ids = [...new Set((itemIds || []).filter(Boolean))];
  const invIds = [...new Set((invoiceIds || []).filter(Boolean))].sort();
  if (!ids.length || !invIds.length) return out;
  if (allOrNothing) {
    const { data: invNow, error } = await supabase.from('invoices').select('id, status').in('id', invIds);
    if (error) return { ...out, ok: false, error: error.message };
    const bad = (invNow || []).filter(r => !editableStatuses.includes(r.status)).map(r => r.id);
    if (bad.length) return { ...out, ok: false, code: 'NOT_EDITABLE', skippedInvoiceIds: bad };
  }
  for (const invoiceId of invIds) {
    const r = await removeItemsFromInvoice(supabase, IE, { invoiceId, itemIds: ids, editableStatuses });
    if (r.result === 'ok') out.removedItemIds.push(...(r.removedIds || []));
    else if (r.result === 'not_editable') {
      out.skippedInvoiceIds.push(invoiceId);
      if (allOrNothing) { out.ok = false; out.code = 'NOT_EDITABLE'; return out; }
    } else if (r.result === 'failed') {
      out.failedInvoiceIds.push(invoiceId);
      out.errors.push(r.error);
      if (allOrNothing) { out.ok = false; out.code = 'FAILED'; out.error = r.error; return out; }
    }
    // not_found … その間に請求書ごと消された（外す明細も無い）
  }
  return out;
}

/**
 * 下書き・差し戻し中の請求書を明細ごと消す（DELETE /invoices/:id）。権限の確認は呼ぶ側で済ませ、そのときの発行者を渡す。
 * @returns {Promise<{ result: 'ok'|'not_editable'|'not_found'|'conflict'|'failed', receiptFileIds?: string[], status?: string, error?: string }>}
 */
async function deleteEditableInvoice(supabase, { invoiceId, editableStatuses, expectedIssuerId }) {
  const { data, error } = await supabase.rpc(DELETE_FN, {
    p_invoice_id: invoiceId,
    p_editable_statuses: editableStatuses,
    p_expected_issuer: expectedIssuerId || null,
  });
  if (error) {
    return {
      result: 'failed',
      missingFunction: isMissingFunctionError(error, DELETE_FN),
      error: error.message,
    };
  }
  const r = rpcResult(data);
  if (!r) return { result: 'failed', error: '関数の結果を読めませんでした' };
  if (r.ok) return { result: 'ok', receiptFileIds: Array.isArray(r.receipt_file_ids) ? r.receipt_file_ids.filter(Boolean) : [] };
  if (r.code === 'NOT_EDITABLE') return { result: 'not_editable', status: r.status || null };
  if (r.code === 'NOT_FOUND') return { result: 'not_found' };
  return { result: 'conflict' };
}

module.exports = {
  REMOVE_FN, DELETE_FN, MAX_ATTEMPTS,
  remainingFingerprint, totalsArg, isMissingFunctionError,
  removeItemsFromInvoice, removeItemsFromEditableInvoices, deleteEditableInvoice,
};
