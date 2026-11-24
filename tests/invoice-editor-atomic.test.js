// 請求書エディタの保存・CR の追加・提出を DB の関数（1 トランザクション）で行う（ADR 046 追補 2026-11-24（3））。
//   - utils/invoice-editor-atomic.js（関数に渡す引数・戻り値の読み替え・画面の明細との突き合わせ）の単体テスト
//   - ルートの結合テスト: supabase はメモリ上の偽 DB、関数は tests/helpers/invoice-editor-rpc-fake.js（本物の SQL と同じ意味）。
//     「アプリが読んだあと、関数がロックを取る直前に別の処理が入った」を fake.before で再現し、
//     提出済みの請求書の明細が書き換わらない・同じ CR×役割が 2 回提出されない・関数が無い環境では 503 で止まる ことを確かめる
process.env.INVOICE_PDF_DRIVE_SYNC = 'off';

const IEA = require('../utils/invoice-editor-atomic');
const IE = require('../utils/invoice-editor');

const mockDb = { invoices: [], invoice_items: [], invoice_billing_claims: [], users: [{ id: 'u1', full_name: 'テスト 太郎', business_type: 'individual', role: 'director' }] };
let mockSeq = 0;
function mockBuilder(table) {
  const st = { op: 'select', payload: null, eq: [], in: [] };
  const rowsOf = () => (mockDb[table] || []);
  const match = (r) => st.eq.every(([k, v]) => r[k] === v) && st.in.every(([k, vs]) => vs.includes(r[k]));
  const run = () => {
    if (st.op === 'insert') {
      const list = (Array.isArray(st.payload) ? st.payload : [st.payload]).map(p => ({ id: `new-${++mockSeq}`, ...p }));
      mockDb[table] = rowsOf().concat(list);
      return { data: list, error: null };
    }
    if (st.op === 'update') {
      const hit = rowsOf().filter(match);
      hit.forEach(r => Object.assign(r, st.payload));
      return { data: hit, error: null };
    }
    if (st.op === 'delete') {
      mockDb[table] = rowsOf().filter(r => !match(r));
      return { data: null, error: null };
    }
    return { data: rowsOf().filter(match).map(r => ({ ...r })), error: null, count: 0 };
  };
  const b = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'then') return (res, rej) => Promise.resolve(run()).then(res, rej);
      if (prop === 'insert') return (p) => { st.op = 'insert'; st.payload = p; return b; };
      if (prop === 'update') return (p) => { st.op = 'update'; st.payload = p; return b; };
      if (prop === 'delete') return () => { st.op = 'delete'; return b; };
      if (prop === 'eq') return (k, v) => { st.eq.push([k, v]); return b; };
      if (prop === 'in') return (k, vs) => { st.in.push([k, vs]); return b; };
      if (prop === 'single' || prop === 'maybeSingle') return async () => {
        const r = run();
        return { ...r, data: Array.isArray(r.data) ? (r.data[0] || null) : r.data };
      };
      return () => b;
    },
  });
  return b;
}
const mockRpcFake = require('./helpers/invoice-editor-rpc-fake').createInvoiceEditorRpcFake({
  rows: (t) => (mockDb[t] || (mockDb[t] = [])), setRows: (t, arr) => { mockDb[t] = arr; },
});
jest.mock('../supabase', () => ({ from: (t) => mockBuilder(t), rpc: async (n, a) => mockRpcFake(n, a) || ({ data: null, error: null }), storage: { from: () => ({}) } }));
jest.mock('../auth', () => {
  const pass = (req, res, next) => { req.user = { id: 'u1', role: 'director' }; next(); };
  return {
    requireAuth: pass, requireRole: () => pass, requireLevel: () => pass, requirePermission: () => pass,
    requireAnyPermission: () => pass, requireSuperAdmin: pass, isSuperAdminUser: () => false,
    userHasPermission: async () => false, getEffectiveRole: async () => 'director', getEffectiveRoleCodes: async () => ['director'],
    invalidatePermissionsCache: () => {}, invalidateUserCache: () => {},
  };
});

