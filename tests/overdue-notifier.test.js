// tests/overdue-notifier.test.js — 提出遅れ日次通知ワーカ（ADR 049）の実行判定・1回分の実行をモックで検証
// TZ=UTC / TZ=Asia/Tokyo のどちらでも同じ結果になること（Railway は UTC 動作）。

const mockSb = { _creatives: [], _teams: [], _users: [], _sentLogs: [] };

function mockChain(result) {
  const q = {};
  const self = () => q;
  ['select', 'lt', 'neq', 'order', 'eq', 'in', 'contains'].forEach(k => { q[k] = jest.fn(self); });
  q.range = jest.fn(() => Promise.resolve(result()));
  q.then = (resolve, reject) => Promise.resolve(result()).then(resolve, reject);
  return q;
}

jest.mock('../supabase', () => ({
  from: jest.fn((table) => {
    if (table === 'creatives') return mockChain(() => ({ data: mockSb._creatives, error: null }));
    if (table === 'teams') return mockChain(() => ({ data: mockSb._teams, error: null }));
    if (table === 'users') return mockChain(() => ({ data: mockSb._users, error: null }));
    if (table === 'notification_logs') return mockChain(() => ({ data: mockSb._sentLogs, error: null }));
    return mockChain(() => ({ data: [], error: null }));
  }),
}));
const mockCreateNotification = jest.fn(async () => ({ id: 'n1' }));
jest.mock('../utils/notification', () => ({ createNotification: (...a) => mockCreateNotification(...a) }));
const mockNotifyMember = jest.fn(async () => ({ ok: true, channel: 'chatwork_direct' }));
jest.mock('../utils/member-notify', () => ({
  notifyMember: (...a) => mockNotifyMember(...a),
  NOTIFY_USER_COLUMNS: 'id, full_name, nickname, is_active, chatwork_dm_id, chatwork_direct_room_id, slack_dm_id',
}));
jest.mock('../notifications', () => ({ buildAppUrl: (p) => `https://app.example/${p}` }));

const { shouldRunNow, runOnce } = require('../workers/overdue-notifier');

describe('shouldRunNow', () => {
  test('平日 JST 10 時台・未実行なら true', () => {
    expect(shouldRunNow({ now: new Date('2026-10-08T01:10:00Z'), lastRunDay: null })).toBe(true);
  });
  test('同じ日に実行済みなら false', () => {
    expect(shouldRunNow({ now: new Date('2026-10-08T01:40:00Z'), lastRunDay: '2026-10-08' })).toBe(false);
  });
  test('JST 9 時台はまだ・19 時以降はもう走らない', () => {
    expect(shouldRunNow({ now: new Date('2026-10-08T00:10:00Z'), lastRunDay: null })).toBe(false);
    expect(shouldRunNow({ now: new Date('2026-10-08T10:10:00Z'), lastRunDay: null })).toBe(false);
  });
  test('土日・祝日は走らない', () => {
    expect(shouldRunNow({ now: new Date('2026-10-10T01:10:00Z'), lastRunDay: null })).toBe(false); // 土
    expect(shouldRunNow({ now: new Date('2026-10-12T01:10:00Z'), lastRunDay: null })).toBe(false); // スポーツの日
  });
});

