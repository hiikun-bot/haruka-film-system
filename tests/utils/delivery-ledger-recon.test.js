// tests/utils/delivery-ledger-recon.test.js
// ADR 055 追補: 納品カウントの自動突合（HFS が Slack / Chatwork を自分で読んで DB と照らす）のユニットテスト。

const R = require('../../utils/delivery-ledger-recon');
const L = require('../../utils/delivery-ledger');

const P = 'p1';
const YM = '2026-10';

function dbOf(ids) {
  return {
    ym: YM, monthTotal: ids.length, projectTotal: 30,
    items: ids.map((id, i) => ({ id, file_name: `${id}.mp4`, creative_type: '動画', delivered_at: `2026-10-${String(i + 1).padStart(2, '0')}T01:00:00Z`, seq: i + 1 })),
  };
}
const tag = (o) => L.formatLedgerTag({ projectId: P, ym: YM, monthTotal: o.mt, projectTotal: 30, seq: o.seq ?? null, creativeId: o.c || null, added: o.added ?? null });
const msg = (id, text, at) => ({ id, text, at });

describe('judgePlatform', () => {
  test('最後の投稿の month_total と creative 集合が DB と一致 → match', () => {
    const fetched = { ok: true, messages: [
      msg('1', `本文\n\`${tag({ mt: 1, seq: 1, c: 'c1' })}\``, 1000),
      msg('2', `本文\n\`${tag({ mt: 2, seq: 2, c: 'c2' })}\``, 2000),
    ] };
    const r = R.judgePlatform({ fetched, db: dbOf(['c1', 'c2']), posts: [{ message_id: '1' }, { message_id: '2' }], projectId: P, ym: YM });
    expect(r.verdict).toBe('match');
    expect(r.tag_count).toBe(2);
    expect(r.last_month_total).toBe(2);
    expect(r.missing_posts).toEqual([]);
  });
  test('DB の方が多い（投稿失敗・通知先未設定の期間がある）→ mismatch と理由', () => {
    const fetched = { ok: true, messages: [msg('1', tag({ mt: 1, seq: 1, c: 'c1' }), 1000)] };
    const r = R.judgePlatform({ fetched, db: dbOf(['c1', 'c2']), posts: [], projectId: P, ym: YM });
    expect(r.verdict).toBe('mismatch');
    expect(r.unmentioned_in_db).toEqual(['c2']);
    expect(r.reason).toContain('最後の投稿は当月 1件、DB は 2件');
  });
  test('投稿にあるが DB に無い creative（納品を戻した・月をずらした）→ mismatch', () => {
    const fetched = { ok: true, messages: [msg('1', tag({ mt: 1, seq: 1, c: 'cX' }), 1000)] };
    const r = R.judgePlatform({ fetched, db: dbOf(['c1']), posts: [], projectId: P, ym: YM });
    expect(r.verdict).toBe('mismatch');
    expect(r.only_in_log).toEqual(['cX']);
  });
  test('一括納品（added=）のタグは creative を持たないので unmentioned を問わない', () => {
    const fetched = { ok: true, messages: [msg('1', tag({ mt: 3, added: 3 }), 1000)] };
    const r = R.judgePlatform({ fetched, db: dbOf(['c1', 'c2', 'c3']), posts: [], projectId: P, ym: YM });
    expect(r.verdict).toBe('match');
    expect(r.unmentioned_in_db).toEqual([]);
  });
  test('他案件・他月のタグは無視する', () => {
    const other = L.formatLedgerTag({ projectId: 'p2', ym: YM, monthTotal: 9, projectTotal: 9, seq: 9 });
    const otherMonth = L.formatLedgerTag({ projectId: P, ym: '2026-09', monthTotal: 7, projectTotal: 7, seq: 7 });
    const fetched = { ok: true, messages: [msg('1', other, 1), msg('2', otherMonth, 2), msg('3', tag({ mt: 1, seq: 1, c: 'c1' }), 3)] };
    const r = R.judgePlatform({ fetched, db: dbOf(['c1']), posts: [], projectId: P, ym: YM });
    expect(r.verdict).toBe('match');
    expect(r.tag_count).toBe(1);
  });
  test('投稿記録の message_id がチャンネルに無い（削除された）→ mismatch', () => {
    const fetched = { ok: true, messages: [msg('2', tag({ mt: 1, seq: 1, c: 'c1' }), 2)] };
    const r = R.judgePlatform({ fetched, db: dbOf(['c1']), posts: [{ message_id: '1' }, { message_id: '2' }], projectId: P, ym: YM });
    expect(r.verdict).toBe('mismatch');
    expect(r.missing_posts).toEqual(['1']);
  });
  test('タグが無く DB にも納品が無い → match、DB にだけある → no_posts', () => {
    expect(R.judgePlatform({ fetched: { ok: true, messages: [] }, db: dbOf([]), posts: [], projectId: P, ym: YM }).verdict).toBe('match');
    expect(R.judgePlatform({ fetched: { ok: true, messages: [] }, db: dbOf(['c1']), posts: [], projectId: P, ym: YM }).verdict).toBe('no_posts');
  });
  test('取得失敗（missing_scope など）→ fetch_error と理由', () => {
    const r = R.judgePlatform({ fetched: { ok: false, messages: [], reason: 'missing_scope' }, db: dbOf(['c1']), posts: [], projectId: P, ym: YM });
    expect(r.verdict).toBe('fetch_error');
    expect(r.reason).toBe('missing_scope');
  });
});

