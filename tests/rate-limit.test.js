// アクセス回数制限（utils/rate-limit.js）のテスト。
// 本物の express に server.js と同じ trust proxy 1 で載せ、上限だけ小さくして確かめる。

const express = require('express');
const rl = require('../utils/rate-limit');

let server;
let base;

beforeAll(async () => {
  const app = express();
  app.set('trust proxy', 1); // server.js と同じ
  app.use(express.json());
  // テスト用: X-Test-User があればログイン済みとみなす
  app.use((req, _res, next) => { if (req.get('x-test-user')) req.user = { id: req.get('x-test-user') }; next(); });

  const login = rl.createLoginRateLimit({ limit: 3 });
  const google = rl.createGoogleLoginRateLimit({ limit: 2 });
  app.post('/auth/login', login, (_req, res) => res.json({ ok: true }));
  app.get('/auth/google', google, (_req, res) => res.json({ ok: true }));
  app.get('/auth/google/reauth', google, (_req, res) => res.json({ ok: true }));

  // routes/bank-transfer.js と同じ掛け方（PATHS だけ）。/admin/payouts は素通りして別ルーターへ
  const bank = express.Router();
  bank.use(['/bank', '/payouts/transfer'], rl.createBankRateLimit({ limit: 2 }));
  bank.get('/bank/connection', (_req, res) => res.json({ ok: true }));
  bank.get('/bank/connect', (_req, res) => res.json({ ok: true }));
  bank.post('/payouts/transfer/preview', (_req, res) => res.json({ ok: true }));
  app.use('/api/haruka/admin', bank);
  app.get('/api/haruka/admin/payouts', (_req, res) => res.json({ ok: true }));
  app.get('/api/haruka/creatives', (_req, res) => res.json({ ok: true }));

  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise((r) => server.close(r)));

const call = (path, { method = 'GET', xff, user } = {}) => fetch(base + path, {
  method,
  redirect: 'manual',
  headers: {
    'content-type': 'application/json',
    ...(xff ? { 'x-forwarded-for': xff } : {}),
    ...(user ? { 'x-test-user': user } : {}),
  },
  body: method === 'POST' ? '{}' : undefined,
});

describe('ログインの回数制限（IP ごと）', () => {
  test('上限までは通り、超えると 429 と日本語メッセージ', async () => {
    const ip = '203.0.113.10';
    for (let i = 0; i < 3; i++) expect((await call('/auth/login', { method: 'POST', xff: ip })).status).toBe(200);
    const res = await call('/auth/login', { method: 'POST', xff: ip });
    expect(res.status).toBe(429);
    const data = await res.json();
    expect(data.error).toBe(rl.RATE_LIMIT_MESSAGE);
    expect(data.error).toMatch(/しばらく待ってから/);
    expect(data.code).toBe('rate_limited');
    expect(data.retry_after_sec).toBeGreaterThan(0);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  test('X-Forwarded-For の先頭を書き換えても別人扱いにならない（直前のプロキシが付けた末尾の値で数える）', async () => {
    const edge = '203.0.113.20';
    for (let i = 0; i < 3; i++) {
      expect((await call('/auth/login', { method: 'POST', xff: `10.0.0.${i}, ${edge}` })).status).toBe(200);
    }
    expect((await call('/auth/login', { method: 'POST', xff: `10.0.0.99, ${edge}` })).status).toBe(429);
  });

  test('別の IP は別に数える', async () => {
    expect((await call('/auth/login', { method: 'POST', xff: '203.0.113.30' })).status).toBe(200);
  });
});

describe('Google ログインの回数制限', () => {
  test('超えたらログイン画面へエラーコード付きで戻す', async () => {
    const ip = '198.51.100.1';
    for (let i = 0; i < 2; i++) expect((await call('/auth/google', { xff: ip })).status).toBe(200);
    const res = await call('/auth/google', { xff: ip });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login.html?error=rate_limited');
  });

  test('再認証は振込管理へ戻す', async () => {
    const ip = '198.51.100.2';
    for (let i = 0; i < 2; i++) await call('/auth/google/reauth', { xff: ip });
    const res = await call('/auth/google/reauth', { xff: ip });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/haruka.html?page=payout&reauth_error=rate_limited');
  });
});

describe('振込操作の回数制限（ユーザーごと）', () => {
  test('超えると 429、別ユーザーは影響なし', async () => {
    for (let i = 0; i < 2; i++) expect((await call('/api/haruka/admin/payouts/transfer/preview', { method: 'POST', user: 'admin1' })).status).toBe(200);
    const res = await call('/api/haruka/admin/bank/connection', { user: 'admin1' });
    expect(res.status).toBe(429);
    expect((await res.json()).error).toMatch(/しばらく待ってから/);
    expect((await call('/api/haruka/admin/bank/connection', { user: 'admin2' })).status).toBe(200);
  });

  test('銀行接続（画面遷移）は振込管理へ戻す', async () => {
    for (let i = 0; i < 2; i++) await call('/api/haruka/admin/bank/connect', { user: 'admin3' });
    const res = await call('/api/haruka/admin/bank/connect', { user: 'admin3' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/haruka.html?page=payout&bank_error=rate_limited');
  });

  test('振込以外の /admin/payouts や他の API には掛からない', async () => {
    for (let i = 0; i < 10; i++) {
      expect((await call('/api/haruka/admin/payouts', { user: 'admin1', xff: '203.0.113.10' })).status).toBe(200);
      expect((await call('/api/haruka/creatives', { user: 'admin1', xff: '203.0.113.10' })).status).toBe(200);
    }
  });
});

describe('既定の上限（普通の使い方では届かない緩さ）', () => {
  test('値', () => {
    expect(rl.LIMITS.login).toEqual({ windowMs: 15 * 60 * 1000, limit: 100 });
    expect(rl.LIMITS.googleLogin).toEqual({ windowMs: 15 * 60 * 1000, limit: 200 });
    expect(rl.LIMITS.bank).toEqual({ windowMs: 60 * 1000, limit: 60 });
  });

  test('IP の鍵: IPv4 射影を外し、IPv6 は /56 でまとめる', () => {
    expect(rl.ipKey({ ip: '::ffff:203.0.113.5' })).toBe('ip:203.0.113.5');
    expect(rl.ipKey({ ip: '2001:db8:abcd:1200::1' })).toBe(rl.ipKey({ ip: '2001:db8:abcd:12ff::2' }));
    expect(rl.userKey({ user: { id: 7 }, ip: '1.2.3.4' })).toBe('u:7');
    expect(rl.userKey({ ip: '1.2.3.4' })).toBe('ip:1.2.3.4');
  });
});
