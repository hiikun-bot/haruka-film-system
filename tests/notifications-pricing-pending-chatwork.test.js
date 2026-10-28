// tests/notifications-pricing-pending-chatwork.test.js
// 単価の承認待ち → 管理者 Chatwork マイチャットへ必ず一報（ADR 037 追補）のユニットテスト。

jest.mock('../supabase', () => ({}));
jest.mock('../utils/notification', () => ({ createBulkNotifications: jest.fn() }));
jest.mock('axios');

const axios = require('axios');
const { notifyPricingPendingMyChat, _formatPricingPendingText } = require('../notifications');

const params = {
  actorLabel: 'ぴょん（片山 紗季）',
  clientName: '東京ガス',
  projectName: '東京ガスLPディレクション',
  projectId: 'proj-1',
  lineCount: 1,
};

describe('_formatPricingPendingText', () => {
  beforeEach(() => { process.env.APP_URL = 'https://hfs.example.com'; });
  afterEach(() => { delete process.env.APP_URL; });

  test('設定した人・案件・グループ数・見積タブへのリンクを含む', () => {
    const text = _formatPricingPendingText(params);
    expect(text).toContain('[title]💴 単価の承認待ちが届きました[/title]');
    expect(text).toContain('設定した人: ぴょん（片山 紗季）さん');
    expect(text).toContain('案件: 東京ガス / 東京ガスLPディレクション');
    expect(text).toContain('対象: 1グループ');
    expect(text).toContain('承認する: https://hfs.example.com/haruka.html?project=proj-1&tab=estimate');
  });
});

describe('notifyPricingPendingMyChat', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    process.env.CHATWORK_API_TOKEN = 'tok-' + Math.random();
    process.env.ADMIN_MYCHAT_CHATWORK_ROOM_ID = '297050688';
    delete process.env.ERROR_REPORT_SLACK_CHANNEL_URL;
  });
  afterEach(() => {
    delete process.env.CHATWORK_API_TOKEN;
    delete process.env.ADMIN_MYCHAT_CHATWORK_ROOM_ID;
  });

  test('管理者のマイチャットへ送る', async () => {
    axios.post.mockResolvedValue({ status: 200, data: {} });
    const r = await notifyPricingPendingMyChat(params);
    expect(r.ok).toBe(true);
    const [url, body] = axios.post.mock.calls[0];
    expect(url).toBe('https://api.chatwork.com/v2/rooms/297050688/messages');
    expect(body.get('body')).toContain('東京ガスLPディレクション');
  });

  test('トークンが無ければ送らず失敗を返す', async () => {
    delete process.env.CHATWORK_API_TOKEN;
    const r = await notifyPricingPendingMyChat(params);
    expect(r).toEqual({ ok: false, reason: 'no_token' });
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('送信失敗は ok:false を返す（例外にしない）', async () => {
    axios.post.mockResolvedValue({ status: 403, data: { errors: ['no permission'] } });
    const r = await notifyPricingPendingMyChat(params);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('403');
  });
});
