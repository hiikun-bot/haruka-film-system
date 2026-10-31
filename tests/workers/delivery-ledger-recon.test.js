// tests/workers/delivery-ledger-recon.test.js
// 納品カウントの月初 自動突合ワーカー（ADR 055 追補）の実行タイミング判定。TZ=UTC / Asia/Tokyo 両方で同じ結果。

jest.mock('../../supabase', () => ({}));
const { shouldRunNow, previousYm } = require('../../workers/delivery-ledger-recon');

describe('previousYm', () => {
  test('JST の前月（UTC 10/31 15:30 = JST 11/1 00:30 → 前月は 2026-10）', () => {
    expect(previousYm(new Date('2026-10-31T15:30:00Z'))).toBe('2026-10');
    expect(previousYm(new Date('2026-10-31T14:30:00Z'))).toBe('2026-09');
    expect(previousYm(new Date('2026-01-05T03:00:00Z'))).toBe('2025-12');
  });
});

describe('shouldRunNow', () => {
  test('毎月 1〜3 日の JST 10〜18 時台だけ true', () => {
    expect(shouldRunNow({ now: new Date('2026-11-01T01:00:00Z'), lastRunYm: null })).toBe(true);   // JST 11/1 10:00
    expect(shouldRunNow({ now: new Date('2026-11-03T09:00:00Z'), lastRunYm: null })).toBe(true);   // JST 11/3 18:00
    expect(shouldRunNow({ now: new Date('2026-11-04T01:00:00Z'), lastRunYm: null })).toBe(false);  // JST 11/4
    expect(shouldRunNow({ now: new Date('2026-11-01T00:30:00Z'), lastRunYm: null })).toBe(false);  // JST 11/1 09:30
    expect(shouldRunNow({ now: new Date('2026-10-31T15:30:00Z'), lastRunYm: null })).toBe(false);  // JST 11/1 00:30
  });
  test('その対象月をすでに突合していれば false', () => {
    expect(shouldRunNow({ now: new Date('2026-11-02T01:00:00Z'), lastRunYm: '2026-10' })).toBe(false);
    expect(shouldRunNow({ now: new Date('2026-11-02T01:00:00Z'), lastRunYm: '2026-09' })).toBe(true);
  });
});

describe('shouldRunNow（未完了の再試行）', () => {
  test('取得不可で未完了のまま送った日は再送しない。翌日（3 日まで）は再突合する', () => {
    // JST 11/1 10:00 に未完了で送った → 同日 14:00 は false、11/2 10:00 は true、11/4 は期間外
    expect(shouldRunNow({ now: new Date('2026-11-01T05:00:00Z'), lastRunYm: null, lastAttemptDay: '2026-11-01' })).toBe(false);
    expect(shouldRunNow({ now: new Date('2026-11-02T01:00:00Z'), lastRunYm: null, lastAttemptDay: '2026-11-01' })).toBe(true);
    expect(shouldRunNow({ now: new Date('2026-11-04T01:00:00Z'), lastRunYm: null, lastAttemptDay: '2026-11-01' })).toBe(false);
    // 完了していれば試行日に関係なく false
    expect(shouldRunNow({ now: new Date('2026-11-02T01:00:00Z'), lastRunYm: '2026-10', lastAttemptDay: null })).toBe(false);
  });
});
