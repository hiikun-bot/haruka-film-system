// tests/withholding-monthly-reminder.test.js
// 月初リマインド（ADR 054 §5）の送信判定（純関数）。supabase は読み込まれるがネットワークには触れない。
jest.mock('../supabase', () => ({ from: () => { throw new Error('not used in this test'); } }));
const { decideWithholdingReminderAction } = require('../workers/withholding-monthly-reminder');
const { resolveItemPaidAt, jstDateToIso } = require('../utils/withholding-ledger-source');

describe('resolveItemPaidAt（API 振込の支払日は振込指定日・JST）', () => {
  test('transfer_designated_date を JST 0:00 として優先し、月またぎで completed_at の月に引きずられない', () => {
    // 10/31 指定の振込を HFS が 11/1 02:00 JST（10/31 17:00Z）に完了検知 → 支払日は 10/31（10 月分）
    const item = { batch: { transfer_designated_date: '2026-10-31', completed_at: '2026-10-31T17:00:00Z' } };
    expect(resolveItemPaidAt(item)).toBe('2026-10-30T15:00:00.000Z');
    expect(new Date(resolveItemPaidAt(item)).toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' })).toBe('2026-10-31');
    expect(jstDateToIso('2027-01-05')).toBe('2027-01-04T15:00:00.000Z');
  });
  test('指定日が無ければ batch.completed_at、どちらも無ければ null', () => {
    expect(resolveItemPaidAt({ batch: { completed_at: '2026-10-31T17:00:00Z' } })).toBe('2026-10-31T17:00:00Z');
    expect(resolveItemPaidAt({ batch: {} })).toBeNull();
    expect(resolveItemPaidAt({ completed_at: '2026-10-31T17:00:00Z' })).toBeNull(); // 明細側の completed_at は見ない（列が無い）
  });
});

describe('decideWithholdingReminderAction', () => {
  test('毎月1日 10時以降に前月分を送る', () => {
    expect(decideWithholdingReminderAction({ jstDate: '2026-11-01', jstHour: 10, lastSentMonth: null }))
      .toEqual({ action: 'send', year: 2026, month: 10, monthKey: '2026-10' });
    expect(decideWithholdingReminderAction({ jstDate: '2027-01-01', jstHour: 12, lastSentMonth: '2026-11' }))
      .toEqual({ action: 'send', year: 2026, month: 12, monthKey: '2026-12' });
  });
  test('10時前・6日以降・送信済みはスキップ', () => {
    expect(decideWithholdingReminderAction({ jstDate: '2026-11-01', jstHour: 9, lastSentMonth: null })).toEqual({ action: 'skip' });
    expect(decideWithholdingReminderAction({ jstDate: '2026-11-06', jstHour: 10, lastSentMonth: null })).toEqual({ action: 'skip' });
    expect(decideWithholdingReminderAction({ jstDate: '2026-11-15', jstHour: 10, lastSentMonth: null })).toEqual({ action: 'skip' });
    expect(decideWithholdingReminderAction({ jstDate: '2026-11-02', jstHour: 10, lastSentMonth: '2026-10' })).toEqual({ action: 'skip' });
  });
  test('1日に送れなかったら5日までリカバリ送信する', () => {
    expect(decideWithholdingReminderAction({ jstDate: '2026-11-05', jstHour: 14, lastSentMonth: '2026-09' }))
      .toEqual({ action: 'send', year: 2026, month: 10, monthKey: '2026-10' });
  });
});
