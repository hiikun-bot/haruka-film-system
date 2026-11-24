'use strict';
// ADR 046 追補 2026-11-24（4）: utils/invoice-remove-items.js（下書きから明細を外す・請求書を消す）
const R = require('../../utils/invoice-remove-items');
const IE = require('../../utils/invoice-editor');
const { createInvoiceEditorRpcFake } = require('../helpers/invoice-editor-rpc-fake');

// 最小の偽 supabase（from().select().eq()/in()/maybeSingle と rpc）
function makeDb(tables) {
  const db = { tables, readError: null, onRpc: null };
  const fake = createInvoiceEditorRpcFake({
    rows: (t) => (db.tables[t] || (db.tables[t] = [])), setRows: (t, a) => { db.tables[t] = a; },
  });
  db.fake = fake;
  db.client = {
    from(table) {
      const filters = [];
      const run = () => {
        if (db.readError && db.readError(table)) return { data: null, error: { message: `read ${table} failed` } };
        return { data: (db.tables[table] || []).filter(r => filters.every(f => f(r))).map(r => ({ ...r })), error: null };
      };
      const b = {
        select() { return b; },
        eq(k, v) { filters.push(r => r[k] === v); return b; },
        in(k, vs) { filters.push(r => vs.includes(r[k])); return b; },
        maybeSingle: async () => { const r = run(); return { ...r, data: r.data ? (r.data[0] || null) : null }; },
        then(res, rej) { return Promise.resolve(run()).then(res, rej); },
      };
      return b;
    },
    rpc: async (name, args) => {
      if (db.onRpc) db.onRpc(name, args);
      return fake(name, args) || { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } };
    },
  };
  return db;
}

const U = 'u1';
function seed({ status = 'draft', tax_mode = 'exclusive' } = {}) {
  return {
    invoices: [{ id: 'inv1', issuer_id: U, status, tax_mode, withholding_enabled: true, total_amount: 999, updated_at: 't0' }],
    invoice_items: [
      { id: 'a', invoice_id: 'inv1', creative_id: 'c1', cost_type: 'base_fee', unit_price: 10000, quantity: 1, total_amount: 10000 },
      { id: 'b', invoice_id: 'inv1', creative_id: 'c2', cost_type: 'base_fee', unit_price: 5000, quantity: 1, total_amount: 5000 },
      { id: 'e', invoice_id: 'inv1', creative_id: null, cost_type: 'expense', unit_price: 800, quantity: 1, total_amount: 800, receipt_file_id: 'drv-x' },
    ],
  };
}

