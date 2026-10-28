const { jstMonthBoundary } = require('../utils/pricing');

describe('jstMonthBoundary（単価の月またぎ分割の境目・ADR 037 追補その3）', () => {
  test('月の途中: 今月1日・先月末・今月1日 0:00 JST', () => {
    expect(jstMonthBoundary('2026-10-28')).toEqual({
      monthStart: '2026-10-01',
      prevMonthEnd: '2026-09-30',
      monthStartIso: '2026-09-30T15:00:00.000Z',
    });
  });
  test('1月は前年12月末', () => {
    expect(jstMonthBoundary('2027-01-05')).toMatchObject({ monthStart: '2027-01-01', prevMonthEnd: '2026-12-31' });
  });
  test('3月はうるう年の2月末', () => {
    expect(jstMonthBoundary('2028-03-01').prevMonthEnd).toBe('2028-02-29');
    expect(jstMonthBoundary('2027-03-31').prevMonthEnd).toBe('2027-02-28');
  });
});
