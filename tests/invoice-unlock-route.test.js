// 請求書の「提出後に直すためのロック解除」（ADR 046 追補 2026-11-22）の結合テスト。supabase はメモリ上の小さな偽 DB。
//   - POST /invoices/:id/reject: 理由必須・kind で保存文言が変わる・提出済みだけ・メンバー請求書だけ本人へ個別通知・通知失敗でも 200
//   - POST /invoices/:id/unlock-request: 本人のみ・理由必須・submitted のみ・10 分に 1 回・管理者のマイチャットへ一報

process.env.INVOICE_PDF_DRIVE_SYNC = 'off'; // Drive へは行かない（PDF のゴミ箱送りは別テストの範囲）

const mockDb = { tables: {} };
const mockSent = { member: [], adminMyChat: [], bell: [], memberResult: { ok: true, channel: 'chatwork_direct', reason: null }, adminResult: { ok: true }, memberThrows: false };
function mockReset() {
  mockDb.tables = {
    users: [
      { id: 'admin1', full_name: '管理 太郎', nickname: 'かんり', role: 'admin' },
      { id: 'm1', full_name: '山田 花子', nickname: 'はな', role: 'editor', chatwork_direct_room_id: '111' },
      { id: 'm2', full_name: '別 の人', nickname: '', role: 'editor' },
    ],
    invoices: [
      { id: 'inv-sub', invoice_number: 'INV-1', issuer_id: 'm1', status: 'submitted', year: 2026, month: 10, invoice_type: 'member', total_amount: 55000 },
      { id: 'inv-null', invoice_number: 'INV-2', issuer_id: 'm1', status: 'submitted', year: 2026, month: 9, invoice_type: null },
      { id: 'inv-app', invoice_number: 'INV-3', issuer_id: 'm1', status: 'approved', year: 2026, month: 8, invoice_type: 'member' },
      { id: 'inv-draft', invoice_number: 'INV-4', issuer_id: 'm1', status: 'draft', year: 2026, month: 11, invoice_type: 'member' },
      { id: 'inv-client', invoice_number: 'C-1', issuer_id: 'admin1', status: 'submitted', year: 2026, month: 10, invoice_type: 'client' },
    ],
    member_invoice_folders: [],
  };
  mockSent.member = []; mockSent.adminMyChat = []; mockSent.bell = [];
  mockSent.memberResult = { ok: true, channel: 'chatwork_direct', reason: null };
  mockSent.adminResult = { ok: true };
  mockSent.memberThrows = false;
}
mockReset();

function mockBuilder(table) {
  const filters = [];
  let op = 'select'; let payload = null;
  const rows = () => (mockDb.tables[table] || (mockDb.tables[table] = []));
  const match = () => rows().filter(r => filters.every(f => f(r)));
  const run = () => {
    if (op === 'update') { const m = match(); m.forEach(r => Object.assign(r, payload)); return { data: m.map(r => ({ ...r })), error: null }; }
    return { data: match().map(r => ({ ...r })), error: null };
  };
  const b = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'then') return (res, rej) => Promise.resolve(run()).then(res, rej);
      if (prop === 'update') return (p) => { op = 'update'; payload = p; return b; };
      if (prop === 'eq') return (c, v) => { filters.push(r => r[c] === v); return b; };
      if (prop === 'single' || prop === 'maybeSingle') return async () => {
        const r = run();
        return { ...r, data: Array.isArray(r.data) ? (r.data[0] || null) : r.data };
      };
      return () => b;
    },
  });
  return b;
}
jest.mock('../supabase', () => ({ from: (t) => mockBuilder(t), rpc: async () => ({ data: null, error: null }), storage: { from: () => ({}) } }));
jest.mock('../auth', () => {
  const who = (req) => req.headers['x-test-user'] || 'm1';
  const roleOf = (req) => (who(req) === 'admin1' ? 'admin' : 'editor');
  const pass = (req, res, next) => { req.user = { id: who(req), role: roleOf(req) }; next(); };
  // requireLevel('admin') は本物と同じく admin 以外を 403 にする（権限の付け忘れを検出するため）
  const level = (min) => (req, res, next) => {
    if (min === 'admin' && roleOf(req) !== 'admin') return res.status(403).json({ error: '権限が不足しています' });
    return pass(req, res, next);
  };
  return {
    requireAuth: pass, requireRole: () => pass, requireLevel: level, requirePermission: () => pass,
    requireAnyPermission: () => pass, requireSuperAdmin: pass, isSuperAdminUser: () => false,
    userHasPermission: async () => false, getEffectiveRole: async (req) => req.user.role,
    getEffectiveRoleCodes: async (req) => [req.user.role],
    invalidatePermissionsCache: () => {}, invalidateUserCache: () => {},
  };
});
jest.mock('../utils/member-notify', () => ({
  NOTIFY_USER_COLUMNS: 'id, full_name, nickname',
  notifyMember: async (user, message, opts) => {
    if (mockSent.memberThrows) throw new Error('chatwork down');
    mockSent.member.push({ user, message, opts });
    return { ...mockSent.memberResult };
  },
}));
jest.mock('../notifications', () => ({
  buildAppUrl: (p) => `https://app.test/${String(p).replace(/^\//, '')}`,
  notifyAdminMyChat: async (text, opts) => { mockSent.adminMyChat.push({ text, opts }); return { ...mockSent.adminResult }; },
}));
jest.mock('../utils/notification', () => ({
  createNotification: async (n) => { mockSent.bell.push(n); return { id: 'n1' }; },
  extractMentions: () => [], loadMentionDirectory: async () => [],
}));

