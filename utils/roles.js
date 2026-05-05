// utils/roles.js
// =====================================================
// ロールマスタ参照ヘルパ（Stage 0 / Step 2: dual-read 期間用）
// ADR 003: docs/design/decisions/003-roles-as-master-data.md
//
// このモジュールは「コードから user_roles / roles / role_permissions(role_id) を
// 読みに行く」入口を一本化する。dual-read 期間中は `users.role` 列も並走で
// 残るが、認可判定は順次このモジュール経由に切り替えていく。
//
// 主要 API:
//   - getRolesMap()                  : code -> {id, code, label, ...} を返す（短期キャッシュ）
//   - getUserRoleCodes(userId)       : ユーザーが持つ全ロールコード（小文字スネーク）配列
//   - userHasRole(userId, code)      : 単一ロール保有チェック
//   - isProducerDirector(userId)     : producer + director を両方持つか（合成値の代替）
//   - getUsersRolesMap(userIds)      : N+1 回避用の一括取得
//   - getEffectiveRoleCodes(req)     : リクエストの実効ロール集合（X-View-As 反映）
//   - userHasPermission(userId, key) : role_permissions(role_id) JOIN ベースで判定
//                                      合成値 'producer_director' の TEXT 行は
//                                      producer + director の和集合として解釈する
// =====================================================

const supabase = require('../supabase');

// ---------- ロールマスタの軽量キャッシュ ----------
let _rolesCache = null;        // Map<code, row>
let _rolesByIdCache = null;    // Map<id, row>
let _rolesLoadedAt = 0;
const ROLES_TTL_MS = 60 * 1000;

async function loadRoles(force = false) {
  if (!force && _rolesCache && Date.now() - _rolesLoadedAt < ROLES_TTL_MS) {
    return { byCode: _rolesCache, byId: _rolesByIdCache };
  }
  try {
    const { data, error } = await supabase
      .from('roles')
      .select('id, code, label, category, sort_order, is_creator, is_internal, archived_at');
    if (error) throw error;
    const byCode = new Map();
    const byId = new Map();
    (data || []).forEach(r => {
      byCode.set(r.code, r);
      byId.set(r.id, r);
    });
    _rolesCache = byCode;
    _rolesByIdCache = byId;
    _rolesLoadedAt = Date.now();
  } catch (e) {
    console.error('[ROLES] load failed:', e.message);
    if (!_rolesCache) {
      _rolesCache = new Map();
      _rolesByIdCache = new Map();
    }
  }
  return { byCode: _rolesCache, byId: _rolesByIdCache };
}

function invalidateRolesCache() {
  _rolesLoadedAt = 0;
}

async function getRolesMap() {
  const { byCode } = await loadRoles();
  return byCode;
}

// ---------- ユーザーロール取得 ----------

/**
 * 指定ユーザーが持つロールコードの配列（重複なし、sort_order 昇順）。
 * user_roles JOIN roles ベース。マイグレーション未済の本番では空配列が返る可能性があるため、
 * 呼び出し側は dual-read としてフォールバック判定（users.role）を併用すること。
 */
async function getUserRoleCodes(userId) {
  if (!userId) return [];
  const { data, error } = await supabase
    .from('user_roles')
    .select('role_id, roles(code, sort_order)')
    .eq('user_id', userId);
  if (error) {
    console.error('[ROLES] getUserRoleCodes failed:', error.message);
    return [];
  }
  const rows = (data || [])
    .map(r => r.roles)
    .filter(Boolean)
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  // 重複除去
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    if (!seen.has(r.code)) { seen.add(r.code); out.push(r.code); }
  }
  return out;
}

async function userHasRole(userId, code) {
  if (!userId || !code) return false;
  const codes = await getUserRoleCodes(userId);
  return codes.includes(code);
}

async function isProducerDirector(userId) {
  const codes = await getUserRoleCodes(userId);
  return codes.includes('producer') && codes.includes('director');
}

/**
 * 複数ユーザーの roles を 1 クエリで取得する（N+1 回避）。
 * 戻り値: Map<userId, string[]>（コード配列、sort_order 昇順）
 */
async function getUsersRolesMap(userIds) {
  const result = new Map();
  if (!Array.isArray(userIds) || userIds.length === 0) return result;
  const ids = Array.from(new Set(userIds.filter(Boolean)));
  if (ids.length === 0) return result;

  const { data, error } = await supabase
    .from('user_roles')
    .select('user_id, roles(code, sort_order)')
    .in('user_id', ids);
  if (error) {
    console.error('[ROLES] getUsersRolesMap failed:', error.message);
    return result;
  }
  for (const id of ids) result.set(id, []);
  for (const row of (data || [])) {
    if (!row.roles) continue;
    const list = result.get(row.user_id) || [];
    list.push(row.roles);
    result.set(row.user_id, list);
  }
  // sort + 重複除去
  for (const [k, v] of result.entries()) {
    v.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
    const seen = new Set();
    const codes = [];
    for (const r of v) {
      if (!seen.has(r.code)) { seen.add(r.code); codes.push(r.code); }
    }
    result.set(k, codes);
  }
  return result;
}

// ---------- 実効ロール（X-View-As 対応） ----------

