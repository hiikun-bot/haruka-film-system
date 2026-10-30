// tests/withholding-monthly-reminder.test.js
// 月初リマインド（ADR 054 §5）の送信判定（純関数）。supabase は読み込まれるがネットワークには触れない。
jest.mock('../supabase', () => ({ from: () => { throw new Error('not used in this test'); } }));
const { decideWithholdingReminderAction } = require('../workers/withholding-monthly-reminder');

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
