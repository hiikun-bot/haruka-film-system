// クリエイティブのファイルが DB から消えたときに、Drive の「リンクを知っている全員」を外す（2026-11-24）結合テスト。
// supabase はメモリ上の偽 DB、Drive は偽物。
//   - DELETE /creatives/:cid/files/:fid（アップロード取り消し）
//   - DELETE /creatives（一括削除）: 別のクリエイティブ・クライアント確認 URL で使っているファイルは外さない
//   - DELETE /projects/:id（案件削除の連鎖）
//   - DB の削除に失敗したときは外さない
process.env.GOOGLE_SERVICE_ACCOUNT_KEY = JSON.stringify({ client_email: 'service-account', private_key: 'x' });
delete process.env.R2_PLAYBACK_ENABLED;
process.env.ENABLE_FASTSTART_AUTOGEN = 'off';
delete process.env.ERROR_REPORT_SLACK_CHANNEL_URL;

const mockDb = { tables: {} };
let mockSeq = 0;
function mockBuilder(table) {
  const st = { op: 'select', payload: null, filters: [], limit: null };
  const rowsOf = () => (mockDb.tables[table] || (mockDb.tables[table] = []));
  const match = (r) => st.filters.every(f => f(r));
  // "creatives.project_id" のような埋め込み先の列（creatives!inner）は creative_id から引く
  const valueOf = (r, k) => {
    if (!k.includes('.')) return r[k];
    const [t, col] = k.split('.');
    if (t === 'creatives') {
      const c = (mockDb.tables.creatives || []).find(x => x.id === r.creative_id);
      return c ? c[col] : undefined;
    }
    return undefined;
  };
  const run = () => {
    if (mockDb.fail && mockDb.fail(table, st.op)) return { data: null, error: { message: 'boom', code: 'XX000' } };
    if (st.op === 'insert') {
      const list = (Array.isArray(st.payload) ? st.payload : [st.payload]).map(p => ({ id: `new-${++mockSeq}`, ...p }));
      mockDb.tables[table] = rowsOf().concat(list);
      return { data: list.map(r => ({ ...r })), error: null };
    }
    if (st.op === 'update') {
      const hit = rowsOf().filter(match);
      hit.forEach(r => Object.assign(r, st.payload));
      return { data: hit.map(r => ({ ...r })), error: null };
    }
    if (st.op === 'delete') {
      const gone = rowsOf().filter(match).map(r => r.id);
      mockDb.tables[table] = rowsOf().filter(r => !match(r));
      // ON DELETE CASCADE の再現: projects → creatives → creative_files / 担当
      if (table === 'projects') {
        const goneCr = (mockDb.tables.creatives || []).filter(c => gone.includes(c.project_id)).map(c => c.id);
        mockDb.tables.creatives = (mockDb.tables.creatives || []).filter(c => !goneCr.includes(c.id));
        for (const t of ['creative_assignments', 'creative_files']) {
          mockDb.tables[t] = (mockDb.tables[t] || []).filter(r => !goneCr.includes(r.creative_id));
        }
      }
      if (table === 'creatives') {
        for (const t of ['creative_assignments', 'creative_files']) {
          mockDb.tables[t] = (mockDb.tables[t] || []).filter(r => !gone.includes(r.creative_id));
        }
      }
      return { data: null, error: null };
    }
    let rows = rowsOf().filter(match).map(r => ({ ...r }));
    if (st.limit != null) rows = rows.slice(0, st.limit);
    return { data: rows, error: null, count: rows.length };
  };
  const b = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'then') return (res, rej) => Promise.resolve(run()).then(res, rej);
      if (prop === 'select') return () => b;
      if (prop === 'insert') return (p) => { st.op = 'insert'; st.payload = p; return b; };
      if (prop === 'update') return (p) => { st.op = 'update'; st.payload = p; return b; };
      if (prop === 'delete') return () => { st.op = 'delete'; return b; };
      if (prop === 'eq') return (k, v) => { st.filters.push(r => valueOf(r, k) === v); return b; };
      if (prop === 'in') return (k, vs) => { st.filters.push(r => vs.includes(r[k])); return b; };
      if (prop === 'is') return (k, v) => { st.filters.push(r => (r[k] ?? null) === v); return b; };
      // or(): "<col>.in.(a,b)" / "<col>.ilike.*x*" の 2 形だけ解釈する
      if (prop === 'or') return (expr) => {
        const parts = String(expr).match(/[a-z_]+\.(?:in\.\([^)]*\)|ilike\.\*[^,]*\*)/g) || [];
        st.filters.push(r => parts.some(p => {
          const m1 = p.match(/^([a-z_]+)\.in\.\(([^)]*)\)$/);
          if (m1) return m1[2].split(',').includes(r[m1[1]]);
          const m2 = p.match(/^([a-z_]+)\.ilike\.\*(.*)\*$/);
          return m2 ? String(r[m2[1]] || '').toLowerCase().includes(m2[2].toLowerCase()) : false;
        }));
        return b;
      };
      if (prop === 'limit') return (n) => { st.limit = n; return b; };
      if (prop === 'single' || prop === 'maybeSingle') return async () => {
        const r = run();
        if (r.error) return r;
        return { ...r, data: Array.isArray(r.data) ? (r.data[0] || null) : r.data };
      };
      return () => b;
    },
  });
  return b;
}
jest.mock('../supabase', () => ({ from: (t) => mockBuilder(t), rpc: async () => ({ data: null, error: null }), storage: { from: () => ({}) } }));
jest.mock('../auth', () => {
  const pass = (req, _res, next) => { req.user = { id: req.headers['x-test-user'] || 'adm', role: req.headers['x-test-role'] || 'admin' }; next(); };
  return {
    requireAuth: pass, requireRole: () => pass, requireLevel: () => pass, requirePermission: () => pass,
    requireAnyPermission: () => pass, requireSuperAdmin: pass, isSuperAdminUser: () => false,
    userHasPermission: async () => true, getEffectiveRole: (req) => req.user.role,
    getEffectiveRoleCodes: async (req) => [req.user.role],
    invalidatePermissionsCache: () => {}, invalidateUserCache: () => {},
  };
});
jest.mock('../utils/roles', () => {
  const actual = jest.requireActual('../utils/roles');
  return { ...actual, roleCodesHavePermission: async (codes) => (codes || []).includes('admin') };
});

