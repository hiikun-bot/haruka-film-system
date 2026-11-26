/**
 * アクセス回数制限（ログイン・銀行振込操作だけに掛ける）
 *
 * 掛ける場所（これ以外の API には掛けない。一覧・素材広場・アップロード・作品・通知・ポーリング等は対象外）:
 *   loginRateLimit         … POST /auth/login（IP ごと・成功したログインは数えない）
 *   registerRateLimit      … POST /api/invitations/register（IP ごと）
 *   reauthPwRateLimit      … POST /auth/reauth-password（requireAuth の後ろ・ユーザーごと）
 *   googleLoginRateLimit   … GET /auth/google（Google ログインの開始だけ・IP ごと）
 *   googleReauthRateLimit  … GET /auth/google/reauth（requireAuth の後ろ・ユーザーごと）
 *   bankRateLimit          … routes/bank-transfer.js の /bank/*・/payouts/transfer/*（requireAuth の後ろ・ユーザーごと）
 * 掛けない（意図して外している）:
 *   GET /auth/google/callback … Google 側で認証を終えて戻ってきた人を捨てないため（開始側で数えている）
 *   GET /bank/callback        … 銀行の認可画面からの一回きりの戻り（connect 側で数えている）
 *
 * 上限の決め方（普通の使い方では絶対に届かない緩さにする）:
 *   - ログイン: 同じ IP から 15 分に 300 回（成功したログインは数えない）。これは「乱用の最終防波堤」で、
 *     アカウント単位の抑止は既存の失敗ロック（utils/login-guard.js・メール×IP 5 回で 15 分など）に任せる。
 *     撮影現場・事務所の Wi-Fi や携帯回線（CGNAT）では何十人も同じ IP になるので、ここは大きく緩める。
 *   - 招待登録: 同じ IP から 15 分に 100 回。招待リンクから 1 人 1 回使うだけ。
 *   - パスワード再認証: 同じユーザーで 15 分に 30 回。振込依頼の直前に本人が打つだけで、
 *     5 回失敗で 15 分ロック（server.js）が別にある。IP は共有しない（現場 Wi-Fi の他の人と混ぜない）。
 *   - Google ログイン開始: 同じ IP から 15 分に 200 回。1 回のログインで 1 回（ボタンを押した回数）。
 *   - Google 再認証: 同じユーザーで 15 分に 30 回。振込依頼の直前に 1 回押すだけ。
 *   - 振込操作: 同じユーザーで 1 分に 60 回。使うのは最高管理者だけで、画面の操作（接続状態の取得・
 *     事前照会・依頼・履歴・状態取得）を全部続けても 1 分に 10 回前後。自動の定期取得は無い。
 *
 * IP の取り方: req.ip。本番（app.harukafilm.com）は CNAME で Railway に直結しており（間に CDN・
 *   プロキシ無し）、server.js の app.set('trust proxy', 1) により Railway のエッジが X-Forwarded-For の
 *   末尾に付けた値＝エッジが見た接続元になる。X-Forwarded-For の先頭はブラウザ側が自由に書けるので
 *   使わない（getLockIP と同じ考え方）。IPv6 は /64 単位でまとめる。IP が判定できないときは
 *   みんなを 1 つの鍵にまとめないよう、警告を出して制限をスキップする。
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
  login:        { windowMs: 15 * 60 * 1000, limit: 300 },
  register:     { windowMs: 15 * 60 * 1000, limit: 100 },
  reauthPw:     { windowMs: 15 * 60 * 1000, limit: 30 },
  googleLogin:  { windowMs: 15 * 60 * 1000, limit: 200 },
  googleReauth: { windowMs: 15 * 60 * 1000, limit: 30 },
  bank:         { windowMs: 60 * 1000,      limit: 60 },
};

/** req.ip（無ければ接続元）を正規化して返す。判定できなければ '' */
function clientIp(req) {
  let ip = String(req.ip || req.socket?.remoteAddress || '').trim();
  const m = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (m) ip = m[1];
  return ip;
}

/** 接続元 IP の鍵（IPv4 射影の ::ffff: は外し、IPv6 は /64 にまとめる）。判定できなければ null */
function ipKey(req) {
  const ip = clientIp(req);
  return ip ? `ip:${ipKeyGenerator(ip, IPV6_SUBNET)}` : null;
}

/** ログイン中ユーザーの鍵（未ログインなら IP。どちらも無ければ null） */
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
 * @param {(req) => boolean} [o.skip]  true を返したリクエストは数えない・止めない
 * @param {(req, res, windowMs) => any} [o.onLimit]  画面遷移の GET 用（リダイレクトで戻す）。無ければ JSON の 429
 */
