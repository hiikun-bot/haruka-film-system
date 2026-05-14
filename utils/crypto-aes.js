// utils/crypto-aes.js — AES-256-GCM による対称鍵暗号
//
// ADR 017 Phase 0: Google Calendar の refresh_token を DB 保管する際の暗号化を担う。
//
// 環境変数:
//   GCAL_TOKEN_ENCRYPTION_KEY  32 バイトの鍵を base64 でエンコードした文字列
//   生成例: openssl rand -base64 32
//
// 設計方針:
//   - 鍵未設定なら getKey() が throw（silent skip 禁止）。
//     routes/google-calendar.js の OAuth フローはこの throw を catch して
//     利用者に「鍵が設定されていません」と返す責務を持つ。
//   - IV は毎回ランダム 12 バイト。authTag と iv は復号時に必要なため、
//     ciphertext と一緒に保存する（DB スキーマ側で 3 列に分けている）。
//   - 鍵長が 32 バイトでない場合は明示的に throw。base64 のパディングずれ事故を防ぐ。

const crypto = require('crypto');

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;        // GCM 推奨 12 バイト
const KEY_LEN = 32;       // AES-256

let _cachedKey = null;

function getKey() {
  if (_cachedKey) return _cachedKey;
  const b64 = process.env.GCAL_TOKEN_ENCRYPTION_KEY;
  if (!b64) {
    throw new Error('GCAL_TOKEN_ENCRYPTION_KEY が設定されていません（ADR 017 Phase 0）。openssl rand -base64 32 で生成して env に設定してください。');
  }
  let key;
  try {
    key = Buffer.from(b64, 'base64');
  } catch (e) {
    throw new Error('GCAL_TOKEN_ENCRYPTION_KEY が base64 として不正です: ' + e.message);
  }
  if (key.length !== KEY_LEN) {
    throw new Error(`GCAL_TOKEN_ENCRYPTION_KEY は ${KEY_LEN} バイトである必要があります（base64 デコード後 ${key.length} バイトでした）`);
  }
  _cachedKey = key;
  return _cachedKey;
}

/**
 * plaintext を AES-256-GCM で暗号化する。
 * @param {string} plaintext  UTF-8 文字列。null/undefined/空文字は throw。
 * @returns {{ ciphertext: string, iv: string, authTag: string }} 各値は base64。
 */
function encrypt(plaintext) {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new Error('encrypt: plaintext は非空の文字列である必要があります');
  }
  const key = getKey();
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

/**
 * ciphertext を復号する。
 * @param {{ ciphertext: string, iv: string, authTag: string }} payload  encrypt() の戻り値と同形。
 * @returns {string} plaintext（UTF-8）。
 */
function decrypt(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('decrypt: payload オブジェクトが必要です');
  }
  const { ciphertext, iv, authTag } = payload;
  if (!ciphertext || !iv || !authTag) {
    throw new Error('decrypt: ciphertext / iv / authTag のいずれかが欠けています');
  }
  const key = getKey();
  const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(authTag, 'base64'));
  const dec = Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64')),
    decipher.final(),
  ]);
  return dec.toString('utf8');
}

/**
 * 鍵が設定されているかチェックする（起動時のヘルスチェック用）。
 * @returns {boolean}
 */
function isConfigured() {
  try {
    getKey();
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = { encrypt, decrypt, isConfigured };
