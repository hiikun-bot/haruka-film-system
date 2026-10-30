/**
 * ログイン失敗ロック（総当たり対策）— ADR 054 §1 末尾 / Stage E
 *
 * 同一メールアドレス（小文字化）または同一 IP（x-forwarded-for の先頭）で
 * 連続 MAX_FAILURES 回ログインに失敗したら、その鍵を LOCK_MS の間ロックする。
 * ロック中は /auth/login がパスワード照合に進む前に 429 を返す。
 * 成功したらその鍵のカウンタはリセットされる。
 *
 * 存在しないメールアドレスに対しても同じようにカウント・ロックする
 * （「このメールは登録されていない」を 429 の有無で推測されないようにするため）。
 *
 * 保存先はプロセス内メモリ。Railway は単一インスタンス運用なのでこれで足りる。
 * ★ 複数インスタンス（水平スケール・ローリングデプロイ中の並走）にした場合は
 *    インスタンスごとに別カウンタになり「実質 5×台数 回」までしか効かない。
 *    その時は Supabase のテーブルか Redis に置き換えること（インターフェースは同じでよい）。
 *    またデプロイ（プロセス再起動）でカウンタは消える＝ロックも解ける。これは許容する。
 *
 * このモジュールは DB・express に依存しない純関数＋小さなストアで、jest で単体テストする。
 */

const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60 * 1000;
const LOCK_MESSAGE = 'ログインの失敗が続いたため、15分ほど待ってからやり直してください';

// 同時に照合へ進める試行数（同一メール or 同一 IP あたり）。
// check() は照合（bcrypt・DB）より前に通るので、並列で大量に投げると「5 回」を超えて照合に進めてしまう。
// beginAttempt() で照合中の試行を鍵ごとに予約し、(失敗数 + 照合中) が MAX_FAILURES に達した分と
// MAX_CONCURRENT を超えた分は照合に進ませない。
const MAX_CONCURRENT = 2;
const BUSY_MESSAGE = 'ログインの処理が重なっています。少し待ってからやり直してください';
const BUSY_RETRY_SEC = 5;
// endAttempt() の呼び忘れ・ハング対策: これより古い予約は無かったことにする
const ATTEMPT_TTL_MS = 30 * 1000;

// メモリ保護: これ以上キーが増えたら古いものから掃除する
const STORE_MAX_KEYS = 5000;

/** メールアドレスをカウンタの鍵にそろえる（前後空白除去・小文字化）。空なら null */
function normalizeEmail(email) {
  if (typeof email !== 'string') return null;
  const s = email.trim().toLowerCase();
  return s || null;
}

/** IPv6 でラップされた IPv4（::ffff:1.2.3.4）を IPv4 に正規化 */
function normalizeIp(ip) {
  if (!ip) return null;
  const s = String(ip).trim();
  const m = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  return (m ? m[1] : s) || null;
}

/**
 * リクエストからクライアント IP を取り出す。
 * プロキシ（Railway）経由なので x-forwarded-for の先頭を優先し、無ければ req.ip。
 */
function extractClientIp(req) {
  const fwd = req?.headers?.['x-forwarded-for'];
  if (fwd) {
    const first = String(Array.isArray(fwd) ? fwd[0] : fwd).split(',')[0];
    const ip = normalizeIp(first);
    if (ip) return ip;
  }
  return normalizeIp(req?.ip || req?.connection?.remoteAddress || '') || null;
}

/**
 * ロックストアを作る。
 * @param {object} [opts]
 * @param {number} [opts.maxFailures=5]
 * @param {number} [opts.lockMs=900000]
 * @param {() => number} [opts.now=Date.now]  テスト用に時刻を差し替えられる
 */
