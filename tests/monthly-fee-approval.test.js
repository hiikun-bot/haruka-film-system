// 月額定額（ADR 053）× 単価承認（ADR 037）の結合テスト。supabase はメモリ上の小さな偽 DB。
//   - 差し戻すと各月の分割行（請求・集計に使う金額）も最後に承認された値へ戻る
//   - 承認待ちの分割行は請求書（旧方式・請求書エディタ）にできない
//   - 承認権限なしで月額を 0 円（解除）にすると、消さずに承認待ちになる → 差し戻しで戻る
//   - 案件の無い明細だけの請求書: project_id NOT NULL の DB では分かる文言の 400、外した DB では作れる

const mockDb = { tables: {}, notNullInvoiceProject: true, seq: 0 };
function mockReset() {
  mockDb.seq = 0;
  mockDb.notNullInvoiceProject = true;
  mockDb.tables = {
    projects: [{ id: 'p1', name: '定額案件', client_id: 'c1' }],
    clients: [{ id: 'c1', name: 'クライアントA' }],
    users: [
      { id: 'admin1', full_name: '管理者', nickname: 'かんり', role: 'admin', business_type: 'corporation' },
      { id: 'd1', full_name: 'ディレクター', nickname: 'でぃれ', role: 'director', business_type: 'individual' },
    ],
    roles: [{ id: 'r-dir', code: 'director' }],
    project_estimate_lines: [],
    project_estimate_line_costs: [],
    line_payment_installments: [],
    creatives: [],
    invoices: [],
    invoice_items: [],
    work_hour_entries: [],
    system_settings: [],
  };
}
mockReset();

function mockEmbed(table, row) {
  const t = mockDb.tables;
  if (table === 'line_payment_installments') {
    const line = t.project_estimate_lines.find(l => l.id === row.line_id) || null;
    const proj = line && t.projects.find(p => p.id === line.project_id);
    return { ...row, line: line && { ...line, projects: proj ? { ...proj, clients: t.clients.find(c => c.id === proj.client_id) || null } : null } };
  }
  if (table === 'project_estimate_lines') {
    return {
      ...row,
      line_costs: t.project_estimate_line_costs.filter(c => c.line_id === row.id),
      installments: t.line_payment_installments.filter(i => i.line_id === row.id),
    };
  }
  if (table === 'work_hour_entries') return { ...row, projects: null };
  return row;
}