describe('overallVerdict', () => {
  test('どちらかが不一致なら不一致、両方取得不可なら取得不可、通知先なしは no_channel', () => {
    expect(R.overallVerdict({ slack: { verdict: 'match' }, chatwork: { verdict: 'mismatch' } })).toBe('mismatch');
    expect(R.overallVerdict({ slack: { verdict: 'fetch_error' }, chatwork: { verdict: 'fetch_error' } })).toBe('fetch_error');
    expect(R.overallVerdict({ slack: { verdict: 'fetch_error' }, chatwork: { verdict: 'match' } })).toBe('match');
    expect(R.overallVerdict({ slack: null, chatwork: { verdict: 'no_posts' } })).toBe('no_posts');
    expect(R.overallVerdict({ slack: null, chatwork: null })).toBe('no_channel');
  });
  test('片方が取得不可でもう片方が投稿なし → 取得不可（読めていないのに「投稿なし」と言わない）', () => {
    expect(R.overallVerdict({ slack: { verdict: 'fetch_error' }, chatwork: { verdict: 'no_posts' } })).toBe('fetch_error');
  });
  test('hasFetchError / summarize.incomplete: 総合が match でも読めなかった側があれば未完了に数える', () => {
    const results = [
      { verdict: 'match', slack: { verdict: 'fetch_error' }, chatwork: { verdict: 'match' } },
      { verdict: 'match', slack: { verdict: 'match' }, chatwork: null },
      { verdict: 'fetch_error', slack: null, chatwork: null, error: 'boom' },
    ];
    expect(results.map(R.hasFetchError)).toEqual([true, false, true]);
    expect(R.summarize(results)).toMatchObject({ total: 3, match: 2, fetch_error: 1, incomplete: 2 });
  });
});

describe('judgePlatform（複数投稿先の一部が読めない）', () => {
  test('failures があれば欠落ではなく fetch_error（理由に投稿先を含む）', () => {
    const fetched = { ok: true, messages: [msg('1', tag({ mt: 1, seq: 1, c: 'c1' }), 1)], failures: [{ ref: '888', reason: 'HTTP 503' }] };
    const r = R.judgePlatform({ fetched, db: dbOf(['c1', 'c2']), posts: [{ message_id: '1' }, { message_id: '2', channel_ref: '888' }], projectId: P, ym: YM });
    expect(r.verdict).toBe('fetch_error');
    expect(r.reason).toBe('888: HTTP 503');
    expect(r.missing_posts).toEqual([]);
  });
});

describe('collectRefs / ref の解釈', () => {
  test('今の設定 ∪ 投稿記録の投稿先（重複除去・順序は今の設定が先・解釈不能は unresolved）', () => {
    const r = R.collectRefs({ current: '777', posts: [{ channel_ref: '888' }, { channel_ref: '777' }, { channel_ref: '-' }, { channel_ref: 'abc' }], toId: R.chatworkRoomIdOf });
    expect(r.refs).toEqual(['777', '888']);
    expect(r.unresolved).toEqual(['abc']);
    const notifications = { parseSlackChannelUrl: (u) => (/archives\/(C\w+)/.exec(u) ? { channel_id: /archives\/(C\w+)/.exec(u)[1] } : null) };
    expect(R.slackChannelIdOf('C0AB12', notifications)).toBe('C0AB12');
    expect(R.slackChannelIdOf('https://x.slack.com/archives/C0ZZ9', notifications)).toBe('C0ZZ9');
    expect(R.slackChannelIdOf('-', notifications)).toBeNull();
  });
});

