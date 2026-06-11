// tests/notifications-chatwork.test.js
// Chatwork 投稿失敗の可視化・代替送信（バグ報告 #f03ba5cd）のユニットテスト。
//
// notifications.js は supabase.js（env 必須・欠落時 process.exit）を require するため、
// テストでは supabase / utils/notification をモックして純関数部分だけを検証する。

jest.mock('../supabase', () => ({}));
jest.mock('../utils/notification', () => ({ createBulkNotifications: jest.fn() }));
jest.mock('axios');

const axios = require('axios');
const {
  sendChatworkRoom,
  _formatChatworkFailureMessage,
} = require('../notifications');

describe('sendChatworkRoom', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    process.env.CHATWORK_API_TOKEN = 'dummy-token';
  });
  afterAll(() => {
    delete process.env.CHATWORK_API_TOKEN;
  });

  test('2xx は ok:true と status を返す', async () => {
    axios.post.mockResolvedValue({ status: 200, data: { message_id: '1' } });
    const r = await sendChatworkRoom('123', 'hello');
    expect(r).toEqual({ ok: true, status: 200 });
  });

  test('非2xx は throw せず status と Chatwork エラー本文を reason に含める', async () => {
    axios.post.mockResolvedValue({
      status: 403,
      data: { errors: ["You don't have permission to send messages to this room"] },
    });
    const r = await sendChatworkRoom('297050688', 'hello');
    expect(r.ok).toBe(false);
    expect(r.status).toBe(403);
    expect(r.reason).toContain('HTTP 403');
    expect(r.reason).toContain("don't have permission");
  });

  test('ネットワーク例外は reason にメッセージを返す', async () => {
    axios.post.mockRejectedValue(new Error('timeout of 10000ms exceeded'));
    const r = await sendChatworkRoom('123', 'hello');
    expect(r).toEqual({ ok: false, reason: 'timeout of 10000ms exceeded' });
  });

  test('トークン未設定は no_token', async () => {
    delete process.env.CHATWORK_API_TOKEN;
    const r = await sendChatworkRoom('123', 'hello');
    expect(r).toEqual({ ok: false, reason: 'no_token' });
    expect(axios.post).not.toHaveBeenCalled();
  });
});

describe('_formatChatworkFailureMessage', () => {
  const base = {
    roomId: '297050688',
    primary: { ok: false, status: 403, reason: 'HTTP 403: no permission' },
    creativeId: 'abc-123',
    fileName: 'D-991-6_1級土木模擬試験',
  };

  test('代替送信成功: ルームID設定の確認を促す', () => {
    const msg = _formatChatworkFailureMessage({
      ...base,
      fallbackRoomId: '405578619',
      fallback: { ok: true, status: 200 },
    });
    expect(msg).toContain('297050688');
    expect(msg).toContain('HTTP 403');
    expect(msg).toContain('405578619');
    expect(msg).toContain('代替送信しました');
    expect(msg).toContain('abc-123');
  });

  test('代替送信も失敗: トークン確認を促す', () => {
    const msg = _formatChatworkFailureMessage({
      ...base,
      fallbackRoomId: '405578619',
      fallback: { ok: false, reason: 'HTTP 401: invalid token' },
    });
    expect(msg).toContain('代替送信も失敗');
    expect(msg).toContain('CHATWORK_API_TOKEN');
  });

  test('代替先なし', () => {
    const msg = _formatChatworkFailureMessage({ ...base, fallbackRoomId: null, fallback: null });
    expect(msg).toContain('代替送信先（クライアント側ルーム）はありません');
  });
});
