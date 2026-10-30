// utils/crypto-aes.js — AES-256-GCM による対称鍵暗号
//
// ADR 017 Phase 0: Google Calendar の refresh_token を DB 保管する際の暗号化を担う。
// ADR 054: GMOあおぞらネット銀行 API のトークン（鍵は AOZORA_TOKEN_ENCRYPTION_KEY）でも同じ実装を使う。
//
// 環境変数:
//   GCAL_TOKEN_ENCRYPTION_KEY  32 バイトの鍵を base64 でエンコードした文字列（既定の鍵）
//   生成例: openssl rand -base64 32
//
// 設計方針:
//   - 鍵未設定なら getKey() が throw（silent skip 禁止）。
//     routes/google-calendar.js の OAuth フローはこの throw を catch して
//     利用者に「鍵が設定されていません」と返す責務を持つ。
//   - IV は毎回ランダム 12 バイト。authTag と iv は復号時に必要なため、
//     ciphertext と一緒に保存する（DB スキーマ側で 3 列に分けている）。
//   - 鍵長が 32 バイトでない場合は明示的に throw。base64 のパディングずれ事故を防ぐ。
//   - 別の鍵（別の環境変数名）を使いたい機能は createCipher('ENV_NAME') で専用の
//     { encrypt, decrypt, isConfigured } を作る。既定の encrypt/decrypt は従来どおり
//     GCAL_TOKEN_ENCRYPTION_KEY を使うので既存の呼び出し元は変わらない。

const crypto = require('crypto');

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;        // GCM 推奨 12 バイト
const KEY_LEN = 32;       // AES-256
const DEFAULT_KEY_ENV = 'GCAL_TOKEN_ENCRYPTION_KEY';

// 環境変数名 → デコード済み鍵（Buffer）のキャッシュ
const _keyCache = new Map();

function getKeyFromEnv(envName = DEFAULT_KEY_ENV) {
  const cached = _keyCache.get(envName);
  if (cached) return cached;
  const b64 = process.env[envName];
  if (!b64) {
    throw new Error(`${envName} が設定されていません。openssl rand -base64 32 で生成して env に設定してください。`);
  }
  let key;
  try {
    key = Buffer.from(b64, 'base64');
  } catch (e) {
    throw new Error(`${envName} が base64 として不正です: ` + e.message);
  }
  if (key.length !== KEY_LEN) {
    throw new Error(`${envName} は ${KEY_LEN} バイトである必要があります（base64 デコード後 ${key.length} バイトでした）`);
  }
  _keyCache.set(envName, key);
  return key;
}

function encryptWithKey(key, plaintext) {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new Error('encrypt: plaintext は非空の文字列である必要があります');
  }
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    ciphertext: enc.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
  };
}

function decryptWithKey(key, payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('decrypt: payload オブジェクトが必要です');
  }
  const { ciphertext, iv, authTag } = payload;
  if (!ciphertext || !iv || !authTag) {
    throw new Error('decrypt: ciphertext / iv / authTag のいずれかが欠けています');
  }
  const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(authTag, 'base64'));
  const dec = Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64')),
    decipher.final(),
  ]);
  return dec.toString('utf8');
}

/**
 * 指定した環境変数の鍵で暗号化・復号する関数セットを作る。
 * @param {string} envName 鍵を入れる環境変数名（例: 'AOZORA_TOKEN_ENCRYPTION_KEY'）
 * @returns {{ encrypt: (plaintext:string)=>{ciphertext:string,iv:string,authTag:string}, decrypt: (payload:object)=>string, isConfigured: ()=>boolean, envName: string }}
 */
function createCipher(envName) {
  if (!envName || typeof envName !== 'string') throw new Error('createCipher: 環境変数名が必要です');
  return {
    envName,
    encrypt: (plaintext) => encryptWithKey(getKeyFromEnv(envName), plaintext),
    decrypt: (payload) => decryptWithKey(getKeyFromEnv(envName), payload),
    isConfigured: () => { try { getKeyFromEnv(envName); return true; } catch (_) { return false; } },
  };
}

// ---- 既定（GCAL_TOKEN_ENCRYPTION_KEY）の互換 API ----

/**
 * plaintext を AES-256-GCM で暗号化する。
 * @param {string} plaintext  UTF-8 文字列。null/undefined/空文字は throw。
 * @returns {{ ciphertext: string, iv: string, authTag: string }} 各値は base64。
 */
function encrypt(plaintext) {
  return encryptWithKey(getKeyFromEnv(DEFAULT_KEY_ENV), plaintext);
}

/**
 * ciphertext を復号する。
 * @param {{ ciphertext: string, iv: string, authTag: string }} payload  encrypt() の戻り値と同形。
 * @returns {string} plaintext（UTF-8）。
 */
function decrypt(payload) {
  return decryptWithKey(getKeyFromEnv(DEFAULT_KEY_ENV), payload);
}

/**
 * 鍵が設定されているかチェックする（起動時のヘルスチェック用）。
 * @returns {boolean}
 */
function isConfigured() {
  try {
    getKeyFromEnv(DEFAULT_KEY_ENV);
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = { encrypt, decrypt, isConfigured, createCipher, DEFAULT_KEY_ENV };
