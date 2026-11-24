// 素材広場（/api/admin/video-organization-test）の「ファイル ID だけで Drive から中継する入口」を塞いだ（2026-11-24）結合テスト。
//   - GET /download/:fileId・GET /preview/:fileId: 素材広場に登録された素材だけ配信。登録の無い ID は 404 で Drive から読まない
//   - POST /register（既存 Drive ID の取り込み）: 管理者だけ
//   - POST /upload-session/:id/complete: そのセッションで直送したファイル（アップロード先フォルダ・セッション後の作成）だけ登録
process.env.ENABLE_VIDEO_ORGANIZATION_TEST = 'true';

const mockDb = { tables: {} };
let mockSeq = 0;
function mockBuilder(table) {
  const st = { op: 'select', payload: null, filters: [] };
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
    return { data: rowsOf().filter(match).map(r => ({ ...r })), error: null };
  };
  const b = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'then') return (res, rej) => Promise.resolve(run()).then(res, rej);
      if (prop === 'insert') return (p) => { st.op = 'insert'; st.payload = p; return b; };
      if (prop === 'update') return (p) => { st.op = 'update'; st.payload = p; return b; };
      if (prop === 'eq') return (k, v) => { st.filters.push(r => r[k] === v); return b; };
      if (prop === 'single' || prop === 'maybeSingle') return async () => {
        const r = run();
        return { ...r, data: Array.isArray(r.data) ? (r.data[0] || null) : r.data };
      };
      return () => b;
    },
  });
  return b;
}
jest.mock('../supabase', () => ({ from: (t) => mockBuilder(t) }));
// x-test-role で実効ロールを切り替える。requireRole は本物と同じく「許可ロールに無ければ 403」
jest.mock('../auth', () => {
  const who = (req) => ({ id: req.headers['x-test-user'] || 'u1', role: req.headers['x-test-role'] || 'editor' });
  return {
    requireAuth: (req, _res, next) => { req.user = who(req); next(); },
    requireRole: (...roles) => (req, res, next) => (roles.includes(who(req).role) ? next() : res.status(403).json({ error: 'forbidden' })),
    getEffectiveRoleCodes: async (req) => [who(req).role],
  };
});
jest.mock('../lib/video-organization/project-folder', () => ({
  resolveProjectFolder: async () => ({ folderId: 'f-project' }), sanitizeFolderName: (s) => s,
}));

// 偽の Drive（素材広場の Drive ヘルパごと差し替え）
const mockDrive = { files: new Map(), read: [] };
jest.mock('../lib/video-organization/drive', () => ({
  getDriveService: async () => ({
    permissions: { list: async () => ({ data: { permissions: [] } }) },
  }),
  getFileStream: async (fileId) => {
    mockDrive.read.push(fileId);
    if (!mockDrive.files.has(fileId)) { const e = new Error('not found'); e.code = 404; throw e; }
    return { stream: require('stream').Readable.from([Buffer.from('data')]), status: 200, headers: { 'content-type': 'video/mp4' } };
  },
  getVideoFileMeta: async (fileId) => {
    const f = mockDrive.files.get(fileId);
    if (!f) return null;
    return { fileId, fileName: f.name, mimeType: f.mimeType, size: 4, createdTime: f.createdTime, parents: f.parents || [], webViewLink: null };
  },
  getParentFolderName: async () => 'フォルダ',
  getThumbnailLink: async () => null,
  driveClientWithToken: () => ({}),
  getAccessToken: async () => 'sa-token',
}));
jest.mock('../lib/faststart', () => ({
  generateFaststartForVideoOrg: async () => ({}), generatePreviewForVideoOrg: async () => ({}),
}));
jest.mock('../lib/video-organization/auto-analyze', () => ({
  triggerAutoAnalyzeIfEligible: async () => ({}), isAutoAnalyzeEnabled: () => false,
}));
jest.mock('../lib/video-organization/auto-apply', () => ({ applyForRow: async () => ({ ok: true }) }));
jest.mock('../lib/video-organization/gemini', () => ({}));
jest.mock('../lib/google-oauth', () => ({ getValidAccessToken: async () => null }));

const express = require('express');
let server; let base;
beforeAll(async () => {
  const app = express(); app.use(express.json());
  app.use('/vot', require('../routes/video-organization-test'));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/vot`;
});
afterAll(() => server && server.close());

const REGISTERED = 'registeredVideo01234';
const SECRET = 'invoicePdfFile012345';      // Drive にはあるが素材広場に登録されていない（請求書など）
const OTHER_VIDEO = 'otherClientVideo0123'; // 別の場所にある既存の動画
const FRESH = 'freshUpload012345678';
const ADMIN = { 'x-test-user': 'adm', 'x-test-role': 'admin' };
const EDITOR = { 'x-test-user': 'ed', 'x-test-role': 'editor' };
const sessionStart = '2026-11-24T03:00:00.000Z';

beforeEach(() => {
  mockDrive.read = [];
  mockDrive.files = new Map([
    [REGISTERED, { name: 'a.mp4', mimeType: 'video/mp4', parents: ['f-msq'] }],
    [SECRET, { name: 'invoice.pdf', mimeType: 'application/pdf', parents: ['f-invoice'] }],
    [OTHER_VIDEO, { name: 'cr.mp4', mimeType: 'video/mp4', parents: ['f-msq'], createdTime: '2026-10-01T00:00:00.000Z' }],
    [FRESH, { name: 'new.mp4', mimeType: 'video/mp4', parents: ['f-msq'], createdTime: '2026-11-24T03:05:00.000Z' }],
  ]);
  mockDb.tables = {
    video_file_organization_tests: [{ id: 'v1', drive_file_id: REGISTERED, original_filename: 'a.mp4', current_filename: 'a.mp4' }],
    video_org_upload_sessions: [
      { id: 's1', user_id: 'ed', parent_folder_id: 'f-msq', status: 'uploading', file_size: 4, created_at: sessionStart },
    ],
  };
});

const get = (path, headers = EDITOR) => fetch(`${base}${path}`, { headers, redirect: 'manual' });
const post = (path, body, headers = EDITOR) => fetch(`${base}${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body || {}),
});

