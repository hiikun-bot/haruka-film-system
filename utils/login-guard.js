/**
 * ログイン失敗ロック（総当たり対策）— ADR 054 §1 末尾 / Stage E
 *
 * 3 種類の鍵で失敗を数える。
 *   pair:<email>|<ip>  … 硬いロック。同じメール × 同じ IP で 15 分に 5 回失敗 → 15 分ロック（429）。
 *                        メールだけでロックすると「誰でも管理者を締め出せる」ので、組で掛ける。
 *   email:<email>      … 減速のみ。同じメールで 15 分に 5 回失敗したら、以後そのメールへの試行は
 *                        （別 IP からでも）照合の前に 2 秒待たせる。本人が別 IP から入れなくなることはない。
 *                        同時に照合へ進めるのはメールあたり 2 件まで（超過は 429 busy）。
 *   ip:<ip>            … 緩いロック。同じ IP で 15 分に 20 回失敗 → 15 分ロック。事務所 Wi-Fi や携帯回線
 *                        （CGNAT）は何人も同じ IP になるので、メールより大きく緩める。同時照合は IP あたり 10 件まで。
 *
 * IP は req.ip（trust proxy 済み＝プロキシが付けた値）を使う。X-Forwarded-For の先頭はクライアントが
 * 自由に書けるので、鍵には使わない（ログ用途の getClientIP とは別）。
 *
 * 同時リクエスト対策: check だけだと照合（bcrypt・DB）が終わる前に次が通るので、beginAttempt() で
 * 鍵ごとに「照合中」を予約し、(失敗数 + 照合中) が上限に達した分は照合に進ませない。
 * 予約は呼び出しごとの id で持ち、endAttempt(token) で自分の分だけ返す。30 秒で自動失効（ハング対策）。
 *
 * 成功したらそのメール・IP・組の記録は消す。存在しないメールに対しても同じようにカウント・ロックする
 * （429 の有無で登録有無を推測されないようにするため）。
 *
 * 保存先はプロセス内メモリ。Railway は単一インスタンス運用なのでこれで足りる。
 * ★ 複数インスタンス（水平スケール・ローリングデプロイ中の並走）にした場合は
 *    インスタンスごとに別カウンタになり「実質 N×台数 回」までしか効かない。
 *    その時は Supabase のテーブルか Redis に置き換えること（インターフェースは同じでよい）。
 *    またデプロイ（プロセス再起動）でカウンタは消える＝ロックも解ける。これは許容する。
 *
 * このモジュールは DB・express に依存しない純関数＋小さなストアで、jest で単体テストする。
 */

const LOCK_MS = 15 * 60 * 1000;
const WINDOW_MS = LOCK_MS; // 「連続」とみなす間隔（最後の失敗からこれ以上空けば数え直す）

const LIMITS = {
  // 硬いロック: メール × IP
  pair:  { maxFailures: 5,  lock: true,  maxConcurrent: 2 },
  // 減速のみ: メール単独（lock=false。失敗が maxFailures に達したら delayMs 待たせる）
  email: { maxFailures: 5,  lock: false, maxConcurrent: 2, delayMs: 2000 },
  // 緩いロック: IP 単独（NAT の巻き込み対策で大きめ）
  ip:    { maxFailures: 20, lock: true,  maxConcurrent: 10 },
};
const MAX_FAILURES = LIMITS.pair.maxFailures;
const IP_MAX_FAILURES = LIMITS.ip.maxFailures;
const MAX_CONCURRENT = LIMITS.email.maxConcurrent;
const IP_MAX_CONCURRENT = LIMITS.ip.maxConcurrent;
const SLOWDOWN_MS = LIMITS.email.delayMs;

const LOCK_MESSAGE = 'ログインの失敗が続いたため、15分ほど待ってからやり直してください';
const BUSY_MESSAGE = 'ログインの処理が重なっています。少し待ってからやり直してください';
const BUSY_RETRY_SEC = 5;
// endAttempt() の呼び忘れ・ハング対策: これより古い予約は無かったことにする
const ATTEMPT_TTL_MS = 30 * 1000;

