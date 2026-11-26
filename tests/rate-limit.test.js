// アクセス回数制限（utils/rate-limit.js）のテスト。
// 本物の express に server.js と同じ trust proxy 1 で載せ、上限だけ小さくして確かめる。

const express = require('express');
const rl = require('../utils/rate-limit');

let server;
let base;
const sessions = new Map(); // X-Test-Session → 疑似セッション
const calls = [];           // onLimit から既存経路へ渡された引数

beforeAll(async () => {
  const app = express();
  app.set('trust proxy', 1); // server.js と同じ
  app.use(express.json());
  // テスト用: X-Test-User があればログイン済み、X-Test-Session でセッションを共有
  app.use((req, _res, next) => {
    if (req.get('x-test-user')) req.user = { id: req.get('x-test-user') };
    const sid = req.get('x-test-session');
    if (sid) { if (!sessions.has(sid)) sessions.set(sid, {}); req.session = sessions.get(sid); }
    next();
  });

  const login = rl.createLoginRateLimit({ limit: 3 });
  const reauthPw = rl.createReauthPasswordRateLimit({ limit: 2 });
  const google = rl.createGoogleLoginRateLimit({
    limit: 2,
    onLimit: rl.buildGoogleLoginOnLimit({
      loginFail: (res, code, next) => { calls.push({ kind: 'loginFail', code, next }); res.redirect(`/login.html?error=${code}`); },
      reauthRedirect: (res, next, params) => { calls.push({ kind: 'reauth', next, params }); res.redirect('/haruka.html?reauth_error=' + params.reauth_error); },
      verifyState: (state) => (state === 'good' ? { next: '/haruka.html?page=payout' } : null),
    }),
  });
  app.post('/auth/login', login, (req, res) => (req.body?.ok ? res.json({ ok: true }) : res.status(401).json({ error: 'ng' })));
  app.post('/auth/reauth-password', (req, res, next) => (req.user ? next() : res.status(401).end()), reauthPw, (_req, res) => res.status(401).json({ error: 'ng' }));
  app.get('/auth/google', google, (_req, res) => res.json({ ok: true }));
  app.get('/auth/google/reauth', google, (_req, res) => res.json({ ok: true }));
  app.get('/auth/google/callback', google, (_req, res) => res.json({ ok: true }));
  app.get('/api/haruka/creatives', (_req, res) => res.json({ ok: true }));

  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise((r) => server.close(r)));
beforeEach(() => { calls.length = 0; });

const call = (path, { method = 'GET', xff, user, session, body } = {}) => fetch(base + path, {
  method,
  redirect: 'manual',
  headers: {
    'content-type': 'application/json',
    ...(xff ? { 'x-forwarded-for': xff } : {}),
    ...(user ? { 'x-test-user': user } : {}),
    ...(session ? { 'x-test-session': session } : {}),
  },
  body: method === 'POST' ? JSON.stringify(body || {}) : undefined,
});

describe('ログインの回数制限（IP ごと）', () => {
  test('失敗が上限までは通り、超えると 429 と日本語メッセージ', async () => {
    const ip = '203.0.113.10';
    for (let i = 0; i < 3; i++) expect((await call('/auth/login', { method: 'POST', xff: ip })).status).toBe(401);
    const res = await call('/auth/login', { method: 'POST', xff: ip });
    expect(res.status).toBe(429);
    const data = await res.json();
    expect(data.error).toBe(rl.RATE_LIMIT_MESSAGE);
    expect(data.error).toMatch(/しばらく待ってから/);
    expect(data.code).toBe('rate_limited');
    expect(data.retry_after_sec).toBeGreaterThan(0);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  test('成功したログインは数えない（同じ Wi-Fi から大勢が入っても枠を食わない）', async () => {
    const ip = '203.0.113.11';
    for (let i = 0; i < 10; i++) expect((await call('/auth/login', { method: 'POST', xff: ip, body: { ok: true } })).status).toBe(200);
    expect((await call('/auth/login', { method: 'POST', xff: ip })).status).toBe(401);
  });

  test('X-Forwarded-For の先頭を書き換えても別人扱いにならない（直前のプロキシが付けた末尾の値で数える）', async () => {
    const edge = '203.0.113.20';
    for (let i = 0; i < 3; i++) {
      expect((await call('/auth/login', { method: 'POST', xff: `10.0.0.${i}, ${edge}` })).status).toBe(401);
    }
    expect((await call('/auth/login', { method: 'POST', xff: `10.0.0.99, ${edge}` })).status).toBe(429);
  });

  test('別の IP は別に数える', async () => {
    expect((await call('/auth/login', { method: 'POST', xff: '203.0.113.30' })).status).toBe(401);
  });
});

describe('パスワード再認証の回数制限（ユーザーごと・IP 共有枠とは別）', () => {
  test('同じ IP でも別ユーザーは別に数える', async () => {
    const ip = '203.0.113.40';
    for (let i = 0; i < 2; i++) expect((await call('/auth/reauth-password', { method: 'POST', xff: ip, user: 'a1' })).status).toBe(401);
    expect((await call('/auth/reauth-password', { method: 'POST', xff: ip, user: 'a1' })).status).toBe(429);
    expect((await call('/auth/reauth-password', { method: 'POST', xff: ip, user: 'a2' })).status).toBe(401);
    // ログインの IP 枠も食っていない
    expect((await call('/auth/login', { method: 'POST', xff: ip })).status).toBe(401);
  });
});

describe('Google ログインの回数制限', () => {
  test('通常ログインは loginFail に next を渡し、進行中の状態を消す', async () => {
    const ip = '198.51.100.1';
    sessions.set('s1', { googleLoginNonce: 'n', googleReauthUserId: 'leftover' });
    for (let i = 0; i < 2; i++) expect((await call('/auth/google', { xff: ip })).status).toBe(200);
    const res = await call('/auth/google?next=%2Fharuka.html%3Fcreative%3D1', { xff: ip, session: 's1' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login.html?error=rate_limited');
    // /auth/google はセッションに再認証の印が残っていても再認証扱いにしない
    expect(calls).toEqual([{ kind: 'loginFail', code: 'rate_limited', next: '/haruka.html?creative=1' }]);
    expect(sessions.get('s1')).toEqual({});
  });

  test('再認証は reauthRedirect に req.query.next を渡す', async () => {
    const ip = '198.51.100.2';
    for (let i = 0; i < 2; i++) await call('/auth/google/reauth', { xff: ip });
    const res = await call('/auth/google/reauth?next=%2Fharuka.html%3Fpage%3Dpayout', { xff: ip });
    expect(res.status).toBe(302);
    expect(calls).toEqual([{ kind: 'reauth', next: '/haruka.html?page=payout', params: { reauth_error: 'rate_limited' } }]);
  });

  test('戻り（callback）は検証済み state の next を使い、再認証中なら reauthRedirect', async () => {
    const ip = '198.51.100.3';
    for (let i = 0; i < 2; i++) await call('/auth/google/callback', { xff: ip });
    sessions.set('s2', { googleLoginNonce: 'n', googleReauthUserId: 'u1' });
    await call('/auth/google/callback?state=good&next=%2Fevil', { xff: ip, session: 's2' });
    expect(calls).toEqual([{ kind: 'reauth', next: '/haruka.html?page=payout', params: { reauth_error: 'rate_limited' } }]);
    expect(sessions.get('s2')).toEqual({});
    calls.length = 0;
    await call('/auth/google/callback?state=bad&next=%2Fharuka.html%3Fx', { xff: ip });
    expect(calls).toEqual([{ kind: 'loginFail', code: 'rate_limited', next: undefined }]);
  });
});

describe('振込 onLimit（銀行接続の判定）', () => {
  const handler = (opts) => rl.buildBankOnLimit({
    redirectBack: (res, next, params) => res.out = { next, params },
    verifyState: (s) => (s === 'good' ? { next: '/haruka.html?page=payout&x=1' } : null),
  })(opts.req, opts.res, 60000);
  const fakeRes = () => ({ headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });

  test.each([
    ['/connect', { next: '/haruka.html?page=payout' }, '/haruka.html?page=payout'],
    ['/connect/', { next: '/haruka.html?page=payout' }, '/haruka.html?page=payout'],
    ['/callback', { state: 'good', next: '/evil' }, '/haruka.html?page=payout&x=1'],
  ])('GET /bank%s は redirectBack', (p, query, expected) => {
    const res = fakeRes();
    handler({ req: { method: 'GET', baseUrl: '/api/haruka/admin/bank', path: p, query }, res });
    expect(res.out).toEqual({ next: expected, params: { bank_error: 'rate_limited' } });
  });

  test('それ以外は JSON の 429', () => {
    const res = fakeRes();
    handler({ req: { method: 'GET', baseUrl: '/api/haruka/admin/bank', path: '/connection', query: {} }, res });
    expect(res.code).toBe(429);
    expect(res.body.code).toBe('rate_limited');
  });
});

describe('既定の上限（普通の使い方では届かない緩さ）', () => {
  test('値', () => {
    expect(rl.LIMITS.login).toEqual({ windowMs: 15 * 60 * 1000, limit: 100 });
    expect(rl.LIMITS.reauthPw).toEqual({ windowMs: 15 * 60 * 1000, limit: 30 });
    expect(rl.LIMITS.googleLogin).toEqual({ windowMs: 15 * 60 * 1000, limit: 200 });
    expect(rl.LIMITS.bank).toEqual({ windowMs: 60 * 1000, limit: 60 });
  });

  test('IP の鍵: IPv4 射影を外し、IPv6 は /64 でまとめる', () => {
    expect(rl.ipKey({ ip: '::ffff:203.0.113.5' })).toBe('ip:203.0.113.5');
    expect(rl.ipKey({ ip: '2001:db8:abcd:1200::1' })).toBe(rl.ipKey({ ip: '2001:db8:abcd:1200:ffff::2' }));
    expect(rl.ipKey({ ip: '2001:db8:abcd:1200::1' })).not.toBe(rl.ipKey({ ip: '2001:db8:abcd:1201::1' }));
    expect(rl.userKey({ user: { id: 7 }, ip: '1.2.3.4' })).toBe('u:7');
    expect(rl.userKey({ ip: '1.2.3.4' })).toBe('ip:1.2.3.4');
  });

  test('ログイン系以外の API には掛けていない', async () => {
    for (let i = 0; i < 20; i++) expect((await call('/api/haruka/creatives', { xff: '203.0.113.10' })).status).toBe(200);
  });
});