describe('runOnce', () => {
  beforeEach(() => {
    mockCreateNotification.mockClear();
    mockNotifyMember.mockClear();
    mockSb._teams = [{ id: 'team-A', director_id: 'dir-team', team_members: [{ user_id: 'ed-1' }] }];
    mockSb._users = [
      { id: 'dir-proj', full_name: '川崎 かおり', nickname: 'かおり', is_active: true },
      { id: 'prod-1', full_name: '髙橋 聖', nickname: 'ハル', is_active: true },
      { id: 'dir-team', full_name: 'チーム D', nickname: null, is_active: true },
      { id: 'retired', full_name: '退職 者', nickname: null, is_active: false },
    ];
    mockSb._sentLogs = [];
    mockSb._creatives = [
      { id: 'c1', file_name: 'a.mp4', status: 'Dチェック', final_deadline: '2026-09-30', force_delivered: false,
        projects: { name: 'P1', director_id: 'dir-proj', producer_id: 'prod-1', clients: { name: 'hertech', status: '進行中' } },
        creative_assignments: [{ role: 'editor', user_id: 'ed-1', users: { id: 'ed-1', nickname: 'パンセ', team_id: 'team-A' } }] },
      { id: 'c2', file_name: 'b.mp4', status: '編集', final_deadline: '2026-10-05', force_delivered: false,
        projects: { name: 'P2', director_id: null, producer_id: 'prod-1', clients: { name: 'ハビー', status: '進行中' } },
        creative_assignments: [{ role: 'editor', user_id: 'ed-1', users: { id: 'ed-1', nickname: 'パンセ', team_id: 'team-A' } }] },
      { id: 'c3', file_name: 'ended.mp4', status: '編集', final_deadline: '2026-10-01', force_delivered: false,
        projects: { name: 'P3', director_id: 'retired', producer_id: null, clients: { name: '旧', status: 'クライアント取引終了' } },
        creative_assignments: [] },
      { id: 'c4', file_name: 'forced.mp4', status: '編集', final_deadline: '2026-10-01', force_delivered: true,
        projects: { name: 'P4', director_id: 'dir-proj', producer_id: null, clients: { name: 'x', status: '進行中' } },
        creative_assignments: [] },
    ];
  });

  test('管理 D/P ごとに 1 通ずつ（ベル＋DM）。取引終了・強制納品は除外。チーム代表 D はフォールバックで受信', async () => {
    const r = await runOnce(new Date('2026-10-08T01:10:00Z'));
    expect(r).toMatchObject({ today: '2026-10-08', overdue: 2, recipients: 3, sent: 3 });
    const bellTo = mockCreateNotification.mock.calls.map(c => c[0].userId).sort();
    expect(bellTo).toEqual(['dir-proj', 'dir-team', 'prod-1']);
    const prod = mockCreateNotification.mock.calls.find(c => c[0].userId === 'prod-1')[0];
    expect(prod.type).toBe('deadline');
    expect(prod.title).toBe('⏰ 提出遅れのクリエイティブ 2件（10/8時点）');
    expect(prod.linkUrl).toBe('/haruka.html?delayed=1');
    expect(prod.meta).toEqual({ digest_date: '2026-10-08', creative_ids: ['c1', 'c2'], count: 2 });
    const dm = mockNotifyMember.mock.calls.find(c => c[0].id === 'prod-1')[1];
    expect(dm.chatwork).toContain('[info][title]⏰ 提出遅れのクリエイティブ 2件');
    expect(dm.chatwork).toContain('■ hertech / a.mp4');
    expect(dm.chatwork).toContain('https://app.example/haruka.html?creative=c1');
    expect(dm.chatwork).toContain('進行ボード（遅延のみ表示）: https://app.example/haruka.html?delayed=1');
    // dir-team は c2（プロジェクト D 無し）だけ
    const team = mockCreateNotification.mock.calls.find(c => c[0].userId === 'dir-team')[0];
    expect(team.meta.creative_ids).toEqual(['c2']);
  });

  test('同じ日に送信済みの受信者には再送しない（再デプロイ耐性）', async () => {
    mockSb._sentLogs = [{ user_id: 'prod-1' }];
    const r = await runOnce(new Date('2026-10-08T01:10:00Z'));
    expect(r.sent).toBe(2);
    expect(mockCreateNotification.mock.calls.map(c => c[0].userId)).not.toContain('prod-1');
  });

  test('提出遅れが無ければ何も送らない', async () => {
    mockSb._creatives = [];
    const r = await runOnce(new Date('2026-10-08T01:10:00Z'));
    expect(r).toMatchObject({ overdue: 0, sent: 0 });
    expect(mockCreateNotification).not.toHaveBeenCalled();
    expect(mockNotifyMember).not.toHaveBeenCalled();
  });
});
