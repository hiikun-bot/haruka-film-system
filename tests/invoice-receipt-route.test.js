// 立替経費の領収書（ADR 046 追補 2026-11-23）の結合テスト。supabase はメモリ上の偽 DB、Drive は偽物。
//   - POST /invoice-editor/:id/items/:itemId/receipt: 本人・管理者だけ／「＋ 立替経費」の行だけ／中身で種類判定／10MB まで／
//     「領収書」サブフォルダに新規作成・差し替えで古いファイルはゴミ箱
//   - GET /invoices/:id/items/:itemId/receipt: 本人・管理者だけ見られる（他人は 403）・Drive からプロキシ
//   - PUT: 日付・支払先・状態の保存／「領収書なし」にしたら写真をゴミ箱へ／行を消したら写真をゴミ箱へ
//   - DELETE /invoices/:id: 領収書もゴミ箱へ
//   - submit: 日付・支払先・領収書が欠けたら 409（どの行か）。列が無い環境は従来どおり（見ない）
//   - アップロードと提出の競合: 確認→（間に提出）→保存 で、提出済みの請求書の領収書が差し替わらない（DB の関数で確認と書き込みを一度に）
//   - GET /invoices: 本人以外の請求書は管理者（admin/秘書・実効ロールも）だけ。それ以外は issuer_id を無視して自分の分だけ
process.env.INVOICE_PDF_DRIVE_SYNC = 'off';
process.env.GOOGLE_SERVICE_ACCOUNT_KEY = JSON.stringify({ client_email: 'service-account', private_key: 'x' });

