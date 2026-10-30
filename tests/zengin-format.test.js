const z = require('../utils/zengin-format');

describe('toHalfWidthKana', () => {
  test('全角カナを半角へ、濁点・半濁点は別文字に分解', () => {
    expect(z.toHalfWidthKana('ガ')).toBe('ｶﾞ');
    expect(z.toHalfWidthKana('パ')).toBe('ﾊﾟ');
    expect(z.toHalfWidthKana('ヴ')).toBe('ｳﾞ');
    expect(z.toHalfWidthKana('タカハシ　サトル')).toBe('ﾀｶﾊｼ ｻﾄﾙ');
  });
  test('ひらがな・全角英数・全角記号も寄せる', () => {
    expect(z.toHalfWidthKana('たかはし')).toBe('ﾀｶﾊｼ');
    expect(z.toHalfWidthKana('ＡＢＣ１２３')).toBe('ABC123');
    expect(z.toHalfWidthKana('カ）ハルカフィルム')).toBe('ｶ)ﾊﾙｶﾌｲﾙﾑ');
  });
  test('元から半角のものは変えない', () => {
    expect(z.toHalfWidthKana('ｶ)ﾊﾙｶ')).toBe('ｶ)ﾊﾙｶ');
  });
});

describe('filterAllowedChars', () => {
  test('許容文字はそのまま', () => {
    const r = z.filterAllowedChars('ｶ)ﾊﾙｶﾌｲﾙﾑ-1.2/3,4\\ ｢ｱ｣');
    expect(r.value).toBe('ｶ)ﾊﾙｶﾌｲﾙﾑ-1.2/3,4\\ ｢ｱ｣');
    expect(r.removed).toEqual([]);
  });
  test('銀行側の変換と同じ: 小文字カナ→大文字、英小文字→大文字、長音→ハイフン', () => {
    const r = z.filterAllowedChars('ﾌｨﾙﾑ abc ｼﾞｰｴﾑｵｰ');
    expect(r.value).toBe('ﾌｲﾙﾑ ABC ｼﾞ-ｴﾑｵ-');
    expect(r.converted).toBe(true);
  });
  test('カナとして成立しない濁点・半濁点は削除（仕様の例）', () => {
    expect(z.filterAllowedChars('ｱﾞｶﾞｻﾞﾀﾞﾅﾟﾊﾟ').value).toBe('ｱｶﾞｻﾞﾀﾞﾅﾊﾟ');
  });
  test('漢字・絵文字・全角記号は除去して removed に残す', () => {
    const r = z.filterAllowedChars('高橋 ｻﾄﾙ★');
    expect(r.value).toBe('ｻﾄﾙ');
    expect(r.removed).toEqual(['高', '橋', '★']);
  });
  test('連続スペース・前後スペースを詰める', () => {
    expect(z.filterAllowedChars('  ﾀｶﾊｼ　　ｻﾄﾙ  ').value).toBe('ﾀｶﾊｼ ｻﾄﾙ');
  });
});

describe('normalizeBeneficiaryName', () => {
  test('通常の名義', () => {
    const r = z.normalizeBeneficiaryName('ヤマダ　ハナコ');
    expect(r).toEqual({ value: 'ﾔﾏﾀﾞ ﾊﾅｺ', warnings: [], error: null });
  });
  test('除去があれば warning', () => {
    const r = z.normalizeBeneficiaryName('山田 ハナコ');
    expect(r.value).toBe('ﾊﾅｺ');
    expect(r.warnings.length).toBe(1);
    expect(r.warnings[0]).toMatch(/山 田/);
  });
  test('30 文字で切る（31 文字目以降は銀行も切り捨て）', () => {
    const r = z.normalizeBeneficiaryName('ア'.repeat(35));
    expect(r.value).toBe('ｱ'.repeat(30));
    expect(r.warnings.some((w) => w.includes('30'))).toBe(true);
  });
  test('空・有効文字なしはエラー', () => {
    expect(z.normalizeBeneficiaryName('').error).toBeTruthy();
    expect(z.normalizeBeneficiaryName('山田').error).toBeTruthy();
  });
});

describe('コードの桁合わせ', () => {
  test('銀行コード 4 桁・支店コード 3 桁の前ゼロ', () => {
    expect(z.formatBankCode('5')).toBe('0005');
    expect(z.formatBankCode('０３１０')).toBe('0310');
    expect(z.formatBankCode('12345')).toBeNull();
    expect(z.formatBankCode('')).toBeNull();
    expect(z.formatBranchCode('1')).toBe('001');
    expect(z.formatBranchCode('1234')).toBeNull();
  });
  test('口座番号 7 桁の前ゼロ・8 桁以上はエラー', () => {
    expect(z.formatAccountNumber('12345')).toEqual({ value: '0012345', error: null });
    expect(z.formatAccountNumber('2698906')).toEqual({ value: '2698906', error: null });
    expect(z.formatAccountNumber('12345678').error).toMatch(/8 桁以上/);
    expect(z.formatAccountNumber('').error).toBeTruthy();
    expect(z.formatAccountNumber('0000000').error).toBeTruthy();
  });
  test('科目コード', () => {
    expect(z.accountTypeCode('普通')).toBe('1');
    expect(z.accountTypeCode('当座')).toBe('2');
    expect(z.accountTypeCode('貯蓄')).toBe('4');
    expect(z.accountTypeCode('普通預金')).toBe('1');
    expect(z.accountTypeCode('1')).toBe('1');
    expect(z.accountTypeCode('')).toBeNull();
    expect(z.accountTypeCode('定期')).toBeNull();
    expect(z.accountTypeLabel('2')).toBe('当座');
  });
  test('下4桁マスク', () => {
    expect(z.maskAccountNumber('2698906')).toBe('****8906');
    expect(z.maskAccountNumber('12')).toBe('**');
    expect(z.maskAccountNumber(null)).toBe('');
  });
});

describe('buildBeneficiary', () => {
  const okUser = {
    bank_code: '310', branch_code: '101', account_type: '普通',
    account_number: '2698906', account_holder_kana: 'カ）ハルカフィルム',
  };
  test('正常系', () => {
    const r = z.buildBeneficiary(okUser);
    expect(r.ok).toBe(true);
    expect(r.item).toEqual({
      bank_code: '0310', branch_code: '101', account_type_code: '1',
      account_number: '2698906', beneficiary_name: 'ｶ)ﾊﾙｶﾌｲﾙﾑ',
    });
    expect(r.errors).toEqual([]);
  });
  test('不備は errors にまとめて返し item は null', () => {
    const r = z.buildBeneficiary({ ...okUser, bank_code: '', account_number: '123456789', account_type: '' });
    expect(r.ok).toBe(false);
    expect(r.item).toBeNull();
    expect(r.errors.length).toBe(3);
    expect(r.errors.join(' ')).toMatch(/銀行コードが未設定/);
    expect(r.errors.join(' ')).toMatch(/8 桁以上/);
    expect(r.errors.join(' ')).toMatch(/科目/);
  });
  test('除去があっても ok・warnings つき', () => {
    const r = z.buildBeneficiary({ ...okUser, account_holder_kana: '髙橋 サトル' });
    expect(r.ok).toBe(true);
    expect(r.item.beneficiary_name).toBe('ｻﾄﾙ');
    expect(r.warnings.length).toBe(1);
  });
  test('null でも落ちない', () => {
    expect(z.buildBeneficiary(null).ok).toBe(false);
  });
});
