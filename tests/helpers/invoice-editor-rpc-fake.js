'use strict';
// テスト用: DB の関数 invoice_editor_save_draft / invoice_editor_submit
// （migrations/2026-11-24_invoice_editor_atomic_submit.sql）を、メモリ上の偽 DB の上で同じ意味に動かす偽物。
// 本物は 1 トランザクション（請求書行の FOR UPDATE・advisory lock）。偽物は await を挟まずに同期で書き切るので、
// Node の 1 スレッドの中では同じく「途中に他の処理が割り込まない」。
//
// 使い方: const fake = createInvoiceEditorRpcFake({ rows, setRows });
//   rows(table) … その表の配列（無ければ [] を作って返す）／ setRows(table, arr) … 置き換え
//   rpc 実装の先頭で `const r = fake(name, args); if (r) return r;`
//   fake.calls … 呼ばれた関数名の配列 / fake.missing = true … 関数がまだ無い環境（PGRST202）

const FIXED = ['hourly_fee', 'hourly_expense', 'installment_fee'];
const has = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);
const intOrNull = (v) => (v === null || v === undefined || v === '' ? null : Math.trunc(Number(v)));
const numOrNull = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

function createInvoiceEditorRpcFake({ rows, setRows }) {
  let seq = 0;
  let clock = 0;
  const now = () => `2030-01-01T00:00:${String(++clock).padStart(2, '0')}.000001+00:00`;

  function saveDraft(a) {
    const inv = rows('invoices').find(r => r.id === a.p_invoice_id);
    if (!inv) return { ok: false, code: 'NOT_FOUND' };
    if (inv.tax_mode !== 'exclusive') return { ok: false, code: 'NOT_EXCLUSIVE' };
    if (!['draft', 'rejected'].includes(inv.status)) return { ok: false, code: 'NOT_EDITABLE', status: inv.status };
    if (!a.p_expected_updated_at || inv.updated_at !== a.p_expected_updated_at) return { ok: false, code: 'CONFLICT', updated_at: inv.updated_at };

    // 途中で失敗したら全部取り消す（トランザクション）ために、書く前の写しを持っておく
    const snapshot = rows('invoice_items').map(r => ({ ...r }));
    const mine = (r) => r.invoice_id === inv.id;
    let trash = [];
    const del = new Set(a.p_delete_ids || []);
    if (del.size) {
      const gone = rows('invoice_items').filter(r => mine(r) && del.has(r.id));
      trash = gone.map(r => r.receipt_file_id).filter(Boolean);
      setRows('invoice_items', rows('invoice_items').filter(r => !(mine(r) && del.has(r.id))));
    }
    const ups = Array.isArray(a.p_updates) ? a.p_updates : [];
    let n = 0;
    for (const u of ups) {
      const it = rows('invoice_items').find(r => r.id === u.id && mine(r));
      if (!it) continue;
      n++;
      const cr = !!it.creative_id;
      const fixed = !cr && FIXED.includes(it.cost_type);
      if (!fixed && has(u, 'unit_price')) it.unit_price = u.unit_price;
      if (cr || ['expense', 'adjustment'].includes(it.cost_type)) it.quantity = 1;
      else if (!fixed && has(u, 'quantity')) it.quantity = u.quantity;
      if (!cr && !fixed && has(u, 'label')) it.label = u.label ?? '';
      if (cr && has(u, 'price_change_reason')) it.price_change_reason = u.price_change_reason;
      if (!cr && !fixed && it.cost_type !== 'expense' && has(u, 'manual_reason')) it.manual_reason = u.manual_reason;
      if (!cr && it.cost_type === 'expense' && has(u, 'expense_date')) it.expense_date = u.expense_date;
      if (!cr && it.cost_type === 'expense' && has(u, 'expense_payee')) it.expense_payee = u.expense_payee;
      if (has(u, 'sort_order')) it.sort_order = u.sort_order;
      if (has(u, 'total_amount')) it.total_amount = u.total_amount;
    }
    if (n !== ups.length) {
      setRows('invoice_items', snapshot);
      return { error: { code: 'P0002', message: `invoice_editor_save_draft: item not found (${n} of ${ups.length})`, hint: 'ITEM_NOT_FOUND' } };
    }
    const applied = []; const conflicts = [];
    for (const w of (Array.isArray(a.p_receipt_writes) ? a.p_receipt_writes : [])) {
      const it = rows('invoice_items').find(r => r.id === w.id && mine(r) && !r.creative_id && r.cost_type === 'expense');
      const guard = w.guard_file_id || null;
      if (!it || (it.receipt_file_id || null) !== guard) { conflicts.push(w.id); continue; }
      if (has(w, 'receipt_status')) it.receipt_status = w.receipt_status;
      if (has(w, 'receipt_missing_reason')) it.receipt_missing_reason = w.receipt_missing_reason;
      if (w.clear_file) Object.assign(it, { receipt_file_id: null, receipt_file_name: null, receipt_mime_type: null, receipt_uploaded_at: null });
      applied.push(w.id);
      if (w.clear_file && guard) trash.push(guard);
    }
    const idMap = {};
    for (const x of (Array.isArray(a.p_inserts) ? a.p_inserts : [])) {
      const cr = !!x.creative_id;
      const qty1 = cr || ['expense', 'adjustment'].includes(x.cost_type);
      const isExp = !cr && x.cost_type === 'expense';
      const row = {
        id: `fn-${++seq}`, invoice_id: inv.id, creative_id: x.creative_id || null, creative_label: x.creative_label ?? null,
        cost_type: x.cost_type ?? null, label: x.label ?? '', unit: x.unit ?? (cr ? '本' : '式'),
        unit_price: x.unit_price ?? null, quantity: qty1 ? 1 : (x.quantity ?? 1),
        manual_reason: (cr || x.cost_type === 'expense') ? null : (x.manual_reason ?? null),
        original_unit_price: cr ? (x.original_unit_price ?? null) : null,
        price_change_reason: cr ? (x.price_change_reason ?? null) : null,
        is_special: false, special_reason: null, sort_order: x.sort_order ?? 0, total_amount: x.total_amount ?? 0,
        expense_date: isExp ? (x.expense_date ?? null) : null, expense_payee: isExp ? (x.expense_payee ?? null) : null,
        receipt_status: isExp ? (x.receipt_status ?? null) : null, receipt_missing_reason: isExp ? (x.receipt_missing_reason ?? null) : null,
        created_at: now(),
      };
      setRows('invoice_items', rows('invoice_items').concat([row]));
      if (x.client_key) idMap[x.client_key] = row.id;
    }
    const p = a.p_invoice || {};
    if (has(p, 'withholding_enabled')) inv.withholding_enabled = p.withholding_enabled;
    Object.assign(inv, {
      subtotal_amount: p.subtotal_amount, tax_amount: p.tax_amount, total_amount: p.total_amount,
      withholding_amount: p.withholding_amount, payout_amount: p.payout_amount,
    });
    if (has(p, 'notes')) inv.notes = p.notes;
    inv.updated_at = now();
    return { ok: true, updated_at: inv.updated_at, id_map: idMap, receipt_applied: applied, receipt_conflicts: conflicts, deleted_receipt_file_ids: trash };
  }

  function submit(a) {
    const inv = rows('invoices').find(r => r.id === a.p_invoice_id);
    if (!inv) return { ok: false, code: 'NOT_FOUND' };
    if (!inv.issuer_id) return { ok: false, code: 'NO_ISSUER' };
    if (inv.tax_mode !== 'exclusive') return { ok: false, code: 'NOT_EXCLUSIVE' };
    if (!['draft', 'rejected'].includes(inv.status)) return { ok: false, code: 'NOT_EDITABLE', status: inv.status };
    if (!a.p_expected_updated_at || inv.updated_at !== a.p_expected_updated_at) return { ok: false, code: 'CONFLICT', updated_at: inv.updated_at };

    const fp = (r) => JSON.stringify([r.id, r.creative_id || null, r.cost_type || null, intOrNull(r.unit_price), numOrNull(r.quantity), r.label ?? null, r.price_change_reason ?? null, r.manual_reason ?? null]);
    const items = rows('invoice_items').filter(r => r.invoice_id === inv.id);
    const cur = items.map(fp).sort();
    const sent = (a.p_items || []).map(fp).sort();
    if (cur.length !== sent.length || cur.some((v, i) => v !== sent[i])) return { ok: false, code: 'STALE_ITEMS' };

    const key = (r) => `${r.creative_id}|${r.cost_type}`;
    const crs = items.filter(r => r.creative_id && r.cost_type);
    const count = new Map();
    for (const r of crs) count.set(key(r), (count.get(key(r)) || 0) + 1);
    const inInv = crs.filter(r => count.get(key(r)) > 1);
    if (inInv.length) return { ok: false, code: 'DUPLICATE', problems: inInv.map(r => ({ item_id: r.id, creative_id: r.creative_id, cost_type: r.cost_type, code: 'DUPLICATE_IN_INVOICE' })) };
    const claims = rows('invoice_billing_claims');
    const billedInvIds = new Set(rows('invoices').filter(i => i.issuer_id === inv.issuer_id && ['submitted', 'approved'].includes(i.status) && i.id !== inv.id).map(i => i.id));
    const dup = crs.filter(m =>
      claims.some(c => c.issuer_id === inv.issuer_id && c.creative_id === m.creative_id && c.cost_type === m.cost_type && c.invoice_id !== inv.id)
      || rows('invoice_items').some(o => billedInvIds.has(o.invoice_id) && o.creative_id === m.creative_id && o.cost_type === m.cost_type));
    if (dup.length) return { ok: false, code: 'DUPLICATE', problems: dup.map(r => ({ item_id: r.id, creative_id: r.creative_id, cost_type: r.cost_type, code: 'DUPLICATE' })) };

    for (const u of (a.p_ref_updates || [])) {
      const it = items.find(r => r.id === u.id && r.creative_id);
      if (it) it.original_unit_price = u.original_unit_price;
    }
    setRows('invoice_billing_claims', claims.filter(c => c.invoice_id !== inv.id).concat(
      crs.map(r => ({ issuer_id: inv.issuer_id, creative_id: r.creative_id, cost_type: r.cost_type, invoice_id: inv.id, invoice_item_id: r.id }))));
    const t = a.p_totals || {};
    const ts = now();
    Object.assign(inv, {
      status: 'submitted', submitted_at: ts, updated_at: ts,
      subtotal_amount: t.subtotal, tax_amount: t.tax, total_amount: t.total, withholding_amount: t.withholding, payout_amount: t.payout,
    });
    return { ok: true, invoice: { ...inv } };
  }

  // migrations/2026-11-24b_invoice_remove_items_and_delete_fn.sql の偽物
  const fpKey = (r) => JSON.stringify([r.id, r.creative_id || null, r.cost_type ?? null, intOrNull(r.unit_price), numOrNull(r.quantity), intOrNull(r.total_amount)]);
  function checkStatuses(sts) {
    if (!Array.isArray(sts) || !sts.length || sts.some(s => !['draft', 'rejected'].includes(s))) {
      return { error: { code: '22023', message: 'editable statuses must be draft/rejected' } };
    }
    return null;
  }
  function removeItemsRecalc(a) {
    const bad = checkStatuses(a.p_editable_statuses);
    if (bad) return bad;
    const inv = rows('invoices').find(r => r.id === a.p_invoice_id);
    if (!inv) return { ok: false, code: 'NOT_FOUND' };
    if (!a.p_editable_statuses.includes(inv.status)) return { ok: false, code: 'NOT_EDITABLE', status: inv.status };
    const exp = a.p_expected || {};
    if ((inv.tax_mode ?? null) !== (exp.tax_mode ?? null) || (inv.withholding_enabled ?? null) !== (exp.withholding_enabled ?? null)) return { ok: false, code: 'STALE' };
    const del = new Set(a.p_delete_ids || []);
    const cur = rows('invoice_items').filter(r => r.invoice_id === inv.id && !del.has(r.id)).map(fpKey).sort();
    const sent = (a.p_remaining || []).map(fpKey).sort();
    if (JSON.stringify(cur) !== JSON.stringify(sent)) return { ok: false, code: 'STALE' };
    const gone = rows('invoice_items').filter(r => r.invoice_id === inv.id && del.has(r.id)).map(r => r.id);
    setRows('invoice_items', rows('invoice_items').filter(r => !(r.invoice_id === inv.id && del.has(r.id))));
    const p = a.p_invoice || {};
    if (inv.tax_mode === 'exclusive') {
      Object.assign(inv, { subtotal_amount: p.subtotal_amount, tax_amount: p.tax_amount, total_amount: p.total_amount, withholding_amount: p.withholding_amount, payout_amount: p.payout_amount });
    } else inv.total_amount = p.total_amount;
    inv.updated_at = now();
    return { ok: true, deleted_ids: gone, updated_at: inv.updated_at };
  }
  function deleteEditable(a) {
    const bad = checkStatuses(a.p_editable_statuses);
    if (bad) return bad;
    const inv = rows('invoices').find(r => r.id === a.p_invoice_id);
    if (!inv) return { ok: false, code: 'NOT_FOUND' };
    if ((inv.issuer_id ?? null) !== (a.p_expected_issuer ?? null)) return { ok: false, code: 'CONFLICT' };
    if (!a.p_editable_statuses.includes(inv.status)) return { ok: false, code: 'NOT_EDITABLE', status: inv.status };
    const files = rows('invoice_items').filter(r => r.invoice_id === inv.id).map(r => r.receipt_file_id).filter(Boolean);
    setRows('invoice_items', rows('invoice_items').filter(r => r.invoice_id !== inv.id));
    setRows('invoice_billing_claims', rows('invoice_billing_claims').filter(c => c.invoice_id !== inv.id));
    setRows('invoices', rows('invoices').filter(r => r.id !== inv.id));
    return { ok: true, receipt_file_ids: files };
  }
  const IMPL = {
    invoice_editor_save_draft: saveDraft,
    invoice_editor_submit: submit,
    invoice_remove_items_recalc: removeItemsRecalc,
    invoice_delete_editable: deleteEditable,
  };

  const fake = function rpc(name, args) {
    if (!IMPL[name]) return null;
    fake.calls.push(name);
    if (fake.missing) return { data: null, error: { code: 'PGRST202', message: `Could not find the function public.${name}` } };
    if (fake.before) fake.before(name, args);
    const out = IMPL[name](args);
    if (out && out.error) return { data: null, error: out.error };
    return { data: out, error: null };
  };
  fake.calls = [];
  fake.missing = false;
  fake.before = null; // (name, args) => void … 関数が走る直前に呼ぶ（「ロックを取る直前に別の処理が入った」を再現する）
  return fake;
}

module.exports = { createInvoiceEditorRpcFake };
