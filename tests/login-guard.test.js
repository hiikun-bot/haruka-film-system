const {
  createLoginGuard,
  normalizeEmail,
  resolveLoginInput,
  LIMITS,
  MAX_FAILURES,
  IP_MAX_FAILURES,
  MAX_CONCURRENT,
  IP_MAX_CONCURRENT,
  SLOWDOWN_MS,
  LOCK_MS,
  LOCK_MESSAGE,
  BUSY_MESSAGE,
  ATTEMPT_TTL_MS,
  STORE_MAX_KEYS,
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

// 「照合に進んで失敗した」を 1 回分まとめて再現
function failOnce(guard, ident) {
  const a = guard.beginAttempt(ident);
  expect(a.allowed).toBe(true);
  guard.endAttempt(a.token);
  return guard.recordFailure(ident);
}

describe('login-guard: 定数・正規化', () => {
  test('しきい値（メール×IP=5 回 / IP=20 回 / 同時=メール 2・IP 10 / 減速 2 秒 / ロック 15 分）', () => {
    expect(MAX_FAILURES).toBe(5);
    expect(IP_MAX_FAILURES).toBe(20);
    expect(MAX_CONCURRENT).toBe(2);
    expect(IP_MAX_CONCURRENT).toBe(10);
    expect(SLOWDOWN_MS).toBe(2000);
    expect(LOCK_MS).toBe(15 * 60 * 1000);
    expect(LIMITS.pair.lock).toBe(true);
    expect(LIMITS.email.lock).toBe(false);
    expect(LIMITS.ip.lock).toBe(true);
    expect(LOCK_MESSAGE).toContain('15分');
    expect(BUSY_MESSAGE).toBeTruthy();
    expect(ATTEMPT_TTL_MS).toBe(30 * 1000);
  });

  test('normalizeEmail は前後空白を落とし小文字化、空なら null', () => {
    expect(normalizeEmail('  Foo@Example.COM ')).toBe('foo@example.com');
    expect(normalizeEmail('')).toBeNull();
    expect(normalizeEmail('   ')).toBeNull();
    expect(normalizeEmail(null)).toBeNull();
    expect(normalizeEmail(123)).toBeNull();
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

  test('query 経由のメールでも 5 回失敗でメール×IP の組がロックされる', () => {
    const { guard } = makeGuard();
    const ip = '198.51.100.9';
    for (let i = 0; i < 5; i++) {
      const req = { body: {}, query: { email: 'Victim@Example.com', password: 'wrong' } };
      const input = resolveLoginInput(req);
      failOnce(guard, { email: input.guardEmail, ip });
    }
    // body 経由・同じ IP で来ても同じ鍵なのでロック中
    const req2 = { body: { email: 'victim@example.com', password: 'right' }, query: {} };
    const input2 = resolveLoginInput(req2);
    const a = guard.beginAttempt({ email: input2.guardEmail, ip });
    expect(a).toMatchObject({ allowed: false, reason: 'locked', retryAfterSec: 15 * 60 });
  });
});

describe('login-guard: メール×IP の硬いロック', () => {
  const ident = { email: 'a@example.com', ip: '203.0.113.5' };

  test('4 回までは失敗してもロックされない', () => {
    const { guard } = makeGuard();
    for (let i = 1; i <= 4; i++) {
      const r = failOnce(guard, ident);
      expect(r.locked).toBe(false);
      expect(r.lockedNow).toBe(false);
      expect(r.failures).toBe(i);
    }
    expect(guard.check(ident).locked).toBe(false);
  });

  test('5 回目の失敗で組がロック（lockedNow=true・retry_after は 15 分）。IP 単独・メール単独はロックされない', () => {
    const { guard } = makeGuard();
    for (let i = 0; i < 4; i++) failOnce(guard, ident);
    const r = failOnce(guard, ident);
    expect(r.locked).toBe(true);
    expect(r.lockedNow).toBe(true);
    expect(r.retryAfterSec).toBe(15 * 60);
    expect(r.lockedKeys).toEqual(['pair:a@example.com|203.0.113.5']);
    expect(guard.check(ident)).toMatchObject({ locked: true, retryAfterSec: 15 * 60, key: 'pair:a@example.com|203.0.113.5' });
    // 同じ IP の別メール、同じメールの別 IP はロックされていない
    expect(guard.check({ email: 'b@example.com', ip: '203.0.113.5' }).locked).toBe(false);
    expect(guard.check({ email: 'a@example.com', ip: '198.51.100.1' }).locked).toBe(false);
  });

  test('ロック中は retry_after が減っていき、15 分経てば解除されカウンタも 0 から', () => {
    const { guard, clock } = makeGuard();
    for (let i = 0; i < 5; i++) failOnce(guard, ident);
    clock.advance(10 * 60 * 1000);
    expect(guard.check(ident)).toMatchObject({ locked: true, retryAfterSec: 5 * 60 });
    clock.advance(5 * 60 * 1000);
    expect(guard.check(ident).locked).toBe(false);
    expect(failOnce(guard, ident).failures).toBe(1);
  });

  test('成功でメール・IP・組の記録が消える', () => {
    const { guard } = makeGuard();
    for (let i = 0; i < 4; i++) failOnce(guard, ident);
    guard.recordSuccess(ident);
    expect(guard.size()).toBe(0);
    expect(failOnce(guard, ident)).toMatchObject({ failures: 1, locked: false });
  });

  test('メールは大文字小文字・前後空白を区別しない', () => {
    const { guard } = makeGuard();
    const ip = '10.0.0.1';
    for (let i = 0; i < 4; i++) failOnce(guard, { email: 'A@Example.com', ip });
    const r = failOnce(guard, { email: '  a@example.com ', ip });
    expect(r.locked).toBe(true);
    expect(r.lockedKeys).toEqual(['pair:a@example.com|10.0.0.1']);
  });

  test('失敗が 15 分以上離れていれば「連続」とみなさない', () => {
    const { guard, clock } = makeGuard();
    for (let i = 0; i < 4; i++) failOnce(guard, ident);
    clock.advance(LOCK_MS);
    const r = failOnce(guard, ident);
    expect(r.failures).toBe(1);
    expect(r.locked).toBe(false);
  });

  test('ロック中に recordFailure しても lockedNow は立たず、ロック期限は延びない', () => {
    const { guard, clock } = makeGuard();
    for (let i = 0; i < 5; i++) failOnce(guard, ident);
    clock.advance(60 * 1000);
    const r = guard.recordFailure(ident);
    expect(r.locked).toBe(true);
    expect(r.lockedNow).toBe(false);
    expect(r.retryAfterSec).toBe(14 * 60);
  });

  test('メールも IP も無いときは何もしない', () => {
    const { guard } = makeGuard();
    expect(guard.recordFailure({})).toMatchObject({ locked: false, failures: 0 });
    expect(guard.check({}).locked).toBe(false);
    expect(guard.beginAttempt({}).allowed).toBe(true);
    expect(guard.size()).toBe(0);
  });

  test('limits / lockMs は差し替えられる', () => {
    const { guard, clock } = makeGuard({ limits: { pair: { maxFailures: 2 } }, lockMs: 1000 });
    failOnce(guard, ident);
    expect(failOnce(guard, ident).lockedNow).toBe(true);
    expect(guard.check(ident).retryAfterSec).toBe(1);
    clock.advance(1000);
    expect(guard.check(ident).locked).toBe(false);
  });
});

describe('login-guard: メール単独は減速のみ（本人を締め出さない）', () => {
  test('他 IP から 5 回失敗させても本人は別 IP からログインできる（減速 2 秒はされる）', () => {
    const { guard } = makeGuard();
    const email = 'admin@example.com';
    // 攻撃者（別 IP）が 5 回失敗
    for (let i = 0; i < 5; i++) failOnce(guard, { email, ip: '198.51.100.66' });
    expect(guard.check({ email, ip: '198.51.100.66' }).locked).toBe(true); // 攻撃者の組はロック
    // 本人（別 IP）
    const me = { email, ip: '203.0.113.10' };
    const a = guard.beginAttempt(me);
    expect(a.allowed).toBe(true);
    expect(a.reason).toBeNull();
    expect(a.delayMs).toBe(SLOWDOWN_MS);
    guard.endAttempt(a.token);
    guard.recordSuccess(me);
    // 成功で本人のメール鍵も消えるので、以後は減速なし
    const b = guard.beginAttempt(me);
    expect(b.allowed).toBe(true);
    expect(b.delayMs).toBe(0);
    guard.endAttempt(b.token);
  });

  test('同じメールを IP を変えながら何回失敗させても、メール単独ではロックされない', () => {
    const { guard } = makeGuard();
    const email = 'target@example.com';
    for (let i = 0; i < 40; i++) {
      const r = failOnce(guard, { email, ip: `198.51.${Math.floor(i / 200)}.${i}` });
      expect(r.locked).toBe(false);
      if (i >= 4) expect(r.slowed).toBe(true);
    }
    const a = guard.beginAttempt({ email, ip: '203.0.113.1' });
    expect(a.allowed).toBe(true);
    expect(a.delayMs).toBe(SLOWDOWN_MS);
    guard.endAttempt(a.token);
  });

  test('減速は 15 分失敗が無ければ解除される', () => {
    const { guard, clock } = makeGuard();
    const email = 'target@example.com';
    for (let i = 0; i < 5; i++) failOnce(guard, { email, ip: `10.0.0.${i}` });
    expect(guard.check({ email, ip: '10.9.9.9' }).delayMs).toBe(SLOWDOWN_MS);
    clock.advance(LOCK_MS);
    expect(guard.check({ email, ip: '10.9.9.9' }).delayMs).toBe(0);
  });
});

describe('login-guard: IP 単独は 20 回で緩いロック（NAT 巻き込み対策）', () => {
  test('同一 IP から別メールを 19 回失敗してもロックされず、20 回目でロック', () => {
    const { guard } = makeGuard();
    const ip = '203.0.113.9';
    for (let i = 0; i < 19; i++) {
      expect(failOnce(guard, { email: `nobody${i}@example.com`, ip }).locked).toBe(false);
    }
    const r = failOnce(guard, { email: 'nobody19@example.com', ip });
    expect(r.locked).toBe(true);
    expect(r.lockedKeys).toEqual([`ip:${ip}`]);
    expect(guard.check({ email: 'someone-else@example.com', ip }).locked).toBe(true);
    expect(guard.check({ email: 'someone-else@example.com', ip: '198.51.100.1' }).locked).toBe(false);
  });

  test('同一 IP の 4 人がそれぞれ 4 回ずつ失敗（計 16 回）しても誰もロックされない', () => {
    const { guard } = makeGuard();
    const ip = '203.0.113.9';
    for (let u = 0; u < 4; u++) for (let i = 0; i < 4; i++) {
      expect(failOnce(guard, { email: `user${u}@example.com`, ip }).locked).toBe(false);
    }
    expect(guard.beginAttempt({ email: 'user0@example.com', ip }).allowed).toBe(true);
  });
});

describe('login-guard: 同時リクエスト（beginAttempt / endAttempt）', () => {
  test('同一メールに並列 40 件（別 IP）→ 照合に進むのはメールあたり 2 件まで、残りは busy', () => {
    const { guard } = makeGuard();
    const results = [];
    for (let i = 0; i < 40; i++) results.push(guard.beginAttempt({ email: 'target@example.com', ip: `203.0.113.${i}` }));
    const allowed = results.filter(r => r.allowed);
    expect(allowed).toHaveLength(MAX_CONCURRENT);
    expect(results.filter(r => !r.allowed).every(r => r.reason === 'busy' && r.retryAfterSec > 0 && r.key === 'email:target@example.com')).toBe(true);
    expect(guard.inFlightOf('email:target@example.com')).toBe(MAX_CONCURRENT);
  });

  test('同一 IP から別メールを並列 40 件 → 照合に進むのは IP あたり 10 件まで', () => {
    const { guard } = makeGuard();
    const results = [];
    for (let i = 0; i < 40; i++) results.push(guard.beginAttempt({ email: `nobody${i}@example.com`, ip: '203.0.113.77' }));
    expect(results.filter(r => r.allowed)).toHaveLength(IP_MAX_CONCURRENT);
    expect(results.find(r => !r.allowed).key).toBe('ip:203.0.113.77');
  });

  test('メール×IP の失敗数 + 照合中 が 5 に達した分は照合に進めない（4 回失敗後は同時 1 件だけ）', () => {
    const { guard } = makeGuard();
    const ident = { email: 'target@example.com', ip: '203.0.113.1' };
    for (let i = 0; i < 4; i++) failOnce(guard, ident);
    const results = [];
    for (let i = 0; i < 40; i++) results.push(guard.beginAttempt(ident));
    const allowed = results.filter(r => r.allowed);
    expect(allowed).toHaveLength(1);
    expect(results.find(r => !r.allowed).key).toBe('pair:target@example.com|203.0.113.1');
    // その 1 件が失敗すれば 5 回目 → ロック
    guard.endAttempt(allowed[0].token);
    expect(guard.recordFailure(ident).lockedNow).toBe(true);
    expect(guard.beginAttempt(ident)).toMatchObject({ allowed: false, reason: 'locked' });
  });

  test('endAttempt は自分の予約だけ返す（他人の予約を返さない）。失敗もロックも無い鍵は残さない', () => {
    const { guard } = makeGuard();
    const email = 'a@example.com';
    const a = guard.beginAttempt({ email, ip: '10.0.0.1' });
    const b = guard.beginAttempt({ email, ip: '10.0.0.2' });
    expect(guard.beginAttempt({ email, ip: '10.0.0.3' }).allowed).toBe(false);
    // 同じ token で 2 回返しても他人の分は減らない
    guard.endAttempt(a.token);
    guard.endAttempt(a.token);
    expect(guard.inFlightOf(`email:${email}`)).toBe(1);
    const c = guard.beginAttempt({ email, ip: '10.0.0.3' });
    expect(c.allowed).toBe(true);
    expect(guard.beginAttempt({ email, ip: '10.0.0.4' }).allowed).toBe(false);
    guard.endAttempt(b.token);
    guard.endAttempt(c.token);
    expect(guard.size()).toBe(0);
    // 無効な token は no-op
    expect(() => guard.endAttempt(null)).not.toThrow();
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
    for (let i = 0; i < 3; i++) failOnce(guard, ident);
    const a = guard.beginAttempt(ident);
    expect(a.allowed).toBe(true);
    guard.endAttempt(a.token);
    guard.recordSuccess(ident);
    expect(guard.size()).toBe(0);
    expect(failOnce(guard, ident).failures).toBe(1);
  });

  test('ロック中は beginAttempt が locked を返し、予約は増えない', () => {
    const { guard } = makeGuard();
    const ident = { email: 'a@example.com', ip: '10.0.0.1' };
    for (let i = 0; i < 5; i++) failOnce(guard, ident);
    const r = guard.beginAttempt(ident);
    expect(r).toMatchObject({ allowed: false, reason: 'locked', retryAfterSec: 15 * 60, token: null });
    expect(guard.inFlightOf('email:a@example.com')).toBe(0);
    expect(guard.inFlightOf('pair:a@example.com|10.0.0.1')).toBe(0);
  });
});

describe('login-guard: prune はロック中・照合中の鍵を捨てない', () => {
  test('鍵が上限を超えても、ロック中の組と照合中の鍵は残り、それ以外の古い鍵から消える', () => {
    const { guard, clock } = makeGuard();
    const locked = { email: 'locked@example.com', ip: '10.0.0.1' };
    for (let i = 0; i < 5; i++) failOnce(guard, locked);
    const busy = guard.beginAttempt({ email: 'busy@example.com', ip: '10.0.0.2' });
    expect(busy.allowed).toBe(true);
    // 失敗 1 回だけの鍵を大量に作る（窓内なので stale ではない）
    for (let i = 0; i < STORE_MAX_KEYS; i++) {
      guard.recordFailure({ email: `u${i}@example.com`, ip: `10.${(i >> 8) & 255}.${i & 255}.9` });
    }
    guard.pruneNow();
    expect(guard.size()).toBeLessThanOrEqual(STORE_MAX_KEYS);
    expect(guard.check(locked)).toMatchObject({ locked: true });
    expect(guard.inFlightOf('email:busy@example.com')).toBe(1);
    expect(guard.inFlightOf('pair:busy@example.com|10.0.0.2')).toBe(1);
    // 15 分後に stale な鍵は全部消えるが、照合中（予約は 30 秒で失効）はもう無いので残るのは 0
    guard.endAttempt(busy.token);
    clock.advance(LOCK_MS);
    guard.pruneNow();
    expect(guard.size()).toBe(0);
  });
});
