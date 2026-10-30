const {
  createLoginGuard,
  normalizeEmail,
  normalizeIp,
  extractClientIp,
  resolveLoginInput,
  MAX_FAILURES,
  LOCK_MS,
  LOCK_MESSAGE,
  MAX_CONCURRENT,
  BUSY_MESSAGE,
  ATTEMPT_TTL_MS,
} = require('../utils/login-guard');

function makeGuard(opts = {}) {
  let t = 1_000_000;
  const clock = {
    now: () => t,
    advance(ms) { t += ms; },
  };
  const guard = createLoginGuard({ now: clock.now, ...opts });
  return { guard, clock };
}

describe('login-guard: 正規化', () => {
  test('normalizeEmail は前後空白を落とし小文字化、空なら null', () => {
    expect(normalizeEmail('  Foo@Example.COM ')).toBe('foo@example.com');
    expect(normalizeEmail('')).toBeNull();
    expect(normalizeEmail('   ')).toBeNull();
    expect(normalizeEmail(null)).toBeNull();
    expect(normalizeEmail(123)).toBeNull();
  });

  test('normalizeIp は ::ffff: ラップの IPv4 をほどく', () => {
    expect(normalizeIp('::ffff:203.0.113.5')).toBe('203.0.113.5');
    expect(normalizeIp(' 198.51.100.7 ')).toBe('198.51.100.7');
    expect(normalizeIp('')).toBeNull();
    expect(normalizeIp(undefined)).toBeNull();
  });

  test('extractClientIp は x-forwarded-for の先頭を優先し、無ければ req.ip', () => {
    expect(extractClientIp({ headers: { 'x-forwarded-for': '203.0.113.5, 10.0.0.1' }, ip: '10.0.0.9' })).toBe('203.0.113.5');
    expect(extractClientIp({ headers: { 'x-forwarded-for': ['::ffff:203.0.113.6'] }, ip: '10.0.0.9' })).toBe('203.0.113.6');
    expect(extractClientIp({ headers: {}, ip: '::ffff:192.0.2.1' })).toBe('192.0.2.1');
    expect(extractClientIp({ headers: {} })).toBeNull();
  });

  test('定数', () => {
    expect(MAX_FAILURES).toBe(5);
    expect(LOCK_MS).toBe(15 * 60 * 1000);
    expect(LOCK_MESSAGE).toContain('15分');
  });
});

