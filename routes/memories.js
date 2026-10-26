// routes/memories.js
// =============================================================
// 🎞 思い出アルバム API（ADR 052）
//
// mount: server.js で app.use('/api/haruka/memories', require('./routes/memories'))
//        を app.use('/api/haruka', harukaRouter) より前に置く。
//
// 保存先は Google Drive（共有ドライブ）。DB テーブルは持たない。
//   <Drive ルート>/🎞 思い出アルバム/<アルバム名>/<投稿者名>/<元のファイル名>
//   - アルバム   = 「🎞 思い出アルバム」直下のフォルダ（appProperties.hfs_kind='memories_album'）
//   - 投稿者     = アルバム直下のフォルダ（appProperties.hfs_uploader_id=users.id）。名前が同じ人がいても ID で区別
//   - ファイル名 = 元の名前のまま（appProperties.hfs_uploader_id / hfs_taken_at を付ける）
//
// アップロードはクリエイティブと同じく「ブラウザ → Drive へ Resumable 直送」。
// バイトは Railway を通さない（約5分のエッジ timeout で 502 になるため）。
//   1) POST /albums/:albumId/upload-session  … セッションURL発行
//   2) ブラウザがセッションURLへチャンク PUT（haruka.html の driveUploadToSession）
//   3) POST /albums/:albumId/upload-complete … 公開リンク権限を付けて一覧キャッシュを捨てる
//
// 権限: 閲覧・アップロードはログイン中の全員。アルバム作成は admin（実効ロール）。
//       ゴミ箱送りは投稿した本人（req.user.id・VIEW AS の影響なし）か admin（実効ロール）。
// =============================================================

const express = require('express');
const { google } = require('googleapis');

const supabase = require('../supabase');
const { requireAuth, requireRole, getEffectiveRoleCodes } = require('../auth');
const { roleCodesMatchAny } = require('../utils/roles');
const M = require('../utils/memories');

const router = express.Router();
router.use(requireAuth);

const MEMORIES_ROOT_NAME = '🎞 思い出アルバム';
const DEFAULT_ALBUM_NAME = '淡路島合宿 2026';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const RESUMABLE_UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3/files';
const ITEMS_CACHE_MS = 30 * 1000;
const THUMB_LINK_CACHE_MS = 30 * 60 * 1000;

// ----- Drive 接続 -----
function getCredentials() {
  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!keyJson) return null;
  return JSON.parse(keyJson);
}
let _auth = null;
function getAuth() {
  if (_auth) return _auth;
  const credentials = getCredentials();
  if (!credentials) throw Object.assign(new Error('Google Drive 連携が設定されていません'), { status: 503 });
  _auth = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/drive'] });
  return _auth;
}
function getDrive() {
  return google.drive({ version: 'v3', auth: getAuth() });
}
async function getAccessToken() {
  const client = await getAuth().getClient();
  const { token } = await client.getAccessToken();
  if (!token) throw new Error('サービスアカウントのアクセストークン取得に失敗しました');
  return token;
}
async function getDriveRootFolderId() {
  const { data } = await supabase.from('system_settings').select('value').eq('key', 'drive_root_folder_id').maybeSingle();
  return data?.value || process.env.DRIVE_ROOT_FOLDER_ID || null;
}

const DRIVE_LIST_OPTS = { supportsAllDrives: true, includeItemsFromAllDrives: true };
const qEsc = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

// リンクを知っている人は閲覧可（クリエイティブ・素材広場と同じ運用）。失敗しても本処理は止めない
async function grantAnyoneReader(drive, fileId) {
  try {
    await drive.permissions.create({ fileId, supportsAllDrives: true, requestBody: { role: 'reader', type: 'anyone' } });
  } catch (e) {
    console.warn('[memories] 公開リンク権限の付与に失敗（閲覧に影響する可能性あり）:', e.message);
  }
}

// 同じフォルダを同時に2つ作らないよう、作成処理はキーごとに直列化する（同時アップロード対策）
const _folderLocks = new Map();
function withFolderLock(key, fn) {
  const prev = _folderLocks.get(key) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  _folderLocks.set(key, next);
  next.finally(() => { if (_folderLocks.get(key) === next) _folderLocks.delete(key); }).catch(() => {});
  return next;
}

