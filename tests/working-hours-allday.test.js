// tests/working-hours-allday.test.js
// バグ #2309e07e: GCal 連携メンバーの稼働が全日 0h になる不具合の回帰テスト。
// 原因は「終日イベント（勤務場所/誕生日 等）を 24h まるごと busy 扱いしていた」こと。
const wh = require('../lib/working-hours');

// 平日 9:00-19:00 (10h) の base slots
const base = [{ from: '09:00', to: '19:00' }];
const DATE = '2026-07-06'; // 月曜

describe('subtractEvents: 終日イベントは稼働を潰さない', () => {
  test('勤務場所(workingLocation)の終日イベントがあっても全日0にならない', () => {
    const events = [
      { start: '2026-07-06', end: '2026-07-07', isAllDay: true, status: 'confirmed', transparency: 'opaque', eventType: 'workingLocation' },
    ];
    const r = wh.subtractEvents(base, events, { dateStr: DATE });
    expect(r.hours).toBe(10); // 終日ラベルは無視 → base のまま
  });

  test('eventType未指定(default)の終日イベントも稼働を潰さない', () => {
    const events = [
      { start: '2026-07-06', end: '2026-07-07', isAllDay: true, status: 'confirmed', transparency: 'opaque', eventType: 'default' },
    ];
    const r = wh.subtractEvents(base, events, { dateStr: DATE });
    expect(r.hours).toBe(10);
  });

  test('誕生日(birthday)の終日イベントも稼働を潰さない', () => {
    const events = [
      { start: '2026-07-06', end: '2026-07-07', isAllDay: true, status: 'confirmed', transparency: 'opaque', eventType: 'birthday' },
    ];
    const r = wh.subtractEvents(base, events, { dateStr: DATE });
    expect(r.hours).toBe(10);
  });

  test('不在(outOfOffice)の終日イベントは稼働を0にする', () => {
    const events = [
      { start: '2026-07-06', end: '2026-07-07', isAllDay: true, status: 'confirmed', transparency: 'opaque', eventType: 'outOfOffice' },
    ];
    const r = wh.subtractEvents(base, events, { dateStr: DATE });
    expect(r.hours).toBe(0);
  });

  test('時間指定の予定は従来どおり差し引く（終日変更の巻き添えなし）', () => {
    const events = [
      // 13:00-14:00 JST の打合せ
      { start: '2026-07-06T13:00:00+09:00', end: '2026-07-06T14:00:00+09:00', isAllDay: false, status: 'confirmed', transparency: 'opaque', eventType: 'default' },
    ];
    const r = wh.subtractEvents(base, events, { dateStr: DATE });
    expect(r.hours).toBe(9); // 10h - 1h
  });

  test('終日ラベル + 時間指定予定: 時間指定分だけ引かれる', () => {
    const events = [
      { start: '2026-07-06', end: '2026-07-07', isAllDay: true, status: 'confirmed', transparency: 'opaque', eventType: 'workingLocation' },
      { start: '2026-07-06T13:00:00+09:00', end: '2026-07-06T15:00:00+09:00', isAllDay: false, status: 'confirmed', transparency: 'opaque', eventType: 'default' },
    ];
    const r = wh.subtractEvents(base, events, { dateStr: DATE });
    expect(r.hours).toBe(8); // 10h - 2h（終日ラベルは無視）
  });
});
