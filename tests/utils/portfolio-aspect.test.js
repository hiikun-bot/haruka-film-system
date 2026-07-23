const { parsePortfolioAspect, portfolioOrientation } = require('../../utils/portfolio-aspect');

describe('parsePortfolioAspect', () => {
  test('解像度表記を読む（x / × の両方）', () => {
    expect(parsePortfolioAspect('1920x1080')).toEqual({ w: 1920, h: 1080 });
    expect(parsePortfolioAspect('1080×1350')).toEqual({ w: 1080, h: 1350 });
    expect(parsePortfolioAspect('バナー 1200x628')).toEqual({ w: 1200, h: 628 });
  });

  test('比率表記を読む（半角/全角コロン）', () => {
    expect(parsePortfolioAspect('9:16')).toEqual({ w: 9, h: 16 });
    expect(parsePortfolioAspect('16：9')).toEqual({ w: 16, h: 9 });
  });

  test('呼称から推定する', () => {
    expect(parsePortfolioAspect('縦型')).toEqual({ w: 9, h: 16 });
    expect(parsePortfolioAspect('スクエア')).toEqual({ w: 1, h: 1 });
    expect(parsePortfolioAspect('横型ワイド')).toEqual({ w: 16, h: 9 });
    expect(parsePortfolioAspect('Portrait')).toEqual({ w: 9, h: 16 });
  });

  test('解像度表記は呼称より優先される', () => {
    // 「縦型 1080x1920」は数値をそのまま採る（呼称フォールバックに落ちない）
    expect(parsePortfolioAspect('縦型 1080x1920')).toEqual({ w: 1080, h: 1920 });
  });

  test('読めない値は null', () => {
    expect(parsePortfolioAspect('')).toBeNull();
    expect(parsePortfolioAspect(null)).toBeNull();
    expect(parsePortfolioAspect('サイズ未設定')).toBeNull();
  });
});

describe('portfolioOrientation', () => {
  test('縦・正方・横を振り分ける', () => {
    expect(portfolioOrientation(1080, 1920)).toBe('portrait');  // 9:16
    expect(portfolioOrientation(1080, 1350)).toBe('portrait');  // 4:5
    expect(portfolioOrientation(1080, 1080)).toBe('square');    // 1:1
    expect(portfolioOrientation(1920, 1080)).toBe('landscape'); // 16:9
    expect(portfolioOrientation(1200, 628)).toBe('landscape');
  });

  test('判定不能は横レーンに寄せる', () => {
    expect(portfolioOrientation(null, null)).toBe('landscape');
    expect(portfolioOrientation(0, 100)).toBe('landscape');
  });
});