describe('removeItemsFromEditableInvoices', () => {
  test('下書きから外し、残りの明細から計算した合計（新方式は 5 列）を書く', async () => {
    const db = makeDb(seed());
    const r = await R.removeItemsFromEditableInvoices(db.client, IE, { itemIds: ['a'], invoiceIds: ['inv1'], editableStatuses: ['draft', 'rejected'] });
    expect(r.ok).toBe(true);
    expect(r.removedItemIds).toEqual(['a']);
    const inv = db.tables.invoices[0];
    const t = IE.computeTotals(db.tables.invoice_items, { withholding_enabled: true });
    expect(inv).toMatchObject({ subtotal_amount: 5000, tax_amount: 500, total_amount: t.total, withholding_amount: t.withholding, payout_amount: t.payout });
    expect(inv.payout_amount).toBe(5000 + 500 + 800 - 510);
    expect(db.tables.invoice_items.map(x => x.id)).toEqual(['b', 'e']);
  });

  test('旧方式は明細の total_amount の合計', async () => {
    const db = makeDb(seed({ tax_mode: 'inclusive' }));
    await R.removeItemsFromEditableInvoices(db.client, IE, { itemIds: ['a'], invoiceIds: ['inv1'], editableStatuses: ['draft'] });
    expect(db.tables.invoices[0].total_amount).toBe(5800);
  });

  test('提出済みなら何もせず skipped（明細・合計そのまま）', async () => {
    const db = makeDb(seed({ status: 'submitted' }));
    const r = await R.removeItemsFromEditableInvoices(db.client, IE, { itemIds: ['a'], invoiceIds: ['inv1'], editableStatuses: ['draft', 'rejected'] });
    expect(r.ok).toBe(true);
    expect(r.skippedInvoiceIds).toEqual(['inv1']);
    expect(db.tables.invoice_items).toHaveLength(3);
    expect(db.tables.invoices[0].total_amount).toBe(999);
  });

  test('読んだあと・関数の直前に提出されたら（ロックの中で気づく）何も変えない', async () => {
    const db = makeDb(seed());
    db.onRpc = (name) => { if (name === R.REMOVE_FN) db.tables.invoices[0].status = 'submitted'; };
    const r = await R.removeItemsFromEditableInvoices(db.client, IE, { itemIds: ['a'], invoiceIds: ['inv1'], editableStatuses: ['draft', 'rejected'] });
    expect(r.skippedInvoiceIds).toEqual(['inv1']);
    expect(db.tables.invoice_items).toHaveLength(3);
    expect(db.tables.invoices[0].total_amount).toBe(999);
  });

  test('明細を読めなければ関数を呼ばない（0 円の合計を書かない）', async () => {
    const db = makeDb(seed());
    db.readError = (t) => t === 'invoice_items';
    const r = await R.removeItemsFromEditableInvoices(db.client, IE, { itemIds: ['a'], invoiceIds: ['inv1'], editableStatuses: ['draft'] });
    expect(r.failedInvoiceIds).toEqual(['inv1']);
    expect(db.fake.calls).toEqual([]);
    expect(db.tables.invoice_items).toHaveLength(3);
    expect(db.tables.invoices[0].total_amount).toBe(999);
  });

  test('読んだあとに単価が変わったら STALE → 読み直してやり直す（新しい単価で合計）', async () => {
    const db = makeDb(seed());
    let once = false;
    db.onRpc = () => { if (!once) { once = true; db.tables.invoice_items.find(x => x.id === 'b').unit_price = 7000; } };
    const r = await R.removeItemsFromEditableInvoices(db.client, IE, { itemIds: ['a'], invoiceIds: ['inv1'], editableStatuses: ['draft'] });
    expect(r.removedItemIds).toEqual(['a']);
    expect(db.fake.calls).toHaveLength(2);
    expect(db.tables.invoices[0].subtotal_amount).toBe(7000);
  });

  test('何度やっても合わなければ failed（何も変えない）', async () => {
    const db = makeDb(seed());
    let n = 0;
    db.onRpc = () => { db.tables.invoice_items.find(x => x.id === 'b').unit_price = 7000 + (++n); };
    const r = await R.removeItemsFromEditableInvoices(db.client, IE, { itemIds: ['a'], invoiceIds: ['inv1'], editableStatuses: ['draft'] });
    expect(r.failedInvoiceIds).toEqual(['inv1']);
    expect(db.fake.calls).toHaveLength(R.MAX_ATTEMPTS);
    expect(db.tables.invoice_items.map(x => x.id)).toContain('a');
  });

  test('allOrNothing: 1 件でも外せない請求書があれば、どれからも消さない', async () => {
    const t = seed();
    t.invoices.push({ id: 'inv2', issuer_id: U, status: 'submitted', tax_mode: 'exclusive', withholding_enabled: true, total_amount: 1 });
    t.invoice_items.push({ id: 'z', invoice_id: 'inv2', creative_id: 'c1', cost_type: 'base_fee', unit_price: 1, quantity: 1, total_amount: 1 });
    const db = makeDb(t);
    const r = await R.removeItemsFromEditableInvoices(db.client, IE, { itemIds: ['a', 'z'], invoiceIds: ['inv1', 'inv2'], editableStatuses: ['draft'], allOrNothing: true });
    expect(r).toMatchObject({ ok: false, code: 'NOT_EDITABLE', skippedInvoiceIds: ['inv2'] });
    expect(db.tables.invoice_items).toHaveLength(4);
  });

  test('allOrNothing: 読んだあと・関数の直前に 2 件目が提出されたら、1 件目からも消さない（1 トランザクション）', async () => {
    const t = seed();
    t.invoices.push({ id: 'inv2', issuer_id: U, status: 'draft', tax_mode: 'exclusive', withholding_enabled: true, total_amount: 1 });
    t.invoice_items.push({ id: 'z', invoice_id: 'inv2', creative_id: 'c1', cost_type: 'base_fee', unit_price: 1, quantity: 1, total_amount: 1 });
    const db = makeDb(t);
    db.onRpc = () => { db.tables.invoices.find(x => x.id === 'inv2').status = 'submitted'; };
    const r = await R.removeItemsFromEditableInvoices(db.client, IE, { itemIds: ['a', 'z'], invoiceIds: ['inv1', 'inv2'], editableStatuses: ['draft'], allOrNothing: true });
    expect(r).toMatchObject({ ok: false, code: 'NOT_EDITABLE', skippedInvoiceIds: ['inv2'] });
    expect(db.tables.invoice_items).toHaveLength(4);
    expect(db.tables.invoices[0].total_amount).toBe(999);
    expect(db.fake.calls).toEqual([R.REMOVE_FN]);
  });

  test('複数の請求書: 1 回の呼び出しで両方から外し、請求書ごとに外した明細を返す', async () => {
    const t = seed();
    t.invoices.push({ id: 'inv2', issuer_id: 'u2', status: 'rejected', tax_mode: 'inclusive', withholding_enabled: null, total_amount: 1 });
    t.invoice_items.push(
      { id: 'z', invoice_id: 'inv2', creative_id: 'c1', cost_type: 'director_fee', unit_price: 3000, quantity: 1, total_amount: 3000 },
      { id: 'y', invoice_id: 'inv2', creative_id: 'c9', cost_type: 'director_fee', unit_price: 2000, quantity: 1, total_amount: 2000 });
    const db = makeDb(t);
    const r = await R.removeItemsFromEditableInvoices(db.client, IE, { itemIds: ['a', 'z'], invoiceIds: ['inv2', 'inv1'], editableStatuses: ['draft', 'rejected'] });
    expect(r.ok).toBe(true);
    expect(r.removedByInvoice).toEqual({ inv1: ['a'], inv2: ['z'] });
    expect(db.fake.calls).toEqual([R.REMOVE_FN]);
    expect(db.tables.invoices.find(x => x.id === 'inv2').total_amount).toBe(2000);
  });

  test('admin-status（{draft}）は差し戻し中の請求書から外さない', async () => {
    const db = makeDb(seed({ status: 'rejected' }));
    const r = await R.removeItemsFromEditableInvoices(db.client, IE, { itemIds: ['a'], invoiceIds: ['inv1'], editableStatuses: ['draft'] });
    expect(r.skippedInvoiceIds).toEqual(['inv1']);
    expect(db.tables.invoice_items).toHaveLength(3);
  });

  test('関数が未適用なら failed（明細は消さない）', async () => {
    const db = makeDb(seed());
    db.fake.missing = true;
    const r = await R.removeItemsFromEditableInvoices(db.client, IE, { itemIds: ['a'], invoiceIds: ['inv1'], editableStatuses: ['draft'] });
    expect(r.failedInvoiceIds).toEqual(['inv1']);
    expect(r.errors[0]).toMatch(/未適用/);
    expect(db.tables.invoice_items).toHaveLength(3);
  });
});

