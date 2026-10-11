// 投稿前チェック（ADR 050 §6）: Premiere の値からテロップを読み取る（パネルと同じファイルを読み込む）
const { parseTelopValue, toHexColor, flattenTranscript, looksLikeTextParam } = require('../../plugins/premiere-precheck/telop-parse');

describe('parseTelopValue', () => {
  test('2026: キーフレームの中の JSON（textEditValue）から文字・サイズ・フォントを読む', () => {
    const kf = { position: {}, value: { value: JSON.stringify({ textEditValue: '夏は涼しい', fontSizeEditValue: [64], fontEditValue: ['HiraginoSans-W6'] }) } };
    expect(parseTelopValue(kf)).toEqual({ text: '夏は涼しい', font_size: 64, font: 'HiraginoSans-W6', color: null });
  });
  test('2027: MogrtText の getText / getFontSize を使う', () => {
    const mogrt = { getText: () => '帯筋', isUniformStyling: () => true, getFontSize: () => 48, getFontName: () => 'NotoSansJP' };
    expect(parseTelopValue(mogrt)).toEqual({ text: '帯筋', font_size: 48, font: 'NotoSansJP', color: null });
  });
  test('2027: 書式が混在していると getFontSize が throw するが、文字は読む', () => {
    const mogrt = { getText: () => '混在', isUniformStyling: () => false, getFontSize: () => { throw new Error('mixed'); } };
    expect(parseTelopValue(mogrt)).toEqual({ text: '混在', font_size: null, font: null, color: null });
  });
  test('数値・座標・色などテロップでない値は null', () => {
    expect(parseTelopValue({ value: { value: 100 } })).toBeNull();
    expect(parseTelopValue({ value: { value: true } })).toBeNull();
    expect(parseTelopValue(null)).toBeNull();
    expect(parseTelopValue('{"foo":1}')).toBeNull();
  });
  test('素の文字列は「文字のパラメータ」のときだけテロップ扱い', () => {
    expect(parseTelopValue({ value: { value: 'こんにちは' } })).toBeNull();
    expect(parseTelopValue({ value: { value: 'こんにちは' } }, { plainStringIsText: true }).text).toBe('こんにちは');
    expect(looksLikeTextParam('ソーステキスト')).toBe(true);
    expect(looksLikeTextParam('不透明度')).toBe(false);
  });
});

describe('toHexColor', () => {
  test('0〜1 の RGB / ARGB / オブジェクト', () => {
    expect(toHexColor([1, 0, 0])).toBe('#FF0000');
    expect(toHexColor([1, 1, 0.5, 0])).toBe('#FF8000');
    expect(toHexColor({ red: 0, green: 1, blue: 0 })).toBe('#00FF00');
    expect(toHexColor(null)).toBeNull();
  });
});

describe('flattenTranscript', () => {
  const json = { language: 'ja-jp', segments: [
    { start: 10, duration: 2, speaker: 'a', words: [{ text: '掘削は' }, { text: '絶対でる' }] },
    { start: 30, duration: 2, speaker: 'a', words: [{ text: '範囲外' }] },
  ] };
  test('素材の時刻をシーケンスの時刻に直し、クリップの範囲だけ拾う', () => {
    expect(flattenTranscript(JSON.stringify(json), -8, [0, 20])).toEqual([{ start: 2, text: '掘削は絶対でる' }]);
  });
  test('壊れた JSON は空', () => {
    expect(flattenTranscript('{oops')).toEqual([]);
  });
});
