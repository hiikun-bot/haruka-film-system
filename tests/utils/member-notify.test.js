// tests/utils/member-notify.test.js — 個別通知モード privateOnly（ADR 049 追補）の送信先決定
// 共有ルーム（[To:] 付き全体チャット）へは絶対に送らず、届かなければ管理者マイチャットへ転送依頼する。

const mockSettings = {};
jest.mock('../../supabase', () => ({
  from: jest.fn(() => ({
    select: jest.fn(() => ({
      eq: jest.fn((k, key) => ({
        maybeSingle: jest.fn(async () => ({ data: mockSettings[key] ? { value: mockSettings[key] } : null })),
      })),
    })),
  })),
}));
jest.mock('../../utils/roles', () => ({ getUsersRolesMap: jest.fn(), roleCodesHavePermission: jest.fn() }));

const mockNotif = {
  sendChatworkRoom: jest.fn(),
  sendSlackDm: jest.fn(),
  sendSlackDmAsUser: jest.fn(),
  resolveChatworkMyAccountId: jest.fn(),
  resolveAdminMyChatRoomId: jest.fn(),
};
jest.mock('../../notifications', () => mockNotif);

const { notifyMember } = require('../../utils/member-notify');
const msg = { chatwork: '[info]秘密の内容[/info]', slack: '*秘密の内容*' };

beforeEach(() => {
  jest.clearAllMocks();
  process.env.CHATWORK_API_TOKEN = 'tok';
  mockNotif.resolveChatworkMyAccountId.mockResolvedValue('111');
  mockNotif.resolveAdminMyChatRoomId.mockResolvedValue('297050688');
  mockNotif.sendChatworkRoom.mockResolvedValue({ ok: true });
  mockNotif.sendSlackDm.mockResolvedValue({ ok: true });
  mockNotif.sendSlackDmAsUser.mockResolvedValue({ ok: false, reason: 'no' });
});

describe('notifyMember privateOnly', () => {
  test('管理者本人（トークン名義人）宛はマイチャットへ', async () => {
    const r = await notifyMember({ chatwork_dm_id: '111', chatwork_direct_room_id: '999' }, msg, { privateOnly: true });
    expect(r).toMatchObject({ ok: true, channel: 'chatwork_mychat' });
    expect(mockNotif.sendChatworkRoom).toHaveBeenCalledWith('297050688', msg.chatwork, { token: 'tok' });
    expect(mockNotif.sendChatworkRoom).toHaveBeenCalledTimes(1);
  });
  test('個別チャットがあればそこへ（共有ルームは使わない）', async () => {
    const r = await notifyMember({ chatwork_dm_id: '222', chatwork_direct_room_id: '555' }, msg, { privateOnly: true });
    expect(r).toMatchObject({ ok: true, channel: 'chatwork_direct' });
    expect(mockNotif.sendChatworkRoom).toHaveBeenCalledWith('555', msg.chatwork);
  });
  test('個別チャットが無ければ Slack DM', async () => {
    const r = await notifyMember({ chatwork_dm_id: '222', slack_dm_id: 'U123' }, msg, { privateOnly: true });
    expect(r).toMatchObject({ ok: true, channel: 'slack_dm' });
    expect(mockNotif.sendChatworkRoom).not.toHaveBeenCalled();
  });
  test('chatwork_dm_id しか無い人は共有ルームに [To:] で流さず、管理者マイチャットへ転送依頼', async () => {
    const r = await notifyMember({ full_name: '謝花 利枝', chatwork_dm_id: '222' }, msg, { privateOnly: true });
    expect(r).toMatchObject({ ok: true, forwarded: true, channel: 'chatwork_mychat_fallback' });
    expect(mockNotif.sendChatworkRoom).toHaveBeenCalledTimes(1);
    const [room, body] = mockNotif.sendChatworkRoom.mock.calls[0];
    expect(room).toBe('297050688');
    expect(body).toContain('【転送依頼】謝花 利枝さんへ届けられませんでした');
    expect(body).toContain('秘密の内容');
    expect(body).not.toContain('[To:');
  });
  test('個別チャット送信に失敗しても共有ルームへ落ちず、マイチャットへ転送依頼', async () => {
    mockNotif.sendChatworkRoom.mockResolvedValueOnce({ ok: false, reason: 'HTTP 403' }).mockResolvedValueOnce({ ok: true });
    const r = await notifyMember({ nickname: 'パンセ', chatwork_dm_id: '222', chatwork_direct_room_id: '555' }, msg, { privateOnly: true });
    expect(r).toMatchObject({ ok: true, forwarded: true, channel: 'chatwork_mychat_fallback' });
    const rooms = mockNotif.sendChatworkRoom.mock.calls.map(c => c[0]);
    expect(rooms).toEqual(['555', '297050688']);
    expect(mockNotif.sendChatworkRoom.mock.calls[1][1]).toContain('理由: Chatwork DM 送信に失敗（HTTP 403）');
  });
  test('マイチャットも解決できなければ ok=false（どこにも送らない）', async () => {
    mockNotif.resolveAdminMyChatRoomId.mockResolvedValue(null);
    const r = await notifyMember({ chatwork_dm_id: '222' }, msg, { privateOnly: true });
    expect(r.ok).toBe(false);
    expect(mockNotif.sendChatworkRoom).not.toHaveBeenCalled();
  });
});

describe('notifyMember 既定（契約・振込の従来挙動は変えない）', () => {
  test('個別チャットが無ければ共有ルームへ [To:] で送る', async () => {
    const r = await notifyMember({ chatwork_dm_id: '222' }, msg);
    expect(r).toMatchObject({ ok: true, channel: 'chatwork_room' });
    expect(mockNotif.sendChatworkRoom.mock.calls[0][1]).toContain('[To:222]');
  });
});