// メモリ保護: これ以上キーが増えたら（ロック中・照合中でない）古いものから掃除する
const STORE_MAX_KEYS = 5000;

/** メールアドレスをカウンタの鍵にそろえる（前後空白除去・小文字化）。空なら null */
function normalizeEmail(email) {
  if (typeof email !== 'string') return null;
  const s = email.trim().toLowerCase();
  return s || null;
}

/**
 * /auth/login の入力を 1 本にまとめる。
 * passport-local は req.body に無ければ req.query からも username/password を拾う。
 * ロック判定が body しか見ていないと、メールを URL のクエリで渡されたときに鍵が空になり
 * アカウント単位のロックを素通りして照合まで進んでしまう。
 * ここで body に固定して query 側は消し、認証とロックが必ず同じ入力を見るようにする。
 * メールは照合用（入力のまま・既存の完全一致検索を変えない）と、ロック鍵用（normalizeEmail）の 2 つを返す。
 * @returns {{ ok: boolean, email: string, password: string, guardEmail: string|null }}
 */
function resolveLoginInput(req) {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const query = req.query && typeof req.query === 'object' ? req.query : null;
  const rawEmail = body.email ?? query?.email;
  const rawPassword = body.password ?? query?.password;
  if (query) { delete query.email; delete query.password; }
  const email = typeof rawEmail === 'string' ? rawEmail : '';
  const password = typeof rawPassword === 'string' ? rawPassword : '';
  req.body = { ...body, email, password };
  const guardEmail = normalizeEmail(email);
  return { ok: !!(guardEmail && password), email, password, guardEmail };
}

/**
 * ロックストアを作る。
 * @param {object} [opts]
 * @param {object} [opts.limits]        LIMITS と同じ形（テスト・調整用。部分上書き可）
 * @param {number} [opts.lockMs=900000]
 * @param {number} [opts.attemptTtlMs=30000]
 * @param {() => number} [opts.now=Date.now]  テスト用に時刻を差し替えられる
 */