function createLoginGuard(opts = {}) {
  const maxFailures = opts.maxFailures ?? MAX_FAILURES;
  const lockMs = opts.lockMs ?? LOCK_MS;
  const maxConcurrent = opts.maxConcurrent ?? MAX_CONCURRENT;
  const attemptTtlMs = opts.attemptTtlMs ?? ATTEMPT_TTL_MS;
  const now = typeof opts.now === 'function' ? opts.now : Date.now;

  // key -> { count, lastFailedAt, lockedUntil, inFlight: number[]（照合中の試行の開始時刻） }
  const store = new Map();

  // 古い予約（endAttempt 漏れ・ハング）を落として、生きている照合中の件数を返す
  function liveInFlight(entry, t) {
    if (!entry.inFlight || !entry.inFlight.length) return 0;
    entry.inFlight = entry.inFlight.filter(at => t - at < attemptTtlMs);
    return entry.inFlight.length;
  }

  function keysOf({ email, ip } = {}) {
    const keys = [];
    const em = normalizeEmail(email);
    const addr = normalizeIp(ip);
    if (em) keys.push(`email:${em}`);
    if (addr) keys.push(`ip:${addr}`);
    return keys;
  }

  // 失敗から lockMs 以上経った記録は「連続」とみなさないので捨てる（ロック中のものは残す）
  function isStale(entry, t) {
    if (entry.lockedUntil && entry.lockedUntil > t) return false;
    if (liveInFlight(entry, t) > 0) return false;
    return t - entry.lastFailedAt >= lockMs;
  }

  function prune(t) {
    for (const [k, e] of store) {
      if (isStale(e, t)) store.delete(k);
    }
    // それでも多すぎるときは古い順（挿入順）に落とす
    while (store.size > STORE_MAX_KEYS) {
      const oldest = store.keys().next().value;
      if (oldest === undefined) break;
      store.delete(oldest);
    }
  }

  function retryAfterSecOf(entry, t) {
    return Math.max(1, Math.ceil((entry.lockedUntil - t) / 1000));
  }

  /**
   * ロック中か確認する（カウントは増やさない）。
   * @returns {{ locked: boolean, retryAfterSec: number, key: string|null }}
   */
  function check(ident) {
    const t = now();
    let worst = null;
    for (const k of keysOf(ident)) {
      const e = store.get(k);
      if (!e) continue;
      if (e.lockedUntil && e.lockedUntil > t) {
        if (!worst || e.lockedUntil > worst.e.lockedUntil) worst = { k, e };
      } else if (isStale(e, t)) {
        store.delete(k);
      }
    }
    if (!worst) return { locked: false, retryAfterSec: 0, key: null };
    return { locked: true, retryAfterSec: retryAfterSecOf(worst.e, t), key: worst.k };
  }

  /**
   * 失敗を 1 回記録する。しきい値に達した鍵はロックする。
   * @returns {{ locked: boolean, lockedNow: boolean, retryAfterSec: number, failures: number, lockedKeys: string[] }}
   *   lockedNow = この呼び出しで新たにロックが掛かった（監査ログ用）
   */
  function recordFailure(ident) {
    const t = now();
    let lockedNow = false;
    let lockedUntil = 0;
    let failures = 0;
    const lockedKeys = [];
    for (const k of keysOf(ident)) {
      let e = store.get(k);
      if (!e || isStale(e, t)) {
        e = { count: 0, lastFailedAt: t, lockedUntil: 0, inFlight: e?.inFlight || [] };
        store.set(k, e);
      }
      if (e.lockedUntil && e.lockedUntil > t) {
        // すでにロック中（通常は check() で弾かれるのでここには来ない）
        lockedKeys.push(k);
        lockedUntil = Math.max(lockedUntil, e.lockedUntil);
        failures = Math.max(failures, e.count);
        continue;
      }
      e.count += 1;
      e.lastFailedAt = t;
      failures = Math.max(failures, e.count);
      if (e.count >= maxFailures) {
        e.lockedUntil = t + lockMs;
        lockedNow = true;
        lockedKeys.push(k);
        lockedUntil = Math.max(lockedUntil, e.lockedUntil);
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
    };
  }

  /**
   * 照合に進む前に呼ぶ。ロック中、または (失敗数 + 照合中) が maxFailures に達している、
   * または照合中が maxConcurrent に達している鍵があれば allowed=false。
   * allowed=true のときは鍵ごとに照合中を 1 件予約するので、照合が終わったら必ず endAttempt() を呼ぶこと。
   * @returns {{ allowed: boolean, reason: null|'locked'|'busy', retryAfterSec: number, key: string|null }}
   */
  function beginAttempt(ident) {
    const t = now();
    const lock = check(ident);
    if (lock.locked) return { allowed: false, reason: 'locked', retryAfterSec: lock.retryAfterSec, key: lock.key };
    const keys = keysOf(ident);
    for (const k of keys) {
      const e = store.get(k);
      if (!e) continue;
      const inFlight = liveInFlight(e, t);
      if (inFlight >= maxConcurrent || e.count + inFlight >= maxFailures) {
        return { allowed: false, reason: 'busy', retryAfterSec: BUSY_RETRY_SEC, key: k };
      }
    }
    for (const k of keys) {
      let e = store.get(k);
      if (!e) {
        e = { count: 0, lastFailedAt: 0, lockedUntil: 0, inFlight: [] };
        store.set(k, e);
      }
      if (!e.inFlight) e.inFlight = [];
      e.inFlight.push(t);
    }
    if (store.size > STORE_MAX_KEYS) prune(t);
    return { allowed: true, reason: null, retryAfterSec: 0, key: null };
  }

  /** beginAttempt() の予約を 1 件返す（照合の成否に関わらず finally で呼ぶ） */
  function endAttempt(ident) {
    const t = now();
    for (const k of keysOf(ident)) {
      const e = store.get(k);
      if (!e) continue;
      if (e.inFlight && e.inFlight.length) e.inFlight.shift();
      // 失敗もロックも照合中も無い鍵は残さない
      if (!e.count && !(e.lockedUntil > t) && !liveInFlight(e, t)) store.delete(k);
    }
  }

  /** 成功したので、そのメール・IP のカウンタを消す */
  function recordSuccess(ident) {
    for (const k of keysOf(ident)) store.delete(k);
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

  return {
    check, beginAttempt, endAttempt, recordFailure, recordSuccess,
    reset, size, inFlightOf, maxFailures, lockMs, maxConcurrent,
  };
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

module.exports = {
  MAX_FAILURES,
  LOCK_MS,
  LOCK_MESSAGE,
  MAX_CONCURRENT,
  BUSY_MESSAGE,
  BUSY_RETRY_SEC,
  ATTEMPT_TTL_MS,
  normalizeEmail,
  normalizeIp,
  extractClientIp,
  resolveLoginInput,
  createLoginGuard,
};