/**
 * リクエストの "実効ロール集合" を返す（配列、sort_order 昇順）。
 * - X-View-As ヘッダは最高管理者のみ尊重（VALID_PREVIEW_ROLES に含まれる場合）
 *   - 'producer_director' プレビュー時は ['producer','director'] に展開
 * - 通常時は user_roles を読み、空ならフォールバックで users.role を 1 要素として返す
 *   （dual-read 期間の安全策）
 */
const VALID_PREVIEW_ROLES = new Set([
  'admin', 'secretary', 'producer', 'producer_director',
  'director', 'editor', 'designer',
]);

function _expandPreviewRole(code) {
  if (code === 'producer_director') return ['producer', 'director'];
  return [code];
}

async function getEffectiveRoleCodes(req, { isSuperAdminUser } = {}) {
  if (!req || !req.user) return [];
  const headerRole = String((req.headers && req.headers['x-view-as']) || '').trim().toLowerCase();
  if (headerRole && VALID_PREVIEW_ROLES.has(headerRole)
      && typeof isSuperAdminUser === 'function' && isSuperAdminUser(req.user)) {
    return _expandPreviewRole(headerRole);
  }
  // user_roles から取得
  const codes = await getUserRoleCodes(req.user.id);
  if (codes.length > 0) return codes;
  // dual-read fallback: 旧 users.role
  const legacy = req.user.role;
  if (!legacy) return [];
  return _expandPreviewRole(legacy);
}

// ---------- 権限チェック（role_permissions JOIN ベース） ----------
// dual-read 期間: role_permissions.role_id (新) と role_permissions.role TEXT (旧) の
// どちらも読む。合成値 'producer_director' は role_id NULL なので role TEXT 列で拾う。
//
// 戻り値の集約方針:
//   ユーザーが持つ "ロール集合" の和集合で permission を解釈。
//   いずれか一つのロールが allowed=true ならその permission を許可する。

let _permsByCodeCache = null; // Map<"code|key", boolean>  (codeはロールコードまたは旧TEXT値)
let _permsLoadedAt = 0;
const PERMS_TTL_MS = 60 * 1000;

async function loadPermissionsByCode(force = false) {
  if (!force && _permsByCodeCache && Date.now() - _permsLoadedAt < PERMS_TTL_MS) {
    return _permsByCodeCache;
  }
  try {
    // role_id 経由（roles JOIN）と、role TEXT を両方読む。
    // 同じ key で role_id 行と role TEXT 行が両方あれば、どちらかが allowed なら true 扱い。
    const { data, error } = await supabase
      .from('role_permissions')
      .select('role, permission_key, allowed, role_id, roles(code)');
    if (error) throw error;
    const map = new Map();
    for (const row of (data || [])) {
      // role_id 由来のコード（あれば優先）
      const codeFromId = row.roles && row.roles.code;
      const codeFromText = row.role;
      // どちらでも引けるよう両方に登録
      const codes = [codeFromId, codeFromText].filter(Boolean);
      for (const c of codes) {
        const key = `${c}|${row.permission_key}`;
        // 既存値が true なら維持（OR 的な集約）
        if (map.get(key) !== true) map.set(key, !!row.allowed);
      }
    }
    _permsByCodeCache = map;
    _permsLoadedAt = Date.now();
  } catch (e) {
    console.error('[PERMS] loadPermissionsByCode failed:', e.message);
    if (!_permsByCodeCache) _permsByCodeCache = new Map();
  }
  return _permsByCodeCache;
}

function invalidatePermissionsCache() {
  _permsLoadedAt = 0;
}

/**
 * ロールコード集合に対する permission チェック。
 * - admin を含む場合は常に true（ロックアウト防止、auth.js の挙動を踏襲）
 * - 'producer_director' を直接渡された場合は ['producer','director'] の和集合として扱う
 */
async function roleCodesHavePermission(codes, key) {
  if (!Array.isArray(codes) || codes.length === 0 || !key) return false;
  // 旧 'producer_director' を渡された場合の互換: 展開して合算
  const expanded = [];
  for (const c of codes) {
    if (c === 'producer_director') expanded.push('producer', 'director');
    else expanded.push(c);
  }
  if (expanded.includes('admin')) return true;
  const perms = await loadPermissionsByCode();
  for (const code of expanded) {
    if (perms.get(`${code}|${key}`) === true) return true;
    // dual-read: 'producer_director' の TEXT 行も拾う（合成値の権限を保持する移行期）
    // producer / director どちらかを持つユーザーには producer_director 設定の許可も適用する
    if ((code === 'producer' || code === 'director')
        && perms.get(`producer_director|${key}`) === true) {
      return true;
    }
  }
  return false;
}

/**
 * userId 起点の permission チェック。Step 2 のメインAPI。
 * Step 3 以降、ルートをこの関数経由に置き換えていく。
 */
async function userHasPermission(userId, key) {
  if (!userId || !key) return false;
  const codes = await getUserRoleCodes(userId);
  if (codes.length === 0) return false; // フォールバックは呼び出し側で
  return roleCodesHavePermission(codes, key);
}

module.exports = {
  // ロールマスタ
  getRolesMap,
  loadRoles,
  invalidateRolesCache,
  // ユーザーロール
  getUserRoleCodes,
  userHasRole,
  isProducerDirector,
  getUsersRolesMap,
  // 実効ロール（X-View-As）
  getEffectiveRoleCodes,
  VALID_PREVIEW_ROLES,
  // 権限
  loadPermissionsByCode,
  invalidatePermissionsCache,
  roleCodesHavePermission,
  userHasPermission,
};