describe('login-guard: 失敗カウントとロック', () => {
  test('4 回までは失敗してもロックされない', () => {
    const { guard } = makeGuard();
    const id = { email: 'a@example.com', ip: '203.0.113.5' };
    for (let i = 1; i <= 4; i++) {
      const r = guard.recordFailure(id);
      expect(r.locked).toBe(false);
      expect(r.lockedNow).toBe(false);
      expect(r.failures).toBe(i);
    }
    expect(guard.check(id).locked).toBe(false);
  });

  test('5 回目の失敗でロック（lockedNow=true・retry_after は 15 分）', () => {
    const { guard } = makeGuard();
    const id = { email: 'a@example.com', ip: '203.0.113.5' };
    for (let i = 0; i < 4; i++) guard.recordFailure(id);
    const r = guard.recordFailure(id);
    expect(r.locked).toBe(true);
    expect(r.lockedNow).toBe(true);
    expect(r.retryAfterSec).toBe(15 * 60);
    expect(r.lockedKeys.sort()).toEqual(['email:a@example.com', 'ip:203.0.113.5']);
    const c = guard.check(id);
    expect(c.locked).toBe(true);
    expect(c.retryAfterSec).toBe(15 * 60);
  });

  test('ロック中は retry_after が減っていき、15 分経てば解除されカウンタも 0 から', () => {
    const { guard, clock } = makeGuard();
    const id = { email: 'a@example.com', ip: '203.0.113.5' };
    for (let i = 0; i < 5; i++) guard.recordFailure(id);
    clock.advance(10 * 60 * 1000);
    expect(guard.check(id)).toMatchObject({ locked: true, retryAfterSec: 5 * 60 });
    clock.advance(5 * 60 * 1000);
    expect(guard.check(id).locked).toBe(false);
    // 解除後の 1 回目はまた failures=1 から
    expect(guard.recordFailure(id).failures).toBe(1);
  });

  test('成功でカウンタがリセットされる', () => {
    const { guard } = makeGuard();
    const id = { email: 'a@example.com', ip: '203.0.113.5' };
    for (let i = 0; i < 4; i++) guard.recordFailure(id);
    guard.recordSuccess(id);
    expect(guard.size()).toBe(0);
    const r = guard.recordFailure(id);
    expect(r.failures).toBe(1);
    expect(r.locked).toBe(false);
  });

  test('メールは大文字小文字・前後空白を区別しない', () => {
    const { guard } = makeGuard();
    for (let i = 0; i < 4; i++) guard.recordFailure({ email: 'A@Example.com', ip: `10.0.0.${i}` });
    const r = guard.recordFailure({ email: '  a@example.com ', ip: '10.0.0.99' });
    expect(r.locked).toBe(true);
    expect(r.lockedKeys).toEqual(['email:a@example.com']);
  });

  test('同一 IP から別メールを 5 回試しても IP でロックされる（存在しないメールも同じ扱い）', () => {
    const { guard } = makeGuard();
    const ip = '203.0.113.9';
    for (let i = 0; i < 4; i++) {
      expect(guard.recordFailure({ email: `nobody${i}@example.com`, ip }).locked).toBe(false);
    }
    const r = guard.recordFailure({ email: 'nobody4@example.com', ip });
    expect(r.locked).toBe(true);
    expect(r.lockedKeys).toEqual([`ip:${ip}`]);
    // 以後その IP からは、どのメールでもロック中
    expect(guard.check({ email: 'someone-else@example.com', ip }).locked).toBe(true);
    // 別 IP の同メールはロックされていない
    expect(guard.check({ email: 'someone-else@example.com', ip: '198.51.100.1' }).locked).toBe(false);
  });

  test('同一メールを別 IP から 5 回試してもメールでロックされる', () => {
    const { guard } = makeGuard();
    const email = 'target@example.com';
    for (let i = 0; i < 4; i++) guard.recordFailure({ email, ip: `198.51.100.${i}` });
    const r = guard.recordFailure({ email, ip: '198.51.100.50' });
    expect(r.locked).toBe(true);
    expect(r.lockedKeys).toEqual([`email:${email}`]);
    expect(guard.check({ email, ip: '192.0.2.77' }).locked).toBe(true);
  });

  test('IP ロック中に成功しても、別のメールのロックは解けない（鍵単位でしか消さない）', () => {
    const { guard } = makeGuard();
    for (let i = 0; i < 5; i++) guard.recordFailure({ email: 'victim@example.com', ip: `10.1.1.${i}` });
    guard.recordSuccess({ email: 'other@example.com', ip: '10.1.1.0' });
    expect(guard.check({ email: 'victim@example.com', ip: '10.9.9.9' }).locked).toBe(true);
  });

  test('失敗が 15 分以上離れていれば「連続」とみなさない', () => {
    const { guard, clock } = makeGuard();
    const id = { email: 'slow@example.com', ip: '203.0.113.1' };
    for (let i = 0; i < 4; i++) guard.recordFailure(id);
    clock.advance(LOCK_MS);
    const r = guard.recordFailure(id);
    expect(r.failures).toBe(1);
    expect(r.locked).toBe(false);
  });

  test('ロック中にさらに失敗を記録しても lockedNow は立たず、ロック期限は延びない', () => {
    const { guard, clock } = makeGuard();
    const id = { email: 'a@example.com', ip: '203.0.113.5' };
    for (let i = 0; i < 5; i++) guard.recordFailure(id);
    clock.advance(60 * 1000);
    const r = guard.recordFailure(id);
    expect(r.locked).toBe(true);
    expect(r.lockedNow).toBe(false);
    expect(r.retryAfterSec).toBe(14 * 60);
  });

  test('メールも IP も無いときは何もしない', () => {
    const { guard } = makeGuard();
    expect(guard.recordFailure({})).toMatchObject({ locked: false, failures: 0 });
    expect(guard.check({}).locked).toBe(false);
    expect(guard.size()).toBe(0);
  });

  test('maxFailures / lockMs は差し替えられる', () => {
    const { guard, clock } = makeGuard({ maxFailures: 2, lockMs: 1000 });
    const id = { email: 'x@example.com', ip: '1.1.1.1' };
    guard.recordFailure(id);
    expect(guard.recordFailure(id).lockedNow).toBe(true);
    expect(guard.check(id).retryAfterSec).toBe(1);
    clock.advance(1000);
    expect(guard.check(id).locked).toBe(false);
  });
});

