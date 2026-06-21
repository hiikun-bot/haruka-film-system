// lib/google-service-account.js — GOOGLE_SERVICE_ACCOUNT_KEY の安全な読み取り/診断
//
// private_key 本体は絶対にログへ出さない。ログに出すのは形状・有無・長さだけ。

const LOG_PREFIX = '[google-sa]';

function maskId(value) {
  const s = String(value || '');
  if (!s) return null;
  return `${s.slice(0, 8)}...(${s.length})`;
}

function normalizePrivateKey(privateKey) {
  if (typeof privateKey !== 'string') return privateKey;
  return privateKey.replace(/\\n/g, '\n');
}

function normalizeCredentials(credentials) {
  if (!credentials || typeof credentials !== 'object') return credentials;
  if (typeof credentials.private_key !== 'string') return credentials;
  return {
    ...credentials,
    private_key: normalizePrivateKey(credentials.private_key),
  };
}

function parseCredentialsFromEnv({ normalize = true } = {}) {
  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!keyJson) throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY が設定されていません');
  const credentials = JSON.parse(keyJson);
  return normalize ? normalizeCredentials(credentials) : credentials;
}

function inspectCredentials(credentials, { rawEnv } = {}) {
  const privateKey = credentials?.private_key;
  const normalizedPrivateKey = normalizePrivateKey(privateKey);
  const hasPrivateKey = typeof privateKey === 'string' && privateKey.length > 0;
  const hasNormalizedPrivateKey = typeof normalizedPrivateKey === 'string' && normalizedPrivateKey.length > 0;

  const diagnostics = {
    has_client_email: Boolean(credentials?.client_email),
    client_email: credentials?.client_email || null,
    has_private_key_id: Boolean(credentials?.private_key_id),
    private_key_id: maskId(credentials?.private_key_id),
    has_private_key: hasPrivateKey,
    private_key_length: hasPrivateKey ? privateKey.length : 0,
    private_key_has_actual_newline: hasPrivateKey ? privateKey.includes('\n') : false,
    private_key_has_literal_backslash_n: hasPrivateKey ? privateKey.includes('\\n') : false,
    private_key_starts_with_begin: hasPrivateKey ? privateKey.startsWith('-----BEGIN PRIVATE KEY-----') : false,
    private_key_ends_with_end: hasPrivateKey ? privateKey.trimEnd().endsWith('-----END PRIVATE KEY-----') : false,
    normalized_private_key_length: hasNormalizedPrivateKey ? normalizedPrivateKey.length : 0,
    normalized_private_key_has_actual_newline: hasNormalizedPrivateKey ? normalizedPrivateKey.includes('\n') : false,
    normalized_private_key_has_literal_backslash_n: hasNormalizedPrivateKey ? normalizedPrivateKey.includes('\\n') : false,
    normalized_private_key_starts_with_begin: hasNormalizedPrivateKey ? normalizedPrivateKey.startsWith('-----BEGIN PRIVATE KEY-----') : false,
    normalized_private_key_ends_with_end: hasNormalizedPrivateKey ? normalizedPrivateKey.trimEnd().endsWith('-----END PRIVATE KEY-----') : false,
    normalized_private_key_line_count: hasNormalizedPrivateKey ? normalizedPrivateKey.split('\n').length : 0,
  };

  if (typeof rawEnv === 'string') {
    diagnostics.raw_env_length = rawEnv.length;
    diagnostics.raw_env_has_literal_backslash_n = rawEnv.includes('\\n');
  }

  diagnostics.ok = Boolean(
    diagnostics.has_client_email &&
    diagnostics.has_private_key_id &&
    diagnostics.normalized_private_key_starts_with_begin &&
    diagnostics.normalized_private_key_ends_with_end &&
    diagnostics.normalized_private_key_has_actual_newline &&
    !diagnostics.normalized_private_key_has_literal_backslash_n
  );

  return diagnostics;
}

function logCredentialsHealth(context, credentials, { rawEnv } = {}) {
  const diagnostics = inspectCredentials(credentials, { rawEnv });
  const log = diagnostics.ok ? console.info : console.warn;
  log(`${LOG_PREFIX} ${context}`, JSON.stringify(diagnostics));
  return diagnostics;
}

function logEnvCredentialsHealth(context) {
  const rawEnv = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!rawEnv) {
    const diagnostics = { ok: false, has_env: false };
    console.warn(`${LOG_PREFIX} ${context}`, JSON.stringify(diagnostics));
    return diagnostics;
  }
  try {
    const credentials = parseCredentialsFromEnv({ normalize: false });
    return logCredentialsHealth(context, credentials, { rawEnv });
  } catch (e) {
    const diagnostics = {
      ok: false,
      has_env: true,
      raw_env_length: rawEnv.length,
      parse_error: e.message,
    };
    console.warn(`${LOG_PREFIX} ${context}`, JSON.stringify(diagnostics));
    return diagnostics;
  }
}

module.exports = {
  normalizePrivateKey,
  normalizeCredentials,
  parseCredentialsFromEnv,
  inspectCredentials,
  logCredentialsHealth,
  logEnvCredentialsHealth,
};
