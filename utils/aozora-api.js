// utils/aozora-api.js — GMOあおぞらネット銀行 法人向けオープン API クライアント（ADR 054 Stage B）
// =============================================================
// 役割:
//   - OAuth2（Authorization Code・OpenID Connect）の認可 URL 生成 / code→token / refresh
//   - アクセストークンの暗号化保管（utils/crypto-aes.js・鍵は AOZORA_TOKEN_ENCRYPTION_KEY）と期限前更新
//   - 口座一覧照会 / 総合振込（手数料事前照会・依頼・依頼結果照会・状況照会・取消依頼）
//   - 429 / 5xx / タイムアウトは指数バックオフで最大 3 回まで再試行（依頼は Idempotency-Key 付きなので二重受付にならない）
//   - エラーは仕様の errorCode / errorMessage / errorDetails / transferErrorDetails を AozoraApiError に構造化
//
// 仕様の根拠: オープンAPI仕様書 法人口座編 1.21.0（2026-09-14）・認可編 1.8.0
//   - ベース URL: https://{domain}/ganb/api/corporation/v1（本番 api.gmo-aozora.com / 開発 stg-api.gmo-aozora.com）
//   - 認可:       https://{domain}/ganb/api/auth/v1/authorization | /token
//   - API ヘッダ: x-access-token。トークン再発行は Basic 認証（client_id:client_secret）
//   - スコープ（仕様 p.6）: 電子決済等代行業者でない「その他」の事業者は private:* を使う
//       総合振込 5 API … private:bulk-transfer（状況照会・依頼結果照会も同じスコープ）
//       口座一覧照会   … private:account（accountId を取るためだけに必要。AOZORA_ACCOUNT_ID を env で
//                        指定すれば要求しない＝残高・入出金明細の権限を持たない）
//
// 環境変数:
//   ENABLE_AOZORA_TRANSFER=true         機能フラグ（既定 OFF）
//   AOZORA_ENV=staging|production       stg-api / api の切替（既定 staging）
//   AOZORA_CLIENT_ID / AOZORA_CLIENT_SECRET
//   AOZORA_TOKEN_ENCRYPTION_KEY         base64 32 バイト（openssl rand -base64 32）
//   AOZORA_CALLBACK_HOST                任意。戻り先ホスト（既定は Google ログインと同じ許可ホスト）
//   AOZORA_ACCOUNT_ID                   任意。口座 ID を固定する（指定時は private:account を要求しない）
//   AOZORA_SCOPES                       任意。スコープを丸ごと上書き（スペース区切り）
//   AOZORA_CANCEL_TARGET_KEY_CLASS      任意。総合振込取消依頼の取消対象キー区分（既定 4=ビジネスID管理未利用）
//
// ログにトークン・口座番号・受取人名を出さない（口座番号は下4桁のみ）。
// =============================================================

const crypto = require('crypto');
const axios = require('axios');
const supabase = require('../supabase');
const { createCipher } = require('./crypto-aes');

const PROVIDER = 'gmo_aozora';
const TOKEN_KEY_ENV = 'AOZORA_TOKEN_ENCRYPTION_KEY';
const DOMAINS = { staging: 'stg-api.gmo-aozora.com', production: 'api.gmo-aozora.com' };
const CALLBACK_PATH = '/api/haruka/admin/bank/callback';
const REFRESH_MARGIN_MS = 5 * 60 * 1000;     // 期限 5 分前なら更新
const REQUEST_TIMEOUT_MS = 30 * 1000;
const MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 1000;
const ID_TOKEN_MAX_AGE_SEC = 600;             // 認可編 p.9: iat は現在時刻 − 600 秒以上

const cipher = createCipher(TOKEN_KEY_ENV);

// ---------- 設定 ----------
function isTruthy(v) {
  return ['true', '1', 'on', 'yes'].includes(String(v || '').trim().toLowerCase());
}

function getEnvName(env = process.env) {
  const e = String(env.AOZORA_ENV || 'staging').trim().toLowerCase();
  return e === 'production' ? 'production' : 'staging';
}

