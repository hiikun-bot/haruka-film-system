// lib/gmail-send.js — 本人の Gmail からメールを 1 通送る（ADR 056 §3）
//
// トークンは user_oauth_tokens の scope_key='gmail.send'（lib/google-oauth.js が更新まで面倒を見る）。
// 権限は gmail.send（送信だけ）と userinfo.email（差出人アドレスの確認）。受信箱は読めない。

const oauthLib = require('./google-oauth');

const SCOPE_KEY = 'gmail.send';
const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
const SCOPES = [GMAIL_SEND_SCOPE, 'https://www.googleapis.com/auth/userinfo.email'];
const SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';

const notConnected = () => Object.assign(
  new Error('差出人の Gmail が HFS と連携されていません。「メール設定」から連携してください'),
  { status: 400, code: 'gmail_not_connected' },
);

// 同意画面で「メール送信」のチェックを外された場合は連携扱いにしない
const hasSendScope = (grantedScopes) => String(grantedScopes || '').split(/\s+/).includes(GMAIL_SEND_SCOPE);

async function isConnected(userId) {
  if (!oauthLib.isConfigured()) return false;
  const stored = await oauthLib.getStoredTokens({ userId, scopeKey: SCOPE_KEY });
  return !!(stored && stored.refresh_token && hasSendScope(stored.granted_scopes));
}

async function getAccessToken(userId) {
  if (!oauthLib.isConfigured()) throw notConnected();
  const stored = await oauthLib.getStoredTokens({ userId, scopeKey: SCOPE_KEY });
  if (!stored || !hasSendScope(stored.granted_scopes)) throw notConnected();
  const valid = await oauthLib.getValidAccessToken({ userId, scopeKey: SCOPE_KEY });
  if (!valid?.accessToken) throw notConnected();
  return valid.accessToken;
}

// 連携している Google アカウントのアドレス（＝実際の差出人）。10 分だけ覚える
const _emailCache = new Map();
async function getSenderEmail(userId) {
  const hit = _emailCache.get(String(userId));
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.email;
  const accessToken = await getAccessToken(userId);
  const resp = await fetch(USERINFO_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (resp.status === 401 || resp.status === 403) throw notConnected();
  if (!resp.ok) throw new Error(`Google アカウントの確認に失敗しました（${resp.status}）`);
  const email = String((await resp.json())?.email || '').trim();
  if (!email) throw notConnected();
  _emailCache.set(String(userId), { email, at: Date.now() });
  return email;
}
const forgetSenderEmail = (userId) => _emailCache.delete(String(userId));

// raw = utils/sales.js#buildRawMessage の base64url。戻り値は Gmail のメッセージ ID
async function sendRaw({ userId, raw }) {
  const accessToken = await getAccessToken(userId);
  const resp = await fetch(SEND_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw }),
  });
  if (resp.status === 401) throw notConnected();
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const reason = data?.error?.message || `HTTP ${resp.status}`;
    if (resp.status === 403 && /insufficient|scope/i.test(reason)) throw notConnected();
    throw Object.assign(new Error(`Gmail が送信を受け付けませんでした: ${reason}`), { status: 502, code: 'gmail_error' });
  }
  return { id: data.id || null, threadId: data.threadId || null };
}

async function disconnect(userId) {
  forgetSenderEmail(userId);
  await oauthLib.clearStoredTokens({ userId, scopeKey: SCOPE_KEY });
}

module.exports = { SCOPE_KEY, SCOPES, GMAIL_SEND_SCOPE, hasSendScope, isConnected, getSenderEmail, forgetSenderEmail, sendRaw, disconnect };