describe('deleteEditableInvoice', () => {
  test('下書きは明細ごと消え、領収書ファイル id が返る', async () => {
    const db = makeDb(seed());
    const r = await R.deleteEditableInvoice(db.client, { invoiceId: 'inv1', editableStatuses: ['draft', 'rejected'], expectedIssuerId: U });
    expect(r).toEqual({ result: 'ok', receiptFileIds: ['drv-x'] });
    expect(db.tables.invoices).toHaveLength(0);
    expect(db.tables.invoice_items).toHaveLength(0);
  });
  test('権限確認のあと・関数の直前に提出されたら消さない', async () => {
    const db = makeDb(seed());
    db.onRpc = () => { db.tables.invoices[0].status = 'submitted'; };
    const r = await R.deleteEditableInvoice(db.client, { invoiceId: 'inv1', editableStatuses: ['draft', 'rejected'], expectedIssuerId: U });
    expect(r.result).toBe('not_editable');
    expect(db.tables.invoice_items).toHaveLength(3);
  });
  test('発行者が違えば conflict', async () => {
    const db = makeDb(seed());
    const r = await R.deleteEditableInvoice(db.client, { invoiceId: 'inv1', editableStatuses: ['draft'], expectedIssuerId: 'other' });
    expect(r.result).toBe('conflict');
    expect(db.tables.invoices).toHaveLength(1);
  });
  test('関数が未適用なら missingFunction', async () => {
    const db = makeDb(seed());
    db.fake.missing = true;
    const r = await R.deleteEditableInvoice(db.client, { invoiceId: 'inv1', editableStatuses: ['draft'], expectedIssuerId: U });
    expect(r).toMatchObject({ result: 'failed', missingFunction: true });
  });
});

describe('remainingFingerprint', () => {
  test('外す行を除き、数値は数に揃える', () => {
    expect(R.remainingFingerprint([
      { id: 'a', creative_id: 'c', cost_type: 'base_fee', unit_price: '100', quantity: '1.00', total_amount: 100 },
      { id: 'b', creative_id: null, cost_type: null, unit_price: null, quantity: null, total_amount: null },
    ], ['b'])).toEqual([{ id: 'a', creative_id: 'c', cost_type: 'base_fee', unit_price: 100, quantity: 1, total_amount: 100 }]);
  });
});
