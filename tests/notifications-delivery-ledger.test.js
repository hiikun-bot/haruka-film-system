// tests/notifications-delivery-ledger.test.js
// ADR 055: 一括納品完了（月次消込）の案件チャンネル向け台帳投稿 notifyProjectDeliveryLedger と、
// Chatwork [info] 内への差し込み _appendInsideChatworkInfo のユニットテスト。

jest.mock('axios');
jest.mock('../utils/notification', () => ({ createBulkNotifications: jest.fn() }));

// テーブルごとに返す行を差し替えられる最小の Supabase mock
const mockTables = {};
const mockInserted = {};
function mockMakeQuery(table) {
  const q = { _table: table, _filters: [], _head: false };
  const chain = (name) => (...a) => { q._filters.push([name, ...a]); return q; };
  ['eq', 'gte', 'lt', 'not', 'order', 'limit', 'in'].forEach(n => { q[n] = chain(n); });
  q.select = (_cols, opts) => { q._head = !!(opts && opts.head); return q; };
  q.insert = (row) => { (mockInserted[table] = mockInserted[table] || []).push(row); return Promise.resolve({ data: null, error: null }); };
  q.maybeSingle = () => Promise.resolve({ data: (mockTables[table] || [])[0] || null, error: null });
  q.then = (resolve, reject) => {
    if (q._head) return Promise.resolve({ data: null, error: null, count: (mockTables[table] || []).length }).then(resolve, reject);
    return Promise.resolve({ data: mockTables[table] || [], error: null }).then(resolve, reject);
  };
  return q;
}
jest.mock('../supabase', () => ({ from: jest.fn((table) => mockMakeQuery(table)) }));

const axios = require('axios');
const { notifyProjectDeliveryLedger, _appendInsideChatworkInfo } = require('../notifications');

describe('_appendInsideChatworkInfo', () => {
  test('[/info] の直前に差し込む', () => {
    const out = _appendInsideChatworkInfo('[info][title]x[/title]本文[/info]', '台帳');
    expect(out).toBe('[info][title]x[/title]本文\n\n台帳\n[/info]');
  });
  test('[/info] で終わっていなければ末尾に追記', () => {
    expect(_appendInsideChatworkInfo('本文', '台帳')).toBe('本文\n\n台帳');
  });
});

describe('notifyProjectDeliveryLedger', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    for (const k of Object.keys(mockTables)) delete mockTables[k];
    for (const k of Object.keys(mockInserted)) delete mockInserted[k];
    process.env.CHATWORK_API_TOKEN = 'cw-token';
    mockTables.projects = [{
      id: 'p1', name: 'LP制作', director_id: 'u-dir',
      slack_channel_url: null, chatwork_room_id: '12345',
      clients: { id: 'cl1', name: '東京ガス', slack_channel_url: null, chatwork_room_id: null },
    }];
    mockTables.users = [{ id: 'u-dir', full_name: '片山 紗季', slack_dm_id: null, chatwork_dm_id: '999' }];
    mockTables.creatives = [
      { id: 'c1', file_name: 'A.mp4', creative_type: '動画', delivered_at: '2026-10-02T01:00:00Z' },
      { id: 'c2', file_name: 'B.mp4', creative_type: '動画', delivered_at: '2026-10-30T01:00:00Z' },
      { id: 'c3', file_name: 'C.mp4', creative_type: '動画', delivered_at: '2026-10-30T01:00:01Z' },
    ];
    // Chatwork: ルームメンバー照会（actor 名義判定）と投稿の両方を 200 で返す
    axios.get.mockResolvedValue({ status: 200, data: [] });
    axios.post.mockResolvedValue({ status: 200, data: { message_id: '1' } });
  });
  afterEach(() => { delete process.env.CHATWORK_API_TOKEN; });

  test('案件ルームへ 1 通、ディレクター To 付きで台帳を投稿し、ledger を返す', async () => {
    const { ledger } = await notifyProjectDeliveryLedger({
      projectId: 'p1', creativeIds: ['c2', 'c3'], actorUserId: 'u-dir', ym: '2026-10',
    });
    expect(ledger.monthTotal).toBe(3);
    expect(ledger.projectTotal).toBe(3);
    const posts = axios.post.mock.calls.filter(c => String(c[0]).includes('/rooms/12345/messages'));
    expect(posts).toHaveLength(1);
    const body = posts[0][1].get('body');
    expect(body.startsWith('[To:999]\n')).toBe(true);
    expect(body).toContain('[title]📦 一括納品完了（月次消込）[/title]');
    expect(body).toContain('案件: 【東京ガス】LP制作');
    expect(body).toContain('📊 納品カウント（2026年10月）: 今回 2件 → 当月 3件 ／ 案件累計 3件');
    expect(body).toContain('　①10/2 A.mp4');
    expect(body).toContain('　②10/30 B.mp4 🆕');
    expect(body).toContain('　③10/30 C.mp4 🆕');
    expect(body).toContain('[HFS-LEDGER] project=p1 month=2026-10 added=2 month_total=3 project_total=3');
    expect(body.trim().endsWith('[/info]')).toBe(true);
    // ADR 055 追補: 投稿記録（delivery_ledger_posts）に Chatwork 分 1 行
    expect(mockInserted.delivery_ledger_posts).toHaveLength(1);
    expect(mockInserted.delivery_ledger_posts[0]).toMatchObject({
      project_id: 'p1', ym: '2026-10', platform: 'chatwork', channel_ref: '12345', message_id: '1',
      kind: 'bulk', creative_ids: ['c2', 'c3'], seq: null, added: 2, month_total: 3, project_total: 3, posted_by: 'u-dir',
    });
    expect(mockInserted.delivery_ledger_posts[0].tag).toBe('[HFS-LEDGER] project=p1 month=2026-10 added=2 month_total=3 project_total=3');
  });

  test('通知先が未設定でも ledger は返す（ダイジェストの当月累計用）、投稿はしない', async () => {
    mockTables.projects[0].chatwork_room_id = null;
    const { ledger } = await notifyProjectDeliveryLedger({
      projectId: 'p1', creativeIds: ['c2'], actorUserId: null, ym: '2026-10',
    });
    expect(ledger.monthTotal).toBe(3);
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('creativeIds が空なら何もしない', async () => {
    const r = await notifyProjectDeliveryLedger({ projectId: 'p1', creativeIds: [], actorUserId: null, ym: '2026-10' });
    expect(r).toEqual({ ledger: null });
    expect(axios.post).not.toHaveBeenCalled();
  });
});