// ==================== 単体: utils/invoice-editor-atomic.js ====================
describe('utils/invoice-editor-atomic', () => {
  test('関数が無いエラー（PGRST202 / 42883）を見分ける', () => {
    expect(IEA.isMissingFunctionError({ code: 'PGRST202', message: 'Could not find the function public.invoice_editor_submit' })).toBe(true);
    expect(IEA.isMissingFunctionError({ code: '42883', message: 'function invoice_editor_submit(uuid) does not exist' }, IEA.SUBMIT_FN)).toBe(true);
    // 関数の中で別の関数・演算子が見つからない 42883 は「準備中」にしない（本当の不具合を隠さない）
    expect(IEA.isMissingFunctionError({ code: '42883', message: 'operator does not exist: uuid = text' }, IEA.SUBMIT_FN)).toBe(false);
    expect(IEA.rpcErrorToHttp({ code: '42883', message: 'function hashtextextended(text) does not exist' }, IEA.SUBMIT_FN).status).toBe(500);
    expect(IEA.isMissingFunctionError({ code: '23505', message: 'duplicate key' })).toBe(false);
    expect(IEA.isMissingFunctionError(null)).toBe(false);
    expect(IEA.rpcErrorToHttp({ code: 'PGRST202' })).toEqual(IEA.NOT_READY);
    expect(IEA.rpcErrorToHttp({ code: 'P0002', message: 'item not found (0 of 1)' }).status).toBe(409);
    expect(IEA.rpcErrorToHttp({ code: '23505', message: 'duplicate key value violates unique constraint "invoice_billing_claims_pkey"' }, IEA.SUBMIT_FN).body.code).toBe('INVOICE_CHECK_FAILED');
    expect(IEA.rpcErrorToHttp({ code: '23505', message: 'duplicate key' }, IEA.SAVE_FN).status).toBe(500);
    expect(IEA.rpcErrorToHttp({ code: 'XX000', message: 'boom' })).toEqual({ status: 500, body: { error: 'boom' } });
  });

  test('引数は送ってよい列だけ（invoice_id・is_special や知らない列は送らない）', () => {
    expect(IEA.updateArg('a', { unit_price: 100, quantity: 1, sort_order: 2, total_amount: 100, invoice_id: 'x', receipt_file_id: 'f' }))
      .toEqual({ id: 'a', unit_price: 100, quantity: 1, sort_order: 2, total_amount: 100 });
    expect(IEA.insertArg('k1', { invoice_id: 'x', creative_id: null, cost_type: 'expense', label: 'L', unit_price: 5, quantity: 1, is_special: false, expense_date: '2026-10-25', receipt_file_id: 'f' }))
      .toEqual({ client_key: 'k1', creative_id: null, cost_type: 'expense', label: 'L', unit_price: 5, quantity: 1, expense_date: '2026-10-25' });
    expect(IEA.receiptWriteArg({ id: 'e', rc: { receipt_status: 'missing', receipt_file_id: null, receipt_file_name: null }, guardFileId: 'F1' }))
      .toEqual({ id: 'e', guard_file_id: 'F1', receipt_status: 'missing', clear_file: true });
    expect(IEA.receiptWriteArg({ id: 'e', rc: { receipt_missing_reason: 'x' }, guardFileId: null }))
      .toEqual({ id: 'e', guard_file_id: null, receipt_missing_reason: 'x' });
    const t = { subtotal: 1, tax: 2, total: 3, withholding: 4, payout: 5 };
    expect(IEA.invoiceArg(t)).toEqual({ subtotal_amount: 1, tax_amount: 2, total_amount: 3, withholding_amount: 4, payout_amount: 5 });
    expect(IEA.invoiceArg(t, { withholdingEnabled: false, notes: null })).toMatchObject({ withholding_enabled: false, notes: null });
    expect(IEA.totalsArg({ ...t, grand_total: 9 })).toEqual(t);
  });

  test('提出の指紋と参考単価の控え直し', () => {
    const items = [
      { id: 'a', creative_id: 'c1', cost_type: 'base_fee', unit_price: '5000', quantity: '1', original_unit_price: 4000 },
      { id: 'b', creative_id: null, cost_type: null, unit_price: null, quantity: 2, original_unit_price: null },
    ];
    expect(IEA.submitFingerprint(items)).toEqual([
      { id: 'a', creative_id: 'c1', cost_type: 'base_fee', unit_price: 5000, quantity: 1 },
      { id: 'b', creative_id: null, cost_type: null, unit_price: null, quantity: 2 },
    ]);
    expect(IEA.refUpdatesArg(items, () => 4000)).toEqual([]);
    expect(IEA.refUpdatesArg(items, () => 4500)).toEqual([{ id: 'a', original_unit_price: 4500 }]);
    expect(IEA.refUpdatesArg(items, () => null)).toEqual([{ id: 'a', original_unit_price: 0 }]);
  });

  test('画面の明細と保存済みの明細の突き合わせ', () => {
    const opts = { parseMoney: IE.parseMoney, maxQuantity: IE.MAX_QUANTITY, isManualLine: IE.isManualLine, isFixedLine: IE.isFixedLine };
    const items = [
      { id: 'cr', creative_id: 'c1', cost_type: 'base_fee', unit_price: 5000, quantity: 1 },
      { id: 'm', creative_id: null, cost_type: null, unit_price: 300, quantity: 2 },
      { id: 'h', creative_id: null, cost_type: 'hourly_fee', unit_price: 1500, quantity: 3 },
    ];
    expect(IEA.compareDisplayedItems(undefined, items, opts)).toEqual({});
    const same = [{ id: 'cr', unit_price: 5000, quantity: 1 }, { id: 'm', unit_price: '300', quantity: 2 }, { id: 'h' }];
    expect(IEA.compareDisplayedItems(same, items, opts)).toEqual({ stale: false });
    expect(IEA.compareDisplayedItems([same[0], { ...same[1], unit_price: 301 }, same[2]], items, opts).stale).toBe(true);
    expect(IEA.compareDisplayedItems([same[0], { ...same[1], quantity: 3 }, same[2]], items, opts).stale).toBe(true);
    expect(IEA.compareDisplayedItems([same[0], same[1]], items, opts).stale).toBe(true); // 行が足りない
    expect(IEA.compareDisplayedItems([same[0], same[0], same[2]], items, opts).stale).toBe(true); // 同じ行が 2 回
    expect(IEA.compareDisplayedItems([...same, { id: 'zz', unit_price: 1 }], items, opts).stale).toBe(true); // 知らない行
    const bad = IEA.compareDisplayedItems([{ id: 'cr', unit_price: '5,0a0' }, same[1], same[2]], items, opts);
    expect(bad.error.status).toBe(400);
    expect(bad.error.body).toMatchObject({ code: 'BAD_INPUT', index: 0 });
  });

  test('提出の関数の戻り値を HTTP に（DUPLICATE は行ごとの problems）', () => {
    const itemsById = new Map([['a', { id: 'a', creative_label: 'hertech_A_15s' }]]);
    const r = IEA.submitFailureToHttp({ ok: false, code: 'DUPLICATE', problems: [{ item_id: 'a', creative_id: 'c1', code: 'DUPLICATE' }] }, { itemsById });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: 'INVOICE_CHECK_FAILED' });
    expect(r.body.problems).toEqual([{ item_id: 'a', creative_id: 'c1', code: 'DUPLICATE', message: 'hertech_A_15s: すでに提出済みの請求書に入っています' }]);
    expect(IEA.submitFailureToHttp({ ok: false, code: 'STALE_ITEMS' })).toEqual({ status: 409, body: IEA.STALE_BODY });
    expect(IEA.submitFailureToHttp({ ok: false, code: 'CONFLICT' }).body.code).toBe('CONFLICT');
    expect(IEA.submitFailureToHttp({ ok: false, code: 'NOT_EDITABLE', status: 'submitted' }).status).toBe(400);
    expect(IEA.saveFailureToHttp({ ok: false, code: 'NOT_EDITABLE' }).body.code).toBe('NOT_EDITABLE');
    expect(IEA.saveFailureToHttp({ ok: false, code: 'CONFLICT', updated_at: 't9' })).toMatchObject({ status: 409, body: { code: 'CONFLICT', updated_at: 't9' } });
  });
});