const mockDb = { tables: {}, noReceiptCols: false };
let mockSeq = 0;
const RECEIPT_COL_RE = /expense_date|expense_payee|receipt_/;
function mockBuilder(table) {
  const st = { op: 'select', payload: null, filters: [], select: '' };
  const rowsOf = () => (mockDb.tables[table] || (mockDb.tables[table] = []));
  const match = (r) => st.filters.every(f => f(r));
  const run = () => {
    // migration 未適用の再現: 領収書の列を読む・書くと 42703
    const touchesReceipt = RECEIPT_COL_RE.test(st.select)
      || ((st.op === 'update' || st.op === 'insert') && JSON.stringify(st.payload || {}).match(/"(expense_date|expense_payee|receipt_[a-z_]+)"/));
    // 一覧・詳細は invoices から明細を埋め込みで読むので、invoices の select でも同じエラーにする
    if (mockDb.noReceiptCols && (table === 'invoice_items' || table === 'invoices') && touchesReceipt) {
      return { data: null, error: { code: '42703', message: 'column invoice_items.receipt_status does not exist' } };
    }
    if (mockDb.noRegNo && /invoice_registration_number/.test(st.select)) {
      return { data: null, error: { code: '42703', message: 'column users.invoice_registration_number does not exist' } };
    }
    if (st.op === 'insert') {
      const list = (Array.isArray(st.payload) ? st.payload : [st.payload]).map(p => ({ id: `new-${++mockSeq}`, ...p }));
      mockDb.tables[table] = rowsOf().concat(list);
      return { data: list.map(r => ({ ...r })), error: null };
    }
    if (st.op === 'update') {
      if (mockDb.onUpdate) mockDb.onUpdate(table, st.payload || {});
      const hit = rowsOf().filter(match);
      hit.forEach(r => Object.assign(r, st.payload));
      return { data: hit.map(r => ({ ...r })), error: null };
    }
    if (st.op === 'delete') {
      mockDb.tables[table] = rowsOf().filter(r => !match(r));
      return { data: null, error: null };
    }
    return { data: rowsOf().filter(match).map(r => ({ ...r })), error: null, count: 0 };
  };
  const b = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'then') return (res, rej) => Promise.resolve(run()).then(res, rej);
      if (prop === 'select') return (s) => { if (typeof s === 'string') st.select += s; return b; };
      if (prop === 'insert') return (p) => { st.op = 'insert'; st.payload = p; return b; };
      if (prop === 'update') return (p) => { st.op = 'update'; st.payload = p; return b; };
      if (prop === 'delete') return () => { st.op = 'delete'; return b; };
      if (prop === 'eq') return (k, v) => { st.filters.push(r => r[k] === v); return b; };
      if (prop === 'in') return (k, vs) => { st.filters.push(r => vs.includes(r[k])); return b; };
      if (prop === 'is') return (k, v) => { st.filters.push(r => (r[k] ?? null) === v); return b; };
      if (prop === 'single' || prop === 'maybeSingle') return async () => {
        const r = run();
        return { ...r, data: Array.isArray(r.data) ? (r.data[0] || null) : r.data };
      };
      return () => b;
    },
  });
  return b;
}
// DB の関数 attach_invoice_item_receipt（migrations/2026-11-23b_...）の偽物。状態の確認と行の書き込みを一度に行う。
//   mockDb.onRpc … 関数が走る直前に呼ぶ（「確認の直前に提出された」を再現する）
//   mockDb.rpcMissing … 関数がまだ無い環境（PGRST202）
// 保存・提出は DB の関数（ADR 046 追補 2026-11-24（3））。偽 DB の上で同じ意味に動かす
const mockRpcFake = require('./helpers/invoice-editor-rpc-fake').createInvoiceEditorRpcFake({
  rows: (t) => (mockDb.tables[t] || (mockDb.tables[t] = [])), setRows: (t, arr) => { mockDb.tables[t] = arr; },
});
async function mockRpc(name, args) {
  const viaFake = mockRpcFake(name, args);
  if (viaFake) return viaFake;
  if (name !== 'attach_invoice_item_receipt') return { data: null, error: null };
  mockDb.rpcCalls = (mockDb.rpcCalls || 0) + 1;
  if (mockDb.rpcMissing) return { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.attach_invoice_item_receipt' } };
  if (mockDb.rpcFailBefore) return { data: null, error: { message: 'connection refused' } };
  // DB がエラーを返した（SQLSTATE つき＝取り消し済み）
  if (mockDb.rpcDbError) return { data: null, error: { code: '40001', message: 'could not serialize access' } };
  if (mockDb.onRpc) mockDb.onRpc(args);
  const inv = (mockDb.tables.invoices || []).find(r => r.id === args.p_invoice_id);
  if (!inv) return { data: { result: 'invoice_not_found' }, error: null };
  if (!['draft', 'rejected'].includes(inv.status)) return { data: { result: 'not_editable', status: inv.status }, error: null };
  const it = (mockDb.tables.invoice_items || []).find(r => r.id === args.p_item_id && r.invoice_id === args.p_invoice_id);
  if (!it) return { data: { result: 'item_not_found' }, error: null };
  const prev = it.receipt_file_id || null;
  const uploadedAt = new Date().toISOString();
  Object.assign(it, {
    receipt_status: 'attached', receipt_missing_reason: null, receipt_file_id: args.p_file_id,
    receipt_file_name: args.p_file_name, receipt_mime_type: args.p_mime_type, receipt_uploaded_at: uploadedAt,
  });
  // DB では記録が済んだが、応答が届かなかった（タイムアウト・切断）
  if (mockDb.rpcErrorAfterWrite) return { data: null, error: { message: 'fetch failed' } };
  return { data: { result: 'ok', prev_file_id: prev, uploaded_at: uploadedAt }, error: null };
}
jest.mock('../supabase', () => ({ from: (t) => mockBuilder(t), rpc: (n, a) => mockRpc(n, a), storage: { from: () => ({}) } }));
jest.mock('../auth', () => {
  const who = (req) => req.headers['x-test-user'] || 'u1';
  const roleOf = (req) => ({ admin1: 'admin', sec1: 'secretary' }[who(req)] || 'editor');
  const pass = (req, res, next) => { req.user = { id: who(req), role: roleOf(req) }; next(); };
  return {
    requireAuth: pass, requireRole: () => pass, requireLevel: () => pass, requirePermission: () => pass,
    requireAnyPermission: () => pass, requireSuperAdmin: pass, isSuperAdminUser: () => false,
    userHasPermission: async () => false, getEffectiveRole: async (req) => req.user.role,
    // VIEW AS: X-View-As は最高管理者（このテストでは admin1）のときだけ効く（auth.js と同じ）
    getEffectiveRoleCodes: async (req) => {
      const v = String(req.headers['x-view-as'] || '').trim();
      if (v && req.user.id === 'admin1') return [v];
      return [req.user.role];
    },
    invalidatePermissionsCache: () => {}, invalidateUserCache: () => {},
  };
});

// 偽の Drive（作成・ゴミ箱・中身の取得だけ）
const mockDrive = {
  files: new Map(),
  created: [],
  trashed: [],
  api: {
    files: {
      list: async () => ({ data: { files: [] } }),
      create: async ({ requestBody, media }) => {
        const id = `drv-${++mockSeq}`;
        let bytes = null;
        if (media && media.body) {
          const chunks = [];
          for await (const c of media.body) chunks.push(Buffer.from(c));
          bytes = Buffer.concat(chunks);
        }
        mockDrive.files.set(id, { id, ...requestBody, bytes });
        if (mockDrive.onCreate && requestBody.mimeType !== 'application/vnd.google-apps.folder') await mockDrive.onCreate(id);
        mockDrive.created.push({ id, ...requestBody });
        return { data: { id } };
      },
      update: async ({ fileId, requestBody }) => {
        if (requestBody && requestBody.trashed) mockDrive.trashed.push(fileId);
        return { data: {} };
      },
      get: async ({ fileId, alt }) => {
        const f = mockDrive.files.get(fileId);
        if (!f) { const e = new Error('File not found'); e.code = 404; throw e; }
        if (alt === 'media') return { data: require('stream').Readable.from([f.bytes || Buffer.alloc(0)]) };
        return { data: f };
      },
    },
    permissions: { create: async () => ({ data: {} }), list: async () => ({ data: { permissions: [] } }) },
  },
};
jest.mock('googleapis', () => ({
  google: {
    auth: { GoogleAuth: function GoogleAuth() { return {}; } },
    drive: () => mockDrive.api,
    sheets: () => ({}),
    docs: () => ({}),
  },
}));

const express = require('express');
let server; let base;
beforeAll(async () => {
  const app = express(); app.use(express.json());
  // 本番は server.js がログイン済みの人だけを通す（GET /invoices は requireAuth を付けていないので、ここで req.user を入れる）
  app.use((req, _res, next) => {
    const id = req.headers['x-test-user'] || 'u1';
    req.user = { id, role: ({ admin1: 'admin', sec1: 'secretary' })[id] || 'editor' };
    next();
  });
  app.use('/api', require('../routes/haruka'));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api`;
});
afterAll(() => server && server.close());

const JPEG = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(60, 1)]);
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(60, 2)]);

beforeEach(() => {
  mockDb.noReceiptCols = false;
  mockDb.onUpdate = null;
  mockDb.noRegNo = false;
  mockDb.onRpc = null;
  mockDb.rpcMissing = false;
  mockDb.rpcErrorAfterWrite = false; mockDb.rpcFailBefore = false;
  mockDb.rpcCalls = 0;
  mockDrive.onCreate = null;
  mockDrive.files = new Map(); mockDrive.created = []; mockDrive.trashed = [];
  mockDb.tables = {
    users: [
      // 月フォルダは member_invoice_folders に登録済み（フォルダを新しく作らないのでメールアドレスは要らない）
      { id: 'u1', full_name: 'テスト 太郎', nickname: 'たろう', business_type: 'individual', role: 'editor' },
      { id: 'u2', full_name: '別の 人', nickname: '', role: 'editor' },
      { id: 'admin1', full_name: '管理 者', nickname: '', role: 'admin' },
      { id: 'sec1', full_name: '秘書 さん', nickname: '', role: 'secretary' },
    ],
    user_roles: [],
    // 本番と同じ: 請求書一覧の閲覧（invoice.all_view）は admin（常に許可）と秘書だけ
    role_permissions: [
      { role: 'secretary', permission_key: 'invoice.all_view', allowed: true, role_id: null, roles: null },
      { role: 'editor', permission_key: 'invoice.all_view', allowed: false, role_id: null, roles: null },
    ],
    member_invoice_folders: [{ user_id: 'u1', year: 2026, month: 10, folder_id: 'folder-u1-202610', folder_url: 'https://drive.test/folder' }],
    invoices: [{
      id: 'inv1', invoice_number: 'INV-202610-013', issuer_id: 'u1', status: 'draft', year: 2026, month: 10, notes: null,
      tax_mode: 'exclusive', withholding_enabled: true, subtotal_amount: 0, tax_amount: 0, total_amount: 0,
      withholding_amount: 0, payout_amount: 1641, updated_at: 't0', submitted_at: null, rejection_reason: null, invoice_type: null,
    }],
    invoice_items: [
      {
        id: 'ex1', invoice_id: 'inv1', creative_id: null, cost_type: 'expense', label: 'アートホテル撮影 ガソリン代', creative_label: null, unit: '式',
        unit_price: 1641, quantity: 1, total_amount: 1641, original_unit_price: null, price_change_reason: null, manual_reason: null, sort_order: 0,
        expense_date: null, expense_payee: null, receipt_status: null, receipt_missing_reason: null,
        receipt_file_id: null, receipt_file_name: null, receipt_mime_type: null, receipt_uploaded_at: null,
      },
      {
        id: 'mn1', invoice_id: 'inv1', creative_id: null, cost_type: null, label: '撮影補助', creative_label: null, unit: '式',
        unit_price: 0, quantity: 1, total_amount: 0, original_unit_price: null, price_change_reason: null, manual_reason: '直接依頼', sort_order: 1,
      },
    ],
  };
});

const upload = async (itemId, buf, { user = 'u1', name = 'receipt.jpg', type = 'image/jpeg', invoiceId = 'inv1' } = {}) => {
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type }), name);
  const r = await fetch(`${base}/invoice-editor/${invoiceId}/items/${itemId}/receipt`, { method: 'POST', headers: { 'x-test-user': user }, body: fd });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const json = async (method, path, body, user = 'u1') => {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-test-user': user }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const item = (id) => mockDb.tables.invoice_items.find(i => i.id === id);
const inv = () => mockDb.tables.invoices[0];

describe('領収書のアップロード', () => {
  test('本人: 「領収書」サブフォルダに 領収書_YYYYMMDD_内容_金額円.jpg で新規作成し、行に記録する', async () => {
    item('ex1').expense_date = '2026-10-25';
    const r = await upload('ex1', JPEG);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, receipt_status: 'attached', receipt_file_name: '領収書_20261025_アートホテル撮影 ガソリン代_1641円.jpg', receipt_mime_type: 'image/jpeg' });
    const folder = mockDrive.created.find(c => c.mimeType === 'application/vnd.google-apps.folder');
    expect(folder).toMatchObject({ name: '領収書', parents: ['folder-u1-202610'] });
    const file = mockDrive.created.find(c => c.mimeType === 'image/jpeg');
    expect(file.parents).toEqual([folder.id]);
    expect(file.appProperties).toMatchObject({ hfs_kind: 'invoice_receipt', hfs_invoice_id: 'inv1', hfs_item_id: 'ex1' });
    expect(item('ex1')).toMatchObject({ receipt_status: 'attached', receipt_file_id: file.id, receipt_missing_reason: null });
    // 請求書の updated_at は進めない（自動保存の楽観ロックとぶつけない）
    expect(inv().updated_at).toBe('t0');
  });

  test('差し替え: 新しいファイルを作り、古いファイルはゴミ箱へ（上書きしない）', async () => {
    const first = await upload('ex1', JPEG);
    const second = await upload('ex1', PDF, { name: 'GO領収書.pdf', type: 'application/pdf' });
    expect(second.status).toBe(200);
    expect(second.body.receipt_mime_type).toBe('application/pdf');
    expect(second.body.receipt_file_id).not.toBe(first.body.receipt_file_id);
    expect(mockDrive.trashed).toEqual([first.body.receipt_file_id]);
  });

  test('管理者も付けられる・他人は 403（ファイルも作らない）', async () => {
    expect((await upload('ex1', JPEG, { user: 'u2' })).status).toBe(403);
    expect(mockDrive.created).toHaveLength(0);
    expect((await upload('ex1', JPEG, { user: 'admin1' })).status).toBe(200);
  });

  test('「＋ 立替経費」以外の行は 400', async () => {
    expect((await upload('mn1', JPEG)).status).toBe(400);
  });

  test('中身が画像・PDF でなければ 415（拡張子や Content-Type を偽っても通らない）', async () => {
    const r = await upload('ex1', Buffer.from('<html><script>alert(1)</script></html>'.padEnd(80, ' ')), { name: 'x.jpg', type: 'image/jpeg' });
    expect(r.status).toBe(415);
    expect(mockDrive.created.filter(c => c.mimeType !== 'application/vnd.google-apps.folder')).toHaveLength(0);
  });

  test('10MB を超えると 413', async () => {
    const big = Buffer.concat([JPEG, Buffer.alloc(10 * 1024 * 1024)]);
    const r = await upload('ex1', big);
    expect(r.status).toBe(413);
    expect(r.body.code).toBe('RECEIPT_TOO_LARGE');
  });

  test('提出済みの請求書には付けられない', async () => {
    inv().status = 'submitted';
    expect((await upload('ex1', JPEG)).status).toBe(400);
  });

  test('Drive に置いているあいだに提出されたら 409・置いたファイルはゴミ箱へ戻し、行も書かない', async () => {
    mockDrive.onCreate = () => { inv().status = 'submitted'; };
    const r = await upload('ex1', JPEG);
    expect(r.status).toBe(409);
    const file = mockDrive.created.find(c => c.mimeType === 'image/jpeg');
    expect(mockDrive.trashed).toEqual([file.id]);
    expect(item('ex1').receipt_file_id).toBeNull();
  });

  // 確認→（間に提出）→保存: 画面の操作で本当に提出 API が割り込む筋書き
  const readyToSubmit = () => Object.assign(item('ex1'), { expense_date: '2026-10-25', expense_payee: 'ENEOS', receipt_status: 'missing', receipt_missing_reason: '紛失' });
  const submitNow = () => json('POST', '/invoice-editor/inv1/submit', { expected_total: 1641, expected_payout: 1641, updated_at: inv().updated_at });

  test('確認（下書き）→ 間に提出 → 保存: 提出済みの請求書の行は書き換えず 409・置いたファイルはゴミ箱へ', async () => {
    readyToSubmit();
    let submitted = null;
    // アップロードの最初の確認（下書き）を通ったあと、Drive に置いているあいだに提出される
    mockDrive.onCreate = async () => { submitted = await submitNow(); };
    const r = await upload('ex1', JPEG);
    expect(submitted.status).toBe(200);
    expect(inv().status).toBe('submitted');
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('CONFLICT');
    const file = mockDrive.created.find(c => c.mimeType === 'image/jpeg');
    expect(mockDrive.trashed).toEqual([file.id]);
    // 提出したときの中身（領収書なし・理由）のまま
    expect(item('ex1')).toMatchObject({ receipt_status: 'missing', receipt_missing_reason: '紛失', receipt_file_id: null });
  });

  test('差し替え中に提出: 提出時の写真はそのまま残り（ゴミ箱へ送らない）、新しい写真だけゴミ箱へ', async () => {
    const first = await upload('ex1', JPEG);
    expect(first.status).toBe(200);
    Object.assign(item('ex1'), { expense_date: '2026-10-25', expense_payee: 'ENEOS' });
    mockDrive.onCreate = async () => { await submitNow(); };
    const r = await upload('ex1', PDF, { name: 'b.pdf', type: 'application/pdf' });
    expect(r.status).toBe(409);
    expect(inv().status).toBe('submitted');
    expect(item('ex1')).toMatchObject({ receipt_status: 'attached', receipt_file_id: first.body.receipt_file_id, receipt_mime_type: 'image/jpeg' });
    const second = mockDrive.created.find(c => c.mimeType === 'application/pdf');
    expect(mockDrive.trashed).toEqual([second.id]);
    expect(mockDrive.trashed).not.toContain(first.body.receipt_file_id);
  });

  test('確認と書き込みは DB の 1 つの処理で行う（その直前に提出が確定していれば書かない）', async () => {
    mockDb.onRpc = () => { inv().status = 'submitted'; };
    const r = await upload('ex1', JPEG);
    expect(mockDb.rpcCalls).toBe(1);
    expect(r.status).toBe(409);
    expect(item('ex1').receipt_file_id).toBeNull();
  });

  test('行が消されていたら 409・置いたファイルはゴミ箱へ', async () => {
    mockDb.onRpc = () => { mockDb.tables.invoice_items = mockDb.tables.invoice_items.filter(i => i.id !== 'ex1'); };
    const r = await upload('ex1', JPEG);
    expect(r.status).toBe(409);
    const file = mockDrive.created.find(c => c.mimeType === 'image/jpeg');
    expect(mockDrive.trashed).toEqual([file.id]);
  });

  test('記録の結果が分からない（応答がエラー）ときは、置いたファイルをゴミ箱へ送らずに残す', async () => {
    // DB では記録が済んだが応答が届かなかった
    mockDb.rpcErrorAfterWrite = true;
    const r = await upload('ex1', JPEG);
    expect(r.status).toBe(500);
    expect(r.body.code).toBe('RECEIPT_RESULT_UNKNOWN');
    const file = mockDrive.created.find(c => c.mimeType === 'image/jpeg');
    expect(item('ex1').receipt_file_id).toBe(file.id);
    expect(mockDrive.trashed).toEqual([]);
    mockDb.rpcErrorAfterWrite = false;
    // 応答がエラーで、読み直した時点では行が変わっていない（DB の確定がこのあとに来るかもしれない）→ それでも残す
    mockDb.rpcFailBefore = true;
    const r2 = await upload('ex1', PDF, { name: 'b.pdf', type: 'application/pdf' });
    expect(r2.status).toBe(500);
    expect(r2.body.code).toBe('RECEIPT_RESULT_UNKNOWN');
    const file2 = mockDrive.created.find(c => c.mimeType === 'application/pdf');
    expect(file2).toBeTruthy();
    expect(item('ex1').receipt_file_id).toBe(file.id);
    expect(mockDrive.trashed).toEqual([]);
    mockDb.rpcFailBefore = false;
  });

  test('DB がエラーを返した（取り消し済みと分かる）ときは、置いたファイルをゴミ箱へ戻す', async () => {
    mockDb.rpcDbError = true;
    const r = await upload('ex1', JPEG);
    expect(r.status).toBe(500);
    expect(r.body.code).toBeUndefined();
    const file = mockDrive.created.find(c => c.mimeType === 'image/jpeg');
    expect(item('ex1').receipt_file_id || null).toBeNull();
    expect(mockDrive.trashed).toEqual([file.id]);
    mockDb.rpcDbError = false;
  });

  test('差し替えでゴミ箱へ送るのは、書き込んだ時点で行に入っていたファイル', async () => {
    const first = await upload('ex1', JPEG);
    // 画面が読んだあと・書き込む前に、別の画面が写真を付け替えていた
    mockDb.onRpc = () => { item('ex1').receipt_file_id = 'drv-other'; };
    const r = await upload('ex1', PDF, { name: 'b.pdf', type: 'application/pdf' });
    expect(r.status).toBe(200);
    expect(mockDrive.trashed).toEqual(['drv-other']);
    expect(first.body.receipt_file_id).not.toBe('drv-other');
  });

  test('関数がまだ無い環境（migration 未適用）は従来の手順で記録できる・提出済みなら 409', async () => {
    mockDb.rpcMissing = true;
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const ok = await upload('ex1', JPEG);
    expect(ok.status).toBe(200);
    expect(item('ex1')).toMatchObject({ receipt_status: 'attached', receipt_file_id: ok.body.receipt_file_id });
    const re = await upload('ex1', PDF, { name: 'b.pdf', type: 'application/pdf' });
    expect(re.status).toBe(200);
    expect(mockDrive.trashed).toEqual([ok.body.receipt_file_id]);
    mockDrive.onCreate = () => { inv().status = 'submitted'; };
    const ng = await upload('ex1', JPEG);
    expect(ng.status).toBe(409);
    expect(item('ex1').receipt_file_id).toBe(re.body.receipt_file_id);
    warn.mockRestore();
  });

});

describe('領収書を見る（プロキシ）', () => {
  test('本人と管理者は中身を受け取れる・他人は 403', async () => {
    await upload('ex1', PDF, { name: 'r.pdf', type: 'application/pdf' });
    for (const user of ['u1', 'admin1']) {
      const r = await fetch(`${base}/invoices/inv1/items/ex1/receipt`, { headers: { 'x-test-user': user } });
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toBe('application/pdf');
      expect(r.headers.get('content-disposition')).toMatch(/^inline; /);
      expect(r.headers.get('content-security-policy')).toBe('sandbox');
      expect(r.headers.get('x-content-type-options')).toBe('nosniff');
      expect(Buffer.from(await r.arrayBuffer()).equals(PDF)).toBe(true);
    }
    const ng = await fetch(`${base}/invoices/inv1/items/ex1/receipt`, { headers: { 'x-test-user': 'u2' } });
    expect(ng.status).toBe(403);
    const dl = await fetch(`${base}/invoices/inv1/items/ex1/receipt?download=1`, { headers: { 'x-test-user': 'u1' } });
    expect(dl.headers.get('content-disposition')).toMatch(/^attachment; /);
  });

  test('添付が無い行・別の請求書の行は 404', async () => {
    expect((await fetch(`${base}/invoices/inv1/items/ex1/receipt`, { headers: { 'x-test-user': 'u1' } })).status).toBe(404);
    mockDb.tables.invoices.push({ id: 'inv2', issuer_id: 'u1', status: 'draft', year: 2026, month: 10, tax_mode: 'exclusive' });
    await upload('ex1', JPEG);
    expect((await fetch(`${base}/invoices/inv2/items/ex1/receipt`, { headers: { 'x-test-user': 'u1' } })).status).toBe(404);
  });
});

describe('保存（PUT）と提出', () => {
  const putItems = (extra) => json('PUT', '/invoice-editor/inv1', {
    updated_at: inv().updated_at, withholding_enabled: true,
    items: [
      { id: 'ex1', label: 'アートホテル撮影 ガソリン代', unit_price: 1641, ...extra },
      { id: 'mn1', label: '撮影補助', unit_price: 0, quantity: 1, manual_reason: '直接依頼' },
    ],
  });

  test('日付・支払先・状態を保存できる（日付は 2026/10/25 の形も可）。欠けていても下書き保存は通る', async () => {
    const r = await putItems({ expense_date: '2026/10/25', expense_payee: 'ENEOS ○○店', receipt_status: 'attached' });
    expect(r.status).toBe(200);
    expect(item('ex1')).toMatchObject({ expense_date: '2026-10-25', expense_payee: 'ENEOS ○○店', receipt_status: 'attached' });
    // 写真がまだ無いので注意は返る（保存は止めない）
    expect(r.body.issues.find(x => x.id === 'ex1').issues.map(i => i.code)).toEqual(['RECEIPT_FILE_MISSING']);
  });

  test('存在しない日付は 400', async () => {
    expect((await putItems({ expense_date: '2026-02-30' })).status).toBe(400);
  });

  test('送られてこなかった項目は消さない（古い画面のタブが保存しても入力済みの日付が残る）', async () => {
    Object.assign(item('ex1'), { expense_date: '2026-10-25', expense_payee: 'ENEOS', receipt_status: 'missing', receipt_missing_reason: '紛失' });
    expect((await putItems({})).status).toBe(200);
    expect(item('ex1')).toMatchObject({ expense_date: '2026-10-25', expense_payee: 'ENEOS', receipt_status: 'missing', receipt_missing_reason: '紛失' });
  });

  test('「領収書なし」に切り替えたら添付していた写真はゴミ箱へ・行からも外す（画面が見ていた写真と同じとき）', async () => {
    const up = await upload('ex1', JPEG);
    const r = await putItems({ receipt_file_id: up.body.receipt_file_id, expense_date: '2026-10-25', expense_payee: 'ENEOS', receipt_status: 'missing', receipt_missing_reason: 'レシートを紛失したため' });
    expect(r.status).toBe(200);
    expect(r.body.receipt_conflicts).toBeUndefined();
    expect(mockDrive.trashed).toEqual([up.body.receipt_file_id]);
    expect(item('ex1')).toMatchObject({ receipt_status: 'missing', receipt_file_id: null, receipt_missing_reason: 'レシートを紛失したため' });
  });

  test('古いタブ: PC が「領収書なし」→ スマホで写真を付けた → PC の古い自動保存が来ても写真は残る', async () => {
    // PC: 写真なしで「領収書なし」を保存（PC の画面が知っている領収書ファイルは無し）
    let r = await putItems({ receipt_file_id: null, expense_date: '2026-10-25', expense_payee: 'ENEOS', receipt_status: 'missing', receipt_missing_reason: '後で探す' });
    expect(r.status).toBe(200);
    expect(item('ex1')).toMatchObject({ receipt_status: 'missing', receipt_file_id: null });
    // スマホ: 写真を付ける（attached になり理由は消える）
    const up = await upload('ex1', JPEG);
    expect(item('ex1')).toMatchObject({ receipt_status: 'attached', receipt_file_id: up.body.receipt_file_id });
    // PC: 開いたままの古い画面が自動保存（領収書なし・ファイルは知らない）
    r = await putItems({ receipt_file_id: null, expense_date: '2026-10-25', expense_payee: 'ENEOS 本店', receipt_status: 'missing', receipt_missing_reason: '後で探す' });
    expect(r.status).toBe(200);
    expect(r.body.receipt_conflicts).toEqual(['ex1']);
    expect(r.body.receipt_conflict_message).toBe('別の画面で領収書が更新されています。再読み込みしてください');
    // 写真は残り、領収書欄は書かれない（日付・支払先はいつもどおり保存）
    expect(mockDrive.trashed).toEqual([]);
    expect(item('ex1')).toMatchObject({ receipt_status: 'attached', receipt_file_id: up.body.receipt_file_id, receipt_missing_reason: null, expense_payee: 'ENEOS 本店' });
  });

  test('写真がある行の状態を空（null）に戻す保存は無視する', async () => {
    const up = await upload('ex1', JPEG);
    const r = await putItems({ receipt_file_id: up.body.receipt_file_id, receipt_status: null });
    expect(r.status).toBe(200);
    expect(item('ex1')).toMatchObject({ receipt_status: 'attached', receipt_file_id: up.body.receipt_file_id });
    expect(mockDrive.trashed).toEqual([]);
  });

  test('読んだあとに写真が付け替えられていたら（条件付き更新が 0 件）書かずに知らせる', async () => {
    const up = await upload('ex1', JPEG);
    // 読み出したあと、保存の関数がロックを取る直前に、別の端末が写真を差し替えた状況を再現する
    mockRpcFake.before = (name) => {
      if (name === 'invoice_editor_save_draft') { item('ex1').receipt_file_id = 'drv-other'; mockRpcFake.before = null; }
    };
    const r = await putItems({ receipt_file_id: up.body.receipt_file_id, receipt_status: 'missing', receipt_missing_reason: 'x' });
    expect(r.status).toBe(200);
    expect(item('ex1').receipt_status).toBe('attached');
    expect(item('ex1').receipt_file_id).toBe('drv-other');
    expect(mockDrive.trashed).not.toContain('drv-other');
    expect(r.body.receipt_conflicts).toEqual(['ex1']);
  });

  test('立替経費の行を消したら写真もゴミ箱へ', async () => {
    const up = await upload('ex1', JPEG);
    const r = await json('PUT', '/invoice-editor/inv1', { updated_at: 't0', withholding_enabled: true, items: [{ id: 'mn1', label: '撮影補助', unit_price: 0, quantity: 1, manual_reason: '直接依頼' }] });
    expect(r.status).toBe(200);
    expect(item('ex1')).toBeUndefined();
    expect(mockDrive.trashed).toEqual([up.body.receipt_file_id]);
  });

  test('提出: 日付・支払先・領収書が欠けていれば 409（どの行かを返す）。そろえば通る', async () => {
    const ng = await json('POST', '/invoice-editor/inv1/submit', { expected_total: 1641, expected_payout: 1641, updated_at: 't0' });
    expect(ng.status).toBe(409);
    expect(ng.body.problems.filter(p => p.item_id === 'ex1').map(p => p.code).sort())
      .toEqual(['EXPENSE_DATE_MISSING', 'EXPENSE_PAYEE_MISSING', 'RECEIPT_STATUS_MISSING']);
    expect(inv().status).toBe('draft');

    Object.assign(item('ex1'), { expense_date: '2026-10-25', expense_payee: 'ENEOS ○○店', receipt_status: 'missing', receipt_missing_reason: '' });
    const ng2 = await json('POST', '/invoice-editor/inv1/submit', { expected_total: 1641, expected_payout: 1641, updated_at: 't0' });
    expect(ng2.body.problems.map(p => p.code)).toEqual(['RECEIPT_REASON_MISSING']);

    item('ex1').receipt_missing_reason = 'レシートを紛失したため';
    const ok = await json('POST', '/invoice-editor/inv1/submit', { expected_total: 1641, expected_payout: 1641, updated_at: 't0' });
    expect(ok.status).toBe(200);
    expect(inv().status).toBe('submitted');
  });

});

describe('請求書一覧（GET /invoices）: 本人以外の請求書は管理者だけ', () => {
  const ALL_RECEIPT = ['expense_date', 'expense_payee', 'receipt_status', 'receipt_missing_reason', 'receipt_file_id', 'receipt_file_name', 'receipt_mime_type'];
  beforeEach(() => {
    // 偽 DB は埋め込み（invoice_items(...)）を解決しないので、明細を請求書に直接持たせる
    inv().invoice_items = [{
      id: 'ex1', cost_type: 'expense', creative_id: null, label: 'ガソリン代', unit_price: 1641, expense_date: '2026-10-25',
      expense_payee: 'ENEOS ○○店', receipt_status: 'missing', receipt_missing_reason: '紛失', receipt_file_id: 'drv-9', receipt_file_name: 'a.jpg', receipt_mime_type: 'image/jpeg',
    }];
    mockDb.tables.invoices.push(
      { id: 'inv-u2', invoice_number: 'INV-202610-020', issuer_id: 'u2', status: 'draft', year: 2026, month: 10, invoice_type: 'member', invoice_items: [] },
      { id: 'inv-cl', invoice_number: 'CL-202610-001', issuer_id: 'admin1', status: 'draft', year: 2026, month: 10, invoice_type: 'client', invoice_items: [] },
    );
  });
  const ids = (r) => r.body.map(i => i.id).sort();
  const get = (q, user, headers = {}) => fetch(`${base}/invoices${q}`, { headers: { 'x-test-user': user, ...headers } })
    .then(async r => ({ status: r.status, body: await r.json() }));

  test('本人: 自分の請求書だけ（立替経費の項目もすべて返す）', async () => {
    const r = await get('?issuer_id=u1', 'u1');
    expect(r.status).toBe(200);
    expect(ids(r)).toEqual(['inv1']);
    expect(r.body[0].invoice_items[0]).toMatchObject({ expense_date: '2026-10-25', expense_payee: 'ENEOS ○○店', receipt_status: 'missing', receipt_missing_reason: '紛失', receipt_file_id: 'drv-9' });
  });

  test('管理者でない人: issuer_id を省いても・他人の id を指定しても、自分の分だけ（他人・クライアント請求書は出ない）', async () => {
    expect(ids(await get('', 'u2'))).toEqual(['inv-u2']);
    expect(ids(await get('?year=2026&month=10', 'u2'))).toEqual(['inv-u2']);
    const other = await get('?issuer_id=u1', 'u2');
    expect(other.status).toBe(200);
    expect(ids(other)).toEqual(['inv-u2']);
    expect(ids(await get('?issuer_id=admin1', 'u2'))).toEqual(['inv-u2']);
  });

  test('管理者・秘書: 全員分（クライアント請求書も）と、issuer_id 指定の絞り込み', async () => {
    for (const user of ['admin1', 'sec1']) {
      expect(ids(await get('?year=2026&month=10', user))).toEqual(['inv-cl', 'inv-u2', 'inv1']);
      const r = await get('?issuer_id=u1', user);
      expect(ids(r)).toEqual(['inv1']);
      expect(r.body[0].invoice_items[0]).toMatchObject({ expense_payee: 'ENEOS ○○店', receipt_file_id: 'drv-9' });
    }
  });

  test('VIEW AS: 最高管理者が一般メンバーを見ているあいだは自分の分だけ／管理者ロールのプレビューは全員分', async () => {
    expect(ids(await get('?year=2026&month=10', 'admin1', { 'x-view-as': 'editor' }))).toEqual(['inv-cl']);
    expect(ids(await get('?issuer_id=u1', 'admin1', { 'x-view-as': 'director' }))).toEqual(['inv-cl']);
    expect(ids(await get('?year=2026&month=10', 'admin1', { 'x-view-as': 'secretary' }))).toEqual(['inv-cl', 'inv-u2', 'inv1']);
  });

  test('VIEW AS で権限は上がらない（一般メンバーが X-View-As: admin を付けても自分の分だけ）', async () => {
    const r = await get('?issuer_id=u1', 'u2', { 'x-view-as': 'admin' });
    expect(ids(r)).toEqual(['inv-u2']);
    for (const it of r.body.flatMap(i => i.invoice_items || [])) for (const k of ALL_RECEIPT) expect(it).not.toHaveProperty(k);
  });

  test('権限設定に従う: invoice.all_view を付けたロールは全員分、外した秘書は自分の分だけ', async () => {
    mockDb.tables.role_permissions.push({ role: 'editor', permission_key: 'invoice.all_view', allowed: true, role_id: null, roles: null });
    mockDb.tables.role_permissions = mockDb.tables.role_permissions.filter(p => !(p.role === 'editor' && p.allowed === false));
    await require('../utils/roles').loadPermissionsByCode(true);
    expect(ids(await get('?year=2026&month=10', 'u2'))).toEqual(['inv-cl', 'inv-u2', 'inv1']);
    mockDb.tables.role_permissions = [{ role: 'secretary', permission_key: 'invoice.all_view', allowed: false, role_id: null, roles: null }];
    await require('../utils/roles').loadPermissionsByCode(true);
    expect(ids(await get('?year=2026&month=10', 'sec1'))).toEqual([]);
  });

  test('月タブの件数（GET /invoices/months）: 管理者でない人は自分の請求書の件数だけ', async () => {
    await require('../utils/roles').loadPermissionsByCode(true);
    const months = (user) => fetch(`${base}/invoices/months`, { headers: { 'x-test-user': user } }).then(r => r.json());
    expect((await months('u2')).map(m => m.count)).toEqual([1]);
    expect((await months('admin1')).map(m => m.count)).toEqual([3]);
    expect((await months('sec1')).map(m => m.count)).toEqual([3]);
  });
});

describe('請求書の削除', () => {
  test('下書きを消すと領収書もゴミ箱へ', async () => {
    const up = await upload('ex1', JPEG);
    const r = await json('DELETE', '/invoices/inv1');
    expect(r.status).toBe(200);
    expect(mockDrive.trashed).toContain(up.body.receipt_file_id);
    expect(mockDb.tables.invoices).toHaveLength(0);
  });
});

// 列が無い環境の再現は最後に置く（列の有無はプロセス内で 5 分覚えるため、後のテストに影響しないように）
describe('列が無い環境（migration 未適用）', () => {
  const putItems = (extra) => json('PUT', '/invoice-editor/inv1', {
    updated_at: inv().updated_at, withholding_enabled: true,
    items: [
      { id: 'ex1', label: 'アートホテル撮影 ガソリン代', unit_price: 1641, ...extra },
      { id: 'mn1', label: '撮影補助', unit_price: 0, quantity: 1, manual_reason: '直接依頼' },
    ],
  });
  test('請求書の詳細は、領収書の列と登録番号の列が両方無くても読める', async () => {
    mockDb.noReceiptCols = true;
    mockDb.noRegNo = true;
    const r = await json('GET', '/invoices/inv1', undefined, 'u1');
    expect(r.status).toBe(200);
    expect(r.body.id).toBe('inv1');
  });

  test('列が無い環境（migration 未適用）は 503 で止める', async () => {
    mockDb.noReceiptCols = true;
    const r = await upload('ex1', JPEG);
    expect(r.status).toBe(503);
    expect(r.body.code).toBe('RECEIPT_NOT_READY');
  });

  test('列が無い環境（migration 未適用）では従来どおり提出でき、PUT も落ちない', async () => {
    mockDb.noReceiptCols = true;
    // 列が無い DB では行に receipt_* が無い
    for (const k of Object.keys(item('ex1'))) if (/^(expense_date|expense_payee|receipt_)/.test(k)) delete item('ex1')[k];
    const put = await putItems({ expense_date: '2026-10-25', expense_payee: 'ENEOS', receipt_status: 'missing' });
    expect(put.status).toBe(200);
    const g = await json('GET', '/invoice-editor/inv1');
    expect(g.body.receipt_supported).toBe(false);
    const ok = await json('POST', '/invoice-editor/inv1/submit', { expected_total: 1641, expected_payout: 1641, updated_at: inv().updated_at });
    expect(ok.status).toBe(200);
  });
});
