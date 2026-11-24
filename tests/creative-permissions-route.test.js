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
    // 失敗の注入: mockDb.fail(table, op) が真なら DB エラーを返す（何も書かない）
    if (mockDb.fail && mockDb.fail(table, st.op)) return { data: null, error: { message: mockDb.failMessage || 'boom', code: mockDb.failCode || 'XX000' } };
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
      // creatives(id) ON DELETE CASCADE の再現（担当・ファイル）
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
  mockDb.fail = null;
  mockDb.failCode = null;
  mockDb.failMessage = null;
  mockDb.tables = {
    creatives: [
      { id: 'cr1', file_name: 'CR1', status: '制作中', project_id: 'p1', team_id: null, projects: project },
      { id: 'cr2', file_name: 'CR2', status: '納品', delivered_at: '2026-11-01T00:00:00Z', project_id: 'p1', team_id: null, projects: project },
    ],
    creative_assignments: [
      { id: 'a1', creative_id: 'cr1', user_id: 'ed', role: 'editor', rank_applied: 'C' },
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

describe('PUT /creatives/:id の担当行は差分だけ書く（#1327 追加レビュー）', () => {
  const asn = () => mockDb.tables.creative_assignments.filter(a => a.creative_id === 'cr1');
  test('担当者を変えていない保存では担当行を作り直さない（行 ID・保存時のランクを保つ）', async () => {
    mockDb.tables.creative_assignments.push({ id: 'd1', creative_id: 'cr1', user_id: 'dir', role: 'director', rank_applied: 'B' });
    const r = await call('PUT', '/creatives/cr1', DIRECTOR, { assignee_id: 'ed', director_user_ids: ['dir'], producer_user_ids: [], note: 'x' });
    expect(r.status).toBe(200);
    expect(asn().find(a => a.id === 'a1')).toMatchObject({ user_id: 'ed', role: 'editor', rank_applied: 'C' }); // users.rank は B だが変えない
    expect(asn().find(a => a.id === 'd1')).toMatchObject({ rank_applied: 'B' });
    expect(asn()).toHaveLength(2);
  });
  test('前後に空白のある同じ ID は「変更なし」（403 にもならず、書き込みもしない）', async () => {
    const r = await call('PUT', '/creatives/cr1', OTHER_DIRECTOR, { assignee_id: ' ed ', note: 'y' });
    expect(r.status).toBe(200);
    expect(asn().find(a => a.id === 'a1')).toBeTruthy();
  });
  test('Dチェック担当の追加は足した人だけ。残る人の行とランクはそのまま', async () => {
    mockDb.tables.creative_assignments.push({ id: 'd1', creative_id: 'cr1', user_id: 'dir', role: 'director', rank_applied: 'B' });
    const r = await call('PUT', '/creatives/cr1', DIRECTOR, { director_user_ids: ['dir', 'dir2'] });
    expect(r.status).toBe(200);
    const dirs = asn().filter(a => a.role === 'director');
    expect(dirs.find(a => a.id === 'd1')).toMatchObject({ rank_applied: 'B' });
    expect(dirs.map(a => a.user_id).sort()).toEqual(['dir', 'dir2']);
  });
  test('担当者の付け替えで登録に失敗しても、旧担当は消えない', async () => {
    mockDb.fail = (t, op) => t === 'creative_assignments' && op === 'insert';
    const r = await call('PUT', '/creatives/cr1', DIRECTOR, { assignee_id: 'ed2', note: 'z' });
    expect(r.status).toBe(500); // 成功に見せない（本体の更新は済んでいる）
    expect((await r.json()).partial).toBe(true);
    expect(mockDb.tables.creatives[0].note).toBe('z');
    expect(asn().filter(a => a.role === 'editor').map(a => a.user_id)).toEqual(['ed']);
  });
  test('ランクが読めなければ担当行を書かない（ランク空の行で置き換えない）', async () => {
    mockDb.fail = (t, op) => t === 'users' && op === 'select';
    const r = await call('PUT', '/creatives/cr1', DIRECTOR, { assignee_id: 'ed2' });
    expect(r.status).toBe(500);
    expect(asn().filter(a => a.role === 'editor')).toEqual([expect.objectContaining({ id: 'a1', user_id: 'ed', rank_applied: 'C' })]);
  });
  test('大文字の UUID でも同じ人なら変更なし', async () => {
    const U = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    mockDb.tables.creative_assignments.push({ id: 'd9', creative_id: 'cr1', user_id: U, role: 'director', rank_applied: 'B' });
    const r = await call('PUT', '/creatives/cr1', OTHER_DIRECTOR, { director_user_ids: [U.toUpperCase()], note: 'w' });
    expect(r.status).toBe(200);
    expect(asn().find(a => a.id === 'd9')).toMatchObject({ rank_applied: 'B' });
  });
  test('付け替えが成功したら旧担当の行だけ外れる', async () => {
    const r = await call('PUT', '/creatives/cr1', DIRECTOR, { assignee_id: 'ed2' });
    expect(r.status).toBe(200);
    const eds = asn().filter(a => a.role === 'editor');
    expect(eds.map(a => a.user_id)).toEqual(['ed2']);
    expect(eds[0].rank_applied).toBe('C');
  });
});

describe('DELETE /creatives は本体を 1 文で消し、関連行は CASCADE に任せる（#1327 追加レビュー）', () => {
  test('成功すると本体と担当・ファイルが一緒に消え、削除ログが残る', async () => {
    mockDb.tables.creative_files = [{ id: 'f1', creative_id: 'cr1' }];
    const r = await call('DELETE', '/creatives', ADMIN, { ids: ['cr1'] });
    expect(r.status).toBe(200);
    expect(creativeIds()).toEqual(['cr2']);
    expect(mockDb.tables.creative_assignments.some(a => a.creative_id === 'cr1')).toBe(false);
    expect(mockDb.tables.creative_files).toEqual([]);
    expect(mockDb.tables.creative_deletion_logs.map(l => l.creative_id)).toEqual(['cr1']);
  });
  test('本体の削除に失敗したら、担当もファイルも残り、削除ログも取り消す', async () => {
    mockDb.tables.creative_files = [{ id: 'f1', creative_id: 'cr1' }];
    mockDb.fail = (t, op) => t === 'creatives' && op === 'delete';
    const r = await call('DELETE', '/creatives', ADMIN, { ids: ['cr1'] });
    expect(r.status).toBe(500);
    expect(creativeIds()).toEqual(['cr1', 'cr2']);
    expect(mockDb.tables.creative_assignments.find(a => a.id === 'a1')).toBeTruthy();
    expect(mockDb.tables.creative_files).toHaveLength(1);
    expect(mockDb.tables.creative_deletion_logs).toEqual([]);
  });
  test('FK が CASCADE でない環境は従来の順で消す。途中で失敗したら削除ログは残し「一部だけ削除」と返す', async () => {
    mockDb.tables.creative_files = [{ id: 'f1', creative_id: 'cr1' }];
    mockDb.failCode = '23503';
    mockDb.failMessage = 'update or delete on table "creatives" violates foreign key constraint "creative_files_creative_id_fkey" on table "creative_files"';
    mockDb.fail = (t, op) => (t === 'creatives' && op === 'delete') || (t === 'creative_assignments' && op === 'delete');
    const r = await call('DELETE', '/creatives', ADMIN, { ids: ['cr1'] });
    expect(r.status).toBe(500);
    expect((await r.json()).partial).toBe(true);
    expect(mockDb.tables.creative_files).toEqual([]);
    expect(mockDb.tables.creative_deletion_logs.map(l => l.creative_id)).toEqual(['cr1']);
  });
  test('ファイル情報が読めなければ何もしない', async () => {
    mockDb.fail = (t, op) => t === 'creative_files' && op === 'select';
    const r = await call('DELETE', '/creatives', ADMIN, { ids: ['cr1'] });
    expect(r.status).toBe(500);
    expect(creativeIds()).toEqual(['cr1', 'cr2']);
    expect(mockDb.tables.creative_deletion_logs).toEqual([]);
  });
});

describe('制作担当（担当者の欄）は同じ人を 2 行にしない（designer＋editor の二重・2026-11-24）', () => {
  const workers = () => mockDb.tables.creative_assignments
    .filter(a => a.creative_id === 'cr1' && ['editor', 'designer', 'director_as_editor'].includes(a.role));
  beforeEach(() => {
    // cr1 はデザイナー（designer 行）の作品
    mockDb.tables.creative_assignments = [{ id: 'g1', creative_id: 'cr1', user_id: 'ed', role: 'designer', rank_applied: 'C' }];
  });
  test('デザイナー本人が assignee_id として送られても editor 行を足さない（変更なし）', async () => {
    for (const h of [ADMIN, DIRECTOR, EDITOR]) {
      const r = await call('PUT', '/creatives/cr1', h, { assignee_id: 'ed', note: 'n' });
      expect(r.status).toBe(200);
    }
    expect(workers()).toEqual([expect.objectContaining({ id: 'g1', user_id: 'ed', role: 'designer', rank_applied: 'C' })]);
  });
  test('別の人に替えると、制作担当は 1 人だけ（役割 designer を引き継ぐ）', async () => {
    const r = await call('PUT', '/creatives/cr1', DIRECTOR, { assignee_id: 'ed2' });
    expect(r.status).toBe(200);
    expect(workers()).toEqual([expect.objectContaining({ user_id: 'ed2', role: 'designer', rank_applied: 'C' })]);
  });
  test('担当外の人は同じ人を送っても 403 にならない（変更なし）が、別の人へは 403', async () => {
    const r = await call('PUT', '/creatives/cr1', OTHER_DIRECTOR, { assignee_id: 'ed', note: 'm' });
    expect(r.status).toBe(200);
    const r2 = await call('PUT', '/creatives/cr1', OTHER_DIRECTOR, { assignee_id: 'ed2' });
    expect(r2.status).toBe(403);
    expect(workers().map(a => a.id)).toEqual(['g1']);
  });
  test('POST /creatives/:id/assignments: 同じ人を別の制作ロール（editor）で足すのは 409', async () => {
    const r = await call('POST', '/creatives/cr1/assignments', ADMIN, { user_id: 'ed', role: 'editor' });
    expect(r.status).toBe(409);
    expect(workers()).toHaveLength(1);
    // 制作以外の役割（Wチェック等）は今までどおり足せる
    const r2 = await call('POST', '/creatives/cr1/assignments', ADMIN, { user_id: 'ed', role: 'wcheck' });
    expect(r2.status).toBe(200);
  });
});

describe('GET /creatives/:id の perm（画面の出し分け・サーバーの判定と同じ条件）', () => {
  // 偽 DB は embed を再現しないので、詳細の creative_assignments を creatives 行に載せておく（本番は PostgREST の embed）
  beforeEach(() => {
    for (const c of mockDb.tables.creatives) {
      c.creative_assignments = mockDb.tables.creative_assignments
        .filter(a => a.creative_id === c.id).map(a => ({ id: a.id, user_id: a.user_id, role: a.role, users: { id: a.user_id } }));
    }
  });
  const permOf = async (h, id = 'cr1') => {
    const r = await call('GET', `/creatives/${id}`, h);
    expect(r.status).toBe(200);
    return (await r.json()).perm;
  };
  test('admin: 全部できる', async () => {
    expect(await permOf(ADMIN)).toEqual({ can_edit: true, can_edit_assignees: true, can_delete: true });
  });
  test('案件の担当 D: 全部できる（納品済みも削除できる）', async () => {
    expect(await permOf(DIRECTOR, 'cr2')).toEqual({ can_edit: true, can_edit_assignees: true, can_delete: true });
  });
  test('担当の編集者: 編集・担当者の欄は出る。削除は納品前だけ', async () => {
    expect(await permOf(EDITOR)).toEqual({ can_edit: true, can_edit_assignees: true, can_delete: true });
    expect(await permOf(EDITOR, 'cr2')).toEqual({ can_edit: true, can_edit_assignees: true, can_delete: false });
  });
  test('担当外の editor・director: どれも出さない', async () => {
    for (const h of [OUTSIDER, OTHER_DIRECTOR]) {
      expect(await permOf(h)).toEqual({ can_edit: false, can_edit_assignees: false, can_delete: false });
    }
  });
});