const express = require('express');
let server; let base;
beforeAll(async () => {
  const app = express(); app.use(express.json());
  app.use('/api', require('../routes/haruka'));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api`;
});
afterAll(() => server && server.close());
beforeEach(() => mockReset());

const call = async (path, body, user = 'm1') => {
  const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-user': user }, body: JSON.stringify(body || {}) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const inv = (id) => mockDb.tables.invoices.find(i => i.id === id);

describe('POST /invoices/:id/reject', () => {
  test('管理者以外は 403（状態も変わらない・通知も出ない）', async () => {
    const r = await call('/invoices/inv-sub/reject', { kind: 'unlock', rejection_reason: '直したい' }, 'm1');
    expect(r.status).toBe(403);
    expect(inv('inv-sub').status).toBe('submitted');
    expect(mockSent.member).toHaveLength(0);
  });

  test('理由が空だと 400（サーバーでも必須）', async () => {
    for (const body of [{ kind: 'unlock' }, { kind: 'reject', rejection_reason: '   ' }, {}]) {
      const r = await call('/invoices/inv-sub/reject', body, 'admin1');
      expect(r.status).toBe(400);
    }
    expect(inv('inv-sub').status).toBe('submitted');
    expect(mockSent.member).toHaveLength(0);
  });

  test('kind=unlock: 先頭に固定文言つきで保存し、本人へ privateOnly で「修正できるようにしました」を送る', async () => {
    const r = await call('/invoices/inv-sub/reject', { kind: 'unlock', rejection_reason: '1件足してください' }, 'admin1');
    expect(r.status).toBe(200);
    expect(r.body.kind).toBe('unlock');
    expect(r.body.notified).toEqual({ ok: true, channel: 'chatwork_direct', forwarded: false });
    expect(inv('inv-sub').status).toBe('rejected');
    expect(inv('inv-sub').rejection_reason).toBe('修正のためロック解除: 1件足してください');
    expect(inv('inv-sub').rejected_at).toBeTruthy();
    expect(inv('inv-sub').total_amount).toBe(55000); // 金額には触らない

    expect(mockSent.member).toHaveLength(1);
    const sent = mockSent.member[0];
    expect(sent.user.id).toBe('m1');
    expect(sent.opts).toEqual({ privateOnly: true }); // 共有ルームには流さない
    expect(sent.message.chatwork).toContain('2026年10月分の請求書を修正できるようにしました');
    expect(sent.message.chatwork).toContain('メモ: 1件足してください');
    expect(sent.message.chatwork).toContain('請求書（マイページ）から開いて直し、もう一度提出してください。');
    expect(sent.message.chatwork).toContain('https://app.test/haruka.html?page=invoices&invoice=inv-sub');
    expect(sent.message.chatwork).not.toContain('55000');

    expect(mockSent.bell).toHaveLength(1);
    expect(mockSent.bell[0]).toMatchObject({ userId: 'm1', type: 'invoice', linkUrl: '/haruka.html?page=invoices&invoice=inv-sub', senderId: 'admin1' });
  });

  test('kind=reject（未指定も同じ）: 理由そのままで保存し、差し戻しの文面で送る', async () => {
    const r = await call('/invoices/inv-null/reject', { rejection_reason: '単価が違います' }, 'admin1');
    expect(r.status).toBe(200);
    expect(r.body.kind).toBe('reject');
    expect(inv('inv-null').rejection_reason).toBe('単価が違います');
    expect(mockSent.member).toHaveLength(1); // invoice_type が NULL もメンバー請求書として通知する
    expect(mockSent.member[0].message.chatwork).toContain('2026年9月分の請求書が差し戻されました');
    expect(mockSent.member[0].message.chatwork).toContain('理由: 単価が違います');
  });

  test('クライアント宛ての請求書は戻せるが、通知はしない', async () => {
    const r = await call('/invoices/inv-client/reject', { kind: 'reject', rejection_reason: '宛名違い' }, 'admin1');
    expect(r.status).toBe(200);
    expect(r.body.notified).toBeNull();
    expect(inv('inv-client').status).toBe('rejected');
    expect(mockSent.member).toHaveLength(0);
    expect(mockSent.bell).toHaveLength(0);
  });

  test('通知が届かなくても・例外でも API は 200（差し戻しは成立）', async () => {
    mockSent.memberResult = { ok: false, channel: 'none', reason: '未登録' };
    const r1 = await call('/invoices/inv-sub/reject', { kind: 'unlock', rejection_reason: 'a' }, 'admin1');
    expect(r1.status).toBe(200);
    expect(r1.body.notified.ok).toBe(false);
    expect(inv('inv-sub').status).toBe('rejected');

    mockSent.memberThrows = true;
    const r2 = await call('/invoices/inv-null/reject', { kind: 'reject', rejection_reason: 'b' }, 'admin1');
    expect(r2.status).toBe(200);
    expect(r2.body.notified).toEqual({ ok: false, channel: 'none', forwarded: false });
    expect(inv('inv-null').status).toBe('rejected');
  });

  test('管理者のマイチャットへ転送になったら forwarded を返す', async () => {
    mockSent.memberResult = { ok: true, forwarded: true, channel: 'chatwork_mychat_fallback', reason: '未登録' };
    const r = await call('/invoices/inv-sub/reject', { kind: 'unlock', rejection_reason: 'a' }, 'admin1');
    expect(r.body.notified).toEqual({ ok: true, channel: 'chatwork_mychat_fallback', forwarded: true });
  });

  test('提出済み以外（承認済み・下書き・すでに戻した）は 409 で、二重に通知しない', async () => {
    expect((await call('/invoices/inv-app/reject', { kind: 'unlock', rejection_reason: 'a' }, 'admin1')).status).toBe(409);
    expect((await call('/invoices/inv-draft/reject', { kind: 'unlock', rejection_reason: 'a' }, 'admin1')).status).toBe(409);
    expect(inv('inv-app').status).toBe('approved');
    await call('/invoices/inv-sub/reject', { kind: 'unlock', rejection_reason: 'a' }, 'admin1');
    const again = await call('/invoices/inv-sub/reject', { kind: 'reject', rejection_reason: 'b' }, 'admin1');
    expect(again.status).toBe(409);
    expect(inv('inv-sub').rejection_reason).toBe('修正のためロック解除: a');
    expect(mockSent.member).toHaveLength(1);
  });

  test('存在しない請求書は 404', async () => {
    expect((await call('/invoices/nope/reject', { kind: 'unlock', rejection_reason: 'a' }, 'admin1')).status).toBe(404);
  });
});

describe('POST /invoices/:id/unlock-request', () => {
  test('本人の提出済み請求書: 管理者のマイチャットへ一報し、状態は変えない', async () => {
    const r = await call('/invoices/inv-sub/unlock-request', { reason: '1件入れ忘れました' }, 'm1');
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(inv('inv-sub').status).toBe('submitted');
    expect(mockSent.adminMyChat).toHaveLength(1);
    const text = mockSent.adminMyChat[0].text;
    expect(text).toContain('申請した人: はな（山田 花子）さん');
    expect(text).toContain('請求書: 2026年10月分（INV-1）');
    expect(text).toContain('理由: 1件入れ忘れました');
    expect(text).toContain('https://app.test/haruka.html?page=invoices&invoice_unlock=inv-sub');
    expect(text).not.toContain('55000');
    expect(mockSent.member).toHaveLength(0); // 共有ルーム・本人宛てには何も送らない
  });

  test('理由が空だと 400', async () => {
    expect((await call('/invoices/inv-sub/unlock-request', { reason: ' ' }, 'm1')).status).toBe(400);
    expect((await call('/invoices/inv-sub/unlock-request', {}, 'm1')).status).toBe(400);
    expect(mockSent.adminMyChat).toHaveLength(0);
  });

  test('他人の請求書は 403（管理者でも本人以外は申請できない）', async () => {
    expect((await call('/invoices/inv-sub/unlock-request', { reason: 'a' }, 'm2')).status).toBe(403);
    expect((await call('/invoices/inv-sub/unlock-request', { reason: 'a' }, 'admin1')).status).toBe(403);
    expect(mockSent.adminMyChat).toHaveLength(0);
  });

  test('承認済み・下書きは 400、存在しなければ 404', async () => {
    const a = await call('/invoices/inv-app/unlock-request', { reason: 'a' }, 'm1');
    expect(a.status).toBe(400);
    expect(a.body.error).toMatch(/承認済み/);
    expect((await call('/invoices/inv-draft/unlock-request', { reason: 'a' }, 'm1')).status).toBe(400);
    expect((await call('/invoices/nope/unlock-request', { reason: 'a' }, 'm1')).status).toBe(404);
    expect(mockSent.adminMyChat).toHaveLength(0);
  });

  test('クライアント宛ての請求書は対象外', async () => {
    expect((await call('/invoices/inv-client/unlock-request', { reason: 'a' }, 'admin1')).status).toBe(400);
  });

  test('同じ請求書への連打は 429（別の請求書は通る）。管理者がロックを外すと数え直す', async () => {
    // 連打制限はプロセス内で持つ（テストをまたいで残る）ので、このテスト専用の請求書で確かめる
    mockDb.tables.invoices.push(
      { id: 'inv-t1', invoice_number: 'INV-T1', issuer_id: 'm1', status: 'submitted', year: 2026, month: 6, invoice_type: 'member' },
      { id: 'inv-t2', invoice_number: 'INV-T2', issuer_id: 'm1', status: 'submitted', year: 2026, month: 5, invoice_type: 'member' },
    );
    expect((await call('/invoices/inv-t1/unlock-request', { reason: 'a' }, 'm1')).status).toBe(200);
    const again = await call('/invoices/inv-t1/unlock-request', { reason: 'b' }, 'm1');
    expect(again.status).toBe(429);
    expect(again.body.code).toBe('UNLOCK_REQUEST_THROTTLED');
    expect(mockSent.adminMyChat).toHaveLength(1);
    expect((await call('/invoices/inv-t2/unlock-request', { reason: 'c' }, 'm1')).status).toBe(200);

    // ロック解除 → 本人が再提出 → もう一度直したくなったら、10 分待たずに申請できる
    await call('/invoices/inv-t1/reject', { kind: 'unlock', rejection_reason: 'どうぞ' }, 'admin1');
    inv('inv-t1').status = 'submitted';
    expect((await call('/invoices/inv-t1/unlock-request', { reason: 'd' }, 'm1')).status).toBe(200);
  });

  test('管理者へ送れなかったら 502 を返し、すぐ送り直せる', async () => {
    // 連打制限はプロセス内で持つので、ほかのテストで使っていない請求書を足して確かめる
    mockDb.tables.invoices.push({ id: 'inv-fail', invoice_number: 'INV-9', issuer_id: 'm1', status: 'submitted', year: 2026, month: 7, invoice_type: 'member' });
    mockSent.adminResult = { ok: false, reason: 'no_token' };
    expect((await call('/invoices/inv-fail/unlock-request', { reason: 'a' }, 'm1')).status).toBe(502);
    mockSent.adminResult = { ok: true };
    expect((await call('/invoices/inv-fail/unlock-request', { reason: 'a' }, 'm1')).status).toBe(200);
  });
});
