// 本物の routes/bank-transfer.js に掛けた回数制限のテスト（auth・DB・銀行 API はモック）。
// ユーザー単位で数えること、/admin/payouts など振込以外のパスには掛からないことを確かめる。

jest.mock('../supabase', () => ({}));
jest.mock('../auth', () => ({
  requireAuth: (req, res, next) => {
    const uid = req.get('x-test-user');
    if (!uid) return res.status(401).json({ error: 'not authenticated' });
    req.user = { id: uid, email: `${uid}@example.com` };
    next();
  },
  requirePermission: () => (_req, _res, next) => next(),
  requireSuperAdmin: (_req, _res, next) => next(),
}));
jest.mock('../utils/aozora-api', () => {
  const actual = jest.requireActual('../utils/aozora-api');
  return {
    ...actual,
    isEnabled: () => true,
    loadActiveConnection: async () => null,
    configProblems: () => [],
    getScopes: () => [],
  };
});

const express = require('express');
const { LIMITS } = require('../utils/rate-limit');

let server;
let base;

beforeAll(async () => {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use((req, _res, next) => { req.session = {}; next(); });
  app.use('/api/haruka/admin', require('../routes/bank-transfer'));
  // routes/bank-transfer.js を素通りした先（本番では harukaRouter の /admin/payouts*）
  app.get('/api/haruka/admin/payouts', (_req, res) => res.json({ ok: true, from: 'haruka' }));
  app.post('/api/haruka/admin/payouts/:id/pay', (_req, res) => res.json({ ok: true, from: 'haruka' }));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise((r) => server.close(r)));

const get = (path, user, method = 'GET') => fetch(base + path, {
  method,
  redirect: 'manual',
  headers: { 'x-forwarded-for': '203.0.113.50', ...(user ? { 'x-test-user': user } : {}) },
});

test('同じユーザーは 1 分に上限回数まで、超えると 429。同じ IP の別ユーザーは影響なし', async () => {
  const max = LIMITS.bank.limit;
  for (let i = 0; i < max; i++) {
    const res = await get('/api/haruka/admin/bank/connection', 'admin1');
    expect(res.status).toBe(200);
  }
  const over = await get('/api/haruka/admin/bank/connection', 'admin1');
  expect(over.status).toBe(429);
  const data = await over.json();
  expect(data.code).toBe('rate_limited');
  expect(data.error).toMatch(/しばらく待ってから/);
  // /payouts/transfer/* も同じ枠
  expect((await get('/api/haruka/admin/payouts/transfer/batches?year=2026&month=10', 'admin1')).status).toBe(429);
  // 銀行接続（画面遷移）は振込管理へ戻す。next は既存の検証（safeNext）を通る
  const conn = await get('/api/haruka/admin/bank/connect?next=%2Fharuka.html%3Fpage%3Dpayout', 'admin1');
  expect(conn.status).toBe(302);
  expect(conn.headers.get('location')).toBe('/haruka.html?page=payout&bank_error=rate_limited');
  const evil = await get('/api/haruka/admin/bank/connect?next=https%3A%2F%2Fevil.example%2F', 'admin1');
  expect(evil.headers.get('location')).toBe('/haruka.html?bank_error=rate_limited');
  // 別ユーザー
  expect((await get('/api/haruka/admin/bank/connection', 'admin2')).status).toBe(200);
});

test('振込以外の /admin/payouts* には掛からない（上限を使い切ったユーザーでも通る）', async () => {
  for (let i = 0; i < LIMITS.bank.limit + 20; i++) {
    expect((await get('/api/haruka/admin/payouts', 'admin1')).status).toBe(200);
  }
  expect((await get('/api/haruka/admin/payouts/abc/pay', 'admin1', 'POST')).status).toBe(200);
});
