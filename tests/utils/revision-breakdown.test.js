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
