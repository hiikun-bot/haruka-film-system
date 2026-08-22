// tests/utils/personal-goals.test.js
// 🎯 マイゴール（utils/personal-goals.js）の純関数テスト。
// - 進捗計算（done/total/pct）・分類ツリー構築（大分類→中分類→タスク）
// - 今週の完了数（JST・月〜日）・ストリーク（連続完了日数）・カウントダウン
// - 「今週やること」「期限順」の絞り込み・整列
//
// ⚠️ 週境界・ストリークは JST 固定で判定する。completed_at は UTC の ISO 文字列で与え、
//    JST に直すと日付がずれるケース（UTC 15:00 = JST 翌日 0:00）を明示的に検証する。
//    `TZ=UTC npx jest` と `TZ=Asia/Tokyo npx jest` の両方で同結果になること。

const PG = require('../../utils/personal-goals');

const task = (over = {}) => ({
  id: 'x',
  title: 't',
  status: '未着手',
  major_category: null,
  mid_category: null,
  due_date: null,
  completed_at: null,
  ...over,
});
const doneAt = (iso) => task({ status: '完了', completed_at: iso });

describe('jstDateStr（TIMESTAMPTZ → JST日付）', () => {
  test('UTC 15:00 は JST では翌日 0:00（日付が繰り上がる）', () => {
    expect(PG.jstDateStr('2026-08-20T15:00:00Z')).toBe('2026-08-21');
    expect(PG.jstDateStr('2026-08-20T14:59:59Z')).toBe('2026-08-20');
  });
  test('不正値は null', () => {
    expect(PG.jstDateStr('not-a-date')).toBeNull();
  });
});

describe('daysUntil（目標日カウントダウン）', () => {
  test('未来は正・当日は0・過去は負', () => {
    expect(PG.daysUntil('2026-07-01', '2026-08-21')).toBe(-51);
    expect(PG.daysUntil('2026-08-21', '2026-08-21')).toBe(0);
    expect(PG.daysUntil('2027-07-01', '2026-08-21')).toBe(314);
  });
  test('不正値は null', () => {
    expect(PG.daysUntil(null, '2026-08-21')).toBeNull();
    expect(PG.daysUntil('2026-07-01', '')).toBeNull();
  });
});

describe('jstWeekRange（月曜はじまりの週）', () => {
  test('金曜 2026-08-21 の週は 8/17(月)〜8/23(日)', () => {
    expect(PG.jstWeekRange('2026-08-21')).toEqual({ start: '2026-08-17', end: '2026-08-23' });
  });
  test('月曜自身が start、日曜は同じ週の end', () => {
    expect(PG.jstWeekRange('2026-08-17')).toEqual({ start: '2026-08-17', end: '2026-08-23' });
    expect(PG.jstWeekRange('2026-08-23')).toEqual({ start: '2026-08-17', end: '2026-08-23' });
  });
  test('月またぎ・年またぎでも正しい', () => {
    expect(PG.jstWeekRange('2026-01-01')).toEqual({ start: '2025-12-29', end: '2026-01-04' });
  });
});

describe('computeProgress（進捗率）', () => {
  test('完了ステータスのみを done に数え、pct は四捨五入', () => {
    const tasks = [
      task({ status: '完了' }),
      task({ status: '対応中' }),
      task({ status: '未着手' }),
    ];
    expect(PG.computeProgress(tasks)).toEqual({ done: 1, total: 3, pct: 33 });
  });
  test('空・null は 0/0/0%', () => {
    expect(PG.computeProgress([])).toEqual({ done: 0, total: 0, pct: 0 });
    expect(PG.computeProgress(null)).toEqual({ done: 0, total: 0, pct: 0 });
  });
});

describe('buildCategoryTree（大分類→中分類→タスク）', () => {
  test('出現順を保ってグルーピングし、各階層に進捗が付く', () => {
    const tasks = [
      task({ id: '1', major_category: '設計', mid_category: '商号', status: '完了' }),
      task({ id: '2', major_category: '設計', mid_category: '商号', status: '未着手' }),
      task({ id: '3', major_category: '設計', mid_category: '定款', status: '完了' }),
      task({ id: '4', major_category: '設立手続き', mid_category: '税務', status: '未着手' }),
    ];
    const tree = PG.buildCategoryTree(tasks);
    expect(tree.map((m) => m.name)).toEqual(['設計', '設立手続き']);
    expect(tree[0]).toMatchObject({ done: 2, total: 3, pct: 67 });
    expect(tree[0].mids.map((m) => m.name)).toEqual(['商号', '定款']);
    expect(tree[0].mids[0]).toMatchObject({ done: 1, total: 2, pct: 50 });
    expect(tree[0].mids[1]).toMatchObject({ done: 1, total: 1, pct: 100 });
    expect(tree[1]).toMatchObject({ done: 0, total: 1, pct: 0 });
  });
  test('分類なし・空白のみは（未分類）に集約', () => {
    const tree = PG.buildCategoryTree([
      task({ major_category: null, mid_category: '  ' }),
      task({ major_category: '', mid_category: null }),
    ]);
    expect(tree).toHaveLength(1);
    expect(tree[0].name).toBe(PG.UNCATEGORIZED);
    expect(tree[0].mids).toHaveLength(1);
    expect(tree[0].mids[0].name).toBe(PG.UNCATEGORIZED);
    expect(tree[0].total).toBe(2);
  });
});

