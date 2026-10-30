// utils/google-login.js — 「Google でログイン」（招待済みメンバーのみ）
// =============================================================
// 純関数＋ OAuth クライアント生成。DB・セッション操作は server.js の /auth/google* が担う。
//
// 方針（2026-10-13 さとるさん依頼。2026-04 に削除した旧実装の「未登録メールを admin で自動作成」は復活させない）:
//   - Google が「確認済み」と返し、かつ Google が持ち主を保証できるメール（@gmail.com、または hd が一致する
//     Google Workspace）が、有効な users.email と一致した人だけログインできる。Yahoo!・独自ドメイン等で作った
//     Google アカウントは、アドレスが別人に引き継がれても古いアカウントが残るため使わない（2026-10-13 レビュー指摘）
//   - 新規ユーザーの自動作成・ロール付与はしない（招待フローが唯一の入口）
//   - 戻り先（redirect_uri）は「今開いているドメイン」に合わせる（ログインのクッキーはドメイン単位のため）。
//     ただし許可したホストだけ（Host ヘッダ偽装で別ドメインへ code を流させない）
//   - state は HMAC 署名＋10 分期限＋セッションの nonce と照合（ログイン CSRF 対策）
//
// 環境変数（GOOGLE_LOGIN_* が無ければ同じ Cloud プロジェクトのカレンダー連携クライアントを使う）:
//   GOOGLE_LOGIN_CLIENT_ID / GOOGLE_LOGIN_CLIENT_SECRET   （任意・既定は GOOGLE_CALENDAR_CLIENT_ID / SECRET）
//   GOOGLE_LOGIN_ALLOWED_HOSTS  （任意・カンマ区切り。既定は RAILWAY_PUBLIC_DOMAIN ＋ 本番の railway.app ドメイン）
//   GOOGLE_LOGIN_ENABLED=true   で有効化（既定は無効。下のリダイレクト URI を Cloud Console に登録してから true にする。
//                               登録前に有効にすると、ボタンを押した人が Google の redirect_uri_mismatch 画面で止まる）
// Google Cloud Console の OAuth クライアントに、許可ホストごとの
//   https://<host>/auth/google/callback
// を「承認済みのリダイレクト URI」として登録しておくこと。
// =============================================================

const crypto = require('crypto');

const CALLBACK_PATH = '/auth/google/callback';
const STATE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_RAILWAY_HOST = 'haruka-film-system-production.up.railway.app';

function getClientConfig(env = process.env) {
  const id = String(env.GOOGLE_LOGIN_CLIENT_ID || env.GOOGLE_CALENDAR_CLIENT_ID || '').trim();
  const secret = String(env.GOOGLE_LOGIN_CLIENT_SECRET || env.GOOGLE_CALENDAR_CLIENT_SECRET || '').trim();
  return { id, secret };
}

function isEnabled(env = process.env) {
  if (String(env.GOOGLE_LOGIN_ENABLED || '').trim().toLowerCase() !== 'true') return false;
  const { id, secret } = getClientConfig(env);
  return !!(id && secret);
}

function getAllowedHosts(env = process.env) {
  const explicit = String(env.GOOGLE_LOGIN_ALLOWED_HOSTS || '').split(',').map(normalizeHost).filter(Boolean);
  if (explicit.length) return explicit;
  const hosts = [normalizeHost(env.RAILWAY_PUBLIC_DOMAIN), DEFAULT_RAILWAY_HOST];
  if (env.NODE_ENV !== 'production') hosts.push('localhost:3000');
  return [...new Set(hosts.filter(Boolean))];
}

