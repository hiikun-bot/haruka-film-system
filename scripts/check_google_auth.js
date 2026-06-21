#!/usr/bin/env node
// GOOGLE_SERVICE_ACCOUNT_KEY で OAuth アクセストークンを直接取得できるか検証する。
// トークンや private_key 本体は表示しない。

require('dotenv').config();

const { GoogleAuth } = require('google-auth-library');
const {
  parseCredentialsFromEnv,
  logEnvCredentialsHealth,
  logCredentialsHealth,
} = require('../lib/google-service-account');

function getPackageVersion(packageName) {
  try {
    return require(`${packageName}/package.json`).version;
  } catch (_) {
    return null;
  }
}

function serializeError(e) {
  return {
    name: e?.name || null,
    message: e?.message || String(e),
    code: e?.code || null,
    status: e?.status || e?.response?.status || null,
    errors: e?.errors || e?.response?.data?.error?.errors || null,
    details: e?.details || e?.response?.data?.error || null,
    stack: e?.stack || null,
    cause: e?.cause ? {
      name: e.cause.name || null,
      message: e.cause.message || String(e.cause),
      code: e.cause.code || null,
      stack: e.cause.stack || null,
    } : null,
  };
}

async function main() {
  console.log('[google-auth-check] start', JSON.stringify({
    now: new Date().toISOString(),
    node: process.version,
    google_auth_library_version: getPackageVersion('google-auth-library'),
    vertexai_version: getPackageVersion('@google-cloud/vertexai'),
    google_cloud_project: process.env.GOOGLE_CLOUD_PROJECT || null,
    google_cloud_location: process.env.GOOGLE_CLOUD_LOCATION || 'asia-northeast1',
    gemini_model: process.env.GEMINI_MODEL || 'gemini-1.5-pro',
  }));

  logEnvCredentialsHealth('script:raw-env');
  const credentials = parseCredentialsFromEnv();
  logCredentialsHealth('script:normalized-credentials', credentials);

  const auth = new GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });

  try {
    const token = await auth.getAccessToken();
    if (!token) throw new Error('getAccessToken() returned empty token');
    console.log('[google-auth-check] token-ok', JSON.stringify({
      ok: true,
      token_type: typeof token,
      token_length: String(token).length,
    }));
  } catch (e) {
    console.error('[google-auth-check] token-failed', JSON.stringify({
      ok: false,
      error: serializeError(e),
    }));
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error('[google-auth-check] fatal', JSON.stringify({
    ok: false,
    error: serializeError(e),
  }));
  process.exitCode = 1;
});
