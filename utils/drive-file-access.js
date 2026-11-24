// utils/drive-file-access.js — Drive のファイル ID を受け取る API の権限確認まわりの純関数
//
// 背景（2026-11-24）:
//   /files/:fileId/direct-url（動画の直接再生 URL）や /upload-session/complete は
//   ファイル ID を受け取って「リンクを知っている全員が閲覧可」を付ける。
//   受け取った ID が本当にクリエイティブのファイルかを確かめてから処理するための部品。
//   Drive / DB に触る部分は呼び出し側（routes/haruka.js）が持ち、ここは判定だけ。

// Drive のファイル ID として受け付ける形（英数字・_・-）。URL に混ぜても安全な文字だけ。
// ※ _ は LIKE の 1 文字ワイルドカードなので、LIKE に使うときは escapeLikePattern を通す。
const DRIVE_FILE_ID_RE = /^[A-Za-z0-9_-]{10,200}$/;

function isValidDriveFileId(id) {
  return typeof id === 'string' && DRIVE_FILE_ID_RE.test(id);
}

// LIKE パターン用のエスケープ（\ % _ を文字として扱う。Postgres の既定エスケープ文字は \）
function escapeLikePattern(s) {
  return String(s).replace(/[\\%_]/g, (c) => `\\${c}`);
}

const EXT_MIME = {
  mp4: 'video/mp4', m4v: 'video/x-m4v', mov: 'video/quicktime', webm: 'video/webm',
  avi: 'video/x-msvideo', mkv: 'video/x-matroska', mpg: 'video/mpeg', mpeg: 'video/mpeg', wmv: 'video/x-ms-wmv',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  heic: 'image/heic', heif: 'image/heif', bmp: 'image/bmp', svg: 'image/svg+xml', avif: 'image/avif',
};

// ファイル名の拡張子から MIME を推定（分からなければ null）
function guessMimeFromName(name) {
  const m = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  return (m && EXT_MIME[m[1]]) || null;
}

// 直接 URL を出してよい種類か（動画・画像だけ）
function isPlayableMime(mime) {
  return /^(video|image)\//i.test(String(mime || '').trim());
}

// drive_url（https://drive.google.com/file/d/<id>/view...）がこの ID を指しているか（完全一致）
function driveUrlHasFileId(url, id) {
  if (!url || !id) return false;
  const m = String(url).match(/\/d\/([A-Za-z0-9_-]+)/) || String(url).match(/[?&]id=([A-Za-z0-9_-]+)/);
  return !!m && m[1] === id;
}

module.exports = {
  isValidDriveFileId,
  escapeLikePattern,
  guessMimeFromName,
  isPlayableMime,
  driveUrlHasFileId,
};