describe('fetchWindowSec', () => {
  test('月初（JST）〜 翌月 10 日（JST）か now の早い方', () => {
    const w = R.fetchWindowSec('2026-10', new Date('2026-12-01T00:00:00Z'));
    expect(w.oldestSec).toBe(Math.floor(new Date('2026-09-30T15:00:00Z').getTime() / 1000));
    expect(w.latestSec).toBe(Math.floor(new Date('2026-11-10T15:00:00Z').getTime() / 1000));
    const w2 = R.fetchWindowSec('2026-10', new Date('2026-10-15T00:00:00Z'));
    expect(w2.latestSec).toBe(Math.floor(new Date('2026-10-15T00:00:00Z').getTime() / 1000));
    expect(R.fetchWindowSec('bad')).toBeNull();
  });
});

describe('fetchSlackHistory / fetchChatworkRecent / fetchChatworkMessage', () => {
  test('Slack はカーソルで全ページ読む', async () => {
    const http = { get: jest.fn()
      .mockResolvedValueOnce({ data: { ok: true, messages: [{ ts: '2.0', text: 'b' }], has_more: true, response_metadata: { next_cursor: 'C1' } } })
      .mockResolvedValueOnce({ data: { ok: true, messages: [{ ts: '1.0', text: 'a' }], has_more: false } }) };
    const r = await R.fetchSlackHistory({ token: 't', channelId: 'C123', oldestSec: 1, latestSec: 9, http });
    expect(r.ok).toBe(true);
    expect(r.messages.map(m => m.id)).toEqual(['2.0', '1.0']);
    expect(http.get.mock.calls[1][1].params.cursor).toBe('C1');
    expect(http.get.mock.calls[0][1].params).toMatchObject({ channel: 'C123', oldest: '1', latest: '9' });
  });
  test('Slack のエラー（missing_scope）は理由付きで失敗', async () => {
    const http = { get: jest.fn().mockResolvedValue({ data: { ok: false, error: 'missing_scope' } }) };
    const r = await R.fetchSlackHistory({ token: 't', channelId: 'C1', http });
    expect(r).toMatchObject({ ok: false, reason: 'missing_scope' });
  });
  test('Chatwork の最新 100 件（204 は空）と 1 件取得（404 は not_found）', async () => {
    const http = { get: jest.fn()
      .mockResolvedValueOnce({ status: 200, data: [{ message_id: 5, body: 'x', send_time: 1700000000 }] })
      .mockResolvedValueOnce({ status: 204, data: '' })
      .mockResolvedValueOnce({ status: 200, data: { message_id: 3, body: 'old', send_time: 1600000000 } })
      .mockResolvedValueOnce({ status: 404, data: { errors: ['not found'] } }) };
    const a = await R.fetchChatworkRecent({ token: 't', roomId: '1', http });
    expect(a.ok).toBe(true);
    expect(a.messages[0]).toEqual({ id: '5', text: 'x', at: 1700000000000 });
    expect(http.get.mock.calls[0][1].params).toEqual({ force: 1 });
    const b = await R.fetchChatworkRecent({ token: 't', roomId: '1', http });
    expect(b).toEqual({ ok: true, messages: [], reason: null });
    const c = await R.fetchChatworkMessage({ token: 't', roomId: '1', messageId: '3', http });
    expect(c.message).toEqual({ id: '3', text: 'old', at: 1600000000000 });
    const d = await R.fetchChatworkMessage({ token: 't', roomId: '1', messageId: '9', http });
    expect(d).toEqual({ ok: true, message: null, reason: 'not_found' });
  });
});

