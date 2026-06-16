// utils/avatar-ref.js
// =====================================================
// アバター参照ヘルパー（転送量対策）
//
// 背景:
//   users.avatar_url には URL ではなく base64 data URL（最大300KB）が保存されている。
//   creatives 一覧 / members / tweets / knowledge 等の API が users(avatar_url) を
//   埋め込んで返すため、同一ユーザーのアバターが行数分 JSON に重複して乗り、
//   gzip でも潰しきれず一覧系レスポンスの転送量の支配項になっていた。
//
// 対策:
//   レスポンス送出直前に base64 data URL を
//     /api/haruka/members/:id/avatar?v=<ver>
//   という軽量なバイナリ配信エンドポイント URL（数十バイト）へ置換する。
//   画像本体はブラウザが <img src> で 1 ユーザー 1 回だけ取得し、
//   Cache-Control + ETag で再取得を抑える（routes/haruka.js 側で実装）。
//
// バージョン（キャッシュバスティング）:
//   migration を避けるため users テーブルに avatar_ver 列は持たず、
//   data URL の「長さ + 先頭256文字 + 末尾64文字」から FNV-1a で軽量ハッシュを
//   計算して ?v= 兼 ETag に使う。アバター更新で data URL が変わる → ver が変わる
//   → URL が変わるので、長期キャッシュでも更新が即反映される。
// =====================================================

/** base64 data URL かどうか（avatar_url に保存される形式） */
function isAvatarDataUrl(v) {
  return typeof v === 'string' && v.startsWith('data:');
}

/**
 * data URL から軽量バージョンハッシュを計算する。
 * 300KB 全文を毎回ハッシュしない（一覧 1 リクエストで数十行 × 300KB になるため）。
 * 「長さ + 先頭 + 末尾」のサンプリングで実用上一意（同一長かつ先頭末尾一致の
 * 別画像はまず発生しない。万一衝突しても表示が 1 世代古くなるだけで実害は軽微）。
 * @returns {string|null} base36 ハッシュ。data URL でなければ null
 */
function avatarVer(dataUrl) {
  if (!isAvatarDataUrl(dataUrl)) return null;
  const sample = dataUrl.length + ':' + dataUrl.slice(0, 256) + ':' + dataUrl.slice(-64);
  let h = 0x811c9dc5; // FNV-1a 32bit
  for (let i = 0; i < sample.length; i++) {
    h ^= sample.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** バイナリ配信エンドポイントの URL を組み立てる */
function avatarRefUrl(userId, ver) {
  return `/api/haruka/members/${userId}/avatar` + (ver ? `?v=${ver}` : '');
}

/**
 * レスポンス payload を再帰的に走査し、avatar_url の base64 data URL を
 * 配信エンドポイント URL に in-place で置換する。
 * - フィールド名は avatar_url のまま（フロントの <img src="${u.avatar_url}"> や
 *   truthiness 判定がそのまま動く）。値だけが 300KB → 数十バイトになる。
 * - 同階層に id（= ユーザー id）が無く URL を組めない場合は null にする
 *   （フロントはイニシャル表示にフォールバック）。base64 を漏らさないことを優先。
 * - data URL でない値（既に URL / null）はそのまま。
 */
function replaceAvatarDataUrls(node) {
  if (!node || typeof node !== 'object') return node;
  if (Buffer.isBuffer(node)) return node;
  if (Array.isArray(node)) {
    for (const item of node) replaceAvatarDataUrls(item);
    return node;
  }
  for (const key of Object.keys(node)) {
    const v = node[key];
    if (key === 'avatar_url' && isAvatarDataUrl(v)) {
      node[key] = node.id ? avatarRefUrl(node.id, avatarVer(v)) : null;
    } else if (v && typeof v === 'object') {
      replaceAvatarDataUrls(v);
    }
  }
  return node;
}

module.exports = { isAvatarDataUrl, avatarVer, avatarRefUrl, replaceAvatarDataUrls };