// ----- 「🎞 思い出アルバム」ルートフォルダ -----
let _memoriesRootId = null;
async function getMemoriesRootId(drive) {
  if (_memoriesRootId) return _memoriesRootId;
  return withFolderLock('memories-root', async () => {
    if (_memoriesRootId) return _memoriesRootId;
    const rootId = await getDriveRootFolderId();
    if (!rootId) throw Object.assign(new Error('Drive のルートフォルダが設定されていません'), { status: 503 });
    const found = await drive.files.list({
      q: `'${rootId}' in parents and name='${qEsc(MEMORIES_ROOT_NAME)}' and mimeType='${FOLDER_MIME}' and trashed=false`,
      fields: 'files(id)',
      ...DRIVE_LIST_OPTS,
    });
    if (found.data.files?.length) {
      _memoriesRootId = found.data.files[0].id;
    } else {
      const created = await drive.files.create({
        requestBody: { name: MEMORIES_ROOT_NAME, mimeType: FOLDER_MIME, parents: [rootId], appProperties: { hfs_kind: 'memories_root' } },
        fields: 'id',
        supportsAllDrives: true,
      });
      _memoriesRootId = created.data.id;
    }
    return _memoriesRootId;
  });
}

// ----- アルバム -----
async function createAlbumFolder(drive, rootId, name) {
  const created = await drive.files.create({
    requestBody: { name, mimeType: FOLDER_MIME, parents: [rootId], appProperties: { hfs_kind: 'memories_album' } },
    fields: 'id, name, createdTime',
    supportsAllDrives: true,
  });
  // フォルダごと Drive で開いて一括ダウンロードできるように
  await grantAnyoneReader(drive, created.data.id);
  return created.data;
}

async function listAlbums(drive) {
  const rootId = await getMemoriesRootId(drive);
  const res = await drive.files.list({
    q: `'${rootId}' in parents and mimeType='${FOLDER_MIME}' and trashed=false`,
    fields: 'files(id, name, createdTime)',
    orderBy: 'createdTime desc',
    pageSize: 100,
    ...DRIVE_LIST_OPTS,
  });
  let albums = res.data.files || [];
  // 初回は合宿用のアルバムを1つ用意しておく（みんながすぐ入れられるように）
  if (!albums.length) {
    albums = await withFolderLock('memories-default-album', async () => {
      const again = await drive.files.list({
        q: `'${rootId}' in parents and mimeType='${FOLDER_MIME}' and trashed=false`,
        fields: 'files(id, name, createdTime)',
        ...DRIVE_LIST_OPTS,
      });
      if (again.data.files?.length) return again.data.files;
      return [await createAlbumFolder(drive, rootId, DEFAULT_ALBUM_NAME)];
    });
  }
  return albums;
}

// albumId が本当に「🎞 思い出アルバム」直下のフォルダかを確かめる（任意フォルダへの書き込み防止）
const _albumCheckCache = new Map(); // albumId -> { name, at }
async function assertAlbum(drive, albumId) {
  const hit = _albumCheckCache.get(albumId);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit;
  const rootId = await getMemoriesRootId(drive);
  let meta;
  try {
    meta = (await drive.files.get({ fileId: albumId, fields: 'id, name, parents, mimeType, trashed', supportsAllDrives: true })).data;
  } catch (_) {
    throw Object.assign(new Error('アルバムが見つかりません'), { status: 404 });
  }
  if (meta.mimeType !== FOLDER_MIME || meta.trashed || !(meta.parents || []).includes(rootId)) {
    throw Object.assign(new Error('アルバムが見つかりません'), { status: 404 });
  }
  const info = { name: meta.name, at: Date.now() };
  _albumCheckCache.set(albumId, info);
  return info;
}

