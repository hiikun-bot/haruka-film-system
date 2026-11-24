// tests/utils/revision-breakdown.test.js
// 修正回数の内訳（社内 / CL）の純関数テスト。
const { countRevisionBreakdown, formatRevisionBadge } = require('../../utils/revision-breakdown');

describe('countRevisionBreakdown', () => {
  test('W/D/P 後修正は社内、クライアントチェック後修正は CL に数える', () => {
    const rows = [
      { to_status: 'Dチェック後修正' },
      { to_status: 'Pチェック後修正' },
      { to_status: 'Wチェック後修正' },
      { to_status: 'クライアントチェック後修正' },
      { to_status: 'Dチェック' },
      { to_status: '納品' },
    ];
    expect(countRevisionBreakdown(rows)).toEqual({ internal: 3, client: 1 });
  });
  test('空・null は 0 件', () => {
    expect(countRevisionBreakdown([])).toEqual({ internal: 0, client: 0 });
    expect(countRevisionBreakdown(null)).toEqual({ internal: 0, client: 0 });
    expect(countRevisionBreakdown([null, {}])).toEqual({ internal: 0, client: 0 });
  });
});

describe('formatRevisionBadge', () => {
  test('両方ある場合は並記', () => {
    expect(formatRevisionBadge({ internal: 2, client: 1 })).toBe('社内 2回 · CL 1回');
  });
  test('0 の側は省略', () => {
    expect(formatRevisionBadge({ internal: 1, client: 0 })).toBe('社内 1回');
    expect(formatRevisionBadge({ internal: 0, client: 2 })).toBe('CL 2回');
  });
  test('両方 0 / null は null（バッジなし）', () => {
    expect(formatRevisionBadge({ internal: 0, client: 0 })).toBeNull();
    expect(formatRevisionBadge(null)).toBeNull();
  });
});

describe('reconcileRevisionBreakdown / revisionBadgeText（遷移ログが欠けた案件・#1312 レビュー対応）', () => {
  const { reconcileRevisionBreakdown, revisionBadgeText } = require('../../utils/revision-breakdown');
  test('内訳の合計が revision_count 以上なら内訳を使う', () => {
    expect(reconcileRevisionBreakdown({ internal: 2, client: 1 }, 3)).toEqual({ internal: 2, client: 1 });
    expect(reconcileRevisionBreakdown({ internal: 2, client: 2 }, 3)).toEqual({ internal: 2, client: 2 });
    expect(revisionBadgeText({ internal: 2, client: 1 }, 3)).toBe('社内 2回 · CL 1回');
  });
  test('合計が足りなければ内訳を使わず、従来の「修正 N回」', () => {
    expect(reconcileRevisionBreakdown({ internal: 1, client: 0 }, 4)).toBeNull();
    expect(revisionBadgeText({ internal: 1, client: 0 }, 4)).toBe('修正 4回');
  });
  test('ログが全く無くても（内訳 0・0）バッジを消さない', () => {
    expect(revisionBadgeText({ internal: 0, client: 0 }, 2)).toBe('修正 2回');
  });
  test('どちらも 0 ならバッジなし・内訳が取れないときも従来表示', () => {
    expect(revisionBadgeText({ internal: 0, client: 0 }, 0)).toBeNull();
    expect(revisionBadgeText(null, 5)).toBe('修正 5回');
    expect(revisionBadgeText(null, null)).toBeNull();
  });
});