describe('reconProjectMonth（Chatwork の古い投稿を message_id で読み直す）', () => {
  function supabaseMock({ creatives, posts }) {
    return { from: jest.fn((table) => {
      const q = { _head: false, _filters: [] };
      const chain = (n) => (...a) => { q._filters.push([n, ...a]); return q; };
      ['eq', 'gte', 'lt', 'not', 'order', 'in'].forEach(n => { q[n] = chain(n); });
      q.select = (_c, opts) => { q._head = !!(opts && opts.head); return q; };
      q.then = (res, rej) => {
        if (table === 'creatives') return Promise.resolve(q._head ? { count: creatives.length, error: null } : { data: creatives, error: null }).then(res, rej);
        if (table === 'delivery_ledger_posts') return Promise.resolve({ data: posts, error: null }).then(res, rej);
        return Promise.resolve({ data: [], error: null }).then(res, rej);
      };
      return q;
    }) };
  }
  test('最新 100 件に無い投稿記録は 1 件ずつ取り直して判定に使う', async () => {
    const creatives = [
      { id: 'c1', file_name: 'A', creative_type: '動画', delivered_at: '2026-10-02T01:00:00Z' },
      { id: 'c2', file_name: 'B', creative_type: '動画', delivered_at: '2026-10-20T01:00:00Z' },
    ];
    const posts = [
      { id: 'x1', platform: 'chatwork', channel_ref: '777', message_id: '100', kind: 'single', creative_ids: ['c1'], seq: 1, month_total: 1, project_total: 29, posted_at: '2026-10-02T01:00:05Z' },
      { id: 'x2', platform: 'chatwork', channel_ref: '777', message_id: '200', kind: 'single', creative_ids: ['c2'], seq: 2, month_total: 2, project_total: 30, posted_at: '2026-10-20T01:00:05Z' },
    ];
    const t1 = tag({ mt: 1, seq: 1, c: 'c1' });
    const t2 = tag({ mt: 2, seq: 2, c: 'c2' });
    const http = { get: jest.fn(async (url) => {
      if (url.endsWith('/rooms/777/messages')) return { status: 200, data: [{ message_id: 200, body: `[info]${t2}[/info]`, send_time: 1792500000 }] }; // 2026-10-20
      if (url.endsWith('/rooms/777/messages/100')) return { status: 200, data: { message_id: 100, body: `[info]${t1}[/info]`, send_time: 1790900000 } }; // 2026-10-02
      throw new Error(`unexpected ${url}`);
    }) };
    const r = await R.reconProjectMonth(
      { supabase: supabaseMock({ creatives, posts }), notifications: {}, chatworkToken: 'tok', http },
      { project: { id: P, name: 'LP', slack_channel_url: null, chatwork_room_id: '777', clients: { name: 'TG' } }, ym: YM, now: new Date('2026-11-01T01:00:00Z') },
    );
    expect(r.slack).toBeNull();
    expect(r.chatwork.verdict).toBe('match');
    expect(r.chatwork.tag_count).toBe(2);
    expect(r.chatwork.missing_posts).toEqual([]);
    expect(r.verdict).toBe('match');
    expect(http.get).toHaveBeenCalledTimes(2);
  });
  test('代替投稿（クライアント共通ルーム 888）に残った投稿も投稿記録の channel_ref から読む → match', async () => {
    const creatives = [
      { id: 'c1', file_name: 'A', creative_type: '動画', delivered_at: '2026-10-02T01:00:00Z' },
      { id: 'c2', file_name: 'B', creative_type: '動画', delivered_at: '2026-10-20T01:00:00Z' },
    ];
    const posts = [
      { id: 'x1', platform: 'chatwork', channel_ref: '888', message_id: '100', kind: 'single', creative_ids: ['c1'], seq: 1, month_total: 1, project_total: 29, posted_at: '2026-10-02T01:00:05Z' },
      { id: 'x2', platform: 'chatwork', channel_ref: '777', message_id: '200', kind: 'single', creative_ids: ['c2'], seq: 2, month_total: 2, project_total: 30, posted_at: '2026-10-20T01:00:05Z' },
    ];
    const t1 = tag({ mt: 1, seq: 1, c: 'c1' });
    const t2 = tag({ mt: 2, seq: 2, c: 'c2' });
    const http = { get: jest.fn(async (url) => {
      if (url.endsWith('/rooms/777/messages')) return { status: 200, data: [{ message_id: 200, body: `[info]${t2}[/info]`, send_time: 1792500000 }] };
      if (url.endsWith('/rooms/888/messages')) return { status: 200, data: [{ message_id: 100, body: `[info]${t1}[/info]`, send_time: 1790900000 }] };
      throw new Error(`unexpected ${url}`);
    }) };
    const r = await R.reconProjectMonth(
      { supabase: supabaseMock({ creatives, posts }), notifications: {}, chatworkToken: 'tok', http },
      { project: { id: P, name: 'LP', slack_channel_url: null, chatwork_room_id: '777', clients: { name: 'TG' } }, ym: YM, now: new Date('2026-11-01T01:00:00Z') },
    );
    expect(r.chatwork.rooms).toEqual(['777', '888']);
    expect(r.chatwork.verdict).toBe('match');
    expect(r.chatwork.missing_posts).toEqual([]);
    expect(r.verdict).toBe('match');
  });
  test('ルーム変更後に今の設定が無くても、投稿記録の投稿先だけで突合できる', async () => {
    const creatives = [{ id: 'c1', file_name: 'A', creative_type: '動画', delivered_at: '2026-10-02T01:00:00Z' }];
    const posts = [{ id: 'x1', platform: 'chatwork', channel_ref: '555', message_id: '100', kind: 'single', creative_ids: ['c1'], seq: 1, month_total: 1, project_total: 1, posted_at: '2026-10-02T01:00:05Z' }];
    const http = { get: jest.fn(async (url) => {
      if (url.endsWith('/rooms/555/messages')) return { status: 200, data: [{ message_id: 100, body: tag({ mt: 1, seq: 1, c: 'c1' }), send_time: 1790900000 }] };
      throw new Error(`unexpected ${url}`);
    }) };
    const r = await R.reconProjectMonth(
      { supabase: supabaseMock({ creatives, posts }), notifications: {}, chatworkToken: 'tok', http },
      { project: { id: P, name: 'LP', slack_channel_url: null, chatwork_room_id: null, clients: null }, ym: YM, now: new Date('2026-11-01T01:00:00Z') },
    );
    expect(r.chatwork.verdict).toBe('match');
    expect(r.verdict).toBe('match');
  });
  test('古い投稿の 1 件取得が通信エラー（404 以外）→ 欠落ではなく fetch_error', async () => {
    const creatives = [
      { id: 'c1', file_name: 'A', creative_type: '動画', delivered_at: '2026-10-02T01:00:00Z' },
      { id: 'c2', file_name: 'B', creative_type: '動画', delivered_at: '2026-10-20T01:00:00Z' },
    ];
    const posts = [
      { id: 'x1', platform: 'chatwork', channel_ref: '777', message_id: '100', kind: 'single', creative_ids: ['c1'], seq: 1, month_total: 1, project_total: 29, posted_at: '2026-10-02T01:00:05Z' },
      { id: 'x2', platform: 'chatwork', channel_ref: '777', message_id: '200', kind: 'single', creative_ids: ['c2'], seq: 2, month_total: 2, project_total: 30, posted_at: '2026-10-20T01:00:05Z' },
    ];
    const t2 = tag({ mt: 2, seq: 2, c: 'c2' });
    const http = { get: jest.fn(async (url) => {
      if (url.endsWith('/rooms/777/messages')) return { status: 200, data: [{ message_id: 200, body: t2, send_time: 1792500000 }] };
      if (url.endsWith('/rooms/777/messages/100')) return { status: 503, data: '' };
      throw new Error(`unexpected ${url}`);
    }) };
    const r = await R.reconProjectMonth(
      { supabase: supabaseMock({ creatives, posts }), notifications: {}, chatworkToken: 'tok', http },
      { project: { id: P, name: 'LP', slack_channel_url: null, chatwork_room_id: '777', clients: null }, ym: YM, now: new Date('2026-11-01T01:00:00Z') },
    );
    expect(r.chatwork.verdict).toBe('fetch_error');
    expect(r.chatwork.reason).toBe('777/100: HTTP 503');
    expect(r.verdict).toBe('fetch_error');
    expect(R.hasFetchError(r)).toBe(true);
  });
  test('Slack: 今のチャンネル ∪ 投稿記録のチャンネル（変更前）を両方読む', async () => {
    const creatives = [
      { id: 'c1', file_name: 'A', creative_type: '動画', delivered_at: '2026-10-02T01:00:00Z' },
      { id: 'c2', file_name: 'B', creative_type: '動画', delivered_at: '2026-10-20T01:00:00Z' },
    ];
    const posts = [
      { id: 'x1', platform: 'slack', channel_ref: 'COLD1', message_id: '1790900000.000100', kind: 'single', creative_ids: ['c1'], seq: 1, month_total: 1, project_total: 29, posted_at: '2026-10-02T01:00:05Z' },
      { id: 'x2', platform: 'slack', channel_ref: 'CNEW2', message_id: '1792500000.000200', kind: 'single', creative_ids: ['c2'], seq: 2, month_total: 2, project_total: 30, posted_at: '2026-10-20T01:00:05Z' },
    ];
    const t1 = tag({ mt: 1, seq: 1, c: 'c1' });
    const t2 = tag({ mt: 2, seq: 2, c: 'c2' });
    const http = { get: jest.fn(async (_url, { params }) => {
      if (params.channel === 'CNEW2') return { data: { ok: true, messages: [{ ts: '1792500000.000200', text: `\`${t2}\`` }], has_more: false } };
      if (params.channel === 'COLD1') return { data: { ok: true, messages: [{ ts: '1790900000.000100', text: `\`${t1}\`` }], has_more: false } };
      return { data: { ok: false, error: 'channel_not_found' } };
    }) };
    const notifications = {
      parseSlackChannelUrl: (u) => { const m = /archives\/(C\w+)/.exec(String(u)); return m ? { team_id: null, channel_id: m[1], domain: 'x' } : null; },
      resolveSlackWorkspace: async () => ({ token: 'xoxb', reason: null }),
    };
    const r = await R.reconProjectMonth(
      { supabase: supabaseMock({ creatives, posts }), notifications, chatworkToken: null, http },
      { project: { id: P, name: 'LP', slack_channel_url: 'https://x.slack.com/archives/CNEW2', chatwork_room_id: null, clients: null }, ym: YM, now: new Date('2026-11-01T01:00:00Z') },
    );
    expect(r.slack.channels).toEqual(['CNEW2', 'COLD1']);
    expect(r.slack.verdict).toBe('match');
    expect(r.slack.tag_count).toBe(2);
    expect(r.verdict).toBe('match');
  });
});