// ----- 投稿者フォルダ -----
async function loadUploaderFolders(drive, albumId) {
  const map = new Map();
  let pageToken;
  do {
    const res = await drive.files.list({
      q: `'${albumId}' in parents and mimeType='${FOLDER_MIME}' and trashed=false`,
      fields: 'nextPageToken, files(id, name, appProperties)',
      pageSize: 200,
      pageToken,
      ...DRIVE_LIST_OPTS,
    });
    for (const f of res.data.files || []) {
      map.set(f.id, { uploader_id: f.appProperties?.hfs_uploader_id || null, uploader_name: f.name });
    }
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return map;
}

async function displayNameOf(userId) {
  const { data } = await supabase.from('users').select('nickname, full_name').eq('id', userId).maybeSingle();
  const name = (data?.nickname || data?.full_name || '').trim();
  return M.sanitizeMemoryFileName(name || 'メンバー');
}

const _uploaderFolderCache = new Map(); // `${albumId}|${userId}` -> folderId
async function ensureUploaderFolder(drive, albumId, userId) {
  const key = `${albumId}|${userId}`;
  if (_uploaderFolderCache.has(key)) return _uploaderFolderCache.get(key);
  return withFolderLock(key, async () => {
    if (_uploaderFolderCache.has(key)) return _uploaderFolderCache.get(key);
    const found = await drive.files.list({
      q: `'${albumId}' in parents and mimeType='${FOLDER_MIME}' and trashed=false and appProperties has { key='hfs_uploader_id' and value='${qEsc(userId)}' }`,
      fields: 'files(id)',
      ...DRIVE_LIST_OPTS,
    });
    let folderId = found.data.files?.[0]?.id;
    if (!folderId) {
      const created = await drive.files.create({
        requestBody: { name: await displayNameOf(userId), mimeType: FOLDER_MIME, parents: [albumId], appProperties: { hfs_uploader_id: String(userId) } },
        fields: 'id',
        supportsAllDrives: true,
      });
      folderId = created.data.id;
    }
    _uploaderFolderCache.set(key, folderId);
    return folderId;
  });
}

// ----- 一覧（30秒キャッシュ。アップロード・削除で破棄） -----
const _itemsCache = new Map(); // albumId -> { at, payload, fileFolder: Map<fileId, folderId>, thumbs: Map<fileId, link> }
const ITEM_FIELDS = 'nextPageToken, files(id, name, mimeType, size, createdTime, parents, thumbnailLink, appProperties, imageMediaMetadata(time), videoMediaMetadata(durationMillis))';

async function loadAlbumItems(drive, albumId) {
  const hit = _itemsCache.get(albumId);
  if (hit && Date.now() - hit.at < ITEMS_CACHE_MS) return hit;
  const folders = await loadUploaderFolders(drive, albumId);
  const parentIds = [albumId, ...folders.keys()];
  const raw = [];
  // OR 条件が長くなりすぎないよう 20 フォルダずつ
  for (let i = 0; i < parentIds.length; i += 20) {
    const chunk = parentIds.slice(i, i + 20);
    const parentsQ = chunk.map((id) => `'${id}' in parents`).join(' or ');
    let pageToken;
    do {
      const res = await drive.files.list({
        q: `(${parentsQ}) and mimeType!='${FOLDER_MIME}' and trashed=false`,
        fields: ITEM_FIELDS,
        pageSize: 1000,
        pageToken,
        ...DRIVE_LIST_OPTS,
      });
      raw.push(...(res.data.files || []));
      pageToken = res.data.nextPageToken;
    } while (pageToken);
  }
  const items = M.sortMemoryItems(raw.map((f) => M.toMemoryItem(f, folders)).filter(Boolean));
  const thumbs = new Map();
  for (const f of raw) if (f.thumbnailLink) thumbs.set(f.id, f.thumbnailLink);
  const entry = {
    at: Date.now(),
    items,
    uploaders: M.summarizeUploaders(items),
    fileIds: new Set(items.map((it) => it.id)),
    thumbs,
  };
  _itemsCache.set(albumId, entry);
  return entry;
}
function invalidateAlbum(albumId) { _itemsCache.delete(albumId); }

// どのアルバムのファイルかを引く（サムネ・削除で「思い出アルバムの中のファイルか」を確かめる）
async function findAlbumOfFile(drive, fileId) {
  for (const [albumId, entry] of _itemsCache) {
    if (entry.fileIds.has(fileId)) return albumId;
  }
  const rootId = await getMemoriesRootId(drive);
  // 引けない（権限外・共有ドライブの最上位など）ものは「アルバムの外」とみなす
  const parentsOf = async (id) => {
    try {
      return (await drive.files.get({ fileId: id, fields: 'id, parents', supportsAllDrives: true })).data.parents || [];
    } catch (_) {
      return null;
    }
  };
  const fileParents = await parentsOf(fileId);
  for (const parentId of fileParents || []) {
    const pp = await parentsOf(parentId);
    if (!pp) continue;
    if (pp.includes(rootId)) return parentId;                               // アルバム直下
    for (const gp of pp) {                                                  // 投稿者フォルダの中
      const gpp = await parentsOf(gp);
      if (gpp && gpp.includes(rootId)) return gp;
    }
  }
  return null;
}

async function isAdmin(req) {
  try {
    const codes = await getEffectiveRoleCodes(req);
    return roleCodesMatchAny(codes, ['admin']);
  } catch (_) {
    return false;
  }
}

function sendError(res, e, where) {
  const status = e.status || 500;
  if (status >= 500) console.error(`[memories][${where}]`, e.message);
  res.status(status).json({ error: e.message || 'エラーが発生しました' });
}

// =============================================================
// GET /albums — アルバム一覧（初回は既定アルバムを作る）
// =============================================================
router.get('/albums', async (req, res) => {
  try {
    const drive = getDrive();
    const albums = await listAlbums(drive);
    res.json({
      albums: albums.map((a) => ({ id: a.id, name: a.name, created_at: a.createdTime, folder_url: `https://drive.google.com/drive/folders/${a.id}` })),
      can_create: await isAdmin(req),
      max_file_bytes: M.MEMORIES_MAX_FILE_BYTES,
    });
  } catch (e) { sendError(res, e, 'GET albums'); }
});

// POST /albums { name } — アルバムを作る（admin）
router.post('/albums', requireRole('admin'), async (req, res) => {
  try {
    const name = M.normalizeAlbumName(req.body?.name);
    if (!name) return res.status(400).json({ error: 'アルバム名を入力してください' });
    const drive = getDrive();
    const rootId = await getMemoriesRootId(drive);
    const album = await createAlbumFolder(drive, rootId, name);
    res.json({ album: { id: album.id, name: album.name, created_at: album.createdTime, folder_url: `https://drive.google.com/drive/folders/${album.id}` } });
  } catch (e) { sendError(res, e, 'POST albums'); }
});

// GET /albums/:albumId/items — 写真・動画の一覧（撮影日時の新しい順）
router.get('/albums/:albumId/items', async (req, res) => {
  try {
    const drive = getDrive();
    const album = await assertAlbum(drive, req.params.albumId);
    if (req.query.fresh === '1') invalidateAlbum(req.params.albumId);
    const entry = await loadAlbumItems(drive, req.params.albumId);
    res.json({
      album: { id: req.params.albumId, name: album.name, folder_url: `https://drive.google.com/drive/folders/${req.params.albumId}` },
      items: entry.items,
      uploaders: entry.uploaders,
      me: req.user.id,
      can_delete_any: await isAdmin(req),
    });
  } catch (e) { sendError(res, e, 'GET items'); }
});

// POST /albums/:albumId/upload-session { filename, fileSize, mimeType, lastModified }
router.post('/albums/:albumId/upload-session', async (req, res) => {
  try {
    const filename = M.sanitizeMemoryFileName(req.body?.filename);
    const fileSize = Number(req.body?.fileSize);
    let mimeType = String(req.body?.mimeType || '').trim();
    const kind = M.classifyMemoryFile(filename, mimeType);
    if (!kind) return res.status(400).json({ error: '写真か動画のファイルを選んでください' });
    if (!Number.isFinite(fileSize) || fileSize <= 0) return res.status(400).json({ error: 'ファイルサイズが不正です' });
    if (fileSize > M.MEMORIES_MAX_FILE_BYTES) return res.status(400).json({ error: '1ファイル 10GB までです' });
    if (!mimeType) mimeType = 'application/octet-stream';

    const drive = getDrive();
    await assertAlbum(drive, req.params.albumId);
    const folderId = await ensureUploaderFolder(drive, req.params.albumId, req.user.id);

    const appProperties = { hfs_uploader_id: String(req.user.id) };
    const takenAt = M.lastModifiedToIso(req.body?.lastModified);
    if (takenAt) appProperties.hfs_taken_at = takenAt;

    // Drive はセッション発行時の Origin で後続 PUT の CORS を検証するので、ブラウザの Origin を転送する
    const browserOrigin = req.headers.origin
      || (req.headers.referer ? new URL(req.headers.referer).origin : null)
      || `${req.protocol}://${req.get('host')}`;
    const initResp = await fetch(`${RESUMABLE_UPLOAD_BASE}?uploadType=resumable&supportsAllDrives=true`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await getAccessToken()}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': mimeType,
        'X-Upload-Content-Length': String(fileSize),
        Origin: browserOrigin,
      },
      body: JSON.stringify({ name: filename, parents: [folderId], appProperties }),
    });
    if (!initResp.ok) {
      const text = await initResp.text().catch(() => '');
      console.error('[memories] resumable init 失敗:', initResp.status, text.slice(0, 200));
      return res.status(502).json({ error: 'Drive へのアップロード準備に失敗しました' });
    }
    const sessionUrl = initResp.headers.get('location');
    if (!sessionUrl) return res.status(502).json({ error: 'Drive からアップロード先が返りませんでした' });
    res.json({ ok: true, sessionUrl });
  } catch (e) { sendError(res, e, 'POST upload-session'); }
});

