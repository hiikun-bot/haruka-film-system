// クリエイティブの削除・担当者の変更・素材フォルダURL の権限（ADR 015）の結合テスト。
// supabase はメモリ上の偽 DB。ロールは admin / director / editor の 3 つで確かめる。
//   - DELETE /creatives: 全件の権限確認が取れたときだけ消す（見つからない id・権限の無い対象が混ざれば何も消さない）
//   - POST /creatives/:id/assignments・DELETE /assignments/:id・PUT /creatives/:id の担当者変更: 担当外の人は不可
//   - PUT /creatives/:id の material_folder_url: クリエイティブを編集できる人だけ
delete process.env.GOOGLE_SERVICE_ACCOUNT_KEY;

const mockDb = { tables: {} };
let mockSeq = 0;
function mockBuilder(table) {
  const st = { op: 'select', payload: null, filters: [], limit: null };
  const rowsOf = () => (mockDb.tables[table] || (mockDb.tables[table] = []));
  const match = (r) => st.filters.every(f => f(r));
  const run = () => {
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
      mockDb.tables[table] = rowsOf().filter(r => !match(r));
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
      if (prop === 'eq') return (k, v) => { st.filters.push(r => r[k] === v); return b; };
      if (prop === 'in') return (k, vs) => { st.filters.push(r => vs.includes(r[k])); return b; };
      if (prop === 'is') return (k, v) => { st.filters.push(r => (r[k] ?? null) === v); return b; };
      if (prop === 'limit') return (n) => { st.limit = n; return b; };
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
// ヘッダ x-test-user（ユーザー ID）と x-test-role（実効ロール）でログイン中の人を切り替える
jest.mock('../auth', () => {
  const pass = (req, _res, next) => {
    req.user = { id: req.headers['x-test-user'] || 'u1', role: req.headers['x-test-role'] || 'editor' };
    next();
  };
  return {
    requireAuth: pass, requireRole: () => pass, requireLevel: () => pass, requirePermission: () => pass,
    requireAnyPermission: () => pass, requireSuperAdmin: pass, isSuperAdminUser: () => false,
    userHasPermission: async () => false, getEffectiveRole: (req) => req.user.role,
    getEffectiveRoleCodes: async (req) => [req.user.role],
    invalidatePermissionsCache: () => {}, invalidateUserCache: () => {},
  };
});
// 既定のシード（supabase_schema.sql）どおり: project.delete / project.create_edit は admin・秘書・P 層だけ
jest.mock('../utils/roles', () => {
  const actual = jest.requireActual('../utils/roles');
  const GRANTS = {
    'project.delete': ['admin', 'secretary', 'producer', 'producer_director'],
    'project.create_edit': ['admin', 'secretary', 'producer', 'producer_director'],
  };
  return {
    ...actual,
    roleCodesHavePermission: async (codes, key) => (codes || []).some(c => (GRANTS[key] || []).includes(c)),
  };
});

const express = require('express');
let server; let base;
beforeAll(async () => {
  const app = express(); app.use(express.json());
  app.use('/api', require('../routes/haruka'));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api`;
});
afterAll(() => server && server.close());

const ADMIN = { 'x-test-user': 'adm', 'x-test-role': 'admin' };
const DIRECTOR = { 'x-test-user': 'dir', 'x-test-role': 'director' };       // 案件 p1 の担当 D
const OTHER_DIRECTOR = { 'x-test-user': 'dir2', 'x-test-role': 'director' }; // 担当外の D
const EDITOR = { 'x-test-user': 'ed', 'x-test-role': 'editor' };            // cr1 の担当編集者
const OUTSIDER = { 'x-test-user': 'ed2', 'x-test-role': 'editor' };         // 担当外の編集者

const project = { director_id: 'dir', producer_id: 'prd', sub_director_ids: [], sub_producer_ids: [] };
const FOLDER = 'https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrStUvWxYz012345';

beforeEach(() => {
  mockDb.tables = {
    creatives: [
      { id: 'cr1', file_name: 'CR1', status: '制作中', project_id: 'p1', team_id: null, projects: project },
      { id: 'cr2', file_name: 'CR2', status: '納品', delivered_at: '2026-11-01T00:00:00Z', project_id: 'p1', team_id: null, projects: project },
    ],
    creative_assignments: [
      { id: 'a1', creative_id: 'cr1', user_id: 'ed', role: 'editor' },
      { id: 'a2', creative_id: 'cr2', user_id: 'ed', role: 'editor' },
    ],
    creative_files: [],
    invoice_items: [],
    creative_deletion_logs: [],
    users: [{ id: 'ed', rank: 'B' }, { id: 'ed2', rank: 'C' }, { id: 'dir', rank: 'A' }, { id: 'dir2', rank: 'A' }],
    teams: [],
  };
});

const call = (method, path, headers, body) => fetch(`${base}${path}`, {
  method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined,
});
const creativeIds = () => mockDb.tables.creatives.map(c => c.id).sort();

describe('DELETE /creatives（一括削除は全件の確認が取れたときだけ）', () => {
  test('admin: 全件見つかれば消せる', async () => {
    const r = await call('DELETE', '/creatives', ADMIN, { ids: ['cr1', 'cr2'] });
    expect(r.status).toBe(200);
    expect(creativeIds()).toEqual([]);
  });
  test('admin でも見つからない id が混ざれば 404 で何も消さない', async () => {
    const r = await call('DELETE', '/creatives', ADMIN, { ids: ['cr1', 'nope'] });
    expect(r.status).toBe(404);
    expect(creativeIds()).toEqual(['cr1', 'cr2']);
  });
  test('director（案件の担当 D）: 納品済みも消せる', async () => {
    const r = await call('DELETE', '/creatives', DIRECTOR, { ids: ['cr1', 'cr2'] });
    expect(r.status).toBe(200);
    expect(creativeIds()).toEqual([]);
  });
  test('director（担当外）: 403 で何も消さない', async () => {
    const r = await call('DELETE', '/creatives', OTHER_DIRECTOR, { ids: ['cr1'] });
    expect(r.status).toBe(403);
    expect(creativeIds()).toEqual(['cr1', 'cr2']);
  });
  test('editor（担当）: 納品前は消せるが、納品済みが混ざれば 403 で何も消さない', async () => {
    const r1 = await call('DELETE', '/creatives', EDITOR, { ids: ['cr1', 'cr2'] });
    expect(r1.status).toBe(403);
    expect(creativeIds()).toEqual(['cr1', 'cr2']);
    const r2 = await call('DELETE', '/creatives', EDITOR, { ids: ['cr1'] });
    expect(r2.status).toBe(200);
    expect(creativeIds()).toEqual(['cr2']);
  });
  test('editor（担当）: 見つからない id が混ざれば 404 で何も消さない', async () => {
    const r = await call('DELETE', '/creatives', EDITOR, { ids: ['cr1', 'nope'] });
    expect(r.status).toBe(404);
    expect(creativeIds()).toEqual(['cr1', 'cr2']);
  });
  test('ids に文字列以外が混ざれば 400 で何も消さない', async () => {
    const r = await call('DELETE', '/creatives', ADMIN, { ids: ['cr1', { id: 'cr2' }] });
    expect(r.status).toBe(400);
    expect(creativeIds()).toEqual(['cr1', 'cr2']);
  });
});

describe('担当者の変更（自分を担当に足してから削除する抜け道を塞ぐ）', () => {
  test('editor（担当外）: POST /creatives/:id/assignments で自分を足せない → その後の削除も 403', async () => {
    const r = await call('POST', '/creatives/cr1/assignments', OUTSIDER, { user_id: 'ed2', role: 'editor' });
    expect(r.status).toBe(403);
    expect(mockDb.tables.creative_assignments.some(a => a.user_id === 'ed2')).toBe(false);
    const d = await call('DELETE', '/creatives', OUTSIDER, { ids: ['cr1'] });
    expect(d.status).toBe(403);
  });
  test('editor（担当外）: PUT /creatives/:id の assignee_id で自分を担当にできない', async () => {
    const r = await call('PUT', '/creatives/cr1', OUTSIDER, { assignee_id: 'ed2' });
    expect(r.status).toBe(403);
    expect(mockDb.tables.creative_assignments.find(a => a.id === 'a1')).toBeTruthy();
  });
  test('editor（担当）: 自分を Dチェック担当に足せない（納品後も消せる立場になるため）', async () => {
    const r = await call('PUT', '/creatives/cr1', EDITOR, { director_user_ids: ['ed'] });
    expect(r.status).toBe(403);
    expect(mockDb.tables.creative_assignments.some(a => a.user_id === 'ed' && a.role === 'director')).toBe(false);
  });
  test('editor（担当）: Dチェック依頼先（他の人）は今までどおり指定できる', async () => {
    const r = await call('PUT', '/creatives/cr1', EDITOR, { director_user_ids: ['dir'] });
    expect(r.status).toBe(200);
    expect(mockDb.tables.creative_assignments.some(a => a.creative_id === 'cr1' && a.user_id === 'dir' && a.role === 'director')).toBe(true);
  });
  test('director（担当外）: 担当者を変えられない', async () => {
    const r = await call('PUT', '/creatives/cr1', OTHER_DIRECTOR, { assignee_id: 'ed2' });
    expect(r.status).toBe(403);
    const r2 = await call('DELETE', '/assignments/a1', OTHER_DIRECTOR);
    expect(r2.status).toBe(403);
    expect(mockDb.tables.creative_assignments.find(a => a.id === 'a1')).toBeTruthy();
  });
  test('director（案件の担当 D）: 担当者を付け替えられる', async () => {
    const r = await call('PUT', '/creatives/cr1', DIRECTOR, { assignee_id: 'ed2' });
    expect(r.status).toBe(200);
    const editors = mockDb.tables.creative_assignments.filter(a => a.creative_id === 'cr1' && a.role === 'editor');
    expect(editors.map(a => a.user_id)).toEqual(['ed2']);
  });
  test('admin: POST で誰でも足せる・DELETE で外せる', async () => {
    const r = await call('POST', '/creatives/cr1/assignments', ADMIN, { user_id: 'ed2', role: 'editor' });
    expect(r.status).toBe(200);
    const r2 = await call('DELETE', '/assignments/a1', ADMIN);
    expect(r2.status).toBe(200);
    expect(mockDb.tables.creative_assignments.find(a => a.id === 'a1')).toBeFalsy();
  });
  test('チームのリーダー（担当外の director）は担当者を決められる', async () => {
    mockDb.tables.teams = [{ id: 't1', director_id: 'dir2', producer_id: null }];
    mockDb.tables.creatives[0].team_id = 't1';
    const r = await call('PUT', '/creatives/cr1', OTHER_DIRECTOR, { assignee_id: 'ed2' });
    expect(r.status).toBe(200);
  });
  test('既に無い担当行の DELETE は成功扱い（ダブルクリック等）', async () => {
    const r = await call('DELETE', '/assignments/nope', OUTSIDER);
    expect(r.status).toBe(200);
  });
  test('editor（担当）: role=producer_director で自分を足す抜け道も 403。知らない role は 400', async () => {
    const r = await call('POST', '/creatives/cr2/assignments', EDITOR, { user_id: 'ed', role: 'producer_director' });
    expect(r.status).toBe(403);
    const r2 = await call('POST', '/creatives/cr2/assignments', ADMIN, { user_id: 'ed', role: 'boss' });
    expect(r2.status).toBe(400);
    const d = await call('DELETE', '/creatives', EDITOR, { ids: ['cr2'] });
    expect(d.status).toBe(403);
  });
  test('同じ人・同じ役割の二重登録は 409。ランクは画面の値ではなくメンバーのランク', async () => {
    const r = await call('POST', '/creatives/cr1/assignments', ADMIN, { user_id: 'ed', role: 'editor' });
    expect(r.status).toBe(409);
    const r2 = await call('POST', '/creatives/cr1/assignments', ADMIN, { user_id: 'ed2', role: 'designer', rank_applied: 'S' });
    expect(r2.status).toBe(200);
    expect(mockDb.tables.creative_assignments.find(a => a.user_id === 'ed2').rank_applied).toBe('C');
  });
  test('Wチェック担当が自分を制作担当にする付け替えは 403', async () => {
    mockDb.tables.creative_assignments.push({ id: 'a3', creative_id: 'cr1', user_id: 'ed2', role: 'wcheck' });
    const r = await call('PUT', '/creatives/cr1', OUTSIDER, { assignee_id: 'ed2' });
    expect(r.status).toBe(403);
    expect(mockDb.tables.creative_assignments.find(a => a.id === 'a1')).toBeTruthy();
  });
  test('担当外の director: 担当者が変わらない保存（同じ assignee_id・空の producer_user_ids）は今までどおり通る', async () => {
    const r = await call('PUT', '/creatives/cr1', OTHER_DIRECTOR, { assignee_id: 'ed', producer_user_ids: [], note: 'メモ' });
    expect(r.status).toBe(200);
    expect(mockDb.tables.creatives[0].note).toBe('メモ');
  });
  test('チームのリーダーでも、担当外のクリエイティブを自分のチームへ付け替えることはできない', async () => {
    mockDb.tables.teams = [{ id: 't9', director_id: 'dir2', producer_id: null }];
    const r = await call('PUT', '/creatives/cr1', OTHER_DIRECTOR, { team_id: 't9' });
    expect(r.status).toBe(403);
    expect(mockDb.tables.creatives[0].team_id).toBeNull();
  });
});

describe('PUT /creatives/:id の素材フォルダURL（クリエイティブを編集できる人だけ）', () => {
  test('admin・担当 D・担当編集者は保存できる', async () => {
    for (const h of [ADMIN, DIRECTOR, EDITOR]) {
      const r = await call('PUT', '/creatives/cr1', h, { material_folder_url: FOLDER });
      expect(r.status).toBe(200);
    }
    expect(mockDb.tables.creatives[0].material_folder_url).toBe(FOLDER);
  });
  test('担当外の editor・director は 403 で保存されない', async () => {
    for (const h of [OUTSIDER, OTHER_DIRECTOR]) {
      const r = await call('PUT', '/creatives/cr1', h, { material_folder_url: FOLDER });
      expect(r.status).toBe(403);
    }
    expect(mockDb.tables.creatives[0].material_folder_url).toBeUndefined();
  });
  test('存在しないクリエイティブは 404', async () => {
    const r = await call('PUT', '/creatives/nope', OUTSIDER, { material_folder_url: FOLDER });
    expect(r.status).toBe(404);
  });
});
