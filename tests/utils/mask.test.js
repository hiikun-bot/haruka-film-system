// tests/utils/mask.test.js
// 契約管理（ADR 035）utils/mask.js の純関数テスト。

const { maskAccountNumber, maskAddress, maskPhone, maskProfile } = require('../../utils/mask');

describe('maskAccountNumber', () => {
  test('**** + 下4桁', () => {
    expect(maskAccountNumber('1234567')).toBe('****4567');
    expect(maskAccountNumber(1234567)).toBe('****4567');
    expect(maskAccountNumber('0001234')).toBe('****1234');
  });
  test('4桁未満は全部 *、空は空文字', () => {
    expect(maskAccountNumber('123')).toBe('***');
    expect(maskAccountNumber('1234')).toBe('****1234');
    expect(maskAccountNumber('')).toBe('');
    expect(maskAccountNumber(null)).toBe('');
    expect(maskAccountNumber(undefined)).toBe('');
  });
});

describe('maskAddress', () => {
  test('都道府県＋市区町村まで', () => {
    expect(maskAddress('兵庫県尼崎市上坂部1丁目8番1－424号')).toBe('兵庫県尼崎市');
    expect(maskAddress('東京都渋谷区神宮前1-1-1')).toBe('東京都渋谷区');
    expect(maskAddress('大阪府大阪市北区梅田1-1')).toBe('大阪府大阪市');
    expect(maskAddress('北海道札幌市中央区北1条')).toBe('北海道札幌市');
    expect(maskAddress('京都府相楽郡精華町1')).toBe('京都府相楽郡');
  });
  test('判定できないときは空（安全側）', () => {
    expect(maskAddress('')).toBe('');
    expect(maskAddress(null)).toBe('');
    expect(maskAddress('1-2-3')).toBe('');
  });
});

describe('maskPhone', () => {
  test('下4桁だけ残す', () => {
    expect(maskPhone('090-1234-5678')).toBe('****5678');
    expect(maskPhone('0612345678')).toBe('****5678');
    expect(maskPhone('')).toBe('');
    expect(maskPhone('12')).toBe('**');
  });
});

describe('maskProfile', () => {
  test('口座・住所・電話をマスクし他はそのまま', () => {
    const u = { id: 'u1', full_name: '髙橋 聖', account_number: '7654321', address: '兵庫県尼崎市上坂部1', phone: '09011112222', bank_name: '三井住友' };
    const m = maskProfile(u);
    expect(m).toEqual({ id: 'u1', full_name: '髙橋 聖', account_number: '****4321', address: '兵庫県尼崎市', phone: '****2222', bank_name: '三井住友' });
    expect(u.account_number).toBe('7654321'); // 元オブジェクトは変えない
    expect(maskProfile(null)).toBeNull();
  });
});
