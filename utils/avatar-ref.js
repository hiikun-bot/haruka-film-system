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

// ==================== avatar_url 参照キャッシュ（DB→サーバー間転送対策） ====================
// 上の res.json パッチ（replaceAvatarDataUrls）は「サーバー→ブラウザ」の転送だけを
// 解決していた。DB→サーバー間は、一覧 API が embed で users(avatar_url) を select する度に
// 「行数 × 担当者数 × base64（最大300KB）」が PostgREST から毎回流れてくるため未解決だった
// （/creatives はリクエストあたり数十MB級になりうる）。
//
// 対策: ホットな一覧（GET /creatives, GET /members）では select から avatar_url を外し、
// このキャッシュから「レスポンスに入れる avatar_url の最終値」を注入する。
// ウォームは TTL（10分）に 1 回だけ `select id, avatar_url from users`（not null のみ）を
// 引いて全員分を計算する = 一括転送に集約。ウォーム中の同時リクエストは同一 Promise を
// 共有する（thundering herd 防止）。
//
// Map<userId, string> の値（= 従来レスポンスが res.json パッチ通過後に返していた値と同一形）:
//   - base64 data URL のユーザー → avatarRefUrl(id, avatarVer(dataUrl))（?v= 付き配信 URL）
//   - 万一 data: 以外の文字列が保存されていたユーザー → その文字列をそのまま
//     （replaceAvatarDataUrls も data: 以外は素通しなので従来と同値）
//   - avatar 未設定（null）のユーザー → Map に存在しない（注入側が null にする）
//
// 鮮度: アバター書き込み経路（アップロード/削除）が updateAvatarRefCacheEntry() で即時
// 反映する。他経路で avatar_url が変わっても最大 TTL 分 ver が古いだけで、画像本体は
// /members/:id/avatar が ETag で正しく配信するため実害はない。

const AVATAR_REF_TTL_MS   = 10 * 60 * 1000; // ウォーム間隔（avatar-bin ttlCache と同じ 10 分）
const AVATAR_REF_RETRY_MS = 30 * 1000;      // ウォーム失敗時に古い Map で凌ぐ間の再試行間隔

let _refMap = null;          // Map<userId, avatar_url最終値> | null（未ウォーム）
let _refMapExpiresAt = 0;
let _refWarmPromise = null;  // ウォーム中の共有 Promise

/** avatar_url の生値（data URL / 文字列 / null）からレスポンス用の最終値を計算する */
function _refValue(userId, rawAvatarUrl) {
  if (rawAvatarUrl == null) return null;
  return isAvatarDataUrl(rawAvatarUrl)
    ? avatarRefUrl(userId, avatarVer(rawAvatarUrl))
    : rawAvatarUrl;
}

/**
 * アバター参照 Map（userId -> レスポンス用 avatar_url 値）を返す。
 * TTL 内ならキャッシュ、期限切れなら users を 1 クエリでウォームして更新する。
 * @param {object} supabaseClient supabase クライアント（テスト差し替えのため引数で受ける）
 * @returns {Promise<Map<string, string>>}
 */
async function getAvatarRefMap(supabaseClient) {
  if (_refMap && Date.now() < _refMapExpiresAt) return _refMap;
  if (_refWarmPromise) return _refWarmPromise; // 同時リクエストはウォームを共有
  _refWarmPromise = (async () => {
    try {
      const { data, error } = await supabaseClient
        .from('users')
        .select('id, avatar_url')
        .not('avatar_url', 'is', null);
      if (error) throw new Error(error.message);
      const map = new Map();
      for (const u of (data || [])) {
        if (!u || !u.id) continue;
        const v = _refValue(u.id, u.avatar_url);
        if (v != null) map.set(u.id, v);
      }
      _refMap = map;
      _refMapExpiresAt = Date.now() + AVATAR_REF_TTL_MS;
      return map;
    } catch (e) {
      if (_refMap) {
        // ウォーム失敗時は期限切れの古い Map で継続（ver が古くなるだけ・画像は ETag 配信で正）。
        // 短い間隔で再ウォームを試す。
        _refMapExpiresAt = Date.now() + AVATAR_REF_RETRY_MS;
        return _refMap;
      }
      throw e; // 初回ウォーム失敗はフォールバック不能 → 呼び出し元で処理
    } finally {
      _refWarmPromise = null;
    }
  })();
  return _refWarmPromise;
}

/**
 * アバター書き込み経路（アップロード/削除）からキャッシュエントリを即時更新する。
 * 未ウォームなら何もしない（次のウォームが DB から最新を読む）。
 * @param {string} userId
 * @param {string|null} rawAvatarUrl 保存した avatar_url の生値（削除時は null）
 */
function updateAvatarRefCacheEntry(userId, rawAvatarUrl) {
  if (!_refMap || !userId) return;
  const v = _refValue(userId, rawAvatarUrl);
  if (v == null) _refMap.delete(userId);
  else _refMap.set(userId, v);
}

/**
 * select から avatar_url を外したユーザーオブジェクトに、キャッシュから avatar_url を注入する。
 * アバター未設定（Map に無い）ユーザーは null（従来の null 挙動と同一。フロントはイニシャル表示）。
 * 値は data: で始まらないため res.json パッチ（replaceAvatarDataUrls）を素通りする。
 */
function applyAvatarRef(user, refMap) {
  if (!user || typeof user !== 'object' || Array.isArray(user) || !user.id) return user;
  user.avatar_url = (refMap && refMap.get(user.id)) ?? null;
  return user;
}

/** キャッシュ全破棄（テスト用） */
function invalidateAvatarRefCache() {
  _refMap = null;
  _refMapExpiresAt = 0;
}

module.exports = {
  isAvatarDataUrl,
  avatarVer,
  avatarRefUrl,
  replaceAvatarDataUrls,
  getAvatarRefMap,
  updateAvatarRefCacheEntry,
  applyAvatarRef,
  invalidateAvatarRefCache,
};