function createRateLimiter({ name, windowMs, limit, keyBy = 'ip', skipSuccessfulRequests = false, skip, onLimit }) {
  const keyOf = keyBy === 'user' ? userKey : ipKey;
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skipSuccessfulRequests,
    skip: (req) => {
      if (skip && skip(req)) return true;
      if (keyOf(req)) return false;
      // 全員を 1 つの鍵にまとめると無関係な人まで止まるので、数えずに通す
      console.warn(`[rate-limit] ${name}: 接続元を判定できないため制限をスキップ: ${req.method} ${req.baseUrl || ''}${req.path}`);
      return true;
    },
    keyGenerator: (req) => keyOf(req),
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

/** POST /api/invitations/register 用 */
function createRegisterRateLimit(opts = {}) {
  return createRateLimiter({ name: 'invitation-register', ...LIMITS.register, ...opts });
}

/** POST /auth/reauth-password 用（requireAuth の後ろに置く。ユーザーごと） */
function createReauthPasswordRateLimit(opts = {}) {
  return createRateLimiter({ name: 'reauth-password', ...LIMITS.reauthPw, keyBy: 'user', ...opts });
}

/**
 * Google ログイン開始・再認証の超過時の戻し方。
 * 戻り先 next（req.query.next）は呼び出し側の既存の検証済み経路にそのまま渡す（ここでは URL を組み立てない）。
 *   - /auth/google/reauth → reauthRedirect(res, next, { reauth_error })
 *   - /auth/google        → loginFail(res, code, next)
 * 進行中の Google ログイン・再認証の状態（googleLoginNonce / googleReauthUserId）は消す。
 *
 * @param {object} deps
 * @param {(res, code, next) => any} deps.loginFail
 * @param {(res, next, params) => any} deps.reauthRedirect
 */
function buildGoogleLoginOnLimit({ loginFail, reauthRedirect }) {
  return (req, res) => {
    if (req.session) {
      delete req.session.googleReauthUserId;
      delete req.session.googleLoginNonce;
    }
    const next = req.query?.next;
    if (req.path === '/auth/google/reauth') return reauthRedirect(res, next, { reauth_error: RATE_LIMIT_CODE });
    return loginFail(res, RATE_LIMIT_CODE, next);
  };
}

/** GET /auth/google 用（IP ごと） */
function createGoogleLoginRateLimit({ onLimit, ...opts } = {}) {
  if (typeof onLimit !== 'function') throw new Error('createGoogleLoginRateLimit: onLimit が必要です');
  return createRateLimiter({ name: 'google-login', ...LIMITS.googleLogin, onLimit, ...opts });
}

/** GET /auth/google/reauth 用（requireAuth の後ろに置く。ユーザーごと） */
function createGoogleReauthRateLimit({ onLimit, ...opts } = {}) {
  if (typeof onLimit !== 'function') throw new Error('createGoogleReauthRateLimit: onLimit が必要です');
  return createRateLimiter({ name: 'google-reauth', ...LIMITS.googleReauth, keyBy: 'user', onLimit, ...opts });
}

// router.use(PATHS, …) の中では req.path から '/bank' が外れるので baseUrl と合わせて見る
const fullPath = (req) => `${req.baseUrl || ''}${req.path || ''}`;
const isBankConnect = (req) => req.method === 'GET' && /\/bank\/connect\/?$/.test(fullPath(req));
const isBankCallback = (req) => req.method === 'GET' && /\/bank\/callback\/?$/.test(fullPath(req));

/**
 * 銀行振込ルートの超過時の戻し方。接続（認可画面へのリダイレクト）は画面遷移なので、進行中の接続の
 * 状態（aozoraConnectNonce / aozoraOidcNonce）を消して req.query.next を既存の redirectBack に渡す。
 * それ以外は JSON の 429。
 */
function buildBankOnLimit({ redirectBack }) {
  return (req, res, windowMs) => {
    if (!isBankConnect(req)) return jsonLimitHandler(req, res, windowMs);
    if (req.session) {
      delete req.session.aozoraConnectNonce;
      delete req.session.aozoraOidcNonce;
    }
    return redirectBack(res, req.query?.next, { bank_error: RATE_LIMIT_CODE });
  };
}

/** routes/bank-transfer.js の PATHS 用（ユーザーごと）。GET /bank/callback は数えない */
function createBankRateLimit({ onLimit, ...opts } = {}) {
  return createRateLimiter({ name: 'bank-transfer', ...LIMITS.bank, keyBy: 'user', skip: isBankCallback, onLimit, ...opts });
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
  createGoogleReauthRateLimit,
  buildBankOnLimit,
  createBankRateLimit,
};