// 偽の Drive: 公開設定（anyone/reader）を持つファイルと、外した記録
const mockDrive = {
  perms: new Map(),     // fileId → permissions[]
  deleted: [],          // `${fileId}:${permissionId}`
  api: {
    files: {
      delete: async () => { const e = new Error('Insufficient permissions'); e.code = 403; throw e; }, // 共有ドライブで SA は消せない想定
      update: async () => ({ data: {} }),
      get: async ({ fileId }) => ({ data: { id: fileId } }),
      list: async () => ({ data: { files: [] } }),
    },
    permissions: {
      list: async ({ fileId }) => {
        if (!mockDrive.perms.has(fileId)) { const e = new Error('File not found'); e.code = 404; throw e; }
        return { data: { permissions: mockDrive.perms.get(fileId) } };
      },
      delete: async ({ fileId, permissionId }) => {
        mockDrive.deleted.push(`${fileId}:${permissionId}`);
        mockDrive.perms.set(fileId, (mockDrive.perms.get(fileId) || []).filter(p => p.id !== permissionId));
        return {};
      },
      create: async () => ({ data: {} }),
    },
  },
};
jest.mock('googleapis', () => ({
  google: {
    auth: { GoogleAuth: function GoogleAuth() { return { getClient: async () => ({ getAccessToken: async () => ({ token: 't' }) }) }; } },
    drive: () => mockDrive.api,
    sheets: () => ({}),
    docs: () => ({}),
  },
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

const call = (method, path, body) => fetch(`${base}${path}`, {
  method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
});
// 公開設定の解除は応答のあとに走る（投げっぱなし）ので、落ち着くまで待つ
const settle = async () => { for (let i = 0; i < 20; i += 1) await new Promise(r => setTimeout(r, 5)); };

const V1 = 'cr1Version1_0123456';
const V1_FAST = 'cr1Version1Fast_0123';
const V2 = 'cr1Version2_0123456';
const SHARED = 'sharedFile_01234567';
const REVIEW = 'reviewFile_01234567';
const P2_FILE = 'proj2File_012345678';
const DELIVERED = 'deliveredFile_012345';
const anyone = () => [{ id: 'anyoneWithLink', type: 'anyone', role: 'reader' }, { id: 'owner', type: 'user', role: 'owner' }];

const project = { director_id: 'dir', producer_id: 'prd', sub_director_ids: [], sub_producer_ids: [] };
beforeEach(() => {
  mockDb.fail = null;
  mockDrive.deleted = [];
  mockDrive.perms = new Map([V1, V1_FAST, V2, SHARED, REVIEW, P2_FILE, DELIVERED].map(id => [id, anyone()]));
  mockDb.tables = {
    projects: [{ id: 'p1', name: '案件1', client_id: 'c1', clients: { name: 'A' } }, { id: 'p2', name: '案件2', client_id: 'c1', clients: { name: 'A' } }],
    creatives: [
      { id: 'cr1', file_name: 'CR1', status: '制作中', project_id: 'p1', projects: project, client_review_url: null },
      { id: 'cr2', file_name: 'CR2', status: '制作中', project_id: 'p1', projects: project, client_review_url: null },
      { id: 'cr3', file_name: 'CR3', status: '制作中', project_id: 'p2', projects: project,
        client_review_url: `https://drive.google.com/file/d/${REVIEW}/view?usp=drivesdk` },
      { id: 'cr4', file_name: 'CR4', status: '制作中', project_id: 'p2', projects: project, client_review_url: null,
        delivery_url: `https://drive.google.com/file/d/${DELIVERED}/view` },   // 手で貼った納品リンク
    ],
    creative_files: [
      { id: 'f1', creative_id: 'cr1', version: 1, drive_file_id: V1, faststart_drive_file_id: V1_FAST },
      { id: 'f2', creative_id: 'cr1', version: 2, drive_file_id: V2 },
      { id: 'f3', creative_id: 'cr2', version: 1, drive_file_id: SHARED },
      { id: 'f4', creative_id: 'cr4', version: 1, drive_file_id: SHARED },   // 同じファイルを別のクリエイティブでも使っている
      { id: 'f5', creative_id: 'cr2', version: 2, drive_file_id: REVIEW },   // cr3 のクライアント確認 URL が同じファイル
      { id: 'f6', creative_id: 'cr4', version: 2, drive_file_id: P2_FILE },
      { id: 'f7', creative_id: 'cr1', version: 3, drive_file_id: DELIVERED },   // cr4 の納品リンクが同じファイル
    ],
    creative_assignments: [],
    creative_version_history: [],
    invoice_items: [],
    invoices: [],
    creative_deletion_logs: [],
    project_deletion_logs: [],
    users: [],
    teams: [],
  };
});

describe('DELETE /creatives/:cid/files/:fid（アップロード取り消し）', () => {
  test('Drive のファイルを消せなくても、原本と高速化版の「リンクを知っている全員」を外す', async () => {
    mockDb.tables.creative_files = mockDb.tables.creative_files.filter(f => f.id !== 'f2');   // v1 を最新にする
    const r = await call('DELETE', '/creatives/cr1/files/f1');
    expect(r.status).toBe(200);
    await settle();
    expect(mockDrive.deleted.sort()).toEqual([`${V1}:anyoneWithLink`, `${V1_FAST}:anyoneWithLink`].sort());
  });

  test('Drive のファイルを消せたときは外す必要が無いので触らない', async () => {
    mockDb.tables.creative_files = mockDb.tables.creative_files.filter(f => f.id !== 'f2');
    const orig = mockDrive.api.files.delete;
    mockDrive.api.files.delete = async () => ({});
    try {
      const r = await call('DELETE', '/creatives/cr1/files/f1');
      expect(r.status).toBe(200);
      await settle();
      expect(mockDrive.deleted).toEqual([]);
    } finally { mockDrive.api.files.delete = orig; }
  });

  test('提出済みなどで取り消せないときは外さない', async () => {
    mockDb.tables.creative_files = mockDb.tables.creative_files.filter(f => f.id !== 'f2');
    mockDb.tables.creative_version_history = [{ id: 'h1', creative_id: 'cr1', version_num: 1 }];   // v1 は提出済み
    const r = await call('DELETE', '/creatives/cr1/files/f1');
    expect(r.status).toBe(409);
    await settle();
    expect(mockDrive.deleted).toEqual([]);
  });
});

describe('DELETE /creatives（一括削除）', () => {
  test('消えたファイルだけ外し、別のクリエイティブ・クライアント確認 URL で使っているファイルは残す', async () => {
    const r = await call('DELETE', '/creatives', { ids: ['cr1', 'cr2'] });
    expect(r.status).toBe(200);
    await settle();
    expect(mockDrive.deleted.sort()).toEqual([V1, V1_FAST, V2].map(id => `${id}:anyoneWithLink`).sort());
    // 持ち主の権限には触らない
    expect(mockDrive.perms.get(V1)).toEqual([{ id: 'owner', type: 'user', role: 'owner' }]);
  });

  test('DB の削除に失敗したら外さない', async () => {
    mockDb.fail = (table, op) => table === 'creatives' && op === 'delete';
    const r = await call('DELETE', '/creatives', { ids: ['cr1'] });
    expect(r.status).toBe(500);
    await settle();
    expect(mockDrive.deleted).toEqual([]);
  });
});

describe('DELETE /projects/:id（案件削除で連鎖して消えるファイル）', () => {
  test('案件のファイルを外す（ほかの案件で使っているファイルは残す）', async () => {
    const r = await call('DELETE', '/projects/p1', { reason: 'テスト削除' });
    expect(r.status).toBe(200);
    await settle();
    // SHARED は p2 の cr4、REVIEW は p2 の cr3 のクライアント確認 URL で使っている
    expect(mockDrive.deleted.sort()).toEqual([V1, V1_FAST, V2].map(id => `${id}:anyoneWithLink`).sort());
  });

  test('案件の削除に失敗したら外さない', async () => {
    mockDb.fail = (table, op) => table === 'projects' && op === 'delete';
    const r = await call('DELETE', '/projects/p1', { reason: 'テスト削除' });
    expect(r.status).toBe(500);
    await settle();
    expect(mockDrive.deleted).toEqual([]);
  });
});
