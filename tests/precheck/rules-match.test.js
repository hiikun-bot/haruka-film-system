// 投稿前チェック（ADR 050）: シートの行の読み取りと辞書照合
const { parseRules, parseScheduleRow, splitPairs } = require('../../lib/precheck/rules');
const { runDictionary, manualChecks, normalize } = require('../../lib/precheck/match');

const HEADER = ['No', '対象ファイル', '項目', '指摘内容', '備考', '判定方法', '誤', '正'];
const sheet = [
  HEADER,
  ['13', '動画編集', 'テロップ', '「要は」は不要', '', '辞書', '要は', '（削除）'],
  ['18', '動画編集', 'テロップ誤字', '圧す→押す', '', '辞書', '圧す／盛り土', '押す／盛土'],
  ['16', '動画編集', 'テロップ', '添字は下付き', '', '辞書', 'VA／VB', 'Vₐ／Vᵦ'],
  ['54', '動画編集', '誤字脱字', '技士', '', '辞書', '建築管理技師／管理技師', '建築施工管理技士／管理技士'],
  ['21', 'サムネイル', 'タイトル変更', 'プロも悩む→講師も悩む', '', '辞書', 'プロも悩む', '講師も悩む'],
  ['8', '動画編集', 'テロップ', '口語体はNG', '', 'AI', '', ''],
  ['34', '動画編集', '切り抜き箇所', 'コアな部分のみ', '', '人', '', ''],
  ['22', '動画編集', 'カット', '白画面はカット', '', '映像', '', ''],
  ['30', 'キャプション文', '', '模擬試験のリンク', '', '必須', '', '模擬試験のリンク'],
  ['58', '', '', '', '', '', '', ''],
  ['59', '動画編集', '新しい指摘', '判定方法を選び忘れた行', '', '', '', ''],
];

describe('parseRules', () => {
  const rules = parseRules(sheet);
  test('指摘内容が空の行は読まない', () => {
    expect(rules.map(r => r.no)).not.toContain(58);
  });
  test('判定方法が空なら AI として効かせる', () => {
    expect(rules.find(r => r.no === 59).method).toBe('AI');
  });
  test('誤と正は「／」区切りで同じ順に対応し、（削除）は削除指示になる', () => {
    expect(rules.find(r => r.no === 18).pairs).toEqual([
      { wrong: '圧す', right: '押す', remove: false },
      { wrong: '盛り土', right: '盛土', remove: false },
    ]);
    expect(rules.find(r => r.no === 13).pairs[0]).toEqual({ wrong: '要は', right: '', remove: true });
  });
  test('splitPairs は全角・半角のスラッシュどちらでも区切る', () => {
    expect(splitPairs('A／B/C')).toEqual(['A', 'B', 'C']);
  });
});

describe('runDictionary', () => {
  const rules = parseRules(sheet);
  const run = (texts, extra = {}) => runDictionary(rules, {
    telops: texts.map((text, index) => ({ index, start: index * 2, text })),
    ...extra,
  });

  test('当たった語と直し方を、テロップの番号・時刻つきで返す', () => {
    const f = run(['土を圧す']);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ rule_no: 18, severity: 'error', telop_index: 0, time_sec: 0, quote: '圧す' });
    expect(f[0].suggestion).toBe('「圧す」→「押す」');
  });
  test('「要は」は「必要は」に当たらない（直前が漢字なら別の語）', () => {
    expect(run(['必要はない'])).toHaveLength(0);
    expect(run(['要は、せん断力'])[0].suggestion).toBe('「要は」を削除');
  });
  test('「VA」は「VALUE」に当たらない（前後が英数字なら別の語）', () => {
    expect(run(['VALUE'])).toHaveLength(0);
    expect(run(['反力VAを求める'])).toHaveLength(1);
  });
  test('長い語と短い語が同じ場所に当たったら長い方だけ', () => {
    const f = run(['2級建築管理技師']);
    expect(f).toHaveLength(1);
    expect(f[0].quote).toBe('建築管理技師');
  });
  test('改行や全角英数字の違いを吸収する', () => {
    expect(normalize('Ｖ Ａ\n')).toBe('VA');
    expect(run(['反力Ｖ\nＡ'])).toHaveLength(1);
  });
  test('サムネイルの行はサムネタイトルにだけ当てる', () => {
    expect(run(['プロも悩む'])).toHaveLength(0);
    const f = run([], { thumbnailTitle: 'プロも悩む施工計画' });
    expect(f).toHaveLength(1);
    expect(f[0].source).toBe('thumbnail');
  });
  test('文字起こし（話した言葉）にも当てる', () => {
    const f = run([], { transcript: [{ start: 12, text: 'じゃあ土を圧すと' }] });
    expect(f[0]).toMatchObject({ source: 'speech', time_sec: 12 });
  });
});

describe('manualChecks', () => {
  test('人と映像の行だけを確認欄にする', () => {
    const m = manualChecks(parseRules(sheet));
    expect(m.map(x => x.rule_no).sort()).toEqual([22, 34]);
    expect(m.find(x => x.rule_no === 22).hint).toMatch(/準備中/);
  });
});

describe('parseScheduleRow', () => {
  const values = [
    ['x', '管理番号', '区分', '等級', '試験区分', '試験内容', 'タイトル', 'ID', '大分類', '中分類', '小分類', '編集担当者', 'ステータス', '納品日', '月度', 'サムネタイトル'],
    ['1', 'K-001-1', '建築', '2級', '第一次検定（学科）\t', '建築学', 'R6年度前期_問1_1', '241001', '建築学', '環境工学', '日照・日射', '井上', '完了', '', '', '日照時間と可照時間の違い'],
  ];
  test('管理番号で行を引き、分野と分類を返す', () => {
    expect(parseScheduleRow(values, 'K-001-1')).toMatchObject({
      field: '建築', grade: '2級', exam: '第一次検定（学科）', major: '建築学', middle: '環境工学', minor: '日照・日射',
      thumbnailTitle: '日照時間と可照時間の違い',
    });
  });
  test('無い管理番号は null', () => {
    expect(parseScheduleRow(values, 'K-999-1')).toBeNull();
  });
});