describe('login-guard: resolveLoginInput（query 経由のメールも同じ鍵で見る）', () => {
  test('body にあれば body、無ければ query から拾い、query 側は消す', () => {
    const req = { body: {}, query: { email: 'Q@Example.com', password: 'pw', next: '/x' } };
    const r = resolveLoginInput(req);
    expect(r.ok).toBe(true);
    expect(r.email).toBe('Q@Example.com');       // 照合用は入力のまま（既存の完全一致検索を変えない）
    expect(r.guardEmail).toBe('q@example.com');  // ロック鍵は正規化
    expect(req.body).toEqual({ email: 'Q@Example.com', password: 'pw' });
    expect(req.query).toEqual({ next: '/x' });
  });

  test('body と query の両方にあれば body が勝つ（passport-local と同じ順）', () => {
    const req = { body: { email: 'b@example.com', password: 'bp' }, query: { email: 'q@example.com', password: 'qp' } };
    const r = resolveLoginInput(req);
    expect(r.guardEmail).toBe('b@example.com');
    expect(req.body.password).toBe('bp');
    expect(req.query.email).toBeUndefined();
  });

  test('メールやパスワードが無い・文字列でないときは ok=false（照合に進ませない）', () => {
    expect(resolveLoginInput({ body: {}, query: {} }).ok).toBe(false);
    expect(resolveLoginInput({ body: { email: 'a@example.com' } }).ok).toBe(false);
    expect(resolveLoginInput({ body: { email: ['a@example.com'], password: 'x' } }).ok).toBe(false);
    expect(resolveLoginInput({ body: { email: '   ', password: 'x' } }).ok).toBe(false);
    expect(resolveLoginInput({}).ok).toBe(false);
  });

  test('query 経由のメールでも 5 回失敗でアカウント単位にロックされる', () => {
    const { guard } = makeGuard();
    const ip = () => `198.51.100.${Math.floor(Math.random() * 200)}`;
    for (let i = 0; i < 5; i++) {
      const req = { body: {}, query: { email: 'Victim@Example.com', password: 'wrong' } };
      const input = resolveLoginInput(req);
      const ident = { email: input.guardEmail, ip: ip() };
      const a = guard.beginAttempt(ident);
      expect(a.allowed).toBe(true);
      guard.endAttempt(ident);
      guard.recordFailure(ident);
    }
    // body 経由・別 IP で来ても同じ鍵なのでロック中
    const req2 = { body: { email: 'victim@example.com', password: 'right' }, query: {} };
    const input2 = resolveLoginInput(req2);
    const a = guard.beginAttempt({ email: input2.guardEmail, ip: '192.0.2.200' });
    expect(a).toMatchObject({ allowed: false, reason: 'locked', retryAfterSec: 15 * 60 });
  });
});

