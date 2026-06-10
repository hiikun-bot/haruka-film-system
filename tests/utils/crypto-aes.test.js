// tests/utils/crypto-aes.test.js
// utils/crypto-aes.js (ADR 017 Phase 0) のユニットテスト。
// 鍵はテスト専用に固定生成し、外部依存なしで roundtrip を検証する。

const crypto = require('crypto');

// 32 バイト固定鍵（テスト専用・本番とは無関係）
const TEST_KEY_B64 = Buffer.alloc(32, 7).toString('base64');

describe('crypto-aes（鍵設定済み）', () => {
  let aes;

  beforeAll(() => {
    process.env.GCAL_TOKEN_ENCRYPTION_KEY = TEST_KEY_B64;
    jest.isolateModules(() => {
      aes = require('../../utils/crypto-aes');
    });
  });

  test('isConfigured は true', () => {
    expect(aes.isConfigured()).toBe(true);
  });

  test('encrypt → decrypt の roundtrip で元の平文に戻る', () => {
    const plaintext = 'refresh-token-テスト-1234';
    const payload = aes.encrypt(plaintext);
    expect(typeof payload.ciphertext).toBe('string');
    expect(typeof payload.iv).toBe('string');
    expect(typeof payload.authTag).toBe('string');
    expect(aes.decrypt(payload)).toBe(plaintext);
  });

  test('IV は毎回ランダム（同じ平文でも ciphertext が変わる）', () => {
    const a = aes.encrypt('same-text');
    const b = aes.encrypt('same-text');
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  test('encrypt: 空文字 / 非文字列は throw', () => {
    expect(() => aes.encrypt('')).toThrow();
    expect(() => aes.encrypt(null)).toThrow();
    expect(() => aes.encrypt(123)).toThrow();
  });

  test('decrypt: payload 欠損は throw', () => {
    expect(() => aes.decrypt(null)).toThrow('payload オブジェクトが必要です');
    const payload = aes.encrypt('x');
    expect(() => aes.decrypt({ ...payload, authTag: undefined })).toThrow('欠けています');
    expect(() => aes.decrypt({ ...payload, iv: undefined })).toThrow('欠けています');
    expect(() => aes.decrypt({ ...payload, ciphertext: undefined })).toThrow('欠けています');
  });

  test('decrypt: 改ざんされた ciphertext は GCM 認証で throw', () => {
    const payload = aes.encrypt('tamper-me');
    const tampered = Buffer.from(payload.ciphertext, 'base64');
    tampered[0] ^= 0xff;
    expect(() => aes.decrypt({ ...payload, ciphertext: tampered.toString('base64') })).toThrow();
  });
});

describe('crypto-aes（鍵未設定 / 不正鍵）', () => {
  const ORIGINAL = process.env.GCAL_TOKEN_ENCRYPTION_KEY;

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.GCAL_TOKEN_ENCRYPTION_KEY;
    else process.env.GCAL_TOKEN_ENCRYPTION_KEY = ORIGINAL;
  });

  test('鍵未設定: isConfigured は false、encrypt は throw（silent skip 禁止）', () => {
    delete process.env.GCAL_TOKEN_ENCRYPTION_KEY;
    jest.isolateModules(() => {
      const fresh = require('../../utils/crypto-aes');
      expect(fresh.isConfigured()).toBe(false);
      expect(() => fresh.encrypt('x')).toThrow('GCAL_TOKEN_ENCRYPTION_KEY が設定されていません');
    });
  });

  test('鍵長が 32 バイトでなければ throw', () => {
    process.env.GCAL_TOKEN_ENCRYPTION_KEY = Buffer.alloc(16, 1).toString('base64');
    jest.isolateModules(() => {
      const fresh = require('../../utils/crypto-aes');
      expect(fresh.isConfigured()).toBe(false);
      expect(() => fresh.encrypt('x')).toThrow('32 バイトである必要があります');
    });
  });
});
