// tests/notifications-slack-url.test.js
// SlackチャンネルURLのパース・ワークスペース解決・失敗可視化（バグ報告 #5cf4ce3e）のユニットテスト。
//
// 背景: 案件の slack_channel_url にブラウザのアドレスバー形式
//   https://<workspace>.slack.com/archives/CXXXX
// を貼ると旧パーサ（/client/T.../C... 固定）が null を返し、sendSlackChannel が
// invalid_url で無言終了 → その案件のクリエイティブ通知が Slack に一切飛ばなかった。
//
// notifications.js は supabase.js（env 必須）を require するためモックする。

// jest.mock のファクトリはホイストされるため、外側の変数は `mock` 始まりの名前だけ参照できる。
const mockSlackWorkspaceRows = { data: [], error: null };

jest.mock('../supabase', () => ({
  from: () => ({
    select: () => ({
      // getSlackBotToken 用: .select().eq().maybeSingle()
      eq: () => ({
        maybeSingle: async () => ({
          data: (mockSlackWorkspaceRows.data || [])[0] || null,
          error: mockSlackWorkspaceRows.error,
        }),
      }),
      // resolveSlackWorkspace 用: .select() を直接 await（thenable）
      then: (resolve, reject) => Promise.resolve({ ...mockSlackWorkspaceRows }).then(resolve, reject),
    }),
  }),
}));
jest.mock('../utils/notification', () => ({ createBulkNotifications: jest.fn() }));
jest.mock('axios');

const axios = require('axios');
const {
  parseSlackChannelUrl,
  sendSlackChannel,
  _formatSlackFailureMessage,
} = require('../notifications');

const setWorkspaces = (rows, error = null) => {
  mockSlackWorkspaceRows.data = rows;
  mockSlackWorkspaceRows.error = error;
};

describe('parseSlackChannelUrl', () => {
  test('アプリ形式 /client/T.../C... を解釈する', () => {
    expect(parseSlackChannelUrl('https://app.slack.com/client/T094ST9L5MH/C0AQASBS9DK'))
      .toEqual({ team_id: 'T094ST9L5MH', channel_id: 'C0AQASBS9DK', domain: null });
  });

  test('アプリ形式は末尾にスレッドIDが付いていても解釈する', () => {
    const r = parseSlackChannelUrl('https://app.slack.com/client/T094ST9L5MH/C0AQASBS9DK/thread/C0AQ-1778');
    expect(r.channel_id).toBe('C0AQASBS9DK');
  });

  test('ブラウザ形式 /archives/C... を解釈し domain を返す（本バグの本体）', () => {
    expect(parseSlackChannelUrl('https://harukafilm.slack.com/archives/C0B9G8TB3TL'))
      .toEqual({ team_id: null, channel_id: 'C0B9G8TB3TL', domain: 'harukafilm' });
  });

  test('ブラウザ形式はメッセージ permalink（/pXXXX 付き）でもチャンネルを取り出す', () => {
    const r = parseSlackChannelUrl('https://goodnew-design-inc.slack.com/archives/C09LD2S2YG3/p1778117319985779');
    expect(r).toEqual({ team_id: null, channel_id: 'C09LD2S2YG3', domain: 'goodnew-design-inc' });
  });

  test('前後の空白は無視する', () => {
    expect(parseSlackChannelUrl('  https://harukafilm.slack.com/archives/C0B9G8TB3TL  ').channel_id)
      .toBe('C0B9G8TB3TL');
  });

  test('Slack と無関係な URL / 空値は null', () => {
    expect(parseSlackChannelUrl('https://example.com/foo')).toBeNull();
    expect(parseSlackChannelUrl('')).toBeNull();
    expect(parseSlackChannelUrl(null)).toBeNull();
  });
});

describe('sendSlackChannel（ワークスペース解決）', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    setWorkspaces([]);
  });

  test('archives 形式: サブドメイン一致でワークスペースの bot_token を使って投稿する', async () => {
    setWorkspaces([{ team_id: 'T094ST9L5MH', bot_token: 'xoxb-haruka' }]);
    axios.post.mockImplementation(async (url) => {
      if (url.endsWith('auth.test')) return { data: { ok: true, url: 'https://harukafilm.slack.com/' } };
      return { data: { ok: true } };
    });
    const r = await sendSlackChannel('https://harukafilm.slack.com/archives/C0B9G8TB3TL', 'hello');
    expect(r.ok).toBe(true);
    const postCall = axios.post.mock.calls.find(c => c[0].endsWith('chat.postMessage'));
    expect(postCall[1]).toEqual({ channel: 'C0B9G8TB3TL', text: 'hello' });
    expect(postCall[2].headers.Authorization).toBe('Bearer xoxb-haruka');
  });

  test('archives 形式: 登録済みワークスペースのどれとも一致しなければ workspace_not_registered', async () => {
    setWorkspaces([{ team_id: 'T094ST9L5MH', bot_token: 'xoxb-haruka' }]);
    axios.post.mockImplementation(async (url) => {
      if (url.endsWith('auth.test')) return { data: { ok: true, url: 'https://harukafilm.slack.com/' } };
      return { data: { ok: true } };
    });
    const r = await sendSlackChannel('https://other-company.slack.com/archives/C09LD2S2YG3', 'hello');
    expect(r).toEqual({ ok: false, reason: 'workspace_not_registered' });
    expect(axios.post.mock.calls.some(c => c[0].endsWith('chat.postMessage'))).toBe(false);
  });

  test('Slack と無関係な URL は invalid_url（投稿しない）', async () => {
    const r = await sendSlackChannel('https://example.com/foo', 'hello');
    expect(r).toEqual({ ok: false, reason: 'invalid_url' });
    expect(axios.post).not.toHaveBeenCalled();
  });
});

describe('_formatSlackFailureMessage', () => {
  const base = {
    channelUrl: 'https://harukafilm.slack.com/archives/C0B9G8TB3TL',
    creativeId: 'abc-123',
    fileName: '260801_SW_TT_bn_ap032_1920_1080_0000320',
  };

  test('reason ごとの直し方ヒントを含める', () => {
    const msg = _formatSlackFailureMessage({ ...base, primary: { ok: false, reason: 'not_in_channel' } });
    expect(msg).toContain('not_in_channel');
    expect(msg).toContain('/invite');
    expect(msg).toContain('file=260801_SW_TT_bn_ap032_1920_1080_0000320');
  });

  test('代替送信に成功した場合はその旨を書く', () => {
    const msg = _formatSlackFailureMessage({
      ...base,
      primary: { ok: false, reason: 'channel_not_found' },
      fallbackChannelUrl: 'https://app.slack.com/client/T094ST9L5MH/C0AQASBS9DK',
      fallback: { ok: true },
    });
    expect(msg).toContain('代替送信しました');
  });

  test('未知の reason でもクラッシュしない', () => {
    const msg = _formatSlackFailureMessage({ ...base, primary: { ok: false, reason: 'weird_error' } });
    expect(msg).toContain('weird_error');
  });
});
