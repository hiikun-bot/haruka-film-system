// tests/utils/serial-sheet.test.js — ADR 038 連番のシート連動（純関数）
const { parseSerialCells, normalizeColumnLetter, columnLetterToIndex, resolveSerialDigits } = require('../../utils/serial-sheet');

describe('parseSerialCells', () => {
  test('先頭の数字列の最大値 + 1 を next に返す（見出しは無視）', () => {
    const values = [['No.'], ['001'], ['002'], [''], ['010'], ['003']];
    expect(parseSerialCells(values)).toEqual({ max: 10, next: 11, count: 4, digitsHint: 3, lastRaw: '010' });
  });

  test('ファイル名そのもの（010_ネコ・イヌスエール_…）でも先頭数字を拾う', () => {
    const values = [['ファイル名'], ['009_ネコ・イヌスエール_1080_1080_a.png'], ['010_ネコ・イヌスエール_1080_1080_b.png']];
    const r = parseSerialCells(values);
    expect(r.max).toBe(10);
    expect(r.next).toBe(11);
    expect(r.lastRaw).toBe('010_ネコ・イヌスエール_1080_1080_b.png');
  });

  test('使用中判定列（usedIdx）: その列が空の行は数えない（No が事前採番されているシート）', () => {
    // A 列 No=1..6 が事前採番、B 列 CR名 は 1〜3 と 5 だけ埋まっている → 使用中の最大は 5 → 次は 6
    const values = [['No', 'CR名'], ['1', 'a'], ['2', 'b'], ['3', 'c'], ['4', ''], ['5', 'e'], ['6']];
    const r = parseSerialCells(values, { numberIdx: 0, usedIdx: 1 });
    expect(r).toEqual({ max: 5, next: 6, count: 4, digitsHint: null, lastRaw: '5' });
  });

  test('桁数ヒントはゼロ埋めされた番号からだけ推定する（素の数字なら null）', () => {
    expect(parseSerialCells([['1'], ['2'], ['13']]).digitsHint).toBeNull();
    expect(parseSerialCells([['001'], ['002'], ['013']]).digitsHint).toBe(3);
  });

  test('数値セル（number）も対象', () => {
    expect(parseSerialCells([[1], [2], [12]]).next).toBe(13);
  });

  test('数字セルが無ければ next=1', () => {
    expect(parseSerialCells([['No.'], ['タイトル']])).toEqual({ max: 0, next: 1, count: 0, digitsHint: null, lastRaw: null });
    expect(parseSerialCells(null).next).toBe(1);
  });

  test('欠番は再利用しない（最大値 + 1）', () => {
    expect(parseSerialCells([['001'], ['005']]).next).toBe(6);
  });

  test('1 次元配列も受け付ける', () => {
    expect(parseSerialCells(['01', '02', '07']).next).toBe(8);
  });
});

describe('normalizeColumnLetter', () => {
  test('小文字・空白を正規化', () => {
    expect(normalizeColumnLetter(' a ')).toBe('A');
    expect(normalizeColumnLetter('aa')).toBe('AA');
  });
  test('不正値は null', () => {
    expect(normalizeColumnLetter('')).toBeNull();
    expect(normalizeColumnLetter('1')).toBeNull();
    expect(normalizeColumnLetter('ABCD')).toBeNull();
    expect(normalizeColumnLetter(null)).toBeNull();
  });
});

describe('columnLetterToIndex', () => {
  test('A=0, B=1, Z=25, AA=26', () => {
    expect(columnLetterToIndex('A')).toBe(0);
    expect(columnLetterToIndex('b')).toBe(1);
    expect(columnLetterToIndex('Z')).toBe(25);
    expect(columnLetterToIndex('AA')).toBe(26);
    expect(columnLetterToIndex('')).toBeNull();
  });
});

describe('resolveSerialDigits', () => {
  test('案件 → テンプレ → 3 の順', () => {
    expect(resolveSerialDigits({ serial_digits: 5 }, { serial_digits: 4 })).toBe(5);
    expect(resolveSerialDigits({ serial_digits: null }, { serial_digits: 4 })).toBe(4);
    expect(resolveSerialDigits({}, {})).toBe(3);
    expect(resolveSerialDigits(null, null)).toBe(3);
  });
  test('範囲外・文字列は未設定扱い', () => {
    expect(resolveSerialDigits({ serial_digits: 0 }, { serial_digits: '7' })).toBe(7);
    expect(resolveSerialDigits({ serial_digits: 11 }, null)).toBe(3);
  });
});
