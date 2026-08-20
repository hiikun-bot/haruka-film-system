// tests/workers/onboarding-stall-reminder.test.js
// オンボーディング停滞催促の純関数テスト（停滞判定・文例生成）。
// supabase / notifications は env 必須のためモックする。
// 日付計算は epoch ms ベースなので TZ=UTC / TZ=Asia/Tokyo で同結果になる。

jest.mock('../../supabase', () => ({}));
jest.mock('../../notifications', () => ({ sendSlackDm: jest.fn() }));

const {
  shouldSendStallReminder,
  buildMemberReminderText,
  buildAdminFallbackText,
  DEFAULT_STALL_DAYS,
} = require('../../workers/onboarding-stall-reminder');

const DAY = 86_400_000;
const NOW = Date.parse('2026-08-25T03:00:00Z'); // JST 12:00

describe('shouldSendStallReminder（停滞判定）', () => {
  test('作成から stallDays 日経過で催促、未満なら催促しない', () => {
    expect(shouldSendStallReminder({
      nowMs: NOW, createdAt: new Date(NOW - 3 * DAY).toISOString(), stallDays: 3,
    })).toBe(true);
    expect(shouldSendStallReminder({
      nowMs: NOW, createdAt: new Date(NOW - 2.5 * DAY).toISOString(), stallDays: 3,
    })).toBe(false);
  });

  test('最近タスクが進んでいれば（done_at が新しい）催促しない', () => {
    expect(shouldSendStallReminder({
      nowMs: NOW,
      createdAt: new Date(NOW - 10 * DAY).toISOString(),
      lastDoneAt: new Date(NOW - 1 * DAY).toISOString(),
      stallDays: 3,
    })).toBe(false);
  });

  test('前回催促から stallDays 日未満は再催促しない（毎日鳴らない）', () => {
    expect(shouldSendStallReminder({
      nowMs: NOW,
      createdAt: new Date(NOW - 10 * DAY).toISOString(),
      lastRemindedAt: new Date(NOW - 1 * DAY).toISOString(),
      stallDays: 3,
    })).toBe(false);
    expect(shouldSendStallReminder({
      nowMs: NOW,
      createdAt: new Date(NOW - 10 * DAY).toISOString(),
      lastRemindedAt: new Date(NOW - 3 * DAY).toISOString(),
      stallDays: 3,
    })).toBe(true);
  });

  test('日時が一切無い場合は催促しない（安全側）', () => {
    expect(shouldSendStallReminder({ nowMs: NOW, stallDays: 3 })).toBe(false);
  });

  test('既定の催促日数は3日', () => {
    expect(DEFAULT_STALL_DAYS).toBe(3);
  });
});

describe('文例生成', () => {
  test('本人向け: 呼び名と未完了タスクを列挙し、問い合わせ先はひーくん', () => {
    const text = buildMemberReminderText({
      displayName: 'キャシーG',
      pendingLabels: ['GND契約書の提出', '個人情報フォーム回答'],
    });
    expect(text).toContain('キャシーGさん、お疲れ様です');
    expect(text).toContain('・GND契約書の提出');
    expect(text).toContain('・個人情報フォーム回答');
    expect(text).toContain('ひーくんへDM');
    expect(text).not.toContain('秘書');
  });

  test('admin向け: 停滞情報とコピペ用文例を含む', () => {
    const memberText = buildMemberReminderText({ displayName: '柏木', pendingLabels: ['GND契約書の提出'] });
    const text = buildAdminFallbackText({
      memberName: '柏木 薫（キャシーG）',
      occupationLabel: '動画クリエイター',
      stallDays: 3,
      pendingLabels: ['GND契約書の提出'],
      memberText,
    });
    expect(text).toContain('🔔 オンボーディング停滞: 柏木 薫（キャシーG）（動画クリエイター）');
    expect(text).toContain('3日以上');
    expect(text).toContain('文例を送ってあげてください');
    expect(text).toContain(memberText);
  });
});
