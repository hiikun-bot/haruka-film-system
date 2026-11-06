// 請求書エディタ: 立替経費（実費）の行（ADR 046 追補 2026-11-05）
// 「＋ 立替経費」で足した行は消費税・源泉の対象外で、差引お振込額にだけ足される。
// 保存（PUT）と提出（submit）で DB に書く値をルートごと確かめる:
//   invoices.total_amount  = 報酬の税込（立替経費を含まない・意味は変えない）
//   invoices.payout_amount = 報酬の税込 − 源泉 ＋ 立替経費
process.env.INVOICE_PDF_DRIVE_SYNC = 'off';

const mockDb = { invoices: [], invoice_items: [], users: [{ id: 'u1', full_name: 'テスト 太郎', business_type: 'individual', role: 'director' }] };
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
    return { data: rowsOf().filter(match), error: null, count: 0 };
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
jest.mock('../supabase', () => ({ from: (t) => mockBuilder(t), rpc: async () => ({ data: null, error: null }), storage: { from: () => ({}) } }));
jest.mock('../auth', () => {
  const pass = (req, res, next) => { req.user = { id: 'u1', role: 'director' }; next(); };
  return {
    requireAuth: pass, requireRole: () => pass, requireLevel: () => pass, requirePermission: () => pass,
    requireAnyPermission: () => pass, requireSuperAdmin: pass, isSuperAdminUser: () => false,
    userHasPermission: async () => false, getEffectiveRole: async () => 'director', getEffectiveRoleCodes: async () => ['director'],
    invalidatePermissionsCache: () => {}, invalidateUserCache: () => {},
  };
});

