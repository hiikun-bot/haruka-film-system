const {
  buildPayoutMessage,
  extractInvoiceAmount,
  evaluatePayoutDiff,
  normalizeFolderPersonName,
  normalizePersonName,
} = require('../../utils/payout');

describe('buildPayoutMessage', () => {
  test('メモなしは定型文のみ', () => {
    expect(buildPayoutMessage({ displayName: 'ぴょん', month: 8, memo: '' }))
      .toBe('ぴょんさん\n今月もお疲れ様でした。8月分を振り込みましたので、ご確認をお願いします。');
  });
  test('空白のみのメモは付けない', () => {
    expect(buildPayoutMessage({ displayName: 'ぴょん', month: 8, memo: '   \n ' }))
      .not.toContain('\n\n');
  });
  test('メモありは空行を挟んで付与', () => {
    expect(buildPayoutMessage({ displayName: 'あんこ', month: 12, memo: 'リサイズ分は来月に回します' }))
      .toBe('あんこさん\n今月もお疲れ様でした。12月分を振り込みましたので、ご確認をお願いします。\n\nリサイズ分は来月に回します');
  });
});

describe('extractInvoiceAmount', () => {
  test('ご請求金額を最優先で拾う', () => {
    const text = '請求書\nご請求金額 43,500円\n小計 43,500\n合計43,500';
    expect(extractInvoiceAmount(text)).toEqual({ amount: 43500, source: 'seikyu' });
  });
  test('全角数字・全角カンマも読める', () => {
    expect(extractInvoiceAmount('ご請求金額 １１０，０００円')).toEqual({ amount: 110000, source: 'seikyu' });
  });
  test('ご請求金額が無ければ合計の最大値（小計・税額と混同しない）', () => {
    const text = '小計 12,727\nうち消費税額合計1,273\n合計14,000';
    expect(extractInvoiceAmount(text)).toEqual({ amount: 14000, source: 'gokei' });
  });
  test('金額が無ければ null', () => {
    expect(extractInvoiceAmount('作業時間報告書です')).toBeNull();
    expect(extractInvoiceAmount('')).toBeNull();
  });
  test('消費税率 0.0% のような小さい数字は棄却', () => {
    expect(extractInvoiceAmount('合計 0\n消費税率 10')).toBeNull();
  });
});

describe('evaluatePayoutDiff', () => {
  test('額面一致は match', () => {
    expect(evaluatePayoutDiff({ invoiceAmount: 42000, actualTotal: 42000 }).status).toBe('match');
  });
  test('税込請求（実データ×1.1）も match', () => {
    const r = evaluatePayoutDiff({ invoiceAmount: 17000, actualTotal: 15455 });
    expect(r.status).toBe('match');
  });
  test('大きな乖離は diff（delta も返す）', () => {
    const r = evaluatePayoutDiff({ invoiceAmount: 120000, actualTotal: 68000 });
    expect(r.status).toBe('diff');
    expect(r.delta).toBe(52000);
  });
  test('請求額が無ければ unknown', () => {
    expect(evaluatePayoutDiff({ invoiceAmount: null, actualTotal: 5000 }).status).toBe('unknown');
  });
});

describe('normalizeFolderPersonName / normalizePersonName', () => {
  test('年月サフィックスと空白を除去して一致比較できる', () => {
    expect(normalizeFolderPersonName('井上　さやか 2026年08月')).toBe('井上さやか');
    expect(normalizeFolderPersonName('安齋 智光 2026年4月')).toBe('安齋智光');
    expect(normalizePersonName('井上　さやか')).toBe('井上さやか');
  });
  test('同姓同名回避サフィックス (email) も除去', () => {
    expect(normalizeFolderPersonName('山田 太郎 (taro123) 2026年08月')).toBe('山田太郎');
  });
});
