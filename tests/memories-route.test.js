// 🎞 思い出アルバム API（routes/memories.js・ADR 052）の結合テスト。
// Drive はメモリ上の偽物、auth / supabase はヘッダで本人・admin を切り替える最小のモック。

const FOLDER = 'application/vnd.google-apps.folder';
const store = new Map();
let seq = 0;
function addFile(f) {
  const id = f.id || `id${++seq}`;
  store.set(id, { trashed: false, createdTime: new Date(Date.UTC(2026, 9, 24, seq)).toISOString(), appProperties: {}, ...f, id });
  return store.get(id);
}
function matches(file, q) {
  if (/trashed=false/.test(q) && file.trashed) return false;
  const parents = [...q.matchAll(/'([^']+)' in parents/g)].map((m) => m[1]);
  if (parents.length && !parents.some((p) => (file.parents || []).includes(p))) return false;
  const name = /name='((?:\\'|[^'])*)'/.exec(q);
  if (name && file.name !== name[1].replace(/\\'/g, "'")) return false;
  if (q.includes(`mimeType='${FOLDER}'`) && file.mimeType !== FOLDER) return false;
  if (q.includes(`mimeType!='${FOLDER}'`) && file.mimeType === FOLDER) return false;
  const ap = /appProperties has \{ key='([^']+)' and value='([^']+)' \}/.exec(q);
  if (ap && file.appProperties?.[ap[1]] !== ap[2]) return false;
  return true;
}
const mockDrive = {
  files: {
    list: jest.fn(async ({ q }) => ({ data: { files: [...store.values()].filter((f) => matches(f, q)) } })),
    create: jest.fn(async ({ requestBody }) => ({ data: addFile({ ...requestBody }) })),
    get: jest.fn(async ({ fileId }) => {
      const f = store.get(fileId);
      if (!f) throw new Error('not found');
      return { data: f };
    }),
    update: jest.fn(async ({ fileId, requestBody }) => { Object.assign(store.get(fileId), requestBody); return { data: {} }; }),
  },
  permissions: { create: jest.fn(async () => ({ data: {} })) },
};

jest.mock('googleapis', () => ({
  google: {
    auth: { GoogleAuth: jest.fn().mockImplementation(() => ({ getClient: async () => ({ getAccessToken: async () => ({ token: 'tok' }) }) })) },
    drive: () => mockDrive,
  },
}));
jest.mock('../supabase', () => ({
  from: (table) => ({
    select: () => ({
      eq: (_col, val) => ({
        maybeSingle: async () => (table === 'system_settings'
          ? { data: { value: 'ROOT' } }
          : { data: { nickname: val === 'u1' ? 'さとる' : 'みっつー', full_name: 'x' } }),
      }),
    }),
  }),
}));
jest.mock('../auth', () => ({
  requireAuth: (req, res, next) => {
    const uid = req.headers['x-test-user'];
    if (!uid) return res.status(401).json({ error: 'login' });
    req.user = { id: uid };
    next();
  },
  requireRole: () => (req, res, next) => (req.headers['x-test-admin'] ? next() : res.status(403).json({ error: 'forbidden' })),
  getEffectiveRoleCodes: async (req) => (req.headers['x-test-admin'] ? ['admin'] : ['editor']),
}));

const express = require('express');
const realFetch = global.fetch;
let server; let base;

beforeAll(async () => {
  process.env.GOOGLE_SERVICE_ACCOUNT_KEY = '{}';
  global.fetch = jest.fn(async (url, opts) => {
    const u = String(url);
    if (u.startsWith('https://www.googleapis.com/upload/')) {
      global.__lastInit = JSON.parse(opts.body);
      return new Response('', { status: 200, headers: { location: 'https://upload.example/session/1' } });
    }
    if (u.startsWith('https://thumb.example/')) return new Response('IMG', { status: 200, headers: { 'content-type': 'image/jpeg' } });
    return realFetch(url, opts);
  });
  const app = express();
  app.use(express.json());
  app.use('/m', require('../routes/memories'));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/m`;
});
afterAll(() => { server && server.close(); global.fetch = realFetch; });

const call = (path, { user = 'u1', admin = false, method = 'GET', body } = {}) => realFetch(base + path, {
  method,
  headers: { 'x-test-user': user, ...(admin ? { 'x-test-admin': '1' } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
  body: body ? JSON.stringify(body) : undefined,
}).then(async (r) => ({ status: r.status, body: r.headers.get('content-type')?.includes('json') ? await r.json() : await r.text() }));

describe('思い出アルバム API', () => {
  let albumId;

  test('初回はルートフォルダと既定アルバムを作る（公開リンク付き）', async () => {
    const r = await call('/albums');
    expect(r.status).toBe(200);
    expect(r.body.albums).toHaveLength(1);
    expect(r.body.albums[0].name).toBe('淡路島合宿 2026');
    expect(r.body.can_create).toBe(false);
    albumId = r.body.albums[0].id;
    const root = [...store.values()].find((f) => f.name === '🎞 思い出アルバム');
    expect(root.parents).toEqual(['ROOT']);
    expect(mockDrive.permissions.create).toHaveBeenCalledWith(expect.objectContaining({ fileId: albumId }));
    // 2回目は増えない
    expect((await call('/albums')).body.albums).toHaveLength(1);
  });

  test('アップロード: 投稿者フォルダを作り、元のファイル名のまま Drive 直送セッションを返す', async () => {
    const r = await call(`/albums/${albumId}/upload-session`, { method: 'POST', body: { filename: 'IMG_0001.HEIC', fileSize: 1234, mimeType: '', lastModified: Date.UTC(2026, 9, 24, 3) } });
    expect(r.status).toBe(200);
    expect(r.body.sessionUrl).toBe('https://upload.example/session/1');
    const folder = [...store.values()].find((f) => f.appProperties?.hfs_uploader_id === 'u1' && f.mimeType === FOLDER);
    expect(folder.name).toBe('さとる');
    expect(global.__lastInit).toEqual({
      name: 'IMG_0001.HEIC',
      parents: [folder.id],
      appProperties: { hfs_uploader_id: 'u1', hfs_taken_at: '2026-10-24T03:00:00.000Z' },
    });
    // 同じ人の2枚目は同じフォルダ
    await call(`/albums/${albumId}/upload-session`, { method: 'POST', body: { filename: 'b.jpg', fileSize: 1, mimeType: 'image/jpeg' } });
    expect([...store.values()].filter((f) => f.appProperties?.hfs_uploader_id === 'u1' && f.mimeType === FOLDER)).toHaveLength(1);
  });

  test('写真・動画以外と、アルバム外のフォルダは拒否', async () => {
    expect((await call(`/albums/${albumId}/upload-session`, { method: 'POST', body: { filename: 'a.pdf', fileSize: 1, mimeType: 'application/pdf' } })).status).toBe(400);
    const other = addFile({ name: 'よそ', mimeType: FOLDER, parents: ['ROOT'] });
    expect((await call(`/albums/${other.id}/upload-session`, { method: 'POST', body: { filename: 'a.jpg', fileSize: 1, mimeType: 'image/jpeg' } })).status).toBe(404);
  });

  test('完了登録は本人のファイルだけ・一覧に投稿者つきで出る', async () => {
    const folder = [...store.values()].find((f) => f.appProperties?.hfs_uploader_id === 'u1' && f.mimeType === FOLDER);
    const file = addFile({ name: 'IMG_0001.JPG', mimeType: 'image/jpeg', size: '1234', parents: [folder.id], thumbnailLink: 'https://thumb.example/x=s220', appProperties: { hfs_uploader_id: 'u1' }, imageMediaMetadata: { time: '2026:10:24 18:00:00' } });
    expect((await call(`/albums/${albumId}/upload-complete`, { user: 'u2', method: 'POST', body: { driveFileId: file.id } })).status).toBe(403);
    expect((await call(`/albums/${albumId}/upload-complete`, { method: 'POST', body: { driveFileId: file.id } })).status).toBe(200);

    const list = await call(`/albums/${albumId}/items`, { user: 'u2' });
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({ id: file.id, kind: 'image', uploader_name: 'さとる', uploader_id: 'u1', date_key: '2026-10-24', has_thumb: true });
    expect(list.body.uploaders).toEqual([expect.objectContaining({ uploader_name: 'さとる', count: 1 })]);

    const thumb = await call(`/items/${file.id}/thumb?s=400`, { user: 'u2' });
    expect(thumb.status).toBe(200);
    expect(global.fetch).toHaveBeenCalledWith('https://thumb.example/x=s400');
  });

  test('アルバム外のファイルのサムネは返さない', async () => {
    const outside = addFile({ name: 'secret.jpg', mimeType: 'image/jpeg', parents: ['ROOT'], thumbnailLink: 'https://thumb.example/s' });
    expect((await call(`/items/${outside.id}/thumb`)).status).toBe(404);
  });

  test('一覧に出たあと Drive でアルバム外へ移したファイルは、キャッシュが残っていても削除できない', async () => {
    const folder = [...store.values()].find((f) => f.appProperties?.hfs_uploader_id === 'u1' && f.mimeType === FOLDER);
    const file = addFile({ name: 'moved.jpg', mimeType: 'image/jpeg', parents: [folder.id], appProperties: { hfs_uploader_id: 'u1' } });
    await call(`/albums/${albumId}/upload-complete`, { method: 'POST', body: { driveFileId: file.id } });
    const list = await call(`/albums/${albumId}/items`);
    expect(list.body.items.map((it) => it.id)).toContain(file.id);
    file.parents = ['ROOT']; // Drive 上でアルバムの外へ移動（一覧キャッシュはまだ有効）
    expect((await call(`/items/${file.id}/trash`, { method: 'POST', body: {} })).status).toBe(404);
    expect((await call(`/items/${file.id}/trash`, { admin: true, method: 'POST', body: {} })).status).toBe(404);
    expect(store.get(file.id).trashed).toBe(false);
    store.delete(file.id);
  });

  test('削除は本人か admin だけ（ゴミ箱送り）', async () => {
    const file = [...store.values()].find((f) => f.name === 'IMG_0001.JPG');
    expect((await call(`/items/${file.id}/trash`, { user: 'u2', method: 'POST', body: {} })).status).toBe(403);
    expect((await call(`/items/${file.id}/trash`, { user: 'u2', admin: true, method: 'POST', body: {} })).status).toBe(200);
    expect(store.get(file.id).trashed).toBe(true);
    expect((await call(`/albums/${albumId}/items`)).body.items).toHaveLength(0);
  });

  test('アルバム作成は admin のみ', async () => {
    expect((await call('/albums', { method: 'POST', body: { name: '忘年会' } })).status).toBe(403);
    const r = await call('/albums', { admin: true, method: 'POST', body: { name: ' 2027 忘年会 ' } });
    expect(r.status).toBe(200);
    expect(r.body.album.name).toBe('2027 忘年会');
  });
});