const express = require('express');
let server; let base;
beforeAll(async () => {
  const app = express(); app.use(express.json());
  app.use('/api', require('../routes/haruka'));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api`;
});
afterAll(() => server && server.close());

beforeEach(() => {
  mockDb.invoices = [{
    id: 'inv1', invoice_number: 'INV-202610-013', issuer_id: 'u1', status: 'draft', year: 2026, month: 10, notes: null,
    tax_mode: 'exclusive', withholding_enabled: true, subtotal_amount: 6000, tax_amount: 600, total_amount: 6600,
    withholding_amount: 612, payout_amount: 5988, updated_at: 't0', submitted_at: null, rejection_reason: null, invoice_type: null,
  }];
  // HFS外の行（課税・源泉あり）1 行だけの下書き
  mockDb.invoice_items = [{
    id: 'it1', invoice_id: 'inv1', creative_id: null, cost_type: null, label: '撮影同行', creative_label: null, unit: '式',
    unit_price: 6000, quantity: 1, total_amount: 6000, original_unit_price: null, price_change_reason: null, manual_reason: '直接依頼', sort_order: 0,
  }];
});

const call = async (method, path, body) => {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
const inv = () => mockDb.invoices[0];
const keepRow = { id: 'it1', label: '撮影同行', unit_price: 6000, quantity: 1, manual_reason: '直接依頼' };
const addExpenses = () => call('PUT', '/invoice-editor/inv1', {
  updated_at: inv().updated_at, withholding_enabled: true,
  items: [
    keepRow,
    { client_key: 'k1', kind: 'expense', label: 'アートホテル撮影 移動タクシー代', unit_price: 2000, quantity: 7, manual_reason: '無視される' },
    { client_key: 'k2', kind: 'expense', label: 'アートホテル撮影 ガソリン代', unit_price: '1,641' },
  ],
});

test('PUT: 「＋ 立替経費」の行は cost_type=expense・数量 1 で入り、消費税・源泉は報酬だけにかかる', async () => {
  const r = await addExpenses();
  expect(r.status).toBe(200);
  expect(r.body.totals).toMatchObject({ subtotal: 6000, tax: 600, total: 6600, expense: 3641, grand_total: 10241, withholding: 612, payout: 9629 });
  expect(Object.keys(r.body.id_map).sort()).toEqual(['k1', 'k2']);

  const added = mockDb.invoice_items.filter(it => it.cost_type === 'expense');
  expect(added.map(it => [it.label, it.unit_price, it.quantity, it.total_amount, it.manual_reason])).toEqual([
    ['アートホテル撮影 移動タクシー代', 2000, 1, 2000, null],
    ['アートホテル撮影 ガソリン代', 1641, 1, 1641, null],
  ]);
  // total_amount は報酬の税込のまま。立替経費は差引にだけ足す
  expect(inv()).toMatchObject({ subtotal_amount: 6000, tax_amount: 600, total_amount: 6600, withholding_amount: 612, payout_amount: 9629 });
});

test('PUT: kind を付けない新しい行は従来どおり HFS外の行（課税）', async () => {
  const r = await call('PUT', '/invoice-editor/inv1', {
    updated_at: 't0', withholding_enabled: true,
    items: [keepRow, { client_key: 'k1', label: 'タクシー代', unit_price: 2000, quantity: 1, manual_reason: '直接依頼' }],
  });
  expect(r.status).toBe(200);
  expect(r.body.totals).toMatchObject({ subtotal: 8000, tax: 800, total: 8800, expense: 0, grand_total: 8800 });
  expect(mockDb.invoice_items.find(it => it.label === 'タクシー代').cost_type).toBeNull();
});

test('PUT: 保存済みの立替経費の金額・内容を直せる（種類は変わらず、数量は 1 のまま）', async () => {
  await addExpenses();
  const [taxi, gas] = mockDb.invoice_items.filter(it => it.cost_type === 'expense');
  const r = await call('PUT', '/invoice-editor/inv1', {
    updated_at: inv().updated_at, withholding_enabled: true,
    items: [keepRow, { id: taxi.id, kind: 'manual', label: 'タクシー代（往復）', unit_price: 4000, quantity: 3 }, { id: gas.id, label: gas.label, unit_price: gas.unit_price }],
  });
  expect(r.status).toBe(200);
  expect(r.body.totals).toMatchObject({ subtotal: 6000, expense: 5641, grand_total: 12241, payout: 11629 });
  expect(mockDb.invoice_items.find(it => it.id === taxi.id)).toMatchObject({ cost_type: 'expense', label: 'タクシー代（往復）', unit_price: 4000, quantity: 1, total_amount: 4000 });
});

test('submit: 画面の「ご請求金額」（立替経費込み）で提出でき、DB は 税込＝報酬だけ・差引＝実費込み', async () => {
  await addExpenses();
  // 報酬の税込（6,600）を送ると合計不一致で止まる
  const ng = await call('POST', '/invoice-editor/inv1/submit', { expected_total: 6600, expected_payout: 9629, updated_at: inv().updated_at });
  expect(ng.status).toBe(409);
  expect(ng.body.problems.map(p => p.code)).toEqual(['TOTAL_MISMATCH']);
  expect(inv().status).toBe('draft');

  const ok = await call('POST', '/invoice-editor/inv1/submit', { expected_total: 10241, expected_payout: 9629, updated_at: inv().updated_at });
  expect(ok.status).toBe(200);
  expect(inv()).toMatchObject({ status: 'submitted', subtotal_amount: 6000, tax_amount: 600, total_amount: 6600, withholding_amount: 612, payout_amount: 9629 });
  // 保存値から立替経費を求め直せる（一覧・PDF・源泉台帳が使う）
  expect(require('../utils/invoice-editor').expenseOfInvoice(inv())).toBe(3641);
});

test('GET: 立替経費の行は kind=expense・is_expense で返る', async () => {
  await addExpenses();
  const r = await fetch(base + '/invoice-editor/inv1');
  const body = await r.json();
  expect(r.status).toBe(200);
  expect(body.items.map(it => [it.kind, it.is_expense, it.quantity, it.amount])).toEqual([
    ['manual', false, 1, 6000], ['expense', true, 1, 2000], ['expense', true, 1, 1641],
  ]);
  expect(body.totals).toMatchObject({ expense: 3641, grand_total: 10241, payout: 9629 });
});