describe('GET /download/:fileId', () => {
  test('登録済みの素材はダウンロードできる', async () => {
    const r = await get(`/download/${REGISTERED}`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-disposition')).toContain('a.mp4');
    expect(mockDrive.read).toEqual([REGISTERED]);
  });

  test('素材広場に登録されていない ID は 404 で、Drive から読まない（管理者でも）', async () => {
    for (const h of [EDITOR, ADMIN]) {
      const r = await get(`/download/${SECRET}`, h);
      expect(r.status).toBe(404);
    }
    expect(mockDrive.read).toEqual([]);
  });
});

describe('GET /preview/:fileId', () => {
  test('登録済みの素材は配信する', async () => {
    const r = await get(`/preview/${REGISTERED}`);
    expect(r.status).toBe(200);
  });

  test('登録されていない ID は ?original=1 でも 404 で、Drive から読まない', async () => {
    const r1 = await get(`/preview/${SECRET}`);
    const r2 = await get(`/preview/${SECRET}?original=1`);
    expect(r1.status).toBe(404);
    expect(r2.status).toBe(404);
    expect(mockDrive.read).toEqual([]);
  });
});

describe('POST /register（既存の Drive ファイル ID の取り込み）', () => {
  test('管理者以外は 403（登録 → ダウンロードの抜け道を塞ぐ）', async () => {
    const r = await post('/register', { fileId: OTHER_VIDEO }, EDITOR);
    expect(r.status).toBe(403);
    expect(mockDb.tables.video_file_organization_tests).toHaveLength(1);
  });

  test('管理者は今までどおり登録できる', async () => {
    const r = await post('/register', { fileId: OTHER_VIDEO }, ADMIN);
    expect(r.status).toBe(200);
  });
});

describe('POST /upload-session/:id/complete', () => {
  test('セッション前からある別のファイル ID は登録しない', async () => {
    const r = await post('/upload-session/s1/complete', { driveFileId: OTHER_VIDEO });
    expect(r.status).toBe(403);
    expect(mockDb.tables.video_file_organization_tests.map(v => v.drive_file_id)).toEqual([REGISTERED]);
  });

  test('アップロード先フォルダ以外のファイルは登録しない', async () => {
    mockDrive.files.set(FRESH, { ...mockDrive.files.get(FRESH), parents: ['f-elsewhere'] });
    const r = await post('/upload-session/s1/complete', { driveFileId: FRESH });
    expect(r.status).toBe(403);
  });

  test('親フォルダが読めない（空）ファイルも登録しない', async () => {
    mockDrive.files.set(FRESH, { ...mockDrive.files.get(FRESH), parents: [] });
    const r = await post('/upload-session/s1/complete', { driveFileId: FRESH });
    expect(r.status).toBe(403);
  });

  test('そのセッションで直送したファイルは登録できる', async () => {
    const r = await post('/upload-session/s1/complete', { driveFileId: FRESH });
    expect(r.status).toBe(200);
    expect(mockDb.tables.video_file_organization_tests.map(v => v.drive_file_id)).toContain(FRESH);
  });
});

describe('POST /upload-session/init（アップロード先フォルダの直接指定）', () => {
  const realFetch = global.fetch;
  beforeAll(() => {
    process.env.ENABLE_RESUMABLE_UPLOAD = 'true';
    process.env.VIDEO_ORG_UPLOAD_FOLDER_ID = 'f-msq';
    // Drive の Resumable セッション発行だけ偽物にする（テストからサーバーへの fetch はそのまま）
    global.fetch = async (url, opts) => {
      if (String(url).startsWith('https://www.googleapis.com/upload/drive/v3/files')) {
        return { ok: true, status: 200, headers: { get: () => 'https://upload.example/session' }, text: async () => '' };
      }
      return realFetch(url, opts);
    };
  });
  afterAll(() => {
    global.fetch = realFetch;
    delete process.env.ENABLE_RESUMABLE_UPLOAD;
    delete process.env.VIDEO_ORG_UPLOAD_FOLDER_ID;
  });
  const body = (extra) => ({ filename: 'a.mp4', fileSize: 10, mimeType: 'video/mp4', ...extra });

  test('管理者以外が別のフォルダを指定すると 403', async () => {
    const r = await post('/upload-session/init', body({ parentFolderId: 'f-other-client' }), EDITOR);
    expect(r.status).toBe(403);
  });

  test('指定なし（素材広場のルート）・案件指定・管理者の指定は今までどおり', async () => {
    expect((await post('/upload-session/init', body(), EDITOR)).status).toBe(200);
    expect((await post('/upload-session/init', body({ project_id: 'p1' }), EDITOR)).status).toBe(200);
    expect((await post('/upload-session/init', body({ parentFolderId: 'f-other-client' }), ADMIN)).status).toBe(200);
  });
});
