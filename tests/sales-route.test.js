// 🤝 営業・名刺管理 API（routes/sales.js・routes/promo-public.js・ADR 056）の結合テスト。
// DB はメモリ上の偽物、Gmail・AI は jest.fn。「誰が見られるか・誰が送れるか」を確かめる。

const mockDb = {};
let mockSeq = 0;
const mockTick = () => new Date(Date.UTC(2026, 10, 14, 0, 0, 0, ++mockSeq)).toISOString();

// supabase-js の問い合わせのうち、このルートが使う分だけをまねる
function mockQuery(table) {
  const rows = () => (mockDb[table] = mockDb[table] || []);
  const st = { filters: [], op: 'select', payload: null, returning: false, single: null, limit: null };
  const match = (r) => st.filters.every((f) => f(r));
  const q = {
    select() { if (st.op !== 'select') st.returning = true; return q; },
    insert(p) { st.op = 'insert'; st.payload = p; return q; },
    update(p) { st.op = 'update'; st.payload = p; return q; },
    upsert(p, o) { st.op = 'upsert'; st.payload = p; st.conflict = String(o?.onConflict || 'id').split(','); return q; },
    delete() { st.op = 'delete'; return q; },
    eq(c, v) { st.filters.push((r) => String(r[c]) === String(v)); return q; },
    in(c, vs) { const s = vs.map(String); st.filters.push((r) => s.includes(String(r[c]))); return q; },
    is(c, v) { st.filters.push((r) => (r[c] ?? null) === v); return q; },
    not(c, _op, v) { st.filters.push((r) => (r[c] ?? null) !== v); return q; },
    gte(c, v) { st.filters.push((r) => String(r[c] ?? '') >= String(v)); return q; },
    gt(c, v) { st.filters.push((r) => Number(r[c]) > Number(v)); return q; },
    ilike(c, v) { st.filters.push((r) => String(r[c] ?? '').toLowerCase() === String(v).replace(/\\/g, '').toLowerCase()); return q; },
    order() { return q; },
    limit(n) { st.limit = n; return q; },
    maybeSingle() { st.single = 'maybe'; return q; },
    single() { st.single = 'one'; return q; },
    then(resolve, reject) { return Promise.resolve().then(run).then(resolve, reject); },
  };
  function run() {
    let out;
    if (st.op === 'select') {
      out = rows().filter(match);
    } else if (st.op === 'insert') {
      const row = { id: `${table}-${++mockSeq}`, created_at: mockTick(), updated_at: mockTick(), ...st.payload };
      if (table === 'sales_contacts') Object.assign(row, { archived_at: null, has_card_image: false, do_not_email: false, client_id: null, ...st.payload });
      if (table === 'sales_mails') Object.assign(row, { status: 'draft', sent_by: null, sent_at: null, promo_page_id: null, ...st.payload });
      if (table === 'sales_promo_pages') Object.assign(row, { view_count: 0, first_viewed_at: null, revoked_at: null, ...st.payload });
      if (table === 'sales_promo_videos') Object.assign(row, { is_active: true, ...st.payload });
      rows().push(row);
      out = [row];
    } else if (st.op === 'upsert') {
      const hit = rows().find((r) => st.conflict.every((c) => String(r[c]) === String(st.payload[c])));
      if (hit) Object.assign(hit, st.payload); else rows().push({ ...st.payload });
      out = [hit || st.payload];
    } else if (st.op === 'update') {
      out = rows().filter(match);
      out.forEach((r) => Object.assign(r, st.payload));
    } else if (st.op === 'delete') {
      out = rows().filter(match);
      mockDb[table] = rows().filter((r) => !out.includes(r));
    }
    if (st.limit) out = out.slice(0, st.limit);
    out = out.map((r) => ({ ...r }));
    if (st.single) return { data: out[0] || null, error: st.single === 'one' && !out[0] ? { message: 'no rows' } : null };
    return { data: out, error: null };
  }
  return q;
}

