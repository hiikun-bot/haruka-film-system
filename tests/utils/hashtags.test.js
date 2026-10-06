const {
  normalizeHashtag,
  extractHashtags,
  uniqueHashtagKeys,
  hasHashtag,
  countHashtags,
  escapeLikePattern,
} = require('../../utils/hashtags');

describe('extractHashtags', () => {
  test('日本語タグを位置つきで切り出す', () => {
    const r = extractHashtags('✨いよさんのCR好調 #勝ちクリエイティブ #Hertech');
    expect(r.map(h => h.tag)).toEqual(['勝ちクリエイティブ', 'Hertech']);
    expect(r[0]).toMatchObject({ key: '勝ちクリエイティブ' });
    const text = '✨いよさんのCR好調 #勝ちクリエイティブ #Hertech';
    expect(text.slice(r[0].start, r[0].end)).toBe('#勝ちクリエイティブ');
    expect(text.slice(r[1].start, r[1].end)).toBe('#Hertech');
  });

  test('全角 ＃ も拾い、検索キーは NFKC + 小文字', () => {
    const r = extractHashtags('＃ＨＦＳ便利 と #hfs便利');
    expect(r.map(h => h.key)).toEqual(['hfs便利', 'hfs便利']);
    expect(r[0].tag).toBe('ＨＦＳ便利');
  });

  test('行頭・空白・括弧の直後だけタグ扱い（URL フラグメントや PR#番号は除外）', () => {
    expect(extractHashtags('#朝活 開始').map(h => h.tag)).toEqual(['朝活']);
    expect(extractHashtags('（#裏話）を公開').map(h => h.tag)).toEqual(['裏話']);
    expect(extractHashtags('https://example.com/page#top を見て')).toEqual([]);
    expect(extractHashtags('PR#1218 がマージ')).toEqual([]);
    expect(extractHashtags('a&#123;b')).toEqual([]);
  });

  test('数字だけ・空・長すぎるタグは拾わない', () => {
    expect(extractHashtags('#1 #2026 #')).toEqual([]);
    expect(extractHashtags('#1位 は拾う').map(h => h.tag)).toEqual(['1位']);
    expect(extractHashtags('#' + 'あ'.repeat(51))).toEqual([]);
    expect(extractHashtags('#' + 'あ'.repeat(50)).length).toBe(1);
  });

  test('タグは句読点・記号・改行で終わる', () => {
    expect(extractHashtags('#納品完了！嬉しい').map(h => h.tag)).toEqual(['納品完了']);
    expect(extractHashtags('#完了、#次へ\n#三つ目。').map(h => h.tag)).toEqual(['完了', '次へ', '三つ目']);
    expect(extractHashtags('#snake_case ok').map(h => h.tag)).toEqual(['snake_case']);
    expect(extractHashtags('#ラッキー #人々').map(h => h.tag)).toEqual(['ラッキー', '人々']);
  });

  test('絵文字（サロゲートペア）の直後でもオフセットがずれない', () => {
    const text = '🎉 #祝 🏆#無視される #ok';
    const r = extractHashtags(text);
    expect(r.map(h => h.tag)).toEqual(['祝', 'ok']); // 🏆 直後は境界ではない
    expect(text.slice(r[1].start, r[1].end)).toBe('#ok');
  });
});

describe('uniqueHashtagKeys / hasHashtag', () => {
  test('重複を除き出現順', () => {
    expect(uniqueHashtagKeys('#A #b #a #B #c')).toEqual(['a', 'b', 'c']);
  });
  test('hasHashtag は正規化して完全一致（部分一致しない）', () => {
    expect(hasHashtag('#勝ちクリエイティブ 誕生', '勝ちクリエイティブ')).toBe(true);
    expect(hasHashtag('#勝ちクリエイティブ 誕生', '#勝ち')).toBe(false);
    expect(hasHashtag('#勝ちクリエイティブ 誕生', '＃勝ちクリエイティブ')).toBe(true);
    expect(hasHashtag('タグなし', '')).toBe(false);
  });
});

describe('countHashtags', () => {
  test('件数降順・同数は名前順。表示名は初出の表記', () => {
    const r = countHashtags(['#朝活 #Hertech', '#HERTECH だけ', '#朝活 二回目', '#勝ち']);
    expect(r).toEqual([
      { tag: 'Hertech', key: 'hertech', count: 2 }, // 同数は表示名順（ja ロケールで英字→かな）
      { tag: '朝活', key: '朝活', count: 2 },
      { tag: '勝ち', key: '勝ち', count: 1 },
    ]);
  });
  test('同一本文内の重複は 1 件', () => {
    expect(countHashtags(['#a #a #A'])).toEqual([{ tag: 'a', key: 'a', count: 1 }]);
  });
});

describe('normalizeHashtag / escapeLikePattern', () => {
  test('先頭の # を落として NFKC + 小文字', () => {
    expect(normalizeHashtag('#ＡＢＣ')).toBe('abc');
    expect(normalizeHashtag('＃タグ')).toBe('タグ');
  });
  test('ilike の特殊文字をエスケープ', () => {
    expect(escapeLikePattern('100%_off\\')).toBe('100\\%\\_off\\\\');
  });
});
