// lib/google-calendar.js — Google Calendar API クライアント（ADR 017 Phase 0）
//
// 既存の Drive 連携（lib/drive-share.js 等）はサービスアカウントを使うが、
// 本モジュールはメンバー個人の OAuth2（refresh_token）で動く点が異なる。
//
// 必要な環境変数:
//   GOOGLE_CALENDAR_CLIENT_ID
//   GOOGLE_CALENDAR_CLIENT_SECRET
//   GOOGLE_CALENDAR_REDIRECT_URI
//
// 公開API:
//   makeOAuth2Client()
//   buildAuthUrl({ state, redirectUri? })
//   exchangeCodeForTokens(code, redirectUri?)
//   fetchEventsForRange({ refreshToken, calendarId, from, to })
//   fetchAccountEmail(refreshToken)
//
// エラー型:
//   GCalAuthError       — refresh_token 失効 / invalid_grant
//   GCalRateLimitError  — 429 Too Many Requests
//
// それ以外の例外は素通しで上位に伝播させる。

const { google } = require('googleapis');

const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events.readonly',
  // userinfo.email は接続中アカウントの email 取得用（UI で表示）
  'https://www.googleapis.com/auth/userinfo.email',
  'openid',
];

class GCalAuthError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'GCalAuthError';
    this.cause = cause;
  }
}

class GCalRateLimitError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'GCalRateLimitError';
    this.cause = cause;
  }
}

function requireEnv() {
  const id = process.env.GOOGLE_CALENDAR_CLIENT_ID;
  const secret = process.env.GOOGLE_CALENDAR_CLIENT_SECRET;
  const redirect = process.env.GOOGLE_CALENDAR_REDIRECT_URI;
  if (!id || !secret || !redirect) {
    throw new Error('GOOGLE_CALENDAR_CLIENT_ID / GOOGLE_CALENDAR_CLIENT_SECRET / GOOGLE_CALENDAR_REDIRECT_URI を設定してください（ADR 017 Phase 0）');
  }
  return { id, secret, redirect };
}

function makeOAuth2Client(redirectUri) {
  const { id, secret, redirect } = requireEnv();
  return new google.auth.OAuth2(id, secret, redirectUri || redirect);
}

/**
 * 認可 URL を生成する。state は呼び出し側で「userId + nonce + 署名」を埋め込む。
 * @param {object} args
 * @param {string} args.state            CSRF 防止用 state 文字列
 * @param {string} [args.redirectUri]    上書き redirect_uri（未指定なら env の値）
 * @returns {string}
 */
function buildAuthUrl({ state, redirectUri }) {
  if (!state) throw new Error('buildAuthUrl: state が必要です');
  const oauth2 = makeOAuth2Client(redirectUri);
  return oauth2.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',       // 既に許諾済みでも refresh_token を確実に取るため
    scope: SCOPES,
    include_granted_scopes: true,
    state,
  });
}

/**
 * 認可コード -> refresh_token / access_token 交換。
 * @returns {Promise<{ refresh_token?: string, access_token?: string, expiry_date?: number, scope?: string, token_type?: string, id_token?: string }>}
 */
async function exchangeCodeForTokens(code, redirectUri) {
  if (!code) throw new Error('exchangeCodeForTokens: code が必要です');
  const oauth2 = makeOAuth2Client(redirectUri);
  try {
    const { tokens } = await oauth2.getToken(code);
    return tokens;
  } catch (e) {
    const status = e?.response?.status || e?.code;
    if (status === 401 || /invalid_grant/i.test(e?.message || '')) {
      throw new GCalAuthError('Google 認可に失敗しました（コード失効の可能性）', e);
    }
    throw e;
  }
}

/**
 * refresh_token から接続中アカウントの email を取得する。
 */
async function fetchAccountEmail(refreshToken) {
  if (!refreshToken) throw new Error('fetchAccountEmail: refreshToken が必要です');
  const oauth2 = makeOAuth2Client();
  oauth2.setCredentials({ refresh_token: refreshToken });
  try {
    const oauth2Api = google.oauth2({ version: 'v2', auth: oauth2 });
    const { data } = await oauth2Api.userinfo.get();
    return data.email || null;
  } catch (e) {
    const status = e?.response?.status || e?.code;
    if (status === 401 || /invalid_grant/i.test(e?.message || '')) {
      throw new GCalAuthError('Google 認可情報が失効しています（再接続が必要）', e);
    }
    if (status === 429) {
      throw new GCalRateLimitError('Google API レート制限に達しました', e);
    }
    throw e;
  }
}

/**
 * 指定範囲の予定を取得する。
 * @param {object} args
 * @param {string} args.refreshToken
 * @param {string} [args.calendarId='primary']
 * @param {string|Date} args.from  ISO 8601 文字列または Date
 * @param {string|Date} args.to
 * @returns {Promise<Array<{ id:string, summary:string, start:string, end:string, isAllDay:boolean, status:string }>>}
 */
async function fetchEventsForRange({ refreshToken, calendarId = 'primary', from, to }) {
  if (!refreshToken) throw new Error('fetchEventsForRange: refreshToken が必要です');
  if (!from || !to) throw new Error('fetchEventsForRange: from / to が必要です');

  const oauth2 = makeOAuth2Client();
  oauth2.setCredentials({ refresh_token: refreshToken });
  const cal = google.calendar({ version: 'v3', auth: oauth2 });

  const timeMin = (from instanceof Date) ? from.toISOString() : new Date(from).toISOString();
  const timeMax = (to instanceof Date) ? to.toISOString() : new Date(to).toISOString();

  try {
    const events = [];
    let pageToken = undefined;
    // ページングは最大 10 ページに制限（暴走防止）
    for (let i = 0; i < 10; i++) {
      const { data } = await cal.events.list({
        calendarId,
        timeMin,
        timeMax,
        singleEvents: true,    // 繰り返し予定を実体化
        orderBy: 'startTime',
        maxResults: 250,
        pageToken,
      });
      const items = data.items || [];
      for (const ev of items) {
        const isAllDay = !!(ev.start && ev.start.date && !ev.start.dateTime);
        events.push({
          id: ev.id,
          summary: ev.summary || '(no title)',
          start: ev.start?.dateTime || ev.start?.date || null,
          end: ev.end?.dateTime || ev.end?.date || null,
          isAllDay,
          status: ev.status || 'confirmed',
        });
      }
      if (!data.nextPageToken) break;
      pageToken = data.nextPageToken;
    }
    return events;
  } catch (e) {
    const status = e?.response?.status || e?.code;
    const msg = e?.message || '';
    if (status === 401 || /invalid_grant/i.test(msg)) {
      throw new GCalAuthError('Google 認可情報が失効しています（再接続が必要）', e);
    }
    if (status === 429) {
      throw new GCalRateLimitError('Google API レート制限に達しました', e);
    }
    throw e;
  }
}

module.exports = {
  SCOPES,
  GCalAuthError,
  GCalRateLimitError,
  makeOAuth2Client,
  buildAuthUrl,
  exchangeCodeForTokens,
  fetchEventsForRange,
  fetchAccountEmail,
};
