const {
  createLoginGuard,
  normalizeEmail,
  normalizeIp,
  extractClientIp,
  MAX_FAILURES,
  LOCK_MS,
  LOCK_MESSAGE,
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