// POST /albums/:albumId/upload-complete { driveFileId }
router.post('/albums/:albumId/upload-complete', async (req, res) => {
  try {
    const fileId = String(req.body?.driveFileId || '').trim();
    if (!fileId) return res.status(400).json({ error: 'driveFileId が必要です' });
    const drive = getDrive();
    await assertAlbum(drive, req.params.albumId);
    const meta = (await drive.files.get({ fileId, fields: 'id, appProperties', supportsAllDrives: true })).data;
    if (meta.appProperties?.hfs_uploader_id !== String(req.user.id)) {
      return res.status(403).json({ error: 'このファイルの登録はできません' });
    }
    await grantAnyoneReader(drive, fileId);
    invalidateAlbum(req.params.albumId);
    res.json({ ok: true });
  } catch (e) { sendError(res, e, 'POST upload-complete'); }
});

// GET /items/:fileId/thumb?s=480 — サムネを代理配信（Drive の thumbnailLink は短命なので隠す）
const _thumbLinks = new Map(); // fileId -> { url, at }
router.get('/items/:fileId/thumb', async (req, res) => {
  try {
    const fileId = req.params.fileId;
    const size = Math.min(Math.max(parseInt(req.query.s, 10) || 480, 120), 2000);
    const drive = getDrive();
    let link = _thumbLinks.get(fileId);
    if (!link || Date.now() - link.at > THUMB_LINK_CACHE_MS) {
      const albumId = await findAlbumOfFile(drive, fileId);
      if (!albumId) return res.status(404).end();
      const meta = (await drive.files.get({ fileId, fields: 'thumbnailLink', supportsAllDrives: true })).data;
      if (!meta.thumbnailLink) return res.status(404).end();
      link = { url: meta.thumbnailLink.replace(/=s\d+$/, ''), at: Date.now() };
      _thumbLinks.set(fileId, link);
    }
    const upstream = await fetch(`${link.url}=s${size}`);
    if (!upstream.ok) {
      _thumbLinks.delete(fileId);
      return res.status(404).end();
    }
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'image/jpeg');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.end(Buffer.from(await upstream.arrayBuffer()));
  } catch (e) {
    console.warn('[memories][thumb]', e.message);
    res.status(500).end();
  }
});

// POST /items/:fileId/trash — ゴミ箱へ（投稿した本人 or admin。共有ドライブは完全削除できないのでゴミ箱送り）
router.post('/items/:fileId/trash', async (req, res) => {
  try {
    const fileId = req.params.fileId;
    const drive = getDrive();
    const albumId = await findAlbumOfFile(drive, fileId);
    if (!albumId) return res.status(404).json({ error: 'ファイルが見つかりません' });
    const meta = (await drive.files.get({ fileId, fields: 'id, appProperties', supportsAllDrives: true })).data;
    const isOwner = meta.appProperties?.hfs_uploader_id === String(req.user.id);
    if (!isOwner && !(await isAdmin(req))) {
      return res.status(403).json({ error: '削除できるのは投稿した本人か管理者だけです' });
    }
    await drive.files.update({ fileId, supportsAllDrives: true, requestBody: { trashed: true } });
    invalidateAlbum(albumId);
    res.json({ ok: true });
  } catch (e) { sendError(res, e, 'POST trash'); }
});

module.exports = router;
