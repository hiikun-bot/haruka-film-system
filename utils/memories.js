// utils/memories.js
// =============================================================
// 🎞 思い出アルバム（ADR 052）の純関数。Drive / DB に触らないので jest で直接テストする。
//   - ファイル種別判定（写真 / 動画 / 対象外）
//   - Drive に置くファイル名の最小限の整形（元の名前はそのまま残す）
//   - 撮影日時の解釈（写真の EXIF → ブラウザの lastModified → Drive の作成日時）
//   - Drive の files.list の1行 → 画面に返すアイテムへの変換
// 時刻はすべて JST で扱う（Railway は UTC 動作のため timeZone を明示）。
// =============================================================

// 1ファイルの上限（スマホの長回し 4K でも収まる値。Drive 直送なので Railway は通らない）
const MEMORIES_MAX_FILE_BYTES = 10 * 1024 * 1024 * 1024;

const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'heic', 'heif', 'gif', 'webp', 'dng', 'tif', 'tiff', 'bmp'];
const VIDEO_EXTS = ['mov', 'mp4', 'm4v', '3gp', 'avi', 'mts', 'm2ts', 'mkv', 'webm', 'hevc'];

function extOf(name) {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(String(name || ''));
  return m ? m[1].toLowerCase() : '';
}

// 'image' | 'video' | null（対象外）。iPhone の HEIC などは mime が空で来ることがあるので拡張子でも見る
function classifyMemoryFile(name, mimeType) {
  const mime = String(mimeType || '').toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  const ext = extOf(name);
  if (IMAGE_EXTS.includes(ext)) return 'image';
  if (VIDEO_EXTS.includes(ext)) return 'video';
  return null;
}

// 元のファイル名はそのまま使う。Drive で困る制御文字・前後空白だけ落とし、長すぎる名前は拡張子を残して切る
function sanitizeMemoryFileName(name) {
  let s = String(name || '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!s) s = 'untitled';
  if (s.length > 200) {
    const ext = extOf(s);
    s = ext ? `${s.slice(0, 190)}.${ext}` : s.slice(0, 200);
  }
  return s;
}

// アルバム名（フォルダ名）: 前後空白を落として 60 文字まで。空なら null
function normalizeAlbumName(name) {
  const s = String(name || '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  return s.slice(0, 60);
}

// Drive の imageMediaMetadata.time（カメラのローカル時刻 "2026:10:24 15:30:12"）を JST とみなして ISO へ
function parseExifTime(value) {
  const m = /^(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(value || ''));
  if (!m) return null;
  const [, y, mo, d, h, mi, se] = m;
  if (y === '0000') return null;
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${se}+09:00`;
  return isNaN(new Date(iso).getTime()) ? null : new Date(iso).toISOString();
}

// ブラウザから届く File.lastModified（ミリ秒）→ ISO。ありえない値（未来・2000年以前）は捨てる
function lastModifiedToIso(ms, nowMs = Date.now()) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n < Date.UTC(2000, 0, 1) || n > nowMs + 24 * 3600 * 1000) return null;
  return new Date(n).toISOString();
}

// 撮影日時の優先順位: 写真の EXIF → アップロード時の lastModified → Drive の作成日時
function takenAtOf(file) {
  return parseExifTime(file?.imageMediaMetadata?.time)
    || (file?.appProperties?.hfs_taken_at || null)
    || file?.createdTime
    || null;
}

// ISO → JST の日付キー 'YYYY-MM-DD'
function jstDateKey(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
}

// Drive の files.list の1行 → 画面に返すアイテム。
// uploaderFolders: Map<folderId, { uploader_id, uploader_name }>（アルバム直下の投稿者フォルダ）
function toMemoryItem(file, uploaderFolders) {
  const kind = classifyMemoryFile(file.name, file.mimeType);
  if (!kind) return null;
  const parentId = (file.parents || [])[0] || null;
  const folder = (parentId && uploaderFolders && uploaderFolders.get(parentId)) || {};
  const takenAt = takenAtOf(file);
  return {
    id: file.id,
    name: file.name,
    kind,
    mime_type: file.mimeType || null,
    size: file.size != null ? Number(file.size) : null,
    taken_at: takenAt,
    date_key: jstDateKey(takenAt),
    uploaded_at: file.createdTime || null,
    duration_ms: file.videoMediaMetadata?.durationMillis != null ? Number(file.videoMediaMetadata.durationMillis) : null,
    has_thumb: !!file.thumbnailLink,
    // Drive に直接入れたファイルは appProperties が無いので、投稿者はフォルダから引く
    uploader_id: file.appProperties?.hfs_uploader_id || folder.uploader_id || null,
    uploader_name: folder.uploader_name || null,
    folder_id: parentId,
  };
}

// 撮影日時の新しい順（同時刻は名前順で安定させる）
function sortMemoryItems(items) {
  return [...items].sort((a, b) => {
    const ta = a.taken_at ? Date.parse(a.taken_at) : 0;
    const tb = b.taken_at ? Date.parse(b.taken_at) : 0;
    if (tb !== ta) return tb - ta;
    return String(a.name).localeCompare(String(b.name));
  });
}

// 投稿者ごとの件数（チップ表示用）。多い順
function summarizeUploaders(items) {
  const map = new Map();
  for (const it of items) {
    const key = it.folder_id || 'unknown';
    const cur = map.get(key) || { folder_id: it.folder_id, uploader_id: it.uploader_id, uploader_name: it.uploader_name, count: 0 };
    cur.count++;
    map.set(key, cur);
  }
  return [...map.values()].sort((a, b) => b.count - a.count || String(a.uploader_name).localeCompare(String(b.uploader_name)));
}

module.exports = {
  MEMORIES_MAX_FILE_BYTES,
  classifyMemoryFile,
  sanitizeMemoryFileName,
  normalizeAlbumName,
  parseExifTime,
  lastModifiedToIso,
  takenAtOf,
  jstDateKey,
  toMemoryItem,
  sortMemoryItems,
  summarizeUploaders,
};