jest.mock('../supabase', () => ({ from: (t) => mockQuery(t) }));
jest.mock('../auth', () => ({
  requireAuth: (req, res, next) => {
    const uid = req.headers['x-test-user'];
    if (!uid) return res.status(401).json({ error: 'login' });
    req.user = { id: uid };
    next();
  },
  getEffectiveRoleCodes: async (req) => (req.headers['x-test-admin'] ? ['admin'] : ['editor']),
}));
const mockConnected = new Set(['u1']);
const mockSendRaw = jest.fn(async () => ({ id: 'gmail-1' }));
jest.mock('../lib/gmail-send', () => ({
  SCOPE_KEY: 'gmail.send',
  isConnected: async (uid) => mockConnected.has(String(uid)),
  getSenderEmail: async (uid) => {
    if (!mockConnected.has(String(uid))) throw Object.assign(new Error('Gmail 未連携'), { status: 400, code: 'gmail_not_connected' });
    return `${uid}@gmail.example`;
  },
  sendRaw: (...a) => mockSendRaw(...a),
  disconnect: jest.fn(),
}));
jest.mock('../lib/google-oauth', () => ({ isConfigured: () => true }));
jest.mock('../lib/sales-ai', () => ({
  getStatus: async () => ({ enabled: false, available: false, budget_jpy: 500, used_jpy: 0 }),
  scanCard: jest.fn(),
  draftMail: jest.fn(),
}));

const express = require('express');
let server; let base;