function createLoginGuard(opts = {}) {
  const limits = {
    pair:  { ...LIMITS.pair,  ...(opts.limits?.pair  || {}) },
    email: { ...LIMITS.email, ...(opts.limits?.email || {}) },
    ip:    { ...LIMITS.ip,    ...(opts.limits?.ip    || {}) },
  };
  const lockMs = opts.lockMs ?? LOCK_MS;
  const windowMs = opts.windowMs ?? (opts.lockMs ?? WINDOW_MS);
  const attemptTtlMs = opts.attemptTtlMs ?? ATTEMPT_TTL_MS;
  const now = typeof opts.now === 'function' ? opts.now : Date.now;

  // key -> { kind, count, lastFailedAt, lockedUntil, inFlight: Map<attemptId, startedAt> }
  const store = new Map();
  let attemptSeq = 0;

  // ident → [{ kind, key }]（メール・IP が無いものは鍵を作らない）
  function keysOf({ email, ip } = {}) {
    const em = normalizeEmail(email);
    const addr = typeof ip === 'string' && ip.trim() ? ip.trim() : null;
    const keys = [];
    if (em && addr) keys.push({ kind: 'pair', key: `pair:${em}|${addr}` });
    if (em) keys.push({ kind: 'email', key: `email:${em}` });
    if (addr) keys.push({ kind: 'ip', key: `ip:${addr}` });
    return keys;
  }

  function getOrCreate(kind, key) {
    let e = store.get(key);
    if (!e) {
      e = { kind, count: 0, lastFailedAt: 0, lockedUntil: 0, inFlight: new Map() };
      store.set(key, e);
    }
    return e;
  }

  // 古い予約（endAttempt 漏れ・ハング）を落として、生きている照合中の件数を返す
  function liveInFlight(entry, t) {
    for (const [id, at] of entry.inFlight) {
      if (t - at >= attemptTtlMs) entry.inFlight.delete(id);
    }
    return entry.inFlight.size;
  }

  function isLocked(entry, t) {
    return entry.lockedUntil > t;
  }

  // 失敗から windowMs 以上経っていて、ロック中でも照合中でもない記録は捨ててよい
  function isStale(entry, t) {
    if (isLocked(entry, t)) return false;
    if (liveInFlight(entry, t) > 0) return false;
    return t - entry.lastFailedAt >= windowMs;
  }

  // 「数え直し」: ロックが切れた／窓を過ぎたら失敗数を 0 に戻す（予約は残す）
  function refresh(entry, t) {
    if (entry.count > 0 && !isLocked(entry, t) && t - entry.lastFailedAt >= windowMs) {
      entry.count = 0;
      entry.lockedUntil = 0;
    }
    if (entry.lockedUntil && !isLocked(entry, t)) {
      // ロック明け: 0 から数え直す
      entry.count = 0;
      entry.lockedUntil = 0;
    }
  }

  function prune(t) {
    for (const [k, e] of store) {
      if (isStale(e, t)) store.delete(k);
    }
    // それでも多すぎるときは、ロック中・照合中の鍵を除いて古い順（挿入順）に落とす
    if (store.size > STORE_MAX_KEYS) {
      for (const [k, e] of store) {
        if (store.size <= STORE_MAX_KEYS) break;
        if (isLocked(e, t) || liveInFlight(e, t) > 0) continue;
        store.delete(k);
      }
    }
  }

  function retryAfterSecOf(entry, t) {
    return Math.max(1, Math.ceil((entry.lockedUntil - t) / 1000));
  }

  /**
   * ロック中か・減速対象かを確認する（カウントは増やさない）。
   * @returns {{ locked: boolean, retryAfterSec: number, key: string|null, delayMs: number }}
   */
  function check(ident) {
    const t = now();
    let worst = null;
    let delayMs = 0;
    for (const { kind, key } of keysOf(ident)) {
      const e = store.get(key);
      if (!e) continue;
      refresh(e, t);
      if (isLocked(e, t)) {
        if (!worst || e.lockedUntil > worst.e.lockedUntil) worst = { key, e };
      } else if (!limits[kind].lock && limits[kind].delayMs && e.count >= limits[kind].maxFailures) {
        delayMs = Math.max(delayMs, limits[kind].delayMs);
      } else if (isStale(e, t)) {
        store.delete(key);
      }
    }
    if (!worst) return { locked: false, retryAfterSec: 0, key: null, delayMs };
    return { locked: true, retryAfterSec: retryAfterSecOf(worst.e, t), key: worst.key, delayMs: 0 };
  }

  /**
   * 照合に進む前に呼ぶ。
   *   - ロック中の鍵があれば allowed=false（reason 'locked'）
   *   - 照合中が maxConcurrent に達した鍵、または（ロックする鍵で）失敗数 + 照合中 が maxFailures に
   *     達した鍵があれば allowed=false（reason 'busy'）
   *   - allowed=true のときは鍵ごとに照合中を 1 件予約する。照合が終わったら必ず endAttempt(token) を呼ぶこと。
   *     delayMs > 0 なら、呼び出し側は照合の前にそれだけ待つ（メール単独の減速）
   * @returns {{ allowed: boolean, reason: null|'locked'|'busy', retryAfterSec: number, key: string|null, delayMs: number, token: object|null }}
   */
  function beginAttempt(ident) {
    const t = now();
    const c = check(ident);
    if (c.locked) return { allowed: false, reason: 'locked', retryAfterSec: c.retryAfterSec, key: c.key, delayMs: 0, token: null };
    const keys = keysOf(ident);
    for (const { kind, key } of keys) {
      const e = store.get(key);
      if (!e) continue;
      const lim = limits[kind];
      const inFlight = liveInFlight(e, t);
      if (inFlight >= lim.maxConcurrent || (lim.lock && e.count + inFlight >= lim.maxFailures)) {
        return { allowed: false, reason: 'busy', retryAfterSec: BUSY_RETRY_SEC, key, delayMs: 0, token: null };
      }
    }
    const id = ++attemptSeq;
    for (const { kind, key } of keys) getOrCreate(kind, key).inFlight.set(id, t);
    if (store.size > STORE_MAX_KEYS) prune(t);
    return { allowed: true, reason: null, retryAfterSec: 0, key: null, delayMs: c.delayMs, token: { id, keys: keys.map(k => k.key) } };
  }

  /** beginAttempt() の予約を自分の分だけ返す（照合の成否に関わらず finally で呼ぶ） */
  function endAttempt(token) {
    if (!token || !Array.isArray(token.keys)) return;
    const t = now();
    for (const key of token.keys) {
      const e = store.get(key);
      if (!e) continue;
      e.inFlight.delete(token.id);
      // 失敗もロックも照合中も無い鍵は残さない
      if (!e.count && !isLocked(e, t) && !liveInFlight(e, t)) store.delete(key);
    }
  }

  /**
   * 失敗を 1 回記録する。しきい値に達した鍵のうち lock=true のものはロックする。
   * @returns {{ locked: boolean, lockedNow: boolean, retryAfterSec: number, failures: number, lockedKeys: string[], slowed: boolean }}
   *   lockedNow = この呼び出しで新たにロックが掛かった（監査ログ用）
   *   slowed    = メール単独の減速しきい値に達している
   */
  function recordFailure(ident) {
    const t = now();
    let lockedNow = false;
    let lockedUntil = 0;
    let failures = 0;
    let slowed = false;
    const lockedKeys = [];
    for (const { kind, key } of keysOf(ident)) {
      const lim = limits[kind];
      const e = getOrCreate(kind, key);
      refresh(e, t);
      if (isLocked(e, t)) {
        // すでにロック中（通常は beginAttempt() で弾かれるのでここには来ない）
        lockedKeys.push(key);
        lockedUntil = Math.max(lockedUntil, e.lockedUntil);
        if (kind === 'pair') failures = e.count;
        continue;
      }
      e.count += 1;
      e.lastFailedAt = t;
      if (kind === 'pair') failures = e.count;
      if (e.count >= lim.maxFailures) {
        if (lim.lock) {
          e.lockedUntil = t + lockMs;
          lockedNow = true;
          lockedKeys.push(key);
          lockedUntil = Math.max(lockedUntil, e.lockedUntil);
        } else if (lim.delayMs) {
          slowed = true;
        }
      }
    }
    if (store.size > STORE_MAX_KEYS) prune(t);
    const locked = lockedUntil > t;
    return {
      locked,
      lockedNow,
      retryAfterSec: locked ? Math.max(1, Math.ceil((lockedUntil - t) / 1000)) : 0,
      failures,
      lockedKeys,
      slowed,
    };
  }

  /** 成功したので、そのメール・IP・組の記録を消す（他の照合中の予約ごと消えるが、endAttempt は no-op になるだけ） */
  function recordSuccess(ident) {
    for (const { key } of keysOf(ident)) store.delete(key);
  }

  /** テスト・運用用: 全部消す */
  function reset() { store.clear(); }

  /** テスト用: 現在のキー数 */
  function size() { return store.size; }

  /** テスト用: 鍵の照合中件数 */
  function inFlightOf(key) {
    const e = store.get(key);
    return e ? liveInFlight(e, now()) : 0;
  }

  /** テスト用: 鍵の失敗数 */
  function failuresOf(key) {
    const e = store.get(key);
    return e ? e.count : 0;
  }

  /** テスト用: prune を明示的に走らせる */
  function pruneNow() { prune(now()); }

  return {
    check, beginAttempt, endAttempt, recordFailure, recordSuccess,
    reset, size, inFlightOf, failuresOf, pruneNow, limits, lockMs,
  };
}

module.exports = {
  LIMITS,
  MAX_FAILURES,
  IP_MAX_FAILURES,
  MAX_CONCURRENT,
  IP_MAX_CONCURRENT,
  SLOWDOWN_MS,
  LOCK_MS,
  WINDOW_MS,
  LOCK_MESSAGE,
  BUSY_MESSAGE,
  BUSY_RETRY_SEC,
  ATTEMPT_TTL_MS,
  STORE_MAX_KEYS,
  normalizeEmail,
  resolveLoginInput,
  createLoginGuard,
};