function getConfig(env = process.env) {
  const environment = getEnvName(env);
  const domain = DOMAINS[environment];
  return {
    enabled: isTruthy(env.ENABLE_AOZORA_TRANSFER),
    environment,
    domain,
    apiBase: `https://${domain}/ganb/api/corporation/v1`,
    authBase: `https://${domain}/ganb/api/auth/v1`,
    issuer: `https://${domain}/`,
    clientId: String(env.AOZORA_CLIENT_ID || '').trim(),
    clientSecret: String(env.AOZORA_CLIENT_SECRET || '').trim(),
    callbackHost: String(env.AOZORA_CALLBACK_HOST || '').trim(),
    fixedAccountId: String(env.AOZORA_ACCOUNT_ID || '').trim() || null,
    scopesOverride: String(env.AOZORA_SCOPES || '').trim() || null,
    cancelTargetKeyClass: String(env.AOZORA_CANCEL_TARGET_KEY_CLASS || '4').trim() || '4',
  };
}

/** 機能フラグ ON かどうか（ルート登録・ワーカ起動の判定） */
function isEnabled(env = process.env) {
  return getConfig(env).enabled;
}

/** 接続に必要な設定が揃っているか。足りなければ理由を返す */
function configProblems(env = process.env) {
  const c = getConfig(env);
  const problems = [];
  if (!c.enabled) problems.push('ENABLE_AOZORA_TRANSFER が true ではありません');
  if (!c.clientId) problems.push('AOZORA_CLIENT_ID が未設定です');
  if (!c.clientSecret) problems.push('AOZORA_CLIENT_SECRET が未設定です');
  if (!cipher.isConfigured()) problems.push(`${TOKEN_KEY_ENV} が未設定か 32 バイトではありません（openssl rand -base64 32）`);
  return problems;
}

/** 要求するスコープ（スペース区切り） */
function getScopes(env = process.env) {
  const c = getConfig(env);
  if (c.scopesOverride) return c.scopesOverride;
  const scopes = ['openid', 'offline_access', 'private:bulk-transfer'];
  if (!c.fixedAccountId) scopes.push('private:account'); // 口座一覧照会で accountId を取るためだけ
  return scopes.join(' ');
}

// ---------- ログ用マスク ----------
function last4(v) {
  const s = String(v ?? '');
  return s.length >= 4 ? '****' + s.slice(-4) : '****';
}

// ---------- OAuth ----------
function buildAuthorizeUrl({ state, redirectUri, nonce, env = process.env }) {
  const c = getConfig(env);
  const params = new URLSearchParams({
    response_type: 'code',
    scope: getScopes(env),
    client_id: c.clientId,
    state: String(state),
    redirect_uri: redirectUri,
  });
  if (nonce) params.set('nonce', String(nonce));
  return `${c.authBase}/authorization?${params.toString()}`;
}

function basicAuthHeader(c) {
  return 'Basic ' + Buffer.from(`${c.clientId}:${c.clientSecret}`, 'utf8').toString('base64');
}

async function postTokenEndpoint(form, env = process.env) {
  const c = getConfig(env);
  const res = await axios.post(`${c.authBase}/token`, new URLSearchParams(form).toString(), {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: basicAuthHeader(c),
    },
    timeout: REQUEST_TIMEOUT_MS,
    validateStatus: () => true,
  });
  if (res.status !== 200 || !res.data || !res.data.access_token) {
    const d = res.data || {};
    throw new AozoraApiError({
      status: res.status,
      errorCode: d.error || 'token_error',
      errorMessage: d.error_description || `トークンエンドポイントが HTTP ${res.status} を返しました`,
      phase: 'token',
    });
  }
  return res.data; // { access_token, refresh_token, scope, token_type, expires_in, id_token }
}

/** 認可コード → トークン */
function exchangeCode({ code, redirectUri, env = process.env }) {
  return postTokenEndpoint({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }, env);
}

