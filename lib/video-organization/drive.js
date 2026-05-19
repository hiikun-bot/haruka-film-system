// lib/video-organization/drive.js — Google Drive メタ取得 + ダウンロードヘルパー
//
// 認証は既存 lib/drive-share.js と同じパターンで GOOGLE_SERVICE_ACCOUNT_KEY を流用。
// 別キーに差し替えたい場合は VERTEX_AI_SERVICE_ACCOUNT_KEY 等を別途用意するが、
// 今回の MVP では同一キーで Vertex AI も叩く前提。

const { google } = require('googleapis');

function getCredentials() {
  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!keyJson) throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY が設定されていません');
  return JSON.parse(keyJson);
}

async function getDriveService() {
  const auth = new google.auth.GoogleAuth({
    credentials: getCredentials(),
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  return google.drive({ version: 'v3', auth });
}

// Drive 上の動画ファイルメタを取得する。
// videoMediaMetadata.durationMillis から動画時間 (秒) を返すので
// ffprobe を介さず長さ判定が可能。
async function getVideoFileMeta(fileId) {
  const drive = await getDriveService();
  const { data } = await drive.files.get({
    fileId,
    fields: [
      'id', 'name', 'mimeType', 'size',
      'createdTime', 'modifiedTime', 'webViewLink',
      'parents', 'videoMediaMetadata'
    ].join(','),
    supportsAllDrives: true,
  });
  const durationMillis = data?.videoMediaMetadata?.durationMillis
    ? Number(data.videoMediaMetadata.durationMillis) : null;
  return {
    fileId: data.id,
    fileName: data.name,
    mimeType: data.mimeType,
    size: data.size ? Number(data.size) : null,
    createdTime: data.createdTime,
    modifiedTime: data.modifiedTime,
    webViewLink: data.webViewLink,
    parents: data.parents || [],
    durationSeconds: durationMillis !== null ? Math.round(durationMillis / 1000) : null,
  };
}

// 親フォルダ名を取得（先頭の parent のみ）。
async function getParentFolderName(parentId) {
  if (!parentId) return null;
  const drive = await getDriveService();
  try {
    const { data } = await drive.files.get({
      fileId: parentId,
      fields: 'id,name',
      supportsAllDrives: true,
    });
    return data?.name || null;
  } catch (_) {
    return null;
  }
}

// Drive 上のファイルをメモリにダウンロードする（base64 で Gemini に渡す用）。
// 大きすぎる動画はメモリ事故になるので、呼び出し側で size を必ずチェックすること。
async function downloadFileBuffer(fileId) {
  const drive = await getDriveService();
  const res = await drive.files.get(
    { fileId, alt: 'media', supportsAllDrives: true },
    { responseType: 'arraybuffer' }
  );
  return Buffer.from(res.data);
}

// Drive にメディアをアップロードする（素材広場アップロードフォルダ宛て）。
// 戻り値: { fileId, fileName, mimeType, size, webViewLink, parents }
async function uploadFile({ buffer, filename, mimeType, parentFolderId }) {
  if (!parentFolderId) throw new Error('parentFolderId が未指定');
  const drive = await getDriveService();
  const { Readable } = require('stream');
  const res = await drive.files.create({
    requestBody: {
      name: filename,
      parents: [parentFolderId],
      mimeType,
    },
    media: {
      mimeType,
      body: Readable.from(buffer),
    },
    fields: 'id,name,mimeType,size,webViewLink,parents,videoMediaMetadata,thumbnailLink,createdTime,modifiedTime',
    supportsAllDrives: true,
  });
  const data = res.data || {};
  const durationMillis = data?.videoMediaMetadata?.durationMillis
    ? Number(data.videoMediaMetadata.durationMillis) : null;
  return {
    fileId: data.id,
    fileName: data.name,
    mimeType: data.mimeType,
    size: data.size ? Number(data.size) : (buffer ? buffer.length : null),
    webViewLink: data.webViewLink,
    parents: data.parents || [],
    durationSeconds: durationMillis !== null ? Math.round(durationMillis / 1000) : null,
    thumbnailLink: data.thumbnailLink || null,
    createdTime: data.createdTime,
    modifiedTime: data.modifiedTime,
  };
}

// プレビュープロキシ用: Drive からのストリームを Range ヘッダ対応で読み取る。
// 戻り値: { stream, headers: {content-type, content-length, ...} }
//   range = "bytes=0-99" 形式 or null
async function getFileStream(fileId, range) {
  const drive = await getDriveService();
  const reqOpts = { responseType: 'stream' };
  if (range) {
    reqOpts.headers = { Range: range };
  }
  const res = await drive.files.get(
    { fileId, alt: 'media', supportsAllDrives: true },
    reqOpts
  );
  return {
    stream: res.data,
    status: res.status || 200,
    headers: res.headers || {},
  };
}

// Drive 上のファイルを削除する。
//   - 例外は再 throw しない。失敗詳細（status / reason / message）を構造化して返す。
//   - { client } を渡すと SA ではなく任意の Drive クライアントで叩く（ユーザーOAuth でのリトライ用）。
//
// 戻り値:
//   成功時: { ok: true, status: 204 }
//   失敗時: { ok: false, status: 404|403|401|5xx|null, reason: 'notFound'|'insufficientFilePermissions'|null, message }
//
// 旧 API（boolean を期待していた呼び出し側）は result.ok で判定するよう更新済み。
async function deleteFile(fileId, { client } = {}) {
  try {
    const drive = client || (await getDriveService());
    await drive.files.delete({ fileId, supportsAllDrives: true });
    return { ok: true, status: 204 };
  } catch (e) {
    const status = e?.code || e?.response?.status || null;
    const reason = e?.errors?.[0]?.reason
      || e?.response?.data?.error?.errors?.[0]?.reason
      || null;
    console.warn('[video-org] drive deleteFile failed:', fileId, status, reason, e.message);
    return {
      ok: false,
      status,
      reason,
      message: e.message,
    };
  }
}

// ユーザー OAuth の access_token から Drive クライアントを作る。
//   - SA で削除権限がないファイル（drive.file スコープで他者がアップロードしたもの等）を
//     ユーザー本人のトークンでリトライする用途。
function driveClientWithToken(accessToken) {
  if (!accessToken) throw new Error('accessToken required');
  const oauth2 = new google.auth.OAuth2();
  oauth2.setCredentials({ access_token: accessToken });
  return google.drive({ version: 'v3', auth: oauth2 });
}

// thumbnailLink を取得（プレビュー用静止画 URL）
async function getThumbnailLink(fileId) {
  const drive = await getDriveService();
  try {
    const { data } = await drive.files.get({
      fileId,
      fields: 'thumbnailLink',
      supportsAllDrives: true,
    });
    return data?.thumbnailLink || null;
  } catch (_) {
    return null;
  }
}

module.exports = {
  getDriveService,
  getVideoFileMeta,
  getParentFolderName,
  downloadFileBuffer,
  uploadFile,
  deleteFile,
  driveClientWithToken,
  getFileStream,
  getThumbnailLink,
};
