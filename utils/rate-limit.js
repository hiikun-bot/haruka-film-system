/**
 * アクセス回数制限（ログイン・銀行振込操作だけに掛ける）
 *
 * 掛ける場所（これ以外の API には掛けない。一覧・素材広場・アップロード・作品・通知・ポーリング等は対象外）:
 *   loginRateLimit        … POST /auth/login（IP ごと・成功したログインは数えない）
 *   registerRateLimit     … POST /api/invitations/register（IP ごと・ログインと同じ上限の別枠）
 *   reauthPwRateLimit     … POST /auth/reauth-password（requireAuth の後ろ・ユーザーごと）
 *   googleLoginRateLimit  … GET /auth/google・GET /auth/google/callback・GET /auth/google/reauth（IP ごと）
 *   bankRateLimit         … routes/bank-transfer.js の /bank/*・/payouts/transfer/*（requireAuth の後ろ・ユーザーごと）
 *
 * 上限の決め方（普通の使い方では絶対に届かない緩さにする）:
 *   - ログイン: 同じ IP から 15 分に 100 回（成功したログインは数えない）。撮影現場・事務所の Wi-Fi や
 *     携帯回線（CGNAT）では何十人も同じ IP になる。メンバー 40 人が一斉に入り、全員が 1 回ずつ
 *     打ち間違えても 40 回で収まる。パスワードの失敗ロック（utils/login-guard.js・メール×IP 5 回で
 *     15 分）はこれとは別に従来どおり効く。招待登録も同じ上限の別枠。
 *   - パスワード再認証: 同じユーザーで 15 分に 30 回。振込依頼の直前に本人が打つだけで、
 *     5 回失敗で 15 分ロック（server.js）が別にある。IP は共有しない（現場 Wi-Fi の他の人と混ぜない）。
 *   - Google ログイン: 同じ IP から 15 分に 200 回。1 回のログインで「開始」と「戻り」の 2 回数えるので、
 *     実質 100 人分のログイン。
 *   - 振込操作: 同じユーザーで 1 分に 60 回。使うのは最高管理者だけで、画面の操作（接続状態の取得・
 *     事前照会・依頼・履歴・状態取得）を全部続けても 1 分に 10 回前後。自動の定期取得は無い。
 *
 * IP の取り方: req.ip。本番（app.harukafilm.com）は CNAME で Railway に直結しており（間に CDN・
 *   プロキシ無し）、server.js の app.set('trust proxy', 1) により Railway のエッジが X-Forwarded-For の
 *   末尾に付けた値＝エッジが見た接続元になる。X-Forwarded-For の先頭はブラウザ側が自由に書けるので
 *   使わない（getLockIP と同じ考え方）。IPv6 は /64 単位でまとめる。
 *   ★ 前段に CDN／プロキシ（Cloudflare 等）を足したら、trust proxy の段数とこの制限を必ず見直すこと。
 *     段数がずれると全員が CDN の同じ IP 扱いになり、上限に達してログインが止まる。
 *
 * 超過時: API（JSON）は 429 ＋日本語の error ＋ retry_after_sec。画面遷移する GET（Google ログイン・
 *   銀行接続）は JSON を見せても意味がないので、エラーコード付きでログイン画面／振込管理へ戻す
 *   （戻り先 next は呼び出し側の既存の検証済み経路＝googleLoginFail / reauthRedirect に渡す）。
 *
 * 保存先はプロセス内メモリ（express-rate-limit の MemoryStore）。Railway は単一インスタンス運用なので
 * これで足りる。複数インスタンスにした場合はインスタンスごとに別カウンタ＝実質「上限×台数」になる。
 * デプロイ（再起動）でカウンタは消える。これは許容する。
 */

const { rateLimit, ipKeyGenerator } = require('express-rate-limit');

const RATE_LIMIT_MESSAGE = 'アクセスが集中しています。しばらく待ってからやり直してください';
const RATE_LIMIT_CODE = 'rate_limited';
const IPV6_SUBNET = 64;

const LIMITS = {
  login:       { windowMs: 15 * 60 * 1000, limit: 100 },
  reauthPw:    { windowMs: 15 * 60 * 1000, limit: 30 },
  googleLogin: { windowMs: 15 * 60 * 1000, limit: 200 },
  bank:        { windowMs: 60 * 1000,      limit: 60 },
};

/** 接続元 IP の鍵（req.ip を使う。IPv4 射影の ::ffff: は外し、IPv6 は /64 にまとめる） */
function ipKey(req) {
  let ip = String(req.ip || req.socket?.remoteAddress || '').trim();
  const m = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (m) ip = m[1];
  if (!ip) return 'ip:unknown';
  return `ip:${ipKeyGenerator(ip, IPV6_SUBNET)}`;
}

/** ログイン中ユーザーの鍵（未ログインなら IP） */
function userKey(req) {
  const uid = req.user?.id;
  return uid != null && uid !== '' ? `u:${uid}` : ipKey(req);
}

function retryAfterSec(req, windowMs) {
  const reset = req.rateLimit?.resetTime;
  const ms = reset instanceof Date ? reset.getTime() - Date.now() : windowMs;
  return Math.max(1, Math.ceil(ms / 1000));
}

/** 既定の超過応答（JSON の 429） */
function jsonLimitHandler(req, res, windowMs) {
  const sec = retryAfterSec(req, windowMs);
  res.setHeader('Retry-After', String(sec));
  return res.status(429).json({ error: RATE_LIMIT_MESSAGE, code: RATE_LIMIT_CODE, retry_after_sec: sec });
}

