// Drive のファイル ID を受け取る API の権限確認（2026-11-24）の結合テスト。supabase はメモリ上の偽 DB、Drive は偽物。
//   - GET /files/:fileId/direct-url: クリエイティブの動画・画像だけ直接 URL を出す（公開設定もそのときだけ）。
//     クリエイティブのファイルでない ID は 404・動画/画像以外は 415・どちらも公開設定をしない
//   - GET /files/:fileId/stream: クリエイティブのファイルでない ID は 404（Drive から読まない）
//   - POST /creatives/:id/upload-session/complete: 案件フォルダ配下のファイルだけ登録・公開設定する
process.env.GOOGLE_SERVICE_ACCOUNT_KEY = JSON.stringify({ client_email: 'service-account', private_key: 'x' });
delete process.env.R2_PLAYBACK_ENABLED;
process.env.ENABLE_FASTSTART_AUTOGEN = 'off';

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
  const likeRe = (pat) => new RegExp('^' + pat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.') + '$');
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
      if (prop === 'like') return (k, p) => { const re = likeRe(p); st.filters.push(r => re.test(String(r[k] ?? ''))); return b; };
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
jest.mock('../auth', () => {
  const pass = (req, _res, next) => { req.user = { id: req.headers['x-test-user'] || 'u1', role: 'editor' }; next(); };
  return {
    requireAuth: pass, requireRole: () => pass, requireLevel: () => pass, requirePermission: () => pass,
    requireAnyPermission: () => pass, requireSuperAdmin: pass, isSuperAdminUser: () => false,
    userHasPermission: async () => false, getEffectiveRole: async (req) => req.user.role,
    getEffectiveRoleCodes: async (req) => [req.user.role],
    invalidatePermissionsCache: () => {}, invalidateUserCache: () => {},
  };
});

// 偽の Drive: files（id → { parents, mimeType, name, bytes }）と、公開設定の呼び出し記録
const mockDrive = {
  files: new Map(),
  granted: [],
  api: {
    files: {
      list: async ({ q }) => {
        // getOrCreateFolder: "name='X' and '<parent>' in parents ..." を素朴に解釈
        const name = (String(q).match(/name\s*=\s*'((?:[^'\\]|\\.)*)'/) || [])[1];
        const parent = (String(q).match(/'([^']+)'\s+in\s+parents/) || [])[1];
        const hit = [...mockDrive.files.values()].filter(f => f.name === name && (f.parents || []).includes(parent));
        return { data: { files: hit.map(f => ({ id: f.id, name: f.name })) } };
      },
      create: async ({ requestBody }) => {
        const id = `drvnew${++mockSeq}xxxxxx`;
        mockDrive.files.set(id, { id, ...requestBody });
        return { data: { id, webViewLink: `https://drive.google.com/file/d/${id}/view` } };
      },
      update: async () => ({ data: {} }),
      get: async ({ fileId, alt }) => {
        const f = mockDrive.files.get(fileId);
        if (!f) { const e = new Error('File not found'); e.code = 404; throw e; }
        if (alt === 'media') return { data: require('stream').Readable.from([f.bytes || Buffer.from('x')]) };
        return { data: { id: f.id, parents: f.parents || [], mimeType: f.mimeType, size: '1', webViewLink: `https://drive.google.com/file/d/${f.id}/view` } };
      },
    },
    permissions: {
      create: async ({ fileId, requestBody }) => { mockDrive.granted.push({ fileId, ...requestBody }); return { data: {} }; },
      list: async () => ({ data: { permissions: [] } }),
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

const VIDEO_ID = 'videoFile_0123456789';
const IMAGE_ID = 'imageFile-0123456789';
const PDF_CR_ID = 'pdfCreativeFile01234';
const LEGACY_ID = 'legacyFile0123456789';
const INVOICE_ID = 'invoicePdf0123456789';
const FASTSTART_ID = 'faststartVer01234567';

beforeEach(() => {
  mockDrive.granted = [];
  mockDrive.files = new Map([
    ['root', { id: 'root', name: 'ROOT', parents: [] }],
    ['f-client', { id: 'f-client', name: 'クライアントA', parents: ['root'], mimeType: 'application/vnd.google-apps.folder' }],
    ['f-proj', { id: 'f-proj', name: '案件X', parents: ['f-client'], mimeType: 'application/vnd.google-apps.folder' }],
    ['f-month', { id: 'f-month', name: '202611', parents: ['f-proj'], mimeType: 'application/vnd.google-apps.folder' }],
    ['f-type', { id: 'f-type', name: '動画', parents: ['f-month'], mimeType: 'application/vnd.google-apps.folder' }],
    ['uploadedVideo0123456', { id: 'uploadedVideo0123456', name: 'cr1_v2.mp4', parents: ['f-type'], mimeType: 'video/mp4' }],
    ['f-invoices', { id: 'f-invoices', name: '請求書', parents: ['root'], mimeType: 'application/vnd.google-apps.folder' }],
    [INVOICE_ID, { id: INVOICE_ID, name: 'invoice.pdf', parents: ['f-invoices'], mimeType: 'application/pdf' }],
    [VIDEO_ID, { id: VIDEO_ID, name: 'a.mp4', parents: ['f-type'], mimeType: 'video/mp4' }],
  ]);
  mockDb.tables = {
    system_settings: [{ key: 'drive_root_folder_id', value: 'root' }],
    creatives: [{ id: 'cr1', project_id: 'p1', projects: { id: 'p1', name: '案件X', clients: { id: 'c1', name: 'クライアントA' } } }],
    creative_files: [
      { id: 'cf1', creative_id: 'cr1', drive_file_id: VIDEO_ID, generated_name: 'a.mp4', mime_type: 'video/mp4', file_size: 100, version: 1 },
      { id: 'cf2', creative_id: 'cr1', drive_file_id: IMAGE_ID, generated_name: 'b.png', mime_type: null, file_size: 50, version: 2 },
      { id: 'cf3', creative_id: 'cr1', drive_file_id: PDF_CR_ID, generated_name: 'c.pdf', mime_type: 'application/pdf', version: 3 },
      { id: 'cf4', creative_id: 'cr1', drive_file_id: null, drive_url: `https://drive.google.com/file/d/${LEGACY_ID}/view?usp=drivesdk`, generated_name: 'd.mov', version: 4 },
      { id: 'cf5', creative_id: 'cr1', drive_file_id: 'withFaststart0123456', generated_name: 'e.mp4', mime_type: 'video/mp4',
        faststart_drive_file_id: FASTSTART_ID, faststart_status: 'done', faststart_file_size: 90, version: 5 },
    ],
  };
});

describe('GET /files/:fileId/direct-url', () => {
  test('クリエイティブの動画は今までどおり直接 URL が返り、公開設定される', async () => {
    const r = await fetch(`${base}/files/${VIDEO_ID}/direct-url`);
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.contentUrl).toContain(`id=${VIDEO_ID}`);
    expect(j.source).toBe('master');
    expect(mockDrive.granted).toEqual([expect.objectContaining({ fileId: VIDEO_ID, type: 'anyone', role: 'reader' })]);
  });

  test('faststart 版があればそちらに公開設定して返す', async () => {
    const r = await fetch(`${base}/files/withFaststart0123456/direct-url`);
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.source).toBe('faststart');
    expect(j.contentUrl).toContain(`id=${FASTSTART_ID}`);
    expect(mockDrive.granted.map(g => g.fileId)).toEqual([FASTSTART_ID]);
  });

  test('mime_type が空でも拡張子が画像なら返す', async () => {
    const r = await fetch(`${base}/files/${IMAGE_ID}/direct-url`);
    expect(r.status).toBe(200);
  });

  test('drive_file_id が無い旧行も drive_url の完全一致で救う', async () => {
    const r = await fetch(`${base}/files/${LEGACY_ID}/direct-url`);
    expect(r.status).toBe(200);
  });

  test('クリエイティブのファイルでない ID（請求書など）は 404 で、公開設定しない', async () => {
    const r = await fetch(`${base}/files/${INVOICE_ID}/direct-url`);
    expect(r.status).toBe(404);
    expect(mockDrive.granted).toEqual([]);
  });

  test('drive_url の部分一致（ID の前方一致）では通さない', async () => {
    const r = await fetch(`${base}/files/${LEGACY_ID.slice(0, 15)}/direct-url`);
    expect(r.status).toBe(404);
    expect(mockDrive.granted).toEqual([]);
  });

  test('クリエイティブのファイルでも動画・画像以外は 415 で、公開設定しない', async () => {
    const r = await fetch(`${base}/files/${PDF_CR_ID}/direct-url`);
    expect(r.status).toBe(415);
    expect(mockDrive.granted).toEqual([]);
  });

  test('クリエイティブが存在しない（消えた）ファイル行は 404', async () => {
    mockDb.tables.creatives = [];
    const r = await fetch(`${base}/files/${VIDEO_ID}/direct-url`);
    expect(r.status).toBe(404);
    expect(mockDrive.granted).toEqual([]);
  });

  test('ID の形が不正なら 404', async () => {
    const r = await fetch(`${base}/files/${encodeURIComponent("x%' or 1=1")}/direct-url`);
    expect(r.status).toBe(404);
  });
});

describe('GET /files/:fileId/stream', () => {
  test('クリエイティブの動画は配信する', async () => {
    const r = await fetch(`${base}/files/${VIDEO_ID}/stream`);
    expect(r.status).toBe(200);
  });
  test('クリエイティブのファイルでない ID は 404', async () => {
    const r = await fetch(`${base}/files/${INVOICE_ID}/stream`);
    expect(r.status).toBe(404);
  });
});

describe('POST /creatives/:id/upload-session/complete', () => {
  const post = (body) => fetch(`${base}/creatives/cr1/upload-session/complete`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });

  test('案件フォルダ配下にアップロードしたファイルは登録・公開設定される', async () => {
    const r = await post({ driveFileId: 'uploadedVideo0123456', version: 9, generated_name: 'cr1_v9.mp4', mimeType: 'video/mp4' });
    expect(r.status).toBe(200);
    expect(mockDrive.granted.map(g => g.fileId)).toEqual(['uploadedVideo0123456']);
    expect(mockDb.tables.creative_files.some(f => f.drive_file_id === 'uploadedVideo0123456')).toBe(true);
  });

  test('案件フォルダの外のファイル（請求書など）は 403 で、公開設定も登録もしない', async () => {
    const r = await post({ driveFileId: INVOICE_ID, version: 9, generated_name: 'x.mp4', mimeType: 'video/mp4' });
    expect(r.status).toBe(403);
    expect(mockDrive.granted).toEqual([]);
    expect(mockDb.tables.creative_files.some(f => f.drive_file_id === INVOICE_ID)).toBe(false);
  });

  test('存在しないファイルは確認できないので 502 で、何もしない', async () => {
    const r = await post({ driveFileId: 'doesNotExist01234567', version: 9, generated_name: 'x.mp4' });
    expect(r.status).toBe(502);
    expect(mockDrive.granted).toEqual([]);
  });
});
