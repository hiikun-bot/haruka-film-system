const {
  parsePortfolioText,
  formatPortfolioText,
  normalizePortfolioUrls,
  portfolioLinkKind,
  portfolioLinkLabel,
  toPortfolioArray,
  MAX_ITEMS,
} = require('../../utils/member-portfolio-urls');

describe('parsePortfolioText', () => {
  test('1 行 1 件・見出しは URL の前後どちらでも拾う', () => {
    const { items, errors } = parsePortfolioText([
      'ブランドムービー https://youtu.be/abc',
      'https://drive.google.com/file/d/xyz/view',
      '',
      'https://example.com/lp　採用LP',
      '会社紹介 | https://example.com/about',
    ].join('\n'));
    expect(errors).toEqual([]);
    expect(items).toEqual([
      { url: 'https://youtu.be/abc', title: 'ブランドムービー' },
      { url: 'https://drive.google.com/file/d/xyz/view', title: null },
      { url: 'https://example.com/lp', title: '採用LP' },
      { url: 'https://example.com/about', title: '会社紹介' },
    ]);
  });

  test('www. 始まりは https を補う・重複 URL はまとめる・CRLF も通る', () => {
    const { items, errors } = parsePortfolioText('www.example.com/a\r\nhttps://www.example.com/a\r\n');
    expect(errors).toEqual([]);
    expect(items).toEqual([{ url: 'https://www.example.com/a', title: null }]);
  });

  test('チャットの「見出し行 → URL 行」の貼り方は直前の行を見出しにする（実データの形）', () => {
    const { items, errors } = parsePortfolioText([
      '会社ホームページ',
      'https://arclarejp.com/',
      '',
      '本出版LP',
      'https://sekaishiseifuku.com/new-sekaishi/',
      '',
      'ポートフォリオ（自己学習含む）',
      'https://portfolio-c5m.pages.dev/',
    ].join('\n'));
    expect(errors).toEqual([]);
    expect(items).toEqual([
      { url: 'https://arclarejp.com/', title: '会社ホームページ' },
      { url: 'https://sekaishiseifuku.com/new-sekaishi/', title: '本出版LP' },
      { url: 'https://portfolio-c5m.pages.dev/', title: 'ポートフォリオ（自己学習含む）' },
    ]);
  });

  test('同じ行に見出しがあれば直前の行より優先', () => {
    const { items } = parsePortfolioText('メモ\n作品A https://a.example.com');
    expect(items).toEqual([{ url: 'https://a.example.com/', title: '作品A' }]);
  });

  test('URL が続かない行・不正なスキームは行番号つきでエラー', () => {
    const { errors } = parsePortfolioText('https://ok.example.com\nただのメモ\nもう1行\njavascript:alert(1)');
    expect(errors).toEqual([
      '2 行目: URL がありません（https:// から貼ってください）',
      '3 行目: URL がありません（https:// から貼ってください）',
      '4 行目: URL がありません（https:// から貼ってください）',
    ]);
  });

  test('上限件数を超えるとエラー', () => {
    const text = Array.from({ length: MAX_ITEMS + 1 }, (_, i) => `https://example.com/${i}`).join('\n');
    expect(parsePortfolioText(text).errors[0]).toMatch(/まで/);
  });
});

describe('formatPortfolioText', () => {
  test('保存値をテキストエリアに戻すと再解析で同じになる', () => {
    const items = [
      { url: 'https://youtu.be/abc', title: 'ブランドムービー' },
      { url: 'https://example.com/', title: null },
    ];
    const text = formatPortfolioText(items);
    expect(text).toBe('ブランドムービー https://youtu.be/abc\nhttps://example.com/');
    expect(parsePortfolioText(text).items).toEqual(items);
  });
});

describe('normalizePortfolioUrls', () => {
  test('空は空配列', () => {
    expect(normalizePortfolioUrls(null)).toEqual({ items: [] });
    expect(normalizePortfolioUrls([])).toEqual({ items: [] });
    expect(normalizePortfolioUrls('')).toEqual({ items: [] });
  });

  test('配列を正規化（見出しの空白整理・重複除去）', () => {
    expect(normalizePortfolioUrls([
      { url: 'https://example.com/a', title: '  作品  A ' },
      { url: 'https://example.com/a', title: '重複' },
      'https://example.com/b',
    ])).toEqual({ items: [
      { url: 'https://example.com/a', title: '作品 A' },
      { url: 'https://example.com/b', title: null },
    ] });
  });

  test('不正な URL・形式はエラー', () => {
    expect(normalizePortfolioUrls([{ url: 'javascript:alert(1)' }]).error).toBeTruthy();
    expect(normalizePortfolioUrls([{ url: 'ftp://example.com' }]).error).toBeTruthy();
    expect(normalizePortfolioUrls({ url: 'https://example.com' }).error).toBeTruthy();
    expect(normalizePortfolioUrls('メモだけ').error).toMatch(/1 行目/);
  });

  test('上限超過はエラー', () => {
    const arr = Array.from({ length: MAX_ITEMS + 1 }, (_, i) => ({ url: `https://example.com/${i}` }));
    expect(normalizePortfolioUrls(arr).error).toMatch(/まで/);
  });
});

describe('表示用', () => {
  test('種類の判定', () => {
    expect(portfolioLinkKind('https://www.youtube.com/watch?v=1').kind).toBe('YouTube');
    expect(portfolioLinkKind('https://youtu.be/1').kind).toBe('YouTube');
    expect(portfolioLinkKind('https://drive.google.com/x').icon).toBe('📂');
    expect(portfolioLinkKind('https://www.instagram.com/p/1').kind).toBe('Instagram');
    expect(portfolioLinkKind('https://notyoutube.com/').kind).toBe('リンク');
  });

  test('見出しが無ければ種類名かドメイン', () => {
    expect(portfolioLinkLabel({ url: 'https://youtu.be/1', title: null })).toBe('YouTube');
    expect(portfolioLinkLabel({ url: 'https://www.example.com/lp', title: null })).toBe('example.com');
    expect(portfolioLinkLabel({ url: 'https://youtu.be/1', title: '作品' })).toBe('作品');
  });

  test('toPortfolioArray は JSON 文字列・null・壊れた値を吸収', () => {
    expect(toPortfolioArray(null)).toEqual([]);
    expect(toPortfolioArray('[{"url":"https://a.example.com"}]')).toEqual([{ url: 'https://a.example.com' }]);
    expect(toPortfolioArray('{broken')).toEqual([]);
    expect(toPortfolioArray([{ url: '' }, null, { url: 'https://b.example.com' }])).toEqual([{ url: 'https://b.example.com' }]);
  });
});