/**
 * @param {object} o
 * @param {string} o.name        ログに出す名前
 * @param {number} o.windowMs
 * @param {number} o.limit
 * @param {'ip'|'user'} [o.keyBy='ip']
 * @param {boolean} [o.skipSuccessfulRequests=false]  true なら 400 未満の応答は数えない
 * @param {(req, res, windowMs) => any} [o.onLimit]  画面遷移の GET 用（リダイレクトで戻す）。無ければ JSON の 429
 */
function createRateLimiter({ name, windowMs, limit, keyBy = 'ip', skipSuccessfulRequests = false, onLimit }) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skipSuccessfulRequests,
    keyGenerator: keyBy === 'user' ? userKey : ipKey,
    handler: (req, res) => {
      console.warn(`[rate-limit] ${name} exceeded: ${req.method} ${req.baseUrl || ''}${req.path}`);
      if (onLimit) return onLimit(req, res, windowMs);
      return jsonLimitHandler(req, res, windowMs);
    },
    // keyGenerator を自前にしているので、ライブラリの IP 系の起動時検査は不要（trust proxy は server.js で 1 に固定済み）
    validate: { keyGeneratorIpFallback: false, trustProxy: false, xForwardedForHeader: false },
  });
}

/** POST /auth/login 用。成功したログインは数えない（大勢が同じ Wi-Fi から入っても枠を食わない） */
function createLoginRateLimit(opts = {}) {
  return createRateLimiter({ name: 'login', ...LIMITS.login, skipSuccessfulRequests: true, ...opts });
}

/** POST /api/invitations/register 用（ログインと同じ上限・別枠） */
function createRegisterRateLimit(opts = {}) {
  return createRateLimiter({ name: 'invitation-register', ...LIMITS.login, ...opts });
}

/** POST /auth/reauth-password 用（requireAuth の後ろに置く。ユーザーごと） */
function createReauthPasswordRateLimit(opts = {}) {
  return createRateLimiter({ name: 'reauth-password', ...LIMITS.reauthPw, keyBy: 'user', ...opts });
}

/**
 * Google ログイン（開始・戻り・再認証）の超過時の戻し方。
 * 戻り先 next は呼び出し側の既存の検証済み経路にそのまま渡す（ここでは URL を組み立てない）。
 *   - /auth/google/reauth            → reauthRedirect(res, req.query.next, { reauth_error })
 *   - /auth/google/callback（再認証） → reauthRedirect(res, 検証済み state の next, { reauth_error })
 *   - それ以外（通常ログイン）         → loginFail(res, code, next)
 * 進行中の Google ログイン・再認証の状態（googleLoginNonce / googleReauthUserId）は消す。
 *
 * @param {object} deps
 * @param {(res, code, next) => any} deps.loginFail
 * @param {(res, next, params) => any} deps.reauthRedirect
 * @param {(state: string) => ({ next?: string } | null)} deps.verifyState  署名検証済みの state を返す（失敗は null）
 */
function buildGoogleLoginOnLimit({ loginFail, reauthRedirect, verifyState }) {
  return (req, res) => {
    const isCallback = req.path === '/auth/google/callback';
    const reauth = req.path === '/auth/google/reauth' || (isCallback && !!req.session?.googleReauthUserId);
    if (req.session) {
      delete req.session.googleReauthUserId;
      delete req.session.googleLoginNonce;
    }
    let next = req.query?.next;
    if (isCallback) {
      let payload = null;
      try { payload = verifyState(String(req.query?.state || '')); } catch (_) { payload = null; }
      next = payload?.next;
    }
    if (reauth) return reauthRedirect(res, next, { reauth_error: RATE_LIMIT_CODE });
    return loginFail(res, RATE_LIMIT_CODE, next);
  };
}

function createGoogleLoginRateLimit({ onLimit, ...opts } = {}) {
  if (typeof onLimit !== 'function') throw new Error('createGoogleLoginRateLimit: onLimit が必要です');
  return createRateLimiter({ name: 'google-login', ...LIMITS.googleLogin, onLimit, ...opts });
}

/**
 * 銀行振込ルートの超過時の戻し方。接続（認可画面へのリダイレクト・戻り）は画面遷移なので振込管理へ戻し、
 * それ以外は JSON の 429。next は connect なら req.query.next、callback なら検証済み state の next を
 * 既存の redirectBack（= reauthRedirect）に渡す。
 */
function buildBankOnLimit({ redirectBack, verifyState }) {
  return (req, res, windowMs) => {
    // router.use(PATHS, …) の中では req.path から '/bank' が外れるので baseUrl と合わせて見る
    const full = `${req.baseUrl || ''}${req.path || ''}`;
    const m = req.method === 'GET' ? full.match(/\/bank\/(connect|callback)\/?$/) : null;
    if (!m) return jsonLimitHandler(req, res, windowMs);
    let next = req.query?.next;
    if (m[1] === 'callback') {
      let payload = null;
      try { payload = verifyState(String(req.query?.state || '')); } catch (_) { payload = null; }
      next = payload?.next;
    }
    return redirectBack(res, next, { bank_error: RATE_LIMIT_CODE });
  };
}

function createBankRateLimit({ onLimit, ...opts } = {}) {
  return createRateLimiter({ name: 'bank-transfer', ...LIMITS.bank, keyBy: 'user', onLimit, ...opts });
}

module.exports = {
  RATE_LIMIT_MESSAGE,
  RATE_LIMIT_CODE,
  LIMITS,
  ipKey,
  userKey,
  jsonLimitHandler,
  createRateLimiter,
  createLoginRateLimit,
  createRegisterRateLimit,
  createReauthPasswordRateLimit,
  buildGoogleLoginOnLimit,
  createGoogleLoginRateLimit,
  buildBankOnLimit,
  createBankRateLimit,
};
