// lib/google-auth-token.js — Vertex AI 用 OAuth token 取得の堅牢化
//
// @google-cloud/vertexai 内蔵の古い google-auth-library/gtoken を通さず、
// 直接依存の google-auth-library で JWT access token を取得する。
// token endpoint への通信は IPv4 強制 + keep-alive 無効 + 指数バックオフ。

const https = require('https');
const { URL } = require('url');
const { JWT } = require('google-auth-library');

const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const DEFAULT_RETRY_COUNT = 4;
const DEFAULT_TIMEOUT_MS = 20000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function toPositiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function getRetryCount() {
  return toPositiveInt(process.env.GOOGLE_AUTH_TOKEN_RETRY_COUNT, DEFAULT_RETRY_COUNT);
}

function getTimeoutMs() {
  return toPositiveInt(process.env.GOOGLE_AUTH_TOKEN_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
}

function errorCode(e) {
  return e?.code || e?.cause?.code || e?.error?.code || null;
}

function isRetryableTokenError(e) {
  const code = errorCode(e);
  if ([
    'ERR_STREAM_PREMATURE_CLOSE',
    'ECONNRESET',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'EAI_AGAIN',
    'ENOTFOUND',
    'EPIPE',
    'UND_ERR_SOCKET',
    'UND_ERR_CONNECT_TIMEOUT',
    'TimeoutError',
  ].includes(code)) {
    return true;
  }
  const status = e?.status || e?.response?.status;
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

function serializeTokenError(e) {
  return {
    name: e?.name || null,
    message: e?.message || String(e),
    code: errorCode(e),
    status: e?.status || e?.response?.status || null,
    cause: e?.cause ? {
      name: e.cause.name || null,
      message: e.cause.message || String(e.cause),
      code: e.cause.code || null,
    } : null,
  };
}

function normalizeHeaders(headers) {
  const out = {};
  if (!headers) return out;
  if (typeof headers.forEach === 'function') {
    headers.forEach((value, key) => { out[key.toLowerCase()] = value; });
    return out;
  }
  for (const [key, value] of Object.entries(headers)) {
    out[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return out;
}

function encodeRequestBody(data) {
  if (data instanceof URLSearchParams) return data.toString();
  if (typeof data === 'string' || Buffer.isBuffer(data)) return data;
  if (data && typeof data === 'object') return new URLSearchParams(data).toString();
  return '';
}

function tokenEndpointRequest(opts) {
  return new Promise((resolve, reject) => {
    const url = new URL(String(opts.url || 'https://oauth2.googleapis.com/token'));
    const method = String(opts.method || 'POST').toUpperCase();
    const body = encodeRequestBody(opts.data);
    const headers = normalizeHeaders(opts.headers);
    if (!headers['content-type']) headers['content-type'] = 'application/x-www-form-urlencoded';
    if (!headers.accept) headers.accept = 'application/json';
    headers['content-length'] = Buffer.byteLength(body);
    headers.connection = 'close';

    const req = https.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || 443,
      path: `${url.pathname}${url.search}`,
      method,
      headers,
      family: 4,
      agent: new https.Agent({ keepAlive: false, family: 4 }),
      timeout: getTimeoutMs(),
    }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let data = raw;
        try { data = raw ? JSON.parse(raw) : {}; } catch (_) { /* keep raw */ }
        const response = {
          status: res.statusCode,
          statusText: res.statusMessage,
          headers: res.headers,
          data,
          config: opts,
        };
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(response);
          return;
        }
        const err = new Error(
          typeof data === 'object' && data?.error
            ? `${data.error}: ${data.error_description || data.error}`
            : `Token endpoint HTTP ${res.statusCode}`
        );
        err.status = res.statusCode;
        err.response = response;
        reject(err);
      });
      res.on('error', reject);
    });

    req.on('timeout', () => {
      const err = new Error(`Token endpoint timeout after ${getTimeoutMs()}ms`);
      err.code = 'TimeoutError';
      req.destroy(err);
    });
    req.on('error', reject);
    req.end(body);
  });
}

function createTokenTransporter() {
  return {
    async request(opts) {
      const retryCount = getRetryCount();
      let lastError;
      for (let attempt = 1; attempt <= retryCount; attempt++) {
        try {
          const res = await tokenEndpointRequest(opts);
          if (attempt > 1) {
            console.info('[google-auth-token] token-request-recovered', JSON.stringify({ attempt }));
          }
          return res;
        } catch (e) {
          lastError = e;
          const retryable = isRetryableTokenError(e);
          console.warn('[google-auth-token] token-request-failed', JSON.stringify({
            attempt,
            max_attempts: retryCount,
            retryable,
            error: serializeTokenError(e),
          }));
          if (!retryable || attempt >= retryCount) break;
          const delay = Math.min(5000, 250 * Math.pow(2, attempt - 1));
          await sleep(delay);
        }
      }
      throw lastError;
    },
  };
}

function createResilientJwtClient(credentials, { projectId } = {}) {
  const client = new JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    keyId: credentials.private_key_id,
    projectId: projectId || credentials.project_id,
    scopes: [CLOUD_PLATFORM_SCOPE],
    transporter: createTokenTransporter(),
    useAuthRequestParameters: false,
    eagerRefreshThresholdMillis: 5 * 60 * 1000,
    forceRefreshOnFailure: true,
  });
  client.fromJSON(credentials);
  client.scopes = [CLOUD_PLATFORM_SCOPE];
  return client;
}

module.exports = {
  CLOUD_PLATFORM_SCOPE,
  createResilientJwtClient,
  createTokenTransporter,
  serializeTokenError,
  isRetryableTokenError,
};
