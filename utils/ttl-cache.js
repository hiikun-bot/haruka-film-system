// utils/ttl-cache.js
// =====================================================
// 汎用 in-memory TTL キャッシュ
//
// utils/roles.js のロールマスタキャッシュ（loadRoles / loadPermissionsByCode）と
// 同じ「短期 TTL + 書き込み時 invalidate」パターンを、マスタ系 GET エンドポイント
// 全般で使い回せるように汎用化したもの。
//
// 使い方:
//   const { ttlCache, invalidateByKey, invalidateByPrefix } = require('../utils/ttl-cache');
//   const data = await ttlCache('categories:active', 30 * 1000, async () => {
//     ...Supabase から取得してレスポンス payload を返す...
//   });
//   // POST/PUT/DELETE 側で:
//   invalidateByPrefix('categories:');
//
// 注意:
//   - loaderFn が throw した場合は何もキャッシュしない（エラーレスポンスを
//     TTL の間返し続ける事故を防ぐ）。
//   - ユーザー・ロールによってレスポンスが変わるエンドポイントには使わないこと
//     （他ユーザーの結果を返してしまう＝権限漏洩になる）。
//   - クエリパラメータでレスポンスが変わる場合は必ずキーに含めること。
// =====================================================

const _store = new Map(); // key -> { value, expiresAt }

// キー空間の暴走（不正な query param 連打等）でメモリが無限に伸びないための上限。
// マスタ系の正規キーは高々数十個なので、十分すぎる余裕を持たせている。
const MAX_ENTRIES = 500;

function _sweepExpired() {
  const now = Date.now();
  for (const [key, entry] of _store) {
    if (entry.expiresAt <= now) _store.delete(key);
  }
}

/**
 * key に対応するキャッシュ値を返す。期限切れ・未登録なら loaderFn() を実行して
 * 結果を ttlMs ミリ秒キャッシュする。
 * @param {string} key       キャッシュキー（クエリパラメータ依存があればキーに含める）
 * @param {number} ttlMs     キャッシュ保持時間（ミリ秒）
 * @param {Function} loaderFn 値を取得する async 関数
 */
async function ttlCache(key, ttlMs, loaderFn) {
  const hit = _store.get(key);
  if (hit && Date.now() < hit.expiresAt) return hit.value;
  const value = await loaderFn(); // throw 時はキャッシュせず呼び出し元へ伝播
  if (_store.size >= MAX_ENTRIES) {
    _sweepExpired();
    if (_store.size >= MAX_ENTRIES) _store.clear(); // それでも溢れるなら全捨て（安全側）
  }
  _store.set(key, { value, expiresAt: Date.now() + ttlMs });
  return value;
}

/** 完全一致キーを invalidate する */
function invalidateByKey(key) {
  _store.delete(key);
}

/** prefix で始まる全キーを invalidate する（パラメータ付きキーの一括破棄用） */
function invalidateByPrefix(prefix) {
  for (const key of _store.keys()) {
    if (key.startsWith(prefix)) _store.delete(key);
  }
}

/** 全キャッシュを破棄する（テスト・緊急用） */
function invalidateAll() {
  _store.clear();
}

module.exports = {
  ttlCache,
  invalidateByKey,
  invalidateByPrefix,
  invalidateAll,
};
