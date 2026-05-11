// lib/video-organization/heic.js — HEIC → JPEG 変換ヘルパー
//
// iPhone カメラの heic/heif は Gemini が直接読めないので、アップロード時に
// JPEG へ変換してから Drive に保存する。
//
// 採用ライブラリ: `heic-convert`（pure JS, sharp 不要）
//   - sharp は libvips の native build が必要で Railway / macOS で詰まりがち
//   - heic-convert は依存軽め
//
// 未インストールでも HEIC 以外のアップロードは動くようにする（dynamic require + 明示エラー）。

function isHeic(mimeType, filename) {
  const mt = String(mimeType || '').toLowerCase();
  const fn = String(filename || '').toLowerCase();
  return mt === 'image/heic' || mt === 'image/heif' || fn.endsWith('.heic') || fn.endsWith('.heif');
}

async function convertHeicToJpeg(buffer) {
  let convert;
  try {
    convert = require('heic-convert');
  } catch (e) {
    throw new Error('heic-convert が未インストールです。`npm install heic-convert` を実行してください。');
  }
  const outputBuffer = await convert({
    buffer,
    format: 'JPEG',
    quality: 0.9,
  });
  return Buffer.from(outputBuffer);
}

// アップロードフォルダ用に「拡張子を jpg に置換した」ファイル名を返す。
function jpegFilenameFor(originalFilename) {
  const safe = String(originalFilename || 'photo').replace(/\.(heic|heif)$/i, '');
  return safe + '.jpg';
}

module.exports = { isHeic, convertHeicToJpeg, jpegFilenameFor };