describe('login-guard: 同時リクエスト（beginAttempt / endAttempt）', () => {
  test('定数', () => {
    expect(MAX_CONCURRENT).toBe(2);
    expect(BUSY_MESSAGE).toBeTruthy();
    expect(ATTEMPT_TTL_MS).toBe(30 * 1000);
  });

  test('同一メールに並列 40 件 → 照合に進むのは maxConcurrent 件まで、残りは busy', () => {
    const { guard } = makeGuard();
    const results = [];
    for (let i = 0; i < 40; i++) {
      results.push(guard.beginAttempt({ email: 'target@example.com', ip: `203.0.113.${i}` }));
    }
    const allowed = results.filter(r => r.allowed);
    expect(allowed).toHaveLength(MAX_CONCURRENT);
    expect(results.filter(r => !r.allowed).every(r => r.reason === 'busy' && r.retryAfterSec > 0)).toBe(true);
    expect(guard.inFlightOf('email:target@example.com')).toBe(MAX_CONCURRENT);
  });

  test('同一 IP から別メールを並列 40 件 → 照合に進むのは maxConcurrent 件まで', () => {
    const { guard } = makeGuard();
    const results = [];
    for (let i = 0; i < 40; i++) {
      results.push(guard.beginAttempt({ email: `nobody${i}@example.com`, ip: '203.0.113.77' }));
    }
    expect(results.filter(r => r.allowed)).toHaveLength(MAX_CONCURRENT);
    expect(results.find(r => !r.allowed).key).toBe('ip:203.0.113.77');
  });

  test('失敗数 + 照合中 が 5 に達した分は照合に進めない（4 回失敗後は同時 1 件だけ）', () => {
    const { guard } = makeGuard();
    const email = 'target@example.com';
    for (let i = 0; i < 4; i++) guard.recordFailure({ email, ip: `10.0.0.${i}` });
    const results = [];
    for (let i = 0; i < 40; i++) results.push(guard.beginAttempt({ email, ip: `203.0.113.${i}` }));
    expect(results.filter(r => r.allowed)).toHaveLength(1);
    // その 1 件が失敗すれば 5 回目 → ロック
    const ident = { email, ip: '203.0.113.0' };
    guard.endAttempt(ident);
    expect(guard.recordFailure(ident).lockedNow).toBe(true);
    expect(guard.beginAttempt({ email, ip: '192.0.2.1' })).toMatchObject({ allowed: false, reason: 'locked' });
  });

  test('endAttempt で予約が返り、次の試行が通る。失敗もロックも無い鍵は残さない', () => {
    const { guard } = makeGuard();
    const a = { email: 'a@example.com', ip: '10.0.0.1' };
    const b = { email: 'a@example.com', ip: '10.0.0.2' };
    const c = { email: 'a@example.com', ip: '10.0.0.3' };
    expect(guard.beginAttempt(a).allowed).toBe(true);
    expect(guard.beginAttempt(b).allowed).toBe(true);
    expect(guard.beginAttempt(c).allowed).toBe(false);
    guard.endAttempt(a);
    expect(guard.beginAttempt(c).allowed).toBe(true);
    guard.endAttempt(b);
    guard.endAttempt(c);
    expect(guard.size()).toBe(0);
  });

  test('endAttempt が呼ばれなくても 30 秒で予約は無かったことになる（ハング対策）', () => {
    const { guard, clock } = makeGuard();
    const email = 'a@example.com';
    expect(guard.beginAttempt({ email, ip: '10.0.0.1' }).allowed).toBe(true);
    expect(guard.beginAttempt({ email, ip: '10.0.0.2' }).allowed).toBe(true);
    expect(guard.beginAttempt({ email, ip: '10.0.0.3' }).allowed).toBe(false);
    clock.advance(ATTEMPT_TTL_MS);
    expect(guard.beginAttempt({ email, ip: '10.0.0.3' }).allowed).toBe(true);
  });

  test('照合中の予約は失敗カウントの連続判定を壊さない（成功でまとめて消える）', () => {
    const { guard } = makeGuard();
    const ident = { email: 'a@example.com', ip: '10.0.0.1' };
    for (let i = 0; i < 3; i++) { guard.beginAttempt(ident); guard.endAttempt(ident); guard.recordFailure(ident); }
    expect(guard.beginAttempt(ident).allowed).toBe(true);
    guard.endAttempt(ident);
    guard.recordSuccess(ident);
    expect(guard.size()).toBe(0);
    expect(guard.recordFailure(ident).failures).toBe(1);
  });

  test('ロック中は beginAttempt が locked を返し、予約は増えない', () => {
    const { guard } = makeGuard();
    const ident = { email: 'a@example.com', ip: '10.0.0.1' };
    for (let i = 0; i < 5; i++) guard.recordFailure(ident);
    const r = guard.beginAttempt(ident);
    expect(r).toMatchObject({ allowed: false, reason: 'locked', retryAfterSec: 15 * 60 });
    expect(guard.inFlightOf('email:a@example.com')).toBe(0);
  });
});