function mockBuilder(table) {
  const filters = [];
  let op = 'select'; let payload = null; let head = false; let orders = []; let lim = null;
  const rows = () => (mockDb.tables[table] || (mockDb.tables[table] = []));
  const match = () => rows().filter(r => filters.every(f => f(r)));
  const run = () => {
    if (op === 'insert' || op === 'upsert') {
      const list = (Array.isArray(payload) ? payload : [payload]).map(r => ({ ...r }));
      if (table === 'invoices' && mockDb.notNullInvoiceProject && list.some(r => r.project_id == null)) {
        return { data: null, error: { code: '23502', message: 'null value in column "project_id" of relation "invoices" violates not-null constraint' } };
      }
      const out = [];
      for (const r of list) {
        if (!r.id) r.id = `${table}-${++mockDb.seq}`;
        if (!r.created_at) r.created_at = new Date(Date.UTC(2026, 9, 1, 0, 0, mockDb.seq)).toISOString();
        const ex = rows().find(x => x.id === r.id);
        if (ex && op === 'upsert') Object.assign(ex, r); else rows().push(r);
        out.push(ex && op === 'upsert' ? ex : r);
      }
      return { data: Array.isArray(payload) ? out : out[0], error: null };
    }
    if (op === 'update') { const m = match(); m.forEach(r => Object.assign(r, payload)); return { data: m, error: null }; }
    if (op === 'delete') {
      const m = new Set(match());
      mockDb.tables[table] = rows().filter(r => !m.has(r));
      if (table === 'project_estimate_lines') {
        const ids = new Set([...m].map(r => r.id));
        mockDb.tables.line_payment_installments = mockDb.tables.line_payment_installments.filter(i => !ids.has(i.line_id));
        mockDb.tables.project_estimate_line_costs = mockDb.tables.project_estimate_line_costs.filter(c => !ids.has(c.line_id));
      }
      return { data: null, error: null };
    }
    let data = match().map(r => mockEmbed(table, r));
    for (const [col, asc] of [...orders].reverse()) {
      data = [...data].sort((a, b) => (String(a[col] ?? '') < String(b[col] ?? '') ? -1 : String(a[col] ?? '') > String(b[col] ?? '') ? 1 : 0) * (asc ? 1 : -1));
    }
    if (lim != null) data = data.slice(0, lim);
    return { data: head ? null : data, count: match().length, error: null };
  };
  const b = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'then') return (res, rej) => Promise.resolve(run()).then(res, rej);
      if (prop === 'select') return (_s, opts) => { if (opts?.head) head = true; return b; };
      if (prop === 'insert') return (p) => { op = 'insert'; payload = p; return b; };
      if (prop === 'upsert') return (p) => { op = 'upsert'; payload = p; return b; };
      if (prop === 'update') return (p) => { op = 'update'; payload = p; return b; };
      if (prop === 'delete') return () => { op = 'delete'; return b; };
      if (prop === 'eq') return (c, v) => { filters.push(r => r[c] === v); return b; };
      if (prop === 'neq') return (c, v) => { filters.push(r => r[c] !== v); return b; };
      if (prop === 'in') return (c, vs) => { filters.push(r => vs.includes(r[c])); return b; };
      if (prop === 'gte') return (c, v) => { filters.push(r => String(r[c]) >= String(v)); return b; };
      if (prop === 'lt') return (c, v) => { filters.push(r => String(r[c]) < String(v)); return b; };
      if (prop === 'order') return (c, o) => { orders.push([c, o?.ascending !== false]); return b; };
      if (prop === 'limit') return (n) => { lim = n; return b; };
      if (prop === 'single' || prop === 'maybeSingle') return async () => {
        const r = run();
        if (r.error) return r;
        return { ...r, data: Array.isArray(r.data) ? (r.data[0] || null) : r.data };
      };
      return () => b;
    },
  });
  return b;
}
jest.mock('../supabase', () => ({ from: (t) => mockBuilder(t), rpc: async () => ({ data: null, error: null }), storage: { from: () => ({}) } }));
jest.mock('../auth', () => {
  const who = (req) => req.headers['x-test-user'] || 'd1';
  const pass = (req, res, next) => { req.user = { id: who(req), role: who(req) === 'admin1' ? 'admin' : 'director' }; next(); };
  return {
    requireAuth: pass, requireRole: () => pass, requireLevel: () => pass, requirePermission: () => pass,
    requireAnyPermission: () => pass, requireSuperAdmin: pass, isSuperAdminUser: () => false,
    userHasPermission: async () => false, getEffectiveRole: async (req) => req.user.role,
    getEffectiveRoleCodes: async (req) => [req.user.role],
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
beforeEach(() => mockReset());

const call = async (method, path, body, user = 'd1') => {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-test-user': user }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const insts = () => mockDb.tables.line_payment_installments;
const line = () => mockDb.tables.project_estimate_lines[0];
// 今月〜（先月以前は書き換えない仕様なので、テストは未来の月で組む）
const START = '2030-01'; const END = '2030-03';
const setFee = (amount, user, extra = {}) => call('PUT', '/projects/p1/monthly-fee', { payee_user_id: 'd1', payment_amount: amount, start_month: START, end_month: END, ...extra }, user);

test('差し戻すと各月の分割行の金額も承認済みの値に戻る', async () => {
  expect((await setFee(30000, 'admin1', { client_amount: 50000 })).status).toBe(200);
  expect(line().pricing_approval).toBe('approved');
  expect(insts().map(i => i.payment_amount)).toEqual([30000, 30000, 30000]);

  const up = await setFee(90000, 'd1');
  expect(up.body.line_pricing_approval).toBe('pending');
  expect(insts().map(i => i.payment_amount)).toEqual([90000, 90000, 90000]);

  const rj = await call('POST', `/projects/p1/lines/${line().id}/pricing/reject`, { reason: '増額は不可' }, 'admin1');
  expect(rj.body.action).toBe('restored');
  expect(insts().map(i => i.payment_amount)).toEqual([30000, 30000, 30000]);
  expect(insts().map(i => i.client_amount)).toEqual([50000, 50000, 50000]);
  expect(mockDb.tables.project_estimate_line_costs[0].unit_price).toBe(30000);
});

test('承認待ちの月額定額は請求書にできず、作成画面にも承認待ちと出る', async () => {
  await setFee(30000, 'admin1');
  await setFee(90000, 'd1');
  const key = insts()[0].id;
  const ed = await call('POST', '/invoice-editor/drafts', { year: 2030, month: 1, installment_keys: [key] });
  expect(ed.status).toBe(400);
  expect(ed.body.code).toBe('PRICING_PENDING');
  expect(mockDb.tables.invoices).toHaveLength(0);

  const pv = await call('GET', '/invoices/preview-items?year=2030&month=1');
  const item = (Array.isArray(pv.body) ? pv.body : pv.body.items || []).find(i => i.installment_key === key);
  if (item) expect(item.pricing_pending).toBe(true);

  await call('POST', `/projects/p1/lines/${line().id}/pricing/approve`, {}, 'admin1');
  const ok = await call('POST', '/invoice-editor/drafts', { year: 2030, month: 1, installment_keys: [key] });
  expect(ok.status).toBe(200);
  expect(mockDb.tables.invoice_items[0].total_amount).toBe(90000);
});

test('承認権限なしの解除（0円）は承認待ちになり、差し戻すと消した月が戻る', async () => {
  await setFee(30000, 'admin1');
  const ids = insts().map(i => i.id);
  const rm = await setFee(0, 'd1');
  expect(rm.body.line_pricing_approval).toBe('pending');
  expect(line().pricing_approval).toBe('pending');
  expect(insts()).toHaveLength(0);

  await call('POST', `/projects/p1/lines/${line().id}/pricing/reject`, { reason: '解除しない' }, 'admin1');
  expect(insts().map(i => i.id).sort()).toEqual([...ids].sort());
  expect(insts().map(i => i.payment_amount)).toEqual([30000, 30000, 30000]);
});

test('承認権限ありの解除はこれまでどおりすぐ消える', async () => {
  await setFee(30000, 'admin1');
  const rm = await setFee(0, 'admin1');
  expect(rm.body.line_removed).toBe(true);
  expect(mockDb.tables.project_estimate_lines).toHaveLength(0);
});

test('案件の無い明細だけ: NOT NULL の DB では分かる文言の 400、外した DB では作れる', async () => {
  await setFee(30000, 'admin1');
  line().project_id = null; // 案件に紐づかない分割行の代わり（明細から project_id が決まらない状態）
  const key = insts()[0].id;
  const ng = await call('POST', '/invoice-editor/drafts', { year: 2030, month: 1, installment_keys: [key] });
  expect(ng.status).toBe(400);
  expect(ng.body.error).toMatch(/案件に紐づかない明細だけでは/);

  mockDb.notNullInvoiceProject = false;
  const ok = await call('POST', '/invoice-editor/drafts', { year: 2030, month: 1, installment_keys: [key] });
  expect(ok.status).toBe(200);
  expect(mockDb.tables.invoices[0].project_id).toBeNull();
});