/** リフレッシュトークン → 新しいアクセストークン */
function refreshAccessToken(refreshToken, env = process.env) {
  return postTokenEndpoint({ grant_type: 'refresh_token', refresh_token: refreshToken }, env);
}

function b64urlDecode(s) {
  return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/**
 * ID トークン（HS256・鍵はクライアントシークレット）を検証する（認可編 p.9）。
 * @returns {{ ok: true, payload: object } | { ok: false, reason: string }}
 */
function verifyIdToken(idToken, { nonce, now = Math.floor(Date.now() / 1000), env = process.env } = {}) {
  const c = getConfig(env);
  if (typeof idToken !== 'string' || idToken.split('.').length !== 3) return { ok: false, reason: 'format' };
  const [h, p, s] = idToken.split('.');
  let header, payload;
  try {
    header = JSON.parse(b64urlDecode(h).toString('utf8'));
    payload = JSON.parse(b64urlDecode(p).toString('utf8'));
  } catch (_) { return { ok: false, reason: 'decode' }; }
  if (!header || header.alg !== 'HS256') return { ok: false, reason: 'alg' };
  const expected = crypto.createHmac('sha256', c.clientSecret).update(`${h}.${p}`).digest();
  const given = b64urlDecode(s);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return { ok: false, reason: 'signature' };
  if (String(payload.iss || '').replace(/\/+$/, '') !== c.issuer.replace(/\/+$/, '')) return { ok: false, reason: 'iss' };
  if (payload.aud !== c.clientId) return { ok: false, reason: 'aud' };
  if (payload.azp && payload.azp !== c.clientId) return { ok: false, reason: 'azp' };
  if (typeof payload.exp !== 'number' || payload.exp <= now) return { ok: false, reason: 'exp' };
  if (typeof payload.iat !== 'number' || payload.iat < now - ID_TOKEN_MAX_AGE_SEC) return { ok: false, reason: 'iat' };
  if (nonce && payload.nonce !== nonce) return { ok: false, reason: 'nonce' };
  return { ok: true, payload };
}

// ---------- トークン保管（bank_api_connections） ----------
const CONNECTION_COLUMNS = 'id, provider, environment, account_id, account_label, scopes, access_token_enc, access_token_iv, access_token_tag, refresh_token_enc, refresh_token_iv, refresh_token_tag, access_token_expires_at, connected_by, connected_at, revoked_at, last_used_at, updated_at';

function encryptTokens(tokens) {
  const a = cipher.encrypt(String(tokens.access_token));
  const out = {
    access_token_enc: a.ciphertext, access_token_iv: a.iv, access_token_tag: a.authTag,
    access_token_expires_at: new Date(Date.now() + (Number(tokens.expires_in) || 0) * 1000).toISOString(),
  };
  if (tokens.refresh_token) {
    const r = cipher.encrypt(String(tokens.refresh_token));
    out.refresh_token_enc = r.ciphertext; out.refresh_token_iv = r.iv; out.refresh_token_tag = r.authTag;
  }
  if (tokens.scope) out.scopes = String(tokens.scope);
  return out;
}

function decryptAccessToken(conn) {
  if (!conn || !conn.access_token_enc) return null;
  return cipher.decrypt({ ciphertext: conn.access_token_enc, iv: conn.access_token_iv, authTag: conn.access_token_tag });
}

function decryptRefreshToken(conn) {
  if (!conn || !conn.refresh_token_enc) return null;
  return cipher.decrypt({ ciphertext: conn.refresh_token_enc, iv: conn.refresh_token_iv, authTag: conn.refresh_token_tag });
}

/** 有効な接続（revoked_at IS NULL・現在の環境）。無ければ null */
async function loadActiveConnection(env = process.env) {
  const c = getConfig(env);
  const { data, error } = await supabase
    .from('bank_api_connections')
    .select(CONNECTION_COLUMNS)
    .eq('provider', PROVIDER)
    .eq('environment', c.environment)
    .is('revoked_at', null)
    .order('connected_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`bank_api_connections 取得失敗: ${error.message}（ADR 054 Stage A の migration 未適用の可能性）`);
  return data || null;
}

/** 接続行をトークンつきで作る（既存の有効行は同時に revoke する＝provider×environment で 1 件） */
async function saveConnection({ tokens, accountId, accountLabel, connectedBy, env = process.env }) {
  const c = getConfig(env);
  const nowIso = new Date().toISOString();
  await supabase
    .from('bank_api_connections')
    .update({ revoked_at: nowIso, updated_at: nowIso })
    .eq('provider', PROVIDER).eq('environment', c.environment).is('revoked_at', null);
  const row = {
    provider: PROVIDER,
    environment: c.environment,
    account_id: String(accountId),
    account_label: accountLabel || null,
    connected_by: connectedBy || null,
    connected_at: nowIso,
    updated_at: nowIso,
    ...encryptTokens(tokens),
  };
  const { data, error } = await supabase.from('bank_api_connections').insert(row).select(CONNECTION_COLUMNS).single();
  if (error) throw new Error(`bank_api_connections 保存失敗: ${error.message}`);
  return data;
}

/** 更新したトークンを保存して最新の行を返す */
async function persistRefreshedTokens(conn, tokens) {
  const patch = { ...encryptTokens(tokens), updated_at: new Date().toISOString() };
  const { data, error } = await supabase
    .from('bank_api_connections').update(patch).eq('id', conn.id).select(CONNECTION_COLUMNS).single();
  if (error) throw new Error(`bank_api_connections トークン更新の保存に失敗: ${error.message}`);
  return data;
}

/** 切断: トークン列を NULL にして revoked_at を立てる */
async function revokeConnection(connId) {
  const nowIso = new Date().toISOString();
  const { error } = await supabase.from('bank_api_connections').update({
    revoked_at: nowIso, updated_at: nowIso,
    access_token_enc: null, access_token_iv: null, access_token_tag: null,
    refresh_token_enc: null, refresh_token_iv: null, refresh_token_tag: null,
  }).eq('id', connId);
  if (error) throw new Error(`bank_api_connections 切断の保存に失敗: ${error.message}`);
}

async function touchLastUsed(connId) {
  try {
    await supabase.from('bank_api_connections').update({ last_used_at: new Date().toISOString() }).eq('id', connId);
  } catch (_) { /* noop */ }
}

/**
 * 有効なアクセストークンを返す。期限 5 分前以内なら refresh して DB に保存する。
 * @param {object} conn bank_api_connections 行
 * @param {{ onRefreshed?: (conn:object)=>Promise<void> }} [opts] 更新後のフック（監査ログ用）
 * @returns {Promise<{ accessToken: string, connection: object, refreshed: boolean }>}
 */
async function getValidAccessToken(conn, opts = {}) {
  if (!conn) throw new Error('銀行 API に接続されていません');
  const expiresAt = conn.access_token_expires_at ? new Date(conn.access_token_expires_at).getTime() : 0;
  const needsRefresh = !conn.access_token_enc || !expiresAt || expiresAt - Date.now() < REFRESH_MARGIN_MS;
  if (!needsRefresh) return { accessToken: decryptAccessToken(conn), connection: conn, refreshed: false };
  const refreshToken = decryptRefreshToken(conn);
  if (!refreshToken) throw new AozoraApiError({ status: 401, errorCode: 'no_refresh_token', errorMessage: 'リフレッシュトークンがありません。銀行 API を接続し直してください', phase: 'token' });
  const tokens = await refreshAccessToken(refreshToken);
  const updated = await persistRefreshedTokens(conn, tokens);
  console.log(`[aozora] アクセストークンを更新しました connection=${conn.id} expires_in=${tokens.expires_in}`);
  if (typeof opts.onRefreshed === 'function') {
    try { await opts.onRefreshed(updated); } catch (e) { console.warn('[aozora] onRefreshed 失敗:', e.message); }
  }
  return { accessToken: tokens.access_token, connection: updated, refreshed: true };
}

// ---------- HTTP ----------
class AozoraApiError extends Error {
  constructor({ status, errorCode, errorMessage, errorDetails, transferErrorDetails, phase, retried }) {
    super(errorMessage || `銀行 API エラー（HTTP ${status || '-'}）`);
    this.name = 'AozoraApiError';
    this.status = status || null;
    this.errorCode = errorCode || null;
    this.errorMessage = errorMessage || null;
    this.errorDetails = Array.isArray(errorDetails) ? errorDetails : [];
    this.transferErrorDetails = Array.isArray(transferErrorDetails) ? transferErrorDetails : [];
    this.phase = phase || 'api';
    this.retried = retried || 0;
  }
  /** API レスポンス・監査ログ向け（秘密情報なし） */
  toJSON() {
    return {
      status: this.status,
      error_code: this.errorCode,
      error_message: this.errorMessage,
      error_details: this.errorDetails.map(d => ({ code: d.errorDetailsCode || d.code || null, message: d.errorDetailsMessage || d.message || null })),
      transfer_error_details: this.transferErrorDetails.map(t => ({
        item_id: t.itemId != null ? Number(t.itemId) : null,
        errors: (Array.isArray(t.errorDetails) ? t.errorDetails : []).map(d => ({ code: d.errorDetailsCode || null, message: d.errorDetailsMessage || null })),
      })),
      phase: this.phase,
    };
  }
}

function isRetryable(status) {
  return status === 429 || (status >= 500 && status <= 599);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * 銀行 API を呼ぶ（x-access-token・JSON）。429/5xx/タイムアウトは指数バックオフで再試行。
 * @returns {Promise<object>} レスポンス JSON
 */
async function apiRequest({ method, path, accessToken, query, body, idempotencyKey, env = process.env }) {
  const c = getConfig(env);
  const headers = { 'x-access-token': accessToken, Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res;
    try {
      res = await axios.request({
        method, url: `${c.apiBase}${path}`, headers,
        params: query || undefined,
        data: body !== undefined ? JSON.stringify(body) : undefined,
        timeout: REQUEST_TIMEOUT_MS,
        validateStatus: () => true,
      });
    } catch (e) {
      // ネットワーク断・タイムアウト（依頼は Idempotency-Key 付きなので再送しても二重受付にならない）
      lastErr = new AozoraApiError({ status: null, errorCode: e.code || 'network', errorMessage: `銀行 API へ接続できませんでした（${e.message}）`, retried: attempt - 1 });
      console.warn(`[aozora] ${method} ${path} 接続失敗 attempt=${attempt}: ${e.code || e.message}`);
    }
    if (res) {
      if (res.status >= 200 && res.status < 300) return res.data || {};
      const d = res.data && typeof res.data === 'object' ? res.data : {};
      lastErr = new AozoraApiError({
        status: res.status,
        errorCode: d.errorCode || null,
        errorMessage: d.errorMessage || `銀行 API が HTTP ${res.status} を返しました`,
        errorDetails: d.errorDetails,
        transferErrorDetails: d.transferErrorDetails,
        retried: attempt - 1,
      });
      console.warn(`[aozora] ${method} ${path} HTTP ${res.status} code=${d.errorCode || '-'} attempt=${attempt}`);
      if (!isRetryable(res.status)) throw lastErr;
    }
    if (attempt < MAX_ATTEMPTS) await sleep(BACKOFF_BASE_MS * 2 ** (attempt - 1));
  }
  throw lastErr;
}

// ---------- 各 API（conn = bank_api_connections 行） ----------
async function withToken(conn, opts, fn) {
  const { accessToken, connection } = await getValidAccessToken(conn, opts);
  const out = await fn(accessToken, connection);
  touchLastUsed(connection.id);
  return out;
}

/** GET /accounts（要 private:account） */
function listAccounts(conn, opts = {}) {
  return withToken(conn, opts, (token) => apiRequest({ method: 'GET', path: '/accounts', accessToken: token }));
}

/** アクセストークン直指定版（接続前・accountId を決める段階で使う） */
function listAccountsWithToken(accessToken) {
  return apiRequest({ method: 'GET', path: '/accounts', accessToken });
}

/** POST /bulktransfer/transferfee */
function bulkTransferFeePrecheck(conn, body, opts = {}) {
  return withToken(conn, opts, (token) => apiRequest({ method: 'POST', path: '/bulktransfer/transferfee', accessToken: token, body }));
}

/** POST /bulktransfer/request（Idempotency-Key 必須） */
function bulkTransferRequest(conn, body, idempotencyKey, opts = {}) {
  if (!idempotencyKey) throw new Error('bulkTransferRequest: idempotencyKey は必須です');
  return withToken(conn, opts, (token) => apiRequest({ method: 'POST', path: '/bulktransfer/request', accessToken: token, body, idempotencyKey }));
}

/** GET /bulktransfer/request-result?accountId&applyNo → { resultCode: '1'|'2'|'8', applyNo, applyEndDatetime? } */
function bulkTransferRequestResult(conn, { accountId, applyNo }, opts = {}) {
  return withToken(conn, opts, (token) => apiRequest({ method: 'GET', path: '/bulktransfer/request-result', accessToken: token, query: { accountId, applyNo } }));
}

/** GET /bulktransfer/status（受付番号指定・明細つき） */
function bulkTransferStatus(conn, { accountId, applyNo, detail = true, itemKey }, opts = {}) {
  const query = { accountId, queryKeyClass: '1', applyNo };
  if (detail) {
    query.detailInfoNecessity = 'true';
    if (itemKey) query.bulktransferItemKey = String(itemKey);
  }
  return withToken(conn, opts, (token) => apiRequest({ method: 'GET', path: '/bulktransfer/status', accessToken: token, query }));
}

/**
 * GET /bulktransfer/status（一括照会・振込申請受付日の範囲）。応答が消えた依頼が受け付けられていないかを探す用。
 * 明細は取らない（queryKeyClass=2 では detailInfoNecessity=true が 400 になる）。
 */
function bulkTransferStatusByDate(conn, { accountId, dateFrom, dateTo, nextItemKey }, opts = {}) {
  const query = { accountId, queryKeyClass: '2', requestTransferTerm: '1' };
  if (dateFrom) query.dateFrom = String(dateFrom);
  if (dateTo) query.dateTo = String(dateTo);
  if (nextItemKey) query.nextItemKey = String(nextItemKey);
  return withToken(conn, opts, (token) => apiRequest({ method: 'GET', path: '/bulktransfer/status', accessToken: token, query }));
}

/**
 * 「応答が消えた」エラーか（timeout / 接続断 / 5xx）。true なら銀行側で受け付けられている可能性があるので、
 * 同じ Idempotency-Key で再送するか、状況照会で確かめてから再送する（仕様 共通仕様＜更新処理に関する注意事項＞）。
 * 4xx（400 明細エラー・401・403 など）は確定した拒否なので false。
 */
function isLostResponse(err) {
  if (!(err instanceof AozoraApiError)) return false;
  if (err.phase === 'token') return false;
  return err.status == null || (err.status >= 500 && err.status <= 599) || err.status === 429;
}

/** POST /bulktransfer/cancel */
function bulkTransferCancel(conn, { accountId, applyNo, cancelTargetKeyClass }, opts = {}) {
  const body = { accountId, cancelTargetKeyClass: String(cancelTargetKeyClass || getConfig().cancelTargetKeyClass), applyNo };
  return withToken(conn, opts, (token) => apiRequest({ method: 'POST', path: '/bulktransfer/cancel', accessToken: token, body }));
}

// ---------- 口座一覧 → 使う口座を選ぶ ----------
const ACCOUNT_TYPE_NAMES = { '01': '普通', '02': '普通（決済用）', '11': '円定期', '51': '外貨普通', '61': '外貨定期', '81': '証券コネクト' };

/** 口座一覧から振込元に使う円普通預金口座を選ぶ（代表口座 → 先頭の普通預金） */
function pickTransferAccount(accounts) {
  const list = Array.isArray(accounts) ? accounts : [];
  const ordinary = list.filter(a => ['01', '02'].includes(String(a.accountTypeCode)) && String(a.currencyCode || 'JPY') === 'JPY');
  return ordinary.find(a => String(a.primaryAccountCode) === '1') || ordinary[0] || null;
}

/** 画面表示用ラベル（口座番号は下4桁のみ） */
function accountLabelOf(a) {
  if (!a) return null;
  const type = ACCOUNT_TYPE_NAMES[String(a.accountTypeCode)] || a.accountTypeName || '';
  return [a.branchName || '', type, a.accountNumber ? last4(a.accountNumber) : ''].filter(Boolean).join(' ');
}

// ---------- ステータス変換（仕様 p.95〜96） ----------
// 総合振込状況照会 bulkTransferDetails[].transferStatus → payout_transfer_batches.status
const TRANSFER_STATUS_TO_BATCH = {
  '2': 'awaiting_approval', // 申請中
  '3': 'cancelled',         // 差戻
  '4': 'cancelled',         // 取下げ
  '5': 'expired',           // 期限切れ
  '8': 'cancelled',         // 承認取消/予約取消
  '11': 'approved',         // 予約中
  '12': 'processing',       // 手続中
  '13': 'processing',       // リトライ中
  '20': 'completed',        // 手続済
  '30': 'completed',        // 不能・組戻あり（明細ごとに returned / failed）
  '40': 'failed',           // 手続不成立
};
const TRANSFER_STATUS_NAMES = {
  '2': '申請中', '3': '差戻', '4': '取下げ', '5': '期限切れ', '8': '承認取消/予約取消',
  '11': '予約中', '12': '手続中', '13': 'リトライ中', '20': '手続済', '30': '不能・組戻あり', '40': '手続不成立',
};

function mapTransferStatus(code) {
  return TRANSFER_STATUS_TO_BATCH[String(code)] || null;
}

/**
 * 状況照会の明細 1 件 → payout_transfer_items.status
 *   unableDetailInfos[].transferDetailStatus 1=手続済 2=手続不成立、refundStatus 1〜3=組戻、isRepayment=資金返却
 */
function mapItemStatus(info, batchStatus) {
  const un = Array.isArray(info?.unableDetailInfos) ? info.unableDetailInfos : [];
  const detailStatus = un.map(u => String(u.transferDetailStatus || '')).find(Boolean) || null;
  const refund = un.map(u => String(u.refundStatus || '')).find(Boolean) || null;
  const repaid = un.some(u => u.isRepayment === true);
  if (detailStatus === '2') return 'failed';
  if (repaid || refund === '2') return 'returned';
  if (detailStatus === '1') return 'completed';
  if (batchStatus === 'completed') return 'completed';
  if (batchStatus === 'failed') return 'failed';
  return 'pending';
}

module.exports = {
  PROVIDER,
  CALLBACK_PATH,
  TOKEN_KEY_ENV,
  CONNECTION_COLUMNS,
  AozoraApiError,
  getConfig,
  isEnabled,
  configProblems,
  getScopes,
  last4,
  buildAuthorizeUrl,
  exchangeCode,
  refreshAccessToken,
  verifyIdToken,
  loadActiveConnection,
  saveConnection,
  persistRefreshedTokens,
  revokeConnection,
  getValidAccessToken,
  apiRequest,
  listAccounts,
  listAccountsWithToken,
  bulkTransferFeePrecheck,
  bulkTransferRequest,
  bulkTransferRequestResult,
  bulkTransferStatus,
  bulkTransferStatusByDate,
  bulkTransferCancel,
  isLostResponse,
  pickTransferAccount,
  accountLabelOf,
  mapTransferStatus,
  mapItemStatus,
  TRANSFER_STATUS_TO_BATCH,
  TRANSFER_STATUS_NAMES,
};