describe('countWeekCompleted（今週の完了数・JST）', () => {
  const today = '2026-08-21'; // 金曜。週 = 8/17(月)〜8/23(日)
  test('今週内の完了だけを数える', () => {
    const tasks = [
      doneAt('2026-08-17T00:00:00+09:00'), // 月曜 0:00 JST（週初め・含む）
      doneAt('2026-08-20T15:00:00Z'),      // JST 8/21 0:00（含む）
      doneAt('2026-08-16T14:59:00Z'),      // JST 8/16 23:59（先週・含まない）
      doneAt('2026-08-24T00:00:00+09:00'), // 来週月曜（含まない）
      task({ status: '対応中', completed_at: null }), // 未完了は数えない
    ];
    expect(PG.countWeekCompleted(tasks, today)).toBe(2);
  });
  test('completed_at が無い完了タスクは数えない（データ不整合セーフ）', () => {
    expect(PG.countWeekCompleted([task({ status: '完了', completed_at: null })], today)).toBe(0);
  });
});

describe('computeStreak（連続完了日数・JST）', () => {
  const today = '2026-08-21';
  test('今日を含めて連続3日', () => {
    const tasks = [
      doneAt('2026-08-21T01:00:00+09:00'),
      doneAt('2026-08-20T23:00:00+09:00'),
      doneAt('2026-08-19T12:00:00+09:00'),
      doneAt('2026-08-16T12:00:00+09:00'), // 8/17-18 が空くのでここで途切れ
    ];
    expect(PG.computeStreak(tasks, today)).toBe(3);
  });
  test('今日まだ完了が無ければ昨日起点で数える（当日中は途切れ扱いにしない）', () => {
    const tasks = [doneAt('2026-08-20T12:00:00+09:00'), doneAt('2026-08-19T12:00:00+09:00')];
    expect(PG.computeStreak(tasks, today)).toBe(2);
  });
  test('昨日も今日も無ければ 0', () => {
    expect(PG.computeStreak([doneAt('2026-08-15T12:00:00+09:00')], today)).toBe(0);
    expect(PG.computeStreak([], today)).toBe(0);
  });
  test('UTC 表記でも JST の日付で判定される（UTC 15:00 = JST 翌日）', () => {
    // completed_at 2026-08-20T15:30:00Z は JST では 8/21（今日）→ ストリーク1
    expect(PG.computeStreak([doneAt('2026-08-20T15:30:00Z')], today)).toBe(1);
  });
  test('同じ日に複数完了しても1日として数える', () => {
    const tasks = [
      doneAt('2026-08-21T09:00:00+09:00'),
      doneAt('2026-08-21T22:00:00+09:00'),
    ];
    expect(PG.computeStreak(tasks, today)).toBe(1);
  });
});

describe('sortByDueDate（期限順）', () => {
  test('未完了のみ・期限昇順・期限なしは末尾', () => {
    const tasks = [
      task({ id: 'a', due_date: '2026-09-01' }),
      task({ id: 'b', due_date: null }),
      task({ id: 'c', due_date: '2026-08-01' }),
      task({ id: 'd', due_date: '2026-08-01', status: '完了' }),
    ];
    expect(PG.sortByDueDate(tasks).map((t) => t.id)).toEqual(['c', 'a', 'b']);
  });
});

describe('filterThisWeek（今週やること = 今週期限＋期限超過の未完了）', () => {
  const today = '2026-08-21'; // 週 = 8/17〜8/23
  test('今週期限と期限超過を含み、来週以降・完了・期限なしは含まない', () => {
    const tasks = [
      task({ id: 'overdue', due_date: '2026-04-12' }),          // 期限超過 → 含む
      task({ id: 'thisweek', due_date: '2026-08-23' }),         // 今週日曜 → 含む
      task({ id: 'nextweek', due_date: '2026-08-24' }),         // 来週 → 含まない
      task({ id: 'nodl', due_date: null }),                     // 期限なし → 含まない
      task({ id: 'done', due_date: '2026-08-21', status: '完了' }), // 完了 → 含まない
    ];
    expect(PG.filterThisWeek(tasks, today).map((t) => t.id)).toEqual(['overdue', 'thisweek']);
  });
});

describe('isOverdue（期限超過）', () => {
  const today = '2026-08-21';
  test('未完了かつ期限が過去のみ true（当日は false）', () => {
    expect(PG.isOverdue(task({ due_date: '2026-08-20' }), today)).toBe(true);
    expect(PG.isOverdue(task({ due_date: '2026-08-21' }), today)).toBe(false);
    expect(PG.isOverdue(task({ due_date: '2026-08-20', status: '完了' }), today)).toBe(false);
    expect(PG.isOverdue(task({ due_date: null }), today)).toBe(false);
  });
});
