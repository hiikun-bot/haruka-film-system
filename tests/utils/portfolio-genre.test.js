const {
  PORTFOLIO_STYLES,
  derivePortfolioStyle,
  resolvePortfolioStyle,
  resolvePortfolioGenre,
} = require('../../utils/portfolio-genre');

describe('derivePortfolioStyle', () => {
  test('本番で最も多い組み合わせ（縦型のショート動画）', () => {
    expect(derivePortfolioStyle('video_short', 'portrait')).toBe('vertical_short');
  });

  test('動画は向きで分かれる', () => {
    expect(derivePortfolioStyle('video_short', 'square')).toBe('square_video');
    expect(derivePortfolioStyle('video_short', 'landscape')).toBe('wide_video');
  });

  test('ロング動画は向きに関係なくロング動画（本番の video_long は縦で入っている）', () => {
    expect(derivePortfolioStyle('video_long', 'portrait')).toBe('long_video');
    expect(derivePortfolioStyle('video_long', 'landscape')).toBe('long_video');
  });

  test('静止画は creative_type でフォーマットが決まる（向きは見ない）', () => {
    expect(derivePortfolioStyle('design_banner', 'portrait')).toBe('banner');
    expect(derivePortfolioStyle('design_banner', 'landscape')).toBe('banner');
    expect(derivePortfolioStyle('design_post', 'square')).toBe('sns_post');
    expect(derivePortfolioStyle('design_story', 'portrait')).toBe('story');
    expect(derivePortfolioStyle('design_thumbnail', 'landscape')).toBe('thumbnail');
  });

  test('LP / HP はプレフィックス無しで来る（一覧 API と同じ扱い）', () => {
    expect(derivePortfolioStyle('lp', 'portrait')).toBe('web');
    expect(derivePortfolioStyle('hp', 'landscape')).toBe('web');
  });

  test('未知の design_* は「その他の静止画」に寄せる', () => {
    expect(derivePortfolioStyle('design_unknown_kind', 'square')).toBe('graphic');
  });

  test('creative_type が空・未知なら other_style', () => {
    expect(derivePortfolioStyle('', 'portrait')).toBe('other_style');
    expect(derivePortfolioStyle(null, null)).toBe('other_style');
    expect(derivePortfolioStyle('mystery', 'portrait')).toBe('other_style');
  });
});

describe('resolvePortfolioStyle', () => {
  test('上書きが無ければ自動導出', () => {
    expect(resolvePortfolioStyle({ creative_type: 'video_short', orientation: 'portrait' }))
      .toEqual({ code: 'vertical_short', name: '縦型ショート動画', overridden: false });
  });

  test('上書きがあればそれを使う（自動判定できない作風）', () => {
    expect(resolvePortfolioStyle({ style_override: 'interview', creative_type: 'video_short', orientation: 'portrait' }))
      .toEqual({ code: 'interview', name: 'インタビュー', overridden: true });
  });

  test('マスターから消えた未知の上書きは自動導出にフォールバックする', () => {
    expect(resolvePortfolioStyle({ style_override: 'gone', creative_type: 'design_banner', orientation: 'square' }))
      .toEqual({ code: 'banner', name: 'バナー', overridden: false });
  });

  test('引数なしでも落ちない', () => {
    expect(resolvePortfolioStyle()).toEqual({ code: 'other_style', name: 'その他', overridden: false });
  });
});

describe('resolvePortfolioGenre', () => {
  const names = new Map([['finance', '金融・保険'], ['education', '教育・スクール']]);

  test('クライアントの業種を継承する', () => {
    expect(resolvePortfolioGenre({ client_genre: 'finance', genreNameMap: names }))
      .toEqual({ code: 'finance', name: '金融・保険', overridden: false });
  });

  test('作品側の上書きが継承より優先される', () => {
    expect(resolvePortfolioGenre({ creative_genre: 'education', client_genre: 'finance', genreNameMap: names }))
      .toEqual({ code: 'education', name: '教育・スクール', overridden: true });
  });

  test('クライアントと同じ値の上書きは「上書き」と見なさない', () => {
    expect(resolvePortfolioGenre({ creative_genre: 'finance', client_genre: 'finance', genreNameMap: names }).overridden)
      .toBe(false);
  });

  test('どちらも未設定なら null（画面では「未設定」に集まる）', () => {
    expect(resolvePortfolioGenre({ genreNameMap: names }))
      .toEqual({ code: null, name: null, overridden: false });
  });

  test('マスターに無い code は code をそのまま名前に使う（落とさない）', () => {
    expect(resolvePortfolioGenre({ client_genre: 'unknown_code', genreNameMap: names }))
      .toEqual({ code: 'unknown_code', name: 'unknown_code', overridden: false });
  });
});

describe('PORTFOLIO_STYLES の定義', () => {
  test('code は重複しない', () => {
    const codes = PORTFOLIO_STYLES.map(s => s.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  test('自動判定できない作風は auto:false（自動導出の戻り値に混ざらない）', () => {
    const manualOnly = PORTFOLIO_STYLES.filter(s => !s.auto).map(s => s.code);
    expect(manualOnly).toEqual(expect.arrayContaining(['live_action', 'motion_graphics', 'interview', 'ugc', 'illustration']));
    const autoResults = new Set([
      derivePortfolioStyle('video_short', 'portrait'),
      derivePortfolioStyle('video_short', 'square'),
      derivePortfolioStyle('video_short', 'landscape'),
      derivePortfolioStyle('video_long', 'portrait'),
      derivePortfolioStyle('design_banner', 'square'),
      derivePortfolioStyle('design_post', 'square'),
      derivePortfolioStyle('design_story', 'portrait'),
      derivePortfolioStyle('design_thumbnail', 'landscape'),
      derivePortfolioStyle('lp', 'portrait'),
      derivePortfolioStyle('design_other', 'square'),
      derivePortfolioStyle('mystery', 'square'),
    ]);
    manualOnly.forEach(code => expect(autoResults.has(code)).toBe(false));
  });
});
