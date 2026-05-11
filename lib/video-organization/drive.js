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

module.exports = {
  getDriveService,
  getVideoFileMeta,
  getParentFolderName,
  downloadFileBuffer,
};
