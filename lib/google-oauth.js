// lib/google-oauth.js — ユーザーOAuth（Google）トークン管理
//
// 役割:
//   - Drive Resumable Upload（ブラウザ→Drive 直送）のために、ユーザー本人の
//     OAuth トークンを取得・保存・リフレッシュする
//   - 既存サーバーサイド Drive 操作はサービスアカウント（GOOGLE_SERVICE_ACCOUNT_KEY）
//     のまま。本モジュールはユーザーOAuthだけを担当（責務分離）
//
// 必要な環境変数:
//   GOOGLE_OAUTH_CLIENT_ID       — Google Cloud Console で発行した OAuth クライアントID
//   GOOGLE_OAUTH_CLIENT_SECRET   — 同シークレット
//   GOOGLE_OAUTH_REDIRECT_URI    — 例: https://haruka-film-system-production.up.railway.app/oauth/google/callback
//   GOOGLE_OAUTH_SCOPES          — 任意。デフォルト 'https://www.googleapis.com/auth/drive.file'
//
// スコープは drive.file（非機密スコープ）を既定。Workspace Internal 公開のため審査不要。

const { google } = require('googleapis');
const supabase = require('../supabase');

const DEFAULT_SCOPES = ['https://www.googleapis.com/auth/drive.file'];

function getConfiguredScopes() {
  const env = String(process.env.GOOGLE_OAUTH_SCOPES || '').trim();
  if (!env) return DEFAULT_SCOPES;
  return env.split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
}

function isConfigured() {
  return !!(
    process.env.GOOGLE_OAUTH_CLIENT_ID &&
    process.env.GOOGLE_OAUTH_CLIENT_SECRET &&
    process.env.GOOGLE_OAUTH_REDIRECT_URI
  );
}

function getOAuth2Client() {
  if (!isConfigured()) {
    throw new Error('Google OAuth が未設定です（GOOGLE_OAUTH_CLIENT_ID / SECRET / REDIRECT_URI を Railway 環境変数に設定してください）');
  }
  return new google.auth.OAuth2(
    process.env.GOOGLE_OAUTH_CLIENT_ID,
    process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    process.env.GOOGLE_OAUTH_REDIRECT_URI,
  );
}

// OAuth 同意画面 URL を生成する。
// access_type=offline + prompt=consent で refresh_token を必ず取得する（Internal
// 同意画面でも初回承認時のみしか refresh_token は返らない）。
function buildConsentUrl({ state, scopes }) {
  const client = getOAuth2Client();
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: true,
    scope: scopes || getConfiguredScopes(),
    state: state || '',
  });
}

// callback で受け取った code をトークンに交換する
async function exchangeCode(code) {
  const client = getOAuth2Client();
  const { tokens } = await client.getToken(code);
  return tokens; // { access_token, refresh_token, expires_in, expiry_date, scope, token_type }
}

// DB に upsert（既存があれば refresh_token 等を更新）。
//   - refresh_token は二度目以降の同意で返って来ないことがあるので、null の時は既存値を保持する。
async function saveTokens({ userId, tokens, scopeKey = 'drive.file' }) {
  if (!userId) throw new Error('userId required');
  if (!tokens || !tokens.access_token) throw new Error('tokens.access_token required');

  const expiresAt = tokens.expiry_date
    ? new Date(tokens.expiry_date).toISOString()
    : (typeof tokens.expires_in === 'number'
        ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
        : null);

  // 既存行を取得（refresh_token 保護のため）
  const { data: existing } = await supabase
    .from('user_oauth_tokens')
    .select('id, refresh_token')
    .eq('user_id', userId)
    .eq('provider', 'google')
    .eq('scope_key', scopeKey)
    .maybeSingle();

  const row = {
    user_id: userId,
    provider: 'google',
    scope_key: scopeKey,
    granted_scopes: tokens.scope || null,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token || existing?.refresh_token || null,
    token_type: tokens.token_type || 'Bearer',
    expires_at: expiresAt,
  };

  if (existing?.id) {
    const { error } = await supabase
      .from('user_oauth_tokens')
      .update(row)
      .eq('id', existing.id);
    if (error) throw error;
  } else {
    const { error } = await supabase
      .from('user_oauth_tokens')
      .insert(row);
    if (error) throw error;
  }
}

// DB から該当ユーザーのトークン行を取得（無ければ null）
async function getStoredTokens({ userId, scopeKey = 'drive.file' }) {
  if (!userId) return null;
  const { data, error } = await supabase
    .from('user_oauth_tokens')
    .select('*')
    .eq('user_id', userId)
    .eq('provider', 'google')
    .eq('scope_key', scopeKey)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

// 有効な access_token を返す。失効が近ければ refresh_token で再発行して保存する。
// 戻り値: { accessToken, expiresAt } / 未連携時は null
async function getValidAccessToken({ userId, scopeKey = 'drive.file' }) {
  const stored = await getStoredTokens({ userId, scopeKey });
  if (!stored) return null;

  const now = Date.now();
  const expiresMs = stored.expires_at ? new Date(stored.expires_at).getTime() : 0;
  // 60秒以上余裕があればそのまま返す
  if (stored.access_token && expiresMs - now > 60_000) {
    return { accessToken: stored.access_token, expiresAt: stored.expires_at };
  }

  // リフレッシュが必要
  if (!stored.refresh_token) {
    // refresh_token を持っていない → 再度同意フローが必要
    return null;
  }

  const client = getOAuth2Client();
  client.setCredentials({ refresh_token: stored.refresh_token });
  let refreshed;
  try {
    const resp = await client.getAccessToken();
    // getAccessToken は { token, res } を返す。res.data に新しい tokens がある場合がある
    const newTokens = (resp && resp.res && resp.res.data) || null;
    refreshed = {
      access_token: (newTokens && newTokens.access_token) || resp.token,
      expires_in: newTokens && newTokens.expires_in,
      expiry_date: newTokens && newTokens.expires_in
        ? Date.now() + newTokens.expires_in * 1000
        : null,
      scope: newTokens && newTokens.scope,
      token_type: (newTokens && newTokens.token_type) || stored.token_type || 'Bearer',
      // refresh_token は通常返って来ないが、念のため保護
      refresh_token: (newTokens && newTokens.refresh_token) || null,
    };
  } catch (e) {
    // invalid_grant 等で失敗 → 連携切れと判断し、行は残したまま null を返して再同意を促す
    console.error('[google-oauth] refresh failed:', e?.message || e);
    return null;
  }

  await saveTokens({ userId, tokens: refreshed, scopeKey });
  return {
    accessToken: refreshed.access_token,
    expiresAt: refreshed.expiry_date ? new Date(refreshed.expiry_date).toISOString() : null,
  };
}

// ユーザーOAuth連携を破棄する（再同意したいとき / refresh_token 切れの時の手動リセット）
async function clearStoredTokens({ userId, scopeKey = 'drive.file' }) {
  if (!userId) return;
  await supabase
    .from('user_oauth_tokens')
    .delete()
    .eq('user_id', userId)
    .eq('provider', 'google')
    .eq('scope_key', scopeKey);
}

module.exports = {
  isConfigured,
  getConfiguredScopes,
  buildConsentUrl,
  exchangeCode,
  saveTokens,
  getStoredTokens,
  getValidAccessToken,
  clearStoredTokens,
};