beforeAll(async () => {
  process.env.APP_URL = 'https://hfs.example';
  mockDb.users = [
    { id: 'u1', nickname: 'さとる', full_name: '髙橋 聖', email: 'u1@example.com', is_active: true, is_external: false },
    { id: 'u2', nickname: 'たごん', full_name: '川崎 かおり', email: 'u2@example.com', is_active: true, is_external: false },
    { id: 'u3', nickname: 'かんり', full_name: '管理 者', email: 'u3@example.com', is_active: true, is_external: false },
  ];
  const app = express();
  app.use('/pv', require('../routes/promo-public'));
  app.use(express.json());
  app.use('/s', require('../routes/sales'));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => server && server.close());

const call = (path, { user = 'u1', admin = false, viewAs = false, method = 'GET', body, ua } = {}) => fetch(base + path, {
  method,
  headers: {
    ...(user ? { 'x-test-user': user } : {}),
    ...(admin ? { 'x-test-admin': '1' } : {}),
    ...(viewAs ? { 'x-view-as': 'editor' } : {}),
    ...(ua ? { 'user-agent': ua } : {}),
    ...(body ? { 'content-type': 'application/json' } : {}),
  },
  body: body ? JSON.stringify(body) : undefined,
}).then(async (r) => ({ status: r.status, body: r.headers.get('content-type')?.includes('json') ? await r.json() : await r.text() }));

describe('営業・名刺管理 API', () => {
  let contactId; let mailId; let pageUrl; let pageId;

  test('ログインしていなければ 401', async () => {
    expect((await call('/s/contacts', { user: null })).status).toBe(401);
  });

  test('名刺を登録すると自分が担当になり、全員の一覧に出る', async () => {
    const r = await call('/s/contacts', { method: 'POST', body: { name: '山田 太郎', company: '㈱サンプル', email: 'yamada@example.co.jp', met_on: '2026-11-14', met_place: '神戸', private_note: '採用動画に興味あり' } });
    expect(r.status).toBe(201);
    contactId = r.body.contact.id;
    expect(r.body.contact.owner_user_id).toBe('u1');
    expect(r.body.contact.stage).toBe('met');

    const list = await call('/s/contacts', { user: 'u2' });
    expect(list.body.contacts).toHaveLength(1);
    expect(list.body.contacts[0]).toMatchObject({ name: '山田 太郎', owner_name: 'さとる（髙橋 聖）', can_edit: false, mail_sent_count: 0 });
  });

  test('個人用メモは書いた本人だけ（他のメンバーにも管理者にも見えない）', async () => {
    expect((await call(`/s/contacts/${contactId}`)).body.private_note).toBe('採用動画に興味あり');
    expect((await call(`/s/contacts/${contactId}`, { user: 'u2' })).body.private_note).toBe('');
    expect((await call(`/s/contacts/${contactId}`, { user: 'u3', admin: true })).body.private_note).toBe('');
    // 別の人が書いても、互いに上書きしない
    await call(`/s/contacts/${contactId}/private-note`, { user: 'u2', method: 'PUT', body: { body: 'u2 のメモ' } });
    expect((await call(`/s/contacts/${contactId}`)).body.private_note).toBe('採用動画に興味あり');
    expect((await call(`/s/contacts/${contactId}`, { user: 'u2' })).body.private_note).toBe('u2 のメモ');
  });

  test('直せるのは担当と管理者だけ', async () => {
    expect((await call(`/s/contacts/${contactId}`, { user: 'u2', method: 'PATCH', body: { next_action: '電話' } })).status).toBe(403);
    expect((await call(`/s/contacts/${contactId}/stage`, { user: 'u2', method: 'POST', body: { stage: 'won' } })).status).toBe(403);
    expect((await call(`/s/contacts/${contactId}`, { user: 'u3', admin: true, method: 'PATCH', body: { next_action: '電話' } })).status).toBe(200);
    expect((await call(`/s/contacts/${contactId}/stage`, { method: 'POST', body: { stage: 'unknown' } })).status).toBe(400);
  });

  test('プロモ動画を登録し、紹介ページの URL を発行する', async () => {
    const v1 = await call('/s/videos', { method: 'POST', body: { title: '会社紹介', url: 'https://youtu.be/dQw4w9WgXcQ' } });
    const v2 = await call('/s/videos', { method: 'POST', body: { title: '採用PV', url: 'https://vimeo.com/123456789' } });
    expect(v1.body.video).toMatchObject({ provider: 'youtube', embed_id: 'dQw4w9WgXcQ' });
    expect((await call('/s/videos', { method: 'POST', body: { title: 'x', url: 'javascript:alert(1)' } })).status).toBe(400);

    const p = await call('/s/promo-pages', { method: 'POST', body: { contact_id: contactId, video_ids: [v1.body.video.id, v2.body.video.id] } });
    expect(p.status).toBe(201);
    pageUrl = p.body.page.url; pageId = p.body.page.id;
    expect(pageUrl).toMatch(/^https:\/\/hfs\.example\/pv\/[A-Za-z0-9_-]{16,}$/);
    expect((await call('/s/promo-pages', { method: 'POST', body: { contact_id: contactId, video_ids: [] } })).status).toBe(400);
  });

  test('他人の名前でメールは作れない（管理者でも不可）', async () => {
    const body = { contact_id: contactId, sender_user_id: 'u1', to_email: 'yamada@example.co.jp', subject: '件名', body: '本文' };
    expect((await call('/s/mails', { user: 'u2', method: 'POST', body })).body.code).toBe('not_allowed');
    expect((await call('/s/mails', { user: 'u3', admin: true, method: 'POST', body })).status).toBe(403);
    expect((await call('/s/mails', { method: 'POST', body: { ...body, to_email: 'a@b.jp, c@d.jp' } })).body.code).toBe('invalid_to');
  });

  test('本人が下書きを作る。他の人は見られるが直せない・送れない', async () => {
    const r = await call('/s/mails', { method: 'POST', body: { contact_id: contactId, to_email: 'yamada@example.co.jp', subject: '先日はありがとうございました', body: '山田様\nお世話になります。', promo_page_id: pageId } });
    expect(r.status).toBe(201);
    mailId = r.body.mail.id;
    expect(r.body.mail).toMatchObject({ sender_user_id: 'u1', status: 'draft', can_send: true });

    const seen = (await call(`/s/contacts/${contactId}`, { user: 'u2' })).body.mails[0];
    expect(seen).toMatchObject({ id: mailId, can_edit: false, can_send: false });
    expect((await call(`/s/mails/${mailId}`, { user: 'u2', method: 'PATCH', body: { body: '書き換え' } })).status).toBe(403);
    expect((await call(`/s/mails/${mailId}`, { user: 'u2', method: 'DELETE' })).status).toBe(403);
    expect((await call(`/s/mails/${mailId}/send`, { user: 'u2', method: 'POST', body: { confirm_to_email: 'yamada@example.co.jp' } })).body.code).toBe('not_allowed');
    expect((await call(`/s/mails/${mailId}/send`, { user: 'u3', admin: true, method: 'POST', body: { confirm_to_email: 'yamada@example.co.jp' } })).body.code).toBe('not_allowed');
    expect(mockSendRaw).not.toHaveBeenCalled();
  });

  test('プレビューは実際に送る文面（紹介ページ URL と署名つき）', async () => {
    const r = await call(`/s/mails/${mailId}/preview`);
    expect(r.body).toMatchObject({ from_name: '髙橋 聖', from_email: 'u1@gmail.example', to_email: 'yamada@example.co.jp' });
    expect(r.body.final_body).toContain(pageUrl);
    expect(r.body.final_body).toContain('HARUKA FILM　髙橋 聖');
  });

  test('確認した宛先が違う・VIEW AS 中は送らない', async () => {
    expect((await call(`/s/mails/${mailId}/send`, { method: 'POST', body: { confirm_to_email: 'other@example.co.jp' } })).body.code).toBe('recipient_mismatch');
    expect((await call(`/s/mails/${mailId}/send`, { method: 'POST', body: {} })).body.code).toBe('recipient_mismatch');
    expect((await call(`/s/mails/${mailId}/send`, { viewAs: true, method: 'POST', body: { confirm_to_email: 'yamada@example.co.jp' } })).body.code).toBe('view_as');
    expect(mockSendRaw).not.toHaveBeenCalled();
  });

  test('本人が送る → 1 通だけ送られ、進み具合が「アプローチ中」に進む', async () => {
    const [a, b] = await Promise.all([
      call(`/s/mails/${mailId}/send`, { method: 'POST', body: { confirm_to_email: 'yamada@example.co.jp' } }),
      call(`/s/mails/${mailId}/send`, { method: 'POST', body: { confirm_to_email: 'yamada@example.co.jp' } }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(mockSendRaw).toHaveBeenCalledTimes(1);
    expect(mockSendRaw.mock.calls[0][0].userId).toBe('u1');
    const text = Buffer.from(mockSendRaw.mock.calls[0][0].raw, 'base64url').toString('utf8');
    expect(text).toContain('To: yamada@example.co.jp');
    expect(text).toContain('<u1@gmail.example>');

    const detail = (await call(`/s/contacts/${contactId}`)).body;
    expect(detail.contact.stage).toBe('approach');
    expect(detail.mails[0]).toMatchObject({ status: 'sent', sent_by: 'u1', gmail_message_id: 'gmail-1', can_send: false });
    expect(detail.mails[0].body).toContain(pageUrl);
    // もう一度押しても送られない・直せない
    expect((await call(`/s/mails/${mailId}/send`, { method: 'POST', body: { confirm_to_email: 'yamada@example.co.jp' } })).status).toBe(409);
    expect((await call(`/s/mails/${mailId}`, { method: 'PATCH', body: { body: 'x' } })).status).toBe(409);
    expect(mockSendRaw).toHaveBeenCalledTimes(1);
    expect((await call('/s/contacts', { user: 'u2' })).body.contacts[0].mail_sent_count).toBe(1);
  });

  test('代理: 本人が認めた人だけが、本人の Gmail から送れる。取り消すと送れない', async () => {
    // 代理を決められるのは本人だけ（VIEW AS 中は不可）
    expect((await call('/s/delegates', { viewAs: true, method: 'POST', body: { delegate_user_id: 'u2' } })).status).toBe(403);
    expect((await call('/s/delegates', { method: 'POST', body: { delegate_user_id: 'u1' } })).status).toBe(400);
    const d = await call('/s/delegates', { method: 'POST', body: { delegate_user_id: 'u2' } });
    expect(d.body.delegates.i_allow).toEqual([{ user_id: 'u2', name: 'たごん（川崎 かおり）' }]);
    expect((await call('/s/bootstrap', { user: 'u2' })).body.delegates.allowed_by[0]).toMatchObject({ user_id: 'u1', gmail_connected: true });

    const draft = await call('/s/mails', { user: 'u2', method: 'POST', body: { contact_id: contactId, sender_user_id: 'u1', to_email: 'yamada@example.co.jp', subject: '続報', body: '本文' } });
    expect(draft.status).toBe(201);
    expect(draft.body.mail).toMatchObject({ sender_user_id: 'u1', created_by: 'u2' });
    // u3 は代理ではない
    expect((await call(`/s/mails/${draft.body.mail.id}/send`, { user: 'u3', method: 'POST', body: { confirm_to_email: 'yamada@example.co.jp' } })).status).toBe(403);

    const sent = await call(`/s/mails/${draft.body.mail.id}/send`, { user: 'u2', method: 'POST', body: { confirm_to_email: 'yamada@example.co.jp' } });
    expect(sent.status).toBe(200);
    expect(mockSendRaw).toHaveBeenCalledTimes(2);
    expect(mockSendRaw.mock.calls[1][0].userId).toBe('u1'); // 差出人（本人）の Gmail から
    expect(mockDb.sales_mails.find((m) => m.id === draft.body.mail.id).sent_by).toBe('u2');

    // 取り消したら、もう作れない
    await call('/s/delegates/u2', { method: 'DELETE' });
    expect((await call('/s/mails', { user: 'u2', method: 'POST', body: { contact_id: contactId, sender_user_id: 'u1', to_email: 'yamada@example.co.jp', subject: 's', body: 'b' } })).status).toBe(403);
  });

  test('Gmail 未連携・「今後メールを送らない」は送らず、下書きのまま残る', async () => {
    const m = await call('/s/mails', { user: 'u2', method: 'POST', body: { contact_id: contactId, to_email: 'yamada@example.co.jp', subject: 's', body: 'b' } });
    const r = await call(`/s/mails/${m.body.mail.id}/send`, { user: 'u2', method: 'POST', body: { confirm_to_email: 'yamada@example.co.jp' } });
    expect(r.body.code).toBe('gmail_not_connected');
    expect(mockDb.sales_mails.find((x) => x.id === m.body.mail.id).status).toBe('draft');

    await call(`/s/contacts/${contactId}`, { method: 'PATCH', body: { do_not_email: true } });
    const m2 = await call('/s/mails', { method: 'POST', body: { contact_id: contactId, to_email: 'yamada@example.co.jp', subject: 's', body: 'b' } });
    expect((await call(`/s/mails/${m2.body.mail.id}/send`, { method: 'POST', body: { confirm_to_email: 'yamada@example.co.jp' } })).body.code).toBe('do_not_email');
    expect(mockSendRaw).toHaveBeenCalledTimes(2);
    await call(`/s/contacts/${contactId}`, { method: 'PATCH', body: { do_not_email: false } });
  });

  test('Gmail が断ったら「失敗」にして送り直せる', async () => {
    mockSendRaw.mockRejectedValueOnce(Object.assign(new Error('Gmail が送信を受け付けませんでした: quota'), { status: 502, code: 'gmail_error' }));
    const m = await call('/s/mails', { method: 'POST', body: { contact_id: contactId, to_email: 'yamada@example.co.jp', subject: 's', body: 'b' } });
    const ng = await call(`/s/mails/${m.body.mail.id}/send`, { method: 'POST', body: { confirm_to_email: 'yamada@example.co.jp' } });
    expect(ng.status).toBe(502);
    expect(mockDb.sales_mails.find((x) => x.id === m.body.mail.id).status).toBe('failed');
    const retry = await call(`/s/mails/${m.body.mail.id}/send`, { method: 'POST', body: { confirm_to_email: 'yamada@example.co.jp' } });
    expect(retry.status).toBe(200);
  });

  test('紹介ページ: ログインなしで開け、開封を数える（ロボット・preview は数えない）', async () => {
    const path = pageUrl.replace('https://hfs.example', '');
    const human = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1';
    const r = await call(path, { user: null, ua: human });
    expect(r.status).toBe(200);
    expect(r.body).toContain('youtube-nocookie.com/embed/dQw4w9WgXcQ');
    expect(r.body).toContain('player.vimeo.com/video/123456789');
    expect(r.body).toContain('noindex');
    await call(path, { user: null, ua: 'Slackbot-LinkExpanding 1.0' });
    await call(`${path}?preview=1`, { user: null, ua: human });
    await new Promise((res) => setTimeout(res, 20));
    expect(mockDb.sales_promo_pages.find((p) => p.id === pageId).view_count).toBe(1);
    expect((await call('/s/contacts', { user: 'u2' })).body.contacts[0].promo_viewed).toBe(true);
  });

  test('紹介ページ: 公開を止められるのは発行した本人と管理者。止めたら 404', async () => {
    expect((await call(`/s/promo-pages/${pageId}/revoke`, { user: 'u2', method: 'POST' })).status).toBe(403);
    expect((await call(`/s/promo-pages/${pageId}/revoke`, { method: 'POST' })).status).toBe(200);
    expect((await call(pageUrl.replace('https://hfs.example', ''), { user: null, ua: 'Mozilla/5.0' })).status).toBe(404);
    expect((await call('/pv/does-not-exist-0000000', { user: null })).status).toBe(404);
  });

  test('紹介ページのタイトル・あいさつは HTML として解釈されない', async () => {
    const v = mockDb.sales_promo_videos[0];
    const p = await call('/s/promo-pages', { method: 'POST', body: { video_ids: [v.id], title: '<script>alert(1)</script>', greeting: '<img src=x onerror=alert(1)>' } });
    const html = (await call(p.body.page.url.replace('https://hfs.example', ''), { user: null, ua: 'Mozilla/5.0' })).body;
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;script&gt;');
  });

  test('アーカイブすると一覧から外れる', async () => {
    expect((await call(`/s/contacts/${contactId}`, { user: 'u2', method: 'DELETE' })).status).toBe(403);
    expect((await call(`/s/contacts/${contactId}`, { method: 'DELETE' })).status).toBe(200);
    expect((await call('/s/contacts')).body.contacts).toHaveLength(0);
    expect((await call('/s/contacts?archived=1')).body.contacts).toHaveLength(1);
  });
});
