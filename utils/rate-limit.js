/**
 * アクセス回数制限（ログイン・銀行振込操作だけに掛ける）
 *
 * 掛ける場所（これ以外の API には掛けない。一覧・素材広場・アップロード・作品・通知・ポーリング等は対象外）:
 *   loginRateLimit       … POST /auth/login・POST /auth/reauth-password・POST /api/invitations/register
 *   googleLoginRateLimit … GET /auth/google・GET /auth/google/callback・GET /auth/google/reauth
 *   bankRateLimit        … routes/bank-transfer.js の /bank/*・/payouts/transfer/*（requireAuth の後ろ）
 *
 * 上限の決め方（普通の使い方では絶対に届かない緩さにする）:
 *   - ログイン: 同じ IP から 15 分に 100 回。撮影現場・事務所の Wi-Fi や携帯回線（CGNAT）では
 *     何十人も同じ IP になる。メンバー 40 人が一斉に入り、全員が 1 回ずつ打ち間違えても 80 回で収まる。
 *     パスワードの失敗ロック（utils/login-guard.js・メール×IP 5 回で 15 分）はこれとは別に従来どおり効く。
 *   - Google ログイン: 同じ IP から 15 分に 200 回。1 回のログインで「開始」と「戻り」の 2 回数えるので、
 *     実質 100 人分のログイン。
 *   - 振込操作: 同じユーザーで 1 分に 60 回。使うのは最高管理者だけで、画面の操作（接続状態の取得・
 *     事前照会・依頼・履歴・状態取得）を全部続けても 1 分に 10 回前後。自動の定期取得は無い。
 *
 * IP の取り方: req.ip（server.js の app.set('trust proxy', 1) により、Railway のエッジが
 *   X-Forwarded-For の末尾に付けた値＝直前のプロキシが見た接続元）。X-Forwarded-For の先頭は
 *   ブラウザ側が自由に書けるので使わない（getLockIP と同じ考え方）。IPv6 は /56 単位でまとめる。
 *
 * 超過時: API（JSON）は 429 ＋日本語の error ＋ retry_after_sec。画面遷移する GET（Google ログイン・
 *   銀行接続）は JSON を見せても意味がないので、エラーコード付きでログイン画面／振込管理へ戻す。
 *
 * 保存先はプロセス内メモリ（express-rate-limit の MemoryStore）。Railway は単一インスタンス運用なので
 * これで足りる。複数インスタンスにした場合はインスタンスごとに別カウンタ＝実質「上限×台数」になる。
 * デプロイ（再起動）でカウンタは消える。これは許容する。
 */

const { rateLimit, ipKeyGenerator } = require('express-rate-limit');

const RATE_LIMIT_MESSAGE = 'アクセスが集中しています。しばらく待ってからやり直してください';

const LIMITS = {
  login:       { windowMs: 15 * 60 * 1000, limit: 100 },
  googleLogin: { windowMs: 15 * 60 * 1000, limit: 200 },
  bank:        { windowMs: 60 * 1000,      limit: 60 },
};

/** 接続元 IP の鍵（req.ip を使う。IPv4 射影の ::ffff: は外し、IPv6 は /56 にまとめる） */
function ipKey(req) {
  let ip = String(req.ip || req.socket?.remoteAddress || '').trim();
  const m = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (m) ip = m[1];
  if (!ip) return 'ip:unknown';
  return `ip:${ipKeyGenerator(ip)}`;
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
  return res.status(429).json({ error: RATE_LIMIT_MESSAGE, code: 'rate_limited', retry_after_sec: sec });
}

/**
 * @param {object} o
 * @param {string} o.name        ログに出す名前
 * @param {number} o.windowMs
 * @param {number} o.limit
 * @param {'ip'|'user'} [o.keyBy='ip']
 * @param {(req, res) => any} [o.onLimit]  画面遷移の GET 用（リダイレクトで戻す）。無ければ JSON の 429
 */
function createRateLimiter({ name, windowMs, limit, keyBy = 'ip', onLimit }) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: keyBy === 'user' ? userKey : ipKey,
    handler: (req, res) => {
      console.warn(`[rate-limit] ${name} exceeded: ${req.method} ${req.baseUrl || ""}${req.path}`);
      if (onLimit) return onLimit(req, res);
      return jsonLimitHandler(req, res, windowMs);
    },
    // keyGenerator を自前にしているので、ライブラリの IP 系の起動時検査は不要（trust proxy は server.js で 1 に固定済み）
    validate: { keyGeneratorIpFallback: false, trustProxy: false, xForwardedForHeader: false },
  });
}

function createLoginRateLimit(opts = {}) {
  return createRateLimiter({ name: 'login', ...LIMITS.login, ...opts });
}

// Google の戻り（callback）は再認証モードもあるので、振込管理から来た再認証は振込管理へ戻す
function googleLoginOnLimit(req, res) {
  const reauth = req.path === '/auth/google/reauth' || !!req.session?.googleReauthUserId;
  if (reauth) return res.redirect('/haruka.html?page=payout&reauth_error=rate_limited');
  return res.redirect('/login.html?error=rate_limited');
}
function createGoogleLoginRateLimit(opts = {}) {
  return createRateLimiter({ name: 'google-login', ...LIMITS.googleLogin, onLimit: googleLoginOnLimit, ...opts });
}

// 銀行の接続（認可画面へのリダイレクト・戻り）は画面遷移なので振込管理へ戻す。それ以外は JSON の 429
function bankOnLimit(req, res) {
  // router.use(PATHS, …) の中では req.path から '/bank' が外れるので baseUrl と合わせて見る
  const full = `${req.baseUrl || ''}${req.path || ''}`;
  if (req.method === 'GET' && /\/bank\/(connect|callback)$/.test(full)) {
    return res.redirect('/haruka.html?page=payout&bank_error=rate_limited');
  }
  return jsonLimitHandler(req, res, LIMITS.bank.windowMs);
}
function createBankRateLimit(opts = {}) {
  return createRateLimiter({ name: 'bank-transfer', ...LIMITS.bank, keyBy: 'user', onLimit: bankOnLimit, ...opts });
}

module.exports = {
  RATE_LIMIT_MESSAGE,
  LIMITS,
  ipKey,
  userKey,
  createRateLimiter,
  createLoginRateLimit,
  createGoogleLoginRateLimit,
  createBankRateLimit,
};
