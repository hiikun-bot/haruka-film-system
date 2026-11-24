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

const defaultSleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * 複数の請求書から明細を外し、各請求書の合計を書き直す（admin-status・納品の取り消しで共用）。
 * 関数 invoice_remove_items_recalc を 1 回呼ぶ＝全部の請求書を 1 トランザクションで扱う。
 * 指紋が合わない（その間に明細・設定が変わった）請求書は、読み直して数回やり直す（間を少しあける）。
 * 読み取りに失敗したら関数を呼ばない（空の明細として 0 円の合計を書かない）。
 * @param {object} p
 * @param {string[]} p.itemIds 外したい明細 id
 * @param {string[]} p.invoiceIds その明細が載っている請求書 id
 * @param {string[]} p.editableStatuses 外してよい状態（draft / rejected の部分集合）
 * @param {boolean} [p.allOrNothing] true なら、1 件でも外せない請求書があれば何も書かない（DB の関数が保証する）
 * @returns {Promise<{ ok: boolean, code?: string, error?: string, skippedInvoiceIds: string[], failedInvoiceIds: string[],
 *   removedItemIds: string[], removedByInvoice: Object<string,string[]>, errors: string[] }>}
 *   ok=false は allOrNothing で止めた（何も書いていない）か、最初の読み取りに失敗した（何も書いていない）とき
 */
async function removeItemsFromEditableInvoices(supabase, IE, {
  itemIds, invoiceIds, editableStatuses, allOrNothing = false, maxAttempts = MAX_ATTEMPTS, sleep = defaultSleep,
}) {
  const out = { ok: true, skippedInvoiceIds: [], failedInvoiceIds: [], removedItemIds: [], removedByInvoice: {}, errors: [] };
  const ids = [...new Set((itemIds || []).filter(Boolean).map(String))];
  let pending = [...new Set((invoiceIds || []).filter(Boolean).map(String))].sort();
  if (!ids.length || !pending.length) return out;
  const wanted = new Set(ids);
  const fail = (invIds, msg) => {
    out.failedInvoiceIds.push(...invIds);
    out.errors.push(msg);
    if (allOrNothing) { out.ok = false; out.code = 'FAILED'; out.error = msg; }
    return out;
  };

  for (let attempt = 0; attempt < maxAttempts && pending.length; attempt++) {
    if (attempt > 0) await sleep(50 * attempt + Math.floor(Math.random() * 50));
    const [{ data: invs, error: invErr }, { data: items, error: itErr }] = await Promise.all([
      supabase.from('invoices').select('id, status, tax_mode, withholding_enabled').in('id', pending),
      supabase.from('invoice_items').select(`invoice_id, ${ITEM_COLS}`).in('invoice_id', pending),
    ]);
    if (invErr || itErr) {
      const msg = (invErr || itErr).message;
      if (attempt === 0 && allOrNothing) return { ...out, ok: false, error: msg, failedInvoiceIds: pending };
      return fail(pending, msg);
    }
    const invById = new Map((invs || []).map(r => [String(r.id), r]));
    const itemsByInv = new Map();
    for (const it of (items || [])) {
      const k = String(it.invoice_id);
      if (!itemsByInv.has(k)) itemsByInv.set(k, []);
      itemsByInv.get(k).push(it);
    }
    const requests = [];
    for (const invId of pending) {
      const inv = invById.get(invId);
      if (!inv) continue; // その間に請求書ごと消された
      if (!editableStatuses.includes(inv.status)) {
        if (allOrNothing) return { ...out, ok: false, code: 'NOT_EDITABLE', skippedInvoiceIds: [invId] };
        out.skippedInvoiceIds.push(invId);
        continue;
      }
      const invItems = itemsByInv.get(invId) || [];
      const present = invItems.filter(it => wanted.has(String(it.id))).map(it => it.id);
      if (!present.length) continue; // 外す明細がもう無い
      const remaining = remainingFingerprint(invItems, present);
      requests.push({
        invoice_id: invId,
        delete_ids: present,
        remaining,
        expected: { tax_mode: inv.tax_mode ?? null, withholding_enabled: inv.withholding_enabled ?? null },
        totals: totalsArg(inv, remaining, IE),
      });
    }
    if (!requests.length) return out;

    const { data, error } = await supabase.rpc(REMOVE_FN, {
      p_requests: requests, p_editable_statuses: editableStatuses, p_all_or_nothing: !!allOrNothing,
    });
    if (error) {
      return fail(requests.map(r => r.invoice_id), isMissingFunctionError(error, REMOVE_FN)
        ? 'DB の更新（2026-11-24b_invoice_remove_items_and_delete_fn.sql）が未適用です'
        : error.message);
    }
    const res = rpcResult(data);
    if (!res || !Array.isArray(res.results)) return fail(requests.map(r => r.invoice_id), '関数の結果を読めませんでした');
    const byInv = new Map(res.results.map(x => [String(x.invoice_id), x]));
    if (!res.ok) {
      // allOrNothing で止まった（何も書いていない）。提出された請求書があれば止める、指紋違いだけなら全部やり直す
      const notEditable = res.results.filter(x => x.result === 'NOT_EDITABLE').map(x => String(x.invoice_id));
      if (res.code === 'NOT_EDITABLE' || notEditable.length) return { ...out, ok: false, code: 'NOT_EDITABLE', skippedInvoiceIds: notEditable };
      pending = requests.map(r => r.invoice_id);
      continue;
    }
    const stale = [];
    for (const rq of requests) {
      const x = byInv.get(rq.invoice_id);
      if (!x) { stale.push(rq.invoice_id); continue; }
      if (x.result === 'OK') {
        const del = Array.isArray(x.deleted_ids) ? x.deleted_ids.map(String) : [];
        out.removedItemIds.push(...del);
        if (del.length) out.removedByInvoice[rq.invoice_id] = del;
      } else if (x.result === 'NOT_EDITABLE') out.skippedInvoiceIds.push(rq.invoice_id);
      else if (x.result === 'STALE') stale.push(rq.invoice_id);
      // NOT_FOUND … その間に請求書ごと消された
    }
    pending = stale;
  }
  if (pending.length) return fail(pending, '請求書の明細が更新中のため外せませんでした（やり直しても合いませんでした）');
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
  removeItemsFromEditableInvoices, deleteEditableInvoice,
};
