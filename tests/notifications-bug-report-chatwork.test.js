// tests/notifications-bug-report-chatwork.test.js
// バグ報告の新規登録 → 管理者 Chatwork マイチャットへ一報 のユニットテスト。
// notifications.js は supabase.js（env 必須）を require するためモックし、
// axios もモックして「送信先の決定」と「本文の組み立て」を検証する。

jest.mock('../supabase', () => ({}));
jest.mock('../utils/notification', () => ({ createBulkNotifications: jest.fn() }));
jest.mock('axios');

const axios = require('axios');
const {
  notifyBugReportCreated,
  resolveChatworkMyRoomId,
  _formatBugReportCreatedText,
} = require('../notifications');

const baseReport = {
  id: 'abcd-1234',
  title: '案件ごとに対応チームを選べるようにして欲しい',
  description: '行1\r\n行2',
  severity: 'normal',
  is_urgent: false,
  is_anonymous: false,
  status: 'open',
  screen_label: 'クリエイティブ一覧',
  duplicate_of_id: null,
};

describe('_formatBugReportCreatedText', () => {
  beforeEach(() => { process.env.APP_URL = 'https://hfs.example.com'; });
  afterEach(() => { delete process.env.APP_URL; });

  test('タイトル・重要度・報告者・画面・詳細・確認リンクを含む', () => {
    const text = _formatBugReportCreatedText({
      report: baseReport,
      reporter: { nickname: 'くるみ', full_name: '南 成美' },
    });
    expect(text).toContain('[title]🐛 新しいバグ報告が届きました[/title]');
    expect(text).toContain('タイトル: 案件ごとに対応チームを選べるようにして欲しい');
    expect(text).toContain('重要度: 🟡 通常');
    expect(text).not.toContain('至急');
    expect(text).toContain('報告者: くるみ（南 成美）');
    expect(text).toContain('画面: クリエイティブ一覧');
    expect(text).toContain('詳細: 行1\n行2');
    expect(text).toContain('確認: https://hfs.example.com/haruka.html?bug-report=abcd-1234');
  });

  test('至急フラグと匿名は明示される', () => {
    const text = _formatBugReportCreatedText({
      report: { ...baseReport, is_urgent: true, is_anonymous: true, severity: 'critical' },
      reporter: null,
    });
    expect(text).toContain('重要度: 🚨 致命的 ／ 🚨 至急');
    expect(text).toContain('報告者: 匿名');
  });

  test('「これと同じです」登録は同件ヘッダーと注記になる', () => {
    const text = _formatBugReportCreatedText({
      report: { ...baseReport, duplicate_of_id: 'parent-1', status: 'duplicate' },
      reporter: { full_name: '片山 紗季' },
    });
    expect(text).toContain('[title]🐛 バグ報告（同件）が届きました[/title]');
    expect(text).toContain('既存の報告に紐付けて登録');
    expect(text).toContain('報告者: 片山 紗季');
  });

  test('詳細は200字で切り詰める', () => {
    const text = _formatBugReportCreatedText({
      report: { ...baseReport, description: 'あ'.repeat(300) },
      reporter: null,
    });
    expect(text).toContain('詳細: ' + 'あ'.repeat(200) + '…');
    expect(text).not.toContain('あ'.repeat(201));
  });
});

describe('resolveChatworkMyRoomId / notifyBugReportCreated', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    process.env.CHATWORK_API_TOKEN = 'tok-' + Math.random(); // キャッシュを毎回無効化
    delete process.env.BUG_REPORT_NOTIFY_CHATWORK_ROOM_ID;
  });
  afterAll(() => {
    delete process.env.CHATWORK_API_TOKEN;
    delete process.env.BUG_REPORT_NOTIFY_CHATWORK_ROOM_ID;
  });

  test('GET /rooms から type=my のルームIDを返す', async () => {
    axios.get.mockResolvedValue({ status: 200, data: [
      { room_id: 365971239, name: '【HF】全体チャット', type: 'group' },
      { room_id: 297050688, name: 'マイチャット', type: 'my' },
    ] });
    const id = await resolveChatworkMyRoomId(process.env.CHATWORK_API_TOKEN);
    expect(id).toBe('297050688');
    expect(axios.get).toHaveBeenCalledWith('https://api.chatwork.com/v2/rooms', expect.objectContaining({
      headers: { 'X-ChatWorkToken': process.env.CHATWORK_API_TOKEN },
    }));
  });

  test('ルーム未指定ならマイチャットを自動検出して投稿する', async () => {
    axios.get.mockResolvedValue({ status: 200, data: [{ room_id: 297050688, type: 'my' }] });
    axios.post.mockResolvedValue({ status: 200, data: { message_id: '1' } });
    const r = await notifyBugReportCreated({ report: baseReport, reporter: { nickname: 'ぴょん', full_name: '片山 紗季' } });
    expect(r.ok).toBe(true);
    expect(axios.post).toHaveBeenCalledTimes(1);
    const [url, body] = axios.post.mock.calls[0];
    expect(url).toBe('https://api.chatwork.com/v2/rooms/297050688/messages');
    const sent = new URLSearchParams(String(body)).get('body');
    expect(sent).toContain('🐛 新しいバグ報告が届きました');
    expect(sent).toContain('報告者: ぴょん（片山 紗季）');
  });

  test('env BUG_REPORT_NOTIFY_CHATWORK_ROOM_ID があればそのルームへ（rooms 取得なし）', async () => {
    process.env.BUG_REPORT_NOTIFY_CHATWORK_ROOM_ID = '111222333';
    axios.post.mockResolvedValue({ status: 200, data: {} });
    const r = await notifyBugReportCreated({ report: baseReport, reporter: null });
    expect(r.ok).toBe(true);
    expect(axios.get).not.toHaveBeenCalled();
    expect(axios.post.mock.calls[0][0]).toBe('https://api.chatwork.com/v2/rooms/111222333/messages');
  });

  test('マイチャットが見つからなければ投稿せず no_room', async () => {
    axios.get.mockResolvedValue({ status: 200, data: [{ room_id: 1, type: 'group' }] });
    const r = await notifyBugReportCreated({ report: baseReport, reporter: null });
    expect(r).toEqual({ ok: false, reason: 'no_room' });
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('トークン未設定なら何もしない', async () => {
    delete process.env.CHATWORK_API_TOKEN;
    const r = await notifyBugReportCreated({ report: baseReport, reporter: null });
    expect(r).toEqual({ ok: false, reason: 'no_token' });
    expect(axios.get).not.toHaveBeenCalled();
  });
});
