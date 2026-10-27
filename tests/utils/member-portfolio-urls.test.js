const {
  parsePortfolioText,
  portfolioDetailRows,
  collectPortfolioRows,
  looksLikeBulkPaste,
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
      '2 行目「ただのメモ」: URL がありません（https:// から貼ってください）',
      '3 行目「もう1行」: URL がありません（https:// から貼ってください）',
      '4 行目「javascript:alert(1)」: URL がありません（https:// から貼ってください）',
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
    expect(text).toBe('ブランドムービー https://youtu.be/abc\n\nhttps://example.com/');
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
    expect(normalizePortfolioUrls('メモだけ').error).toMatch(/1 行目「メモだけ」/);
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

describe('collectPortfolioRows（項目名｜URL の行入力）', () => {
  test('空行は無視・項目名の空白整理・重複 URL はまとめる', () => {
    expect(collectPortfolioRows([
      { title: ' 会社ホームページ ', url: 'https://arclarejp.com/' },
      { title: '', url: '' },
      { title: '', url: 'www.example.com' },
      { title: '重複', url: 'https://arclarejp.com/' },
    ])).toEqual({ items: [
      { url: 'https://arclarejp.com/', title: '会社ホームページ' },
      { url: 'https://www.example.com/', title: null },
    ], errors: [] });
  });

  test('項目名だけ・不正 URL は件数番号つきでエラー（空行は数えない）', () => {
    const { errors } = collectPortfolioRows([
      { title: '', url: '' },
      { title: '本出版LP', url: '' },
      { title: 'x', url: 'javascript:alert(1)' },
    ]);
    expect(errors).toEqual([
      '1 件目「本出版LP」: URL を入れてください',
      '2 件目: URL の形が正しくありません（https:// から入れてください）',
    ]);
  });
});

describe('looksLikeBulkPaste', () => {
  test('URL 1 つだけは普通の入力、複数行・複数 URL はまとめ貼り', () => {
    expect(looksLikeBulkPaste('https://a.example.com')).toBe(false);
    expect(looksLikeBulkPaste('会社ホームページ')).toBe(false);
    expect(looksLikeBulkPaste('会社ホームページ\nhttps://a.example.com')).toBe(true);
    expect(looksLikeBulkPaste('https://a.example.com https://b.example.com')).toBe(true);
  });
});

// 実データ: みこさんが Chatwork で送ってくれた形（見出し＋「- ラベル：値」の箇条書き）
const MIKO_TEXT = [
  ' ◾️ Promasys（EDC）の製品ページ',
  '',
  '- 見せられるURL：https://site.tedama.co.jp/?page_id=79212',
  '- ページ上の表記：「Promasys｜研究を最速で叶えるEDC」',
  '- 業種：臨床研究・治験向けのシステム',
  '- 目的：Promasysの特徴や利用場面を紹介する',
  '- 担当範囲：ヒアリング、構成、ワイヤー、テキスト、デザイン、WordPress（SWELL）での実装',
  '- 使ったツール：WordPress（SWELL）、Codex・Figma・Illustrator',
  '- 社名を出してよいか：可',
  '- ご自身が制作した部分（ページ全体／一部）：ページ全体',
  '',
  '',
  ' ◾️ エステサロンオーナー様向け無料Zoom勉強会LP',
  '',
  '- 見せられるURL：https://member.kitelu.com/lps-001/',
  '- 業種：美容・エステ（サロン運営者向け）',
  '- 目的：無料Zoom勉強会の参加案内。ページからLINEで参加方法を受け取る導線。',
  '- 担当範囲：デザイン、LP構築',
  '- 使ったツール：canva(先方指定ツール）',
  '- 制作した部分：全体のデザイン　ワードプレスに構築',
].join('\n');

describe('見出し＋箇条書きの詳細つき文面（実データ）', () => {
  test('項目ごとに詳細欄へ振り分ける', () => {
    const { items, errors } = parsePortfolioText(MIKO_TEXT);
    expect(errors).toEqual([]);
    expect(items).toEqual([
      {
        url: 'https://site.tedama.co.jp/?page_id=79212',
        title: 'Promasys（EDC）の製品ページ',
        page_label: '「Promasys｜研究を最速で叶えるEDC」',
        industry: '臨床研究・治験向けのシステム',
        purpose: 'Promasysの特徴や利用場面を紹介する',
        role: 'ヒアリング、構成、ワイヤー、テキスト、デザイン、WordPress（SWELL）での実装',
        tools: 'WordPress（SWELL）、Codex・Figma・Illustrator',
        company_ok: '可',
        scope: 'ページ全体',
      },
      {
        url: 'https://member.kitelu.com/lps-001/',
        title: 'エステサロンオーナー様向け無料Zoom勉強会LP',
        industry: '美容・エステ（サロン運営者向け）',
        purpose: '無料Zoom勉強会の参加案内。ページからLINEで参加方法を受け取る導線。',
        role: 'デザイン、LP構築',
        tools: 'canva(先方指定ツール）',
        scope: '全体のデザイン　ワードプレスに構築',
      },
    ]);
  });

  test('まとめてコピーの文面は読み戻すと同じになる', () => {
    const { items } = parsePortfolioText(MIKO_TEXT);
    expect(parsePortfolioText(formatPortfolioText(items)).items).toEqual(items);
  });

  test('一覧に出す詳細は入っている項目だけ定義順', () => {
    const { items } = parsePortfolioText(MIKO_TEXT);
    expect(portfolioDetailRows(items[1]).map(r => r.label)).toEqual(['業種', '目的', '担当範囲', '使ったツール', '制作した部分']);
  });

  test('ラベルの無い箇条書きはメモに入る・URL の無い見出しはエラー', () => {
    const { items, errors } = parsePortfolioText('◾️ 作品A\n- https://a.example.com\n- 自主制作です\n◾️ 作品B\n- 業種：飲食');
    expect(items).toEqual([{ url: 'https://a.example.com/', title: '作品A', note: '自主制作です' }]);
    expect(errors).toEqual(['4 行目「作品B」: URL がありません（https:// から貼ってください）']);
  });

  test('保存時の検証で詳細は残り、知らないキーは落ちる', () => {
    expect(normalizePortfolioUrls([{ url: 'https://a.example.com', title: 'A', industry: ' 飲食 ', evil: '<x>' }]))
      .toEqual({ items: [{ url: 'https://a.example.com/', title: 'A', industry: '飲食' }] });
  });
});
