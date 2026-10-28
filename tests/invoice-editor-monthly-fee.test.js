// 請求書エディタ: 月額定額（ADR 053）の明細だけで下書きを作れるか（バグ報告 b40c092a・invoices.project_id NOT NULL）
const mockInserted = [];
const mockTables = {
  line_payment_installments: [{
    id: 'inst1', line_id: 'l1', seq: 1, total_count: 1, label: '2026年10月分', target_month: '2026-10-01', payment_amount: 30000,
    line: { id: 'l1', name: '月額定額（ぴょん）', project_id: 'p1', projects: { id: 'p1', name: '東京ガスLPディレクション', clients: { id: 'c1', name: '東京ガス' } } },
  }],
  system_settings: [],
  users: [{ id: 'u1', business_type: 'individual', role: 'director' }],
};
function mockBuilder(table) {
  let op = 'select'; let payload = null;
  const result = () => {
    if (op === 'insert') {
      mockInserted.push({ table, payload });
      if (table === 'invoices' && payload.project_id == null) {
        return { data: null, error: { message: 'null value in column "project_id" of relation "invoices" violates not-null constraint' } };
      }
      return { data: table === 'invoices' ? { id: 'inv1', invoice_number: payload.invoice_number } : null, error: null };
    }
    return { data: mockTables[table] || [], error: null, count: 0 };
  };
  const b = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'then') return (res, rej) => Promise.resolve(result()).then(res, rej);
      if (prop === 'insert') return (p) => { op = 'insert'; payload = p; return b; };
      if (prop === 'single' || prop === 'maybeSingle') return async () => {
        const r = result();
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

test('月額定額だけで請求書エディタの下書きが作れる', async () => {
  const r = await fetch(base + '/invoice-editor/drafts', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ year: 2026, month: 10, installment_keys: ['inst1'] }),
  });
  const body = await r.json();
  expect(r.status).toBe(200);
  expect(mockInserted.find(i => i.table === 'invoices').payload.project_id).toBe('p1');
});
