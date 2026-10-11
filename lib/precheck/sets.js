// lib/precheck/sets.js — 投稿前チェックの「案件ごとのルール置き場」（ADR 050）
//
// ルールの正本は各案件のシート。ここには「どのシートのどのタブか」だけを書く。
// 案件を増やすときはこの配列に 1 件足す（シートの列構成は ADR 050 §2 と同じにする）。

const SETS = [
  {
    id: 'higegoro-clip',
    name: 'ひげごろー様 切り抜きショート',
    spreadsheetId: '1bmJvWQm_X8vWWgXNGZ_N3gin9pFQ-vaVGBRbw4aXF6w',
    rulesSheetId: 50610372,      // 投稿前チェックリスト
    scheduleSheetId: 1347781830, // 投稿予定一覧（管理番号 → 分野・分類）
    // シーケンス名から管理番号を拾う（例: K-001-1 / D-012-2）
    codePattern: /[A-Z]{1,3}-\d{2,4}-\d{1,3}/,
  },
];

function getSet(id) {
  return SETS.find(s => s.id === id) || null;
}

function listSets() {
  return SETS.map(({ id, name }) => ({ id, name }));
}

module.exports = { SETS, getSet, listSets };
