// 画像アップロード・配信の安全化（2026-11-24）の結合テスト。supabase はメモリ上の偽 DB、Drive は偽物。
//   - 保存時: 申告の mime ではなく中身（先頭バイト）で PNG/JPEG/WebP/GIF か判定。SVG/HTML は 400、保存値は判定した種類で組み立て直す
//   - 配信時: 保存済みの mime は使わず中身から判定し直した image/* だけ。nosniff / inline / CSP を付ける。許可リスト外の旧行は 404
//   - Drive プロキシ: 動画・音声・画像・PDF 以外は application/octet-stream（ダウンロード扱い）＋ nosniff / CSP sandbox
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
  // Postgres の LIKE（既定エスケープ \）: \x は文字そのもの、% は任意列、_ は任意 1 文字
  const likeRe = (pat) => {
    let re = '';
    for (let i = 0; i < pat.length; i += 1) {
      const c = pat[i];
      if (c === '\\' && i + 1 < pat.length) { i += 1; re += pat[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
      else if (c === '%') re += '.*';
      else if (c === '_') re += '.';
      else re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    return new RegExp(`^${re}$`);
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
        return { data: {
          id: f.id, parents: f.parents || [], mimeType: f.mimeType, size: '1', appProperties: f.appProperties,
          createdTime: f.createdTime || new Date().toISOString(), webViewLink: `https://drive.google.com/file/d/${f.id}/view`,
        } };
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


const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(16, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(16, 2)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>');
const HTML = Buffer.from('<!doctype html><html><body><script>1</script></body></html>');
const dataUrl = (mime, buf) => `data:${mime};base64,${buf.toString('base64')}`;

const HTML_FILE_ID = 'htmlCreativeFile0123';
const VIDEO_ID = 'videoFile_0123456789';

beforeEach(() => {
  mockDrive.files = new Map([
    [HTML_FILE_ID, { id: HTML_FILE_ID, name: 'lp.html', parents: [], mimeType: 'text/html', bytes: HTML }],
    [VIDEO_ID, { id: VIDEO_ID, name: 'a.mp4', parents: [], mimeType: 'video/mp4' }],
  ]);
  mockDb.tables = {
    creatives: [{ id: 'cr1' }],
    creative_files: [
      { id: 'cf1', creative_id: 'cr1', drive_file_id: HTML_FILE_ID, generated_name: 'lp.html', mime_type: 'text/html', file_size: HTML.length },
      { id: 'cf2', creative_id: 'cr1', drive_file_id: VIDEO_ID, generated_name: 'a.mp4', mime_type: 'video/mp4', file_size: 1 },
    ],
    creative_comment_images: [
      { id: 'img-svg', creative_id: 'cr1', image_data: dataUrl('image/svg+xml', SVG), mime: 'image/svg+xml', deleted_at: null },
      { id: 'img-html-as-png', creative_id: 'cr1', image_data: dataUrl('image/png', HTML), mime: 'image/png', deleted_at: null },
      { id: 'img-png-as-svg', creative_id: 'cr1', image_data: dataUrl('image/svg+xml', PNG), mime: 'image/svg+xml', deleted_at: null },
    ],
    bug_report_comment_images: [
      { id: 'b-svg', image_data: dataUrl('image/svg+xml', SVG), deleted_at: null },
      { id: 'b-png', image_data: dataUrl('image/png', PNG), deleted_at: null },
    ],
    tweet_images: [
      { tweet_id: 't1', position: 0, image_data: dataUrl('text/html', HTML) },
      { tweet_id: 't2', position: 0, image_data: dataUrl('image/jpeg', JPEG) },
    ],
    users: [
      { id: 'u-svg', avatar_url: dataUrl('image/svg+xml', SVG) },
      { id: 'u-ok', avatar_url: dataUrl('image/jpeg', JPEG) },
      { id: 'u1', avatar_url: null },
    ],
  };
});

function expectSafeImageHeaders(r, mime) {
  expect(r.headers.get('content-type')).toBe(mime);
  expect(r.headers.get('x-content-type-options')).toBe('nosniff');
  expect(r.headers.get('content-disposition')).toBe('inline');
  expect(r.headers.get('content-security-policy')).toContain("default-src 'none'");
  expect(r.headers.get('content-security-policy')).toContain('sandbox');
}

describe('POST /creatives/:id/comment-images', () => {
  const post = (image_data) => fetch(`${base}/creatives/cr1/comment-images`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ image_data, source: 'live', source_id: 'live-cr1' }),
  });

  test('SVG は 400（保存しない）', async () => {
    const before = mockDb.tables.creative_comment_images.length;
    const r = await post(dataUrl('image/svg+xml', SVG));
    expect(r.status).toBe(400);
    expect(mockDb.tables.creative_comment_images.length).toBe(before);
  });

  test('image/png と申告した HTML も 400', async () => {
    const r = await post(dataUrl('image/png', HTML));
    expect(r.status).toBe(400);
  });

  test('PNG は保存でき、mime と data URL は中身から判定した種類になる', async () => {
    const r = await post(dataUrl('image/gif', PNG));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.mime).toBe('image/png');
    const row = mockDb.tables.creative_comment_images.find(x => x.id === j.id);
    expect(row.image_data).toBe(dataUrl('image/png', PNG));
  });
});

describe('GET /comment-images/:id/image', () => {
  test('保存済みが SVG の旧行は配信しない（404）', async () => {
    const r = await fetch(`${base}/comment-images/img-svg/image`);
    expect(r.status).toBe(404);
  });
  test('image/png と保存された HTML も配信しない（404）', async () => {
    const r = await fetch(`${base}/comment-images/img-html-as-png/image`);
    expect(r.status).toBe(404);
  });
  test('中身が PNG なら保存済みの mime に関係なく image/png ＋安全ヘッダーで返す', async () => {
    const r = await fetch(`${base}/comment-images/img-png-as-svg/image`);
    expect(r.status).toBe(200);
    expectSafeImageHeaders(r, 'image/png');
    expect(Buffer.from(await r.arrayBuffer())).toEqual(PNG);
  });
});

describe('GET /bug-report-comment-images/:id/image', () => {
  test('SVG は 404・PNG は安全ヘッダー付きで返す', async () => {
    expect((await fetch(`${base}/bug-report-comment-images/b-svg/image`)).status).toBe(404);
    const r = await fetch(`${base}/bug-report-comment-images/b-png/image`);
    expect(r.status).toBe(200);
    expectSafeImageHeaders(r, 'image/png');
  });
});

describe('GET /tweets/:id/image/:pos', () => {
  test('HTML の旧行は 404・JPEG は安全ヘッダー付きで返す', async () => {
    expect((await fetch(`${base}/tweets/t1/image/0`)).status).toBe(404);
    const r = await fetch(`${base}/tweets/t2/image/0`);
    expect(r.status).toBe(200);
    expectSafeImageHeaders(r, 'image/jpeg');
  });
});

describe('アバター', () => {
  test('GET: SVG の旧行は 404・JPEG は安全ヘッダー付き', async () => {
    expect((await fetch(`${base}/members/u-svg/avatar`)).status).toBe(404);
    const r = await fetch(`${base}/members/u-ok/avatar`);
    expect(r.status).toBe(200);
    expectSafeImageHeaders(r, 'image/jpeg');
  });

  const upload = (buf, type, name) => {
    const fd = new FormData();
    fd.append('file', new Blob([buf], { type }), name);
    return fetch(`${base}/members/u1/avatar`, { method: 'POST', body: fd, headers: { 'x-test-user': 'u1' } });
  };
  test('POST: image/png と申告した SVG は 400', async () => {
    const r = await upload(SVG, 'image/png', 'a.png');
    expect(r.status).toBe(400);
    expect(mockDb.tables.users.find(u => u.id === 'u1').avatar_url).toBeNull();
  });
  test('POST: JPEG は中身の種類で保存', async () => {
    const r = await upload(JPEG, 'image/svg+xml', 'a.svg');
    expect(r.status).toBe(200);
    expect(mockDb.tables.users.find(u => u.id === 'u1').avatar_url).toBe(dataUrl('image/jpeg', JPEG));
  });
});

describe('POST /tweets', () => {
  test('image/jpeg と申告した HTML は 400', async () => {
    const fd = new FormData();
    fd.append('body', 'こんにちは');
    fd.append('images', new Blob([HTML], { type: 'image/jpeg' }), 'a.jpg');
    const r = await fetch(`${base}/tweets`, { method: 'POST', body: fd });
    expect(r.status).toBe(400);
  });
});

describe('GET /files/:fileId/stream（Drive プロキシ）', () => {
  test('HTML のクリエイティブファイルはダウンロード扱い（octet-stream / attachment / nosniff / sandbox）', async () => {
    const r = await fetch(`${base}/files/${HTML_FILE_ID}/stream`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('application/octet-stream');
    expect(r.headers.get('content-disposition')).toBe('attachment');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('content-security-policy')).toBe('sandbox');
  });
  test('動画は video/mp4 のまま（inline）', async () => {
    const r = await fetch(`${base}/files/${VIDEO_ID}/stream`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('video/mp4');
    expect(r.headers.get('content-disposition')).toBeNull();
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
  });
});