function normalizeHost(h) {
  return String(h || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
}

/** リクエストのホストが許可済みなら戻り先 URL を返す。許可外は null */
function resolveCallbackUrl(host, env = process.env) {
  const h = normalizeHost(host);
  if (!h || !getAllowedHosts(env).includes(h)) return null;
  const scheme = h.startsWith('localhost') ? 'http' : 'https';
  return `${scheme}://${h}${CALLBACK_PATH}`;
}

/** ログイン後の遷移先。オープンリダイレクトを防ぐため /haruka.html 始まりの相対 URL のみ（login.html と同条件） */
function safeNext(next) {
  const s = String(next || '');
  return /^\/haruka\.html(\?|$)/.test(s) ? s : '/haruka.html';
}

/**
 * state / preview_token の HMAC 鍵（セッション署名と同じ SESSION_SECRET）。本番は SESSION_SECRET 必須（server.js が起動時に検査）。
 * dev 用のフォールバック文字列はここだけに置く（他ファイルにコピーしない）。
 */
const DEV_FALLBACK_SECRET = 'video-ops-dev-secret-change-in-production';
function getStateSecret(env = process.env) {
  return env.SESSION_SECRET || DEV_FALLBACK_SECRET;
}

function signState(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyState(state, secret, now = Date.now()) {
  if (typeof state !== 'string' || !state.includes('.')) return null;
  const [body, sig] = state.split('.', 2);
  const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  if (!sig || sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch (_) { return null; }
  if (!payload || typeof payload !== 'object') return null;
  if (typeof payload.exp !== 'number' || payload.exp < now) return null;
  return payload;
}

function newState({ secret, next, now = Date.now() }) {
  const nonce = crypto.randomBytes(16).toString('base64url');
  return { nonce, state: signState({ nonce, next: safeNext(next), exp: now + STATE_TTL_MS }, secret) };
}

/**
 * Google の ID トークン（検証済み payload）からログイン用メールを取り出す。
 * email_verified が true でないものは使わない（未確認メールでのなりすまし防止）。
 */
const GMAIL_DOMAINS = ['gmail.com', 'googlemail.com'];

/**
 * Google がそのメールアドレスの「正当な持ち主」を保証できるか（Google 公式: Verify the Google ID token）。
 *   - @gmail.com / @googlemail.com → Google 自身がメールを管理しているので保証できる
 *   - hd（Google Workspace のドメイン）があり、メールのドメインと一致 → Workspace 管理者が管理しているので保証できる
 *   - それ以外（Yahoo!・独自ドメイン等で作った Google アカウント）→ email_verified は「作成時に一度確認した」だけで、
 *     そのアドレスが後で別人に引き継がれても古い Google アカウントは残る。保証できないのでログインに使わない
 */
function isGoogleAuthoritative(email, hd) {
  const domain = String(email || '').split('@')[1] || '';
  if (GMAIL_DOMAINS.includes(domain)) return true;
  const h = String(hd || '').trim().toLowerCase();
  return !!h && h === domain;
}

function extractVerifiedEmail(payload) {
  if (!payload || typeof payload !== 'object') return { error: 'no_email' };
  const email = String(payload.email || '').trim().toLowerCase();
  if (!email) return { error: 'no_email' };
  if (payload.email_verified !== true && payload.email_verified !== 'true') return { error: 'unverified' };
  if (!isGoogleAuthoritative(email, payload.hd)) return { error: 'not_authoritative' };
  return { email };
}

/** users を ilike で引くときのエスケープ（_ と % をワイルドカードにしない＝完全一致・大文字小文字だけ無視） */
function escapeLike(s) {
  return String(s || '').replace(/[\\%_]/g, ch => `\\${ch}`);
}

/** 照合結果から「ログインさせてよい 1 人」を決める */
function pickLoginUser(rows, email) {
  const list = (rows || []).filter(u => String(u.email || '').trim().toLowerCase() === email);
  if (!list.length) return { error: 'not_registered' };
  if (list.length > 1) return { error: 'ambiguous' };
  const u = list[0];
  if (!u.is_active) return { error: 'inactive' };
  return { user: u };
}

// login.html の ?error=<code> 表示用（login.html 側にも同じ文言の表を持つ）
const ERROR_MESSAGES = {
  google_disabled: 'Googleログインは現在使えません。メールアドレスとパスワードでログインしてください。',
  google_host: 'このアドレスからはGoogleログインできません。app.harukafilm.com から開き直してください。',
  google_state: 'ログインの有効期限が切れました。もう一度「Googleでログイン」を押してください。',
  google_cancel: 'Googleログインがキャンセルされました。',
  google_failed: 'Googleログインに失敗しました。少し時間をおいてもう一度お試しください。',
  no_email: 'Googleアカウントのメールアドレスを取得できませんでした。',
  unverified: 'Googleアカウントのメールアドレスが確認済みではありません。',
  not_authoritative: 'このメールアドレスはGoogleでログインできません（Gmail と Google Workspace のアドレスのみ対応）。メールアドレスとパスワードでログインしてください。',
  not_registered: 'このGoogleアカウントのメールアドレスはHARUKA FILMに登録されていません。招待されたメールアドレスのGoogleアカウントでログインしてください。',
  ambiguous: '同じメールアドレスのアカウントが複数あります。管理者に連絡してください。',
  inactive: 'このアカウントは無効化されています。',
};

module.exports = {
  CALLBACK_PATH,
  STATE_TTL_MS,
  ERROR_MESSAGES,
  getClientConfig,
  isEnabled,
  getAllowedHosts,
  normalizeHost,
  resolveCallbackUrl,
  safeNext,
  getStateSecret,
  signState,
  verifyState,
  newState,
  extractVerifiedEmail,
  isGoogleAuthoritative,
  escapeLike,
  pickLoginUser,
};