// ==================== 結合: ルート ====================
const express = require('express');
let server; let base;
beforeAll(async () => {
  const app = express(); app.use(express.json());
  app.use('/api', require('../routes/haruka'));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api`;
});
afterAll(() => server && server.close());

const draft = (id, extra = {}) => ({
  id, invoice_number: `INV-${id}`, issuer_id: 'u1', status: 'draft', year: 2026, month: 10, notes: null,
  tax_mode: 'exclusive', withholding_enabled: true, subtotal_amount: 6000, tax_amount: 600, total_amount: 6600,
  withholding_amount: 612, payout_amount: 5988, updated_at: 't0', submitted_at: null, rejection_reason: null, invoice_type: null, ...extra,
});
const manualRow = (id, invoiceId, extra = {}) => ({
  id, invoice_id: invoiceId, creative_id: null, cost_type: null, label: '撮影同行', creative_label: null, unit: '式',
  unit_price: 6000, quantity: 1, total_amount: 6000, original_unit_price: null, price_change_reason: null, manual_reason: '直接依頼', sort_order: 0, ...extra,
});
beforeEach(() => {
  mockDb.invoices = [draft('inv1')];
  mockDb.invoice_items = [manualRow('it1', 'inv1')];
  mockDb.invoice_billing_claims = [];
  mockRpcFake.calls = [];
  mockRpcFake.missing = false;
  mockRpcFake.before = null;
  jest.restoreAllMocks();
});

const call = async (method, path, body) => {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
const inv = (id = 'inv1') => mockDb.invoices.find(i => i.id === id);
const itemsOf = (id = 'inv1') => mockDb.invoice_items.filter(it => it.invoice_id === id);
const keepRow = { id: 'it1', label: '撮影同行', unit_price: 6000, quantity: 1, manual_reason: '直接依頼' };
const put = (items, extra = {}) => call('PUT', '/invoice-editor/inv1', { updated_at: inv().updated_at, withholding_enabled: true, items, ...extra });

describe('PUT /invoice-editor/:id（自動保存）', () => {
  test('関数を通して書く（行の追加・単価の変更・合計・updated_at）', async () => {
    const r = await put([{ ...keepRow, unit_price: 7000 }, { client_key: 'k1', label: 'タクシー代', unit_price: 2000, quantity: 1, manual_reason: '移動' }]);
    expect(r.status).toBe(200);
    expect(mockRpcFake.calls).toEqual(['invoice_editor_save_draft']);
    expect(Object.keys(r.body.id_map)).toEqual(['k1']);
    expect(r.body.updated_at).toBe(inv().updated_at);
    expect(r.body.saved_at).toBe(inv().updated_at);
    expect(itemsOf().map(it => [it.label, it.unit_price, it.total_amount])).toEqual([['撮影同行', 7000, 7000], ['タクシー代', 2000, 2000]]);
    expect(inv()).toMatchObject({ subtotal_amount: 9000, tax_amount: 900, total_amount: 9900 });
    // 返ってきた updated_at で続けて保存できる（楽観ロックがつながる）
    const r2 = await call('PUT', '/invoice-editor/inv1', { updated_at: r.body.updated_at, items: [keepRow] });
    expect(r2.status).toBe(200);
    expect(itemsOf()).toHaveLength(1);
  });

  test('画面の client_key とサーバーが振る鍵がぶつからない（どの行にも正しい id が返る）', async () => {
    const r = await put([keepRow,
      { client_key: 's:1', label: 'A', unit_price: 1, quantity: 1, manual_reason: 'x' },
      { label: 'B（鍵なし）', unit_price: 2, quantity: 1, manual_reason: 'x' },
      { client_key: '__row0', label: 'C', unit_price: 3, quantity: 1, manual_reason: 'x' }]);
    expect(r.status).toBe(200);
    const byLabel = Object.fromEntries(itemsOf().map(it => [it.label, it.id]));
    expect(r.body.id_map).toEqual({ 's:1': byLabel.A, __row0: byLabel.C });
    expect(new Set(itemsOf().map(it => it.id)).size).toBe(4);
  });

  test('読んだあと・ロックの直前に提出されていたら書かない（400 NOT_EDITABLE・明細はそのまま）', async () => {
    mockRpcFake.before = () => { inv().status = 'submitted'; };
    const r = await put([{ ...keepRow, unit_price: 1 }]);
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('NOT_EDITABLE');
    expect(itemsOf()[0].unit_price).toBe(6000);
    expect(inv().total_amount).toBe(6600);
  });

  test('読んだあと・ロックの直前に別の画面で保存されていたら 409 CONFLICT（上書きしない）', async () => {
    mockRpcFake.before = () => { inv().updated_at = 't-other'; };
    const r = await put([{ ...keepRow, unit_price: 1 }]);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('CONFLICT');
    expect(itemsOf()[0].unit_price).toBe(6000);
  });

  test('更新しようとした明細が別の画面で消されていたら 409・ほかの書き込みも取り消す', async () => {
    mockDb.invoice_items.push(manualRow('it2', 'inv1', { label: '2行目', sort_order: 1 }));
    mockRpcFake.before = () => { mockDb.invoice_items = mockDb.invoice_items.filter(it => it.id !== 'it2'); };
    const r = await put([{ ...keepRow, unit_price: 1 }, { id: 'it2', label: '2行目', unit_price: 5, quantity: 1, manual_reason: 'x' }]);
    expect(r.status).toBe(409);
    expect(itemsOf().find(it => it.id === 'it1').unit_price).toBe(6000);
    expect(inv().updated_at).toBe('t0');
  });

  test('関数がまだ無い環境では 503 で止める（従来の書き方に戻さない）', async () => {
    mockRpcFake.missing = true;
    const r = await put([{ ...keepRow, unit_price: 1 }]);
    expect(r.status).toBe(503);
    expect(r.body.code).toBe('ATOMIC_SAVE_NOT_READY');
    expect(itemsOf()[0].unit_price).toBe(6000);
    expect(inv().updated_at).toBe('t0');
  });

  test('CR 行の数量は DB でも 1・作業時間の行の単価は変えられない', async () => {
    mockDb.invoice_items = [
      manualRow('cr1', 'inv1', { creative_id: 'c1', cost_type: 'base_fee', label: '編集', unit_price: null, quantity: 1, total_amount: 0, manual_reason: null }),
      manualRow('h1', 'inv1', { cost_type: 'hourly_fee', label: '作業時間', unit_price: 1500, quantity: 2, total_amount: 3000, manual_reason: null, sort_order: 1 }),
    ];
    const r = await put([{ id: 'cr1', unit_price: 4000, quantity: 5 }, { id: 'h1', unit_price: 1, quantity: 99 }]);
    expect(r.status).toBe(200);
    expect(itemsOf().map(it => [it.id, it.unit_price, it.quantity])).toEqual([['cr1', 4000, 1], ['h1', 1500, 2]]);
  });
});

describe('POST /invoice-editor/:id/items（CR の追加）', () => {
  test('読んだあと・ロックの直前に提出されていたら行を足さない', async () => {
    // 足せる CR の判定（本人の分・納品済み）はここでは通す
    jest.spyOn(IE, 'isBillableCreative').mockReturnValue(true);
    mockDb.creatives = [{ id: 'c9', file_name: 'hertech_A_15s', status: '納品', project_id: 'p1', projects: null, creative_assignments: [{ user_id: 'u1', role: 'editor' }] }];
    mockRpcFake.before = () => { inv().status = 'submitted'; };
    const r = await call('POST', '/invoice-editor/inv1/items', { creative_ids: ['c9'], updated_at: 't0' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('NOT_EDITABLE');
    expect(mockRpcFake.calls).toEqual(['invoice_editor_save_draft']);
    expect(itemsOf()).toHaveLength(1);
  });

  test('下書きなら関数を通して CR の行を足す（単価は空欄・数量 1・参考単価の控えつき）', async () => {
    jest.spyOn(IE, 'isBillableCreative').mockReturnValue(true);
    mockDb.creatives = [{ id: 'c9', file_name: 'hertech_A_15s', status: '納品', project_id: 'p1', projects: null, creative_assignments: [{ user_id: 'u1', role: 'editor' }] }];
    const r = await call('POST', '/invoice-editor/inv1/items', { creative_ids: ['c9'], updated_at: 't0' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, added: 1, updated_at: inv().updated_at });
    const added = itemsOf().find(it => it.creative_id === 'c9');
    expect(added).toMatchObject({ cost_type: 'base_fee', creative_label: 'hertech_A_15s', unit_price: null, quantity: 1, unit: '本' });
  });
});

describe('POST /invoice-editor/:id/submit（提出）', () => {
  const okSubmit = (body = {}) => call('POST', '/invoice-editor/inv1/submit', { expected_total: 6600, expected_payout: 5988, updated_at: inv().updated_at, ...body });

  test('関数を通して確定する（status・金額列）', async () => {
    const r = await okSubmit({ items: [{ id: 'it1', unit_price: 6000, quantity: 1 }] });
    expect(r.status).toBe(200);
    expect(mockRpcFake.calls).toEqual(['invoice_editor_submit']);
    expect(r.body).toMatchObject({ id: 'inv1', status: 'submitted', total_amount: 6600, payout_amount: 5988 });
    expect(inv()).toMatchObject({ status: 'submitted', subtotal_amount: 6000, tax_amount: 600, withholding_amount: 612 });
  });

  test('画面の明細と保存済みが違えば 409 STALE_ITEMS（関数は呼ばない）', async () => {
    const r = await okSubmit({ items: [{ id: 'it1', unit_price: 6500, quantity: 1 }] });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('STALE_ITEMS');
    expect(mockRpcFake.calls).toEqual([]);
    expect(inv().status).toBe('draft');
  });

  test('画面の単価に不正な文字があれば 400', async () => {
    const r = await okSubmit({ items: [{ id: 'it1', unit_price: '6千', quantity: 1 }] });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('BAD_INPUT');
  });

  test('検証のあと・ロックの直前に明細が書き換わったら 409 STALE_ITEMS（古い明細で確定しない）', async () => {
    mockRpcFake.before = () => { mockDb.invoice_items[0].unit_price = 1; };
    const r = await okSubmit();
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('STALE_ITEMS');
    expect(inv().status).toBe('draft');
  });

  test('同じ CR×役割を含む 2 枚の請求書を同時に出しても、後の 1 枚は DB の確認で止まる', async () => {
    // 2 枚の下書きに同じ CR（c1・編集）。アプリ側の判定（本人の分・納品済み・参考単価）は通るものとする
    mockDb.invoices.push(draft('inv2'));
    const crRow = (id, invoiceId) => manualRow(id, invoiceId, { creative_id: 'c1', cost_type: 'base_fee', label: '編集', creative_label: 'hertech_A_15s', unit_price: 6000, manual_reason: null, original_unit_price: 6000 });
    mockDb.invoice_items = [crRow('a1', 'inv1'), crRow('b1', 'inv2')];
    jest.spyOn(IE, 'checkInvoiceForSubmit').mockImplementation(({ items, withholdingEnabled }) => ({ problems: [], totals: IE.computeTotals(items, { withholding_enabled: withholdingEnabled }) }));
    // inv2 の提出: アプリの確認（二重請求なし）を通ったあと、関数がロックを取る直前に inv1 の提出が確定した
    mockRpcFake.before = (name, args) => {
      if (args.p_invoice_id !== 'inv2') return;
      mockRpcFake.before = null;
      Object.assign(inv('inv1'), { status: 'submitted' });
      mockDb.invoice_billing_claims.push({ issuer_id: 'u1', creative_id: 'c1', cost_type: 'base_fee', invoice_id: 'inv1', invoice_item_id: 'a1' });
    };
    const r = await call('POST', '/invoice-editor/inv2/submit', { expected_total: 6600, expected_payout: 5988, updated_at: 't0' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('INVOICE_CHECK_FAILED');
    expect(r.body.problems).toEqual([expect.objectContaining({ item_id: 'b1', code: 'DUPLICATE', message: 'hertech_A_15s: すでに提出済みの請求書に入っています' })]);
    expect(inv('inv2').status).toBe('draft');
    expect(mockDb.invoice_billing_claims.filter(c => c.invoice_id === 'inv2')).toEqual([]);
  });

  test('提出すると CR 行が請求済み記録に入る（HFS外の行は入らない）', async () => {
    mockDb.invoice_items = [
      manualRow('a1', 'inv1', { creative_id: 'c1', cost_type: 'base_fee', label: '編集', unit_price: 5000, total_amount: 5000, manual_reason: null, original_unit_price: 5000 }),
      manualRow('m1', 'inv1', { unit_price: 1000, total_amount: 1000, sort_order: 1 }),
    ];
    jest.spyOn(IE, 'checkInvoiceForSubmit').mockImplementation(({ items, withholdingEnabled }) => ({ problems: [], totals: IE.computeTotals(items, { withholding_enabled: withholdingEnabled }) }));
    const r = await okSubmit();
    expect(r.status).toBe(200);
    expect(mockDb.invoice_billing_claims).toEqual([{ issuer_id: 'u1', creative_id: 'c1', cost_type: 'base_fee', invoice_id: 'inv1', invoice_item_id: 'a1' }]);
  });

  test('関数がまだ無い環境では 503（提出しない）', async () => {
    mockRpcFake.missing = true;
    const r = await okSubmit();
    expect(r.status).toBe(503);
    expect(r.body.code).toBe('ATOMIC_SAVE_NOT_READY');
    expect(inv().status).toBe('draft');
  });
});