describe('buildReconDigestText', () => {
  test('見出しに集計、不一致を先に、理由とヒントを付ける', () => {
    const results = [
      { project_id: 'a', client_name: 'A社', project_name: 'OK案件', month: YM, db: { month_total: 3 }, slack: { verdict: 'match', last_month_total: 3 }, chatwork: null, verdict: 'match' },
      { project_id: 'b', client_name: 'B社', project_name: 'NG案件', month: YM, db: { month_total: 5 }, slack: null, chatwork: { verdict: 'mismatch', last_month_total: 4, reason: '最後の投稿は当月 4件、DB は 5件' }, verdict: 'mismatch' },
      { project_id: 'c', client_name: null, project_name: 'スコープ無し', month: YM, db: { month_total: 1 }, slack: { verdict: 'fetch_error', last_month_total: null, reason: 'missing_scope' }, chatwork: null, verdict: 'fetch_error' },
    ];
    const text = R.buildReconDigestText({ month: YM, results, summary: R.summarize(results), pageUrl: 'https://x/api/haruka/admin/delivery-ledger/recon?month=2026-10' });
    const lines = text.split('\n');
    expect(lines[0]).toBe('[info][title]📊 納品カウントの自動突合（2026年10月）: 3案件 ／ ✅1 ❌1 ⚠️0 🚫1 ➖0[/title]');
    const idxNg = lines.findIndex(l => l.startsWith('❌ 不一致 B社 / NG案件：DB 5件 ／ Chatwork 4'));
    const idxOk = lines.findIndex(l => l.startsWith('✅ 一致 A社 / OK案件：DB 3件 ／ Slack 3'));
    expect(idxNg).toBeGreaterThan(0);
    expect(idxNg).toBeLessThan(idxOk);
    expect(lines[idxNg + 1]).toBe('　└ Chatwork: 最後の投稿は当月 4件、DB は 5件');
    expect(text).toContain('🚫 取得不可 スコープ無し：DB 1件 ／ Slack 取得不可');
    expect(text).toContain('channels:history');
    expect(text).toContain('不一致は DB（HFS）が正です');
    expect(text).toContain('読めなかった投稿先がある案件が 1件あります');
    expect(text).toContain('詳細（JSON）: https://x/api/haruka/admin/delivery-ledger/recon?month=2026-10');
    expect(text.trim().endsWith('[/info]')).toBe(true);
  });
});
