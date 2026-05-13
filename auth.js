// auth.js — 認証設定（Supabase永続化版）
const passport      = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const bcrypt         = require('bcryptjs');
const supabase       = require('./supabase');
// Stage 0 / Step 2 (ADR 003): ロール判定を user_roles ベースに置換するためのヘルパ群
const rolesUtil = require('./utils/roles');

// ==================== セッションのシリアライズ ====================
passport.serializeUser((user, done) => done(null, user.id));

passport.deserializeUser(async (id, done) => {
  try {
    const { data: user, error } = await supabase
      .from('users').select('*').eq('id', id).maybeSingle();
    if (error) return done(error);
    done(null, user || false);
  } catch(e) { done(e); }
});

// ==================== Local Strategy（メール＋パスワード） ====================
passport.use(new LocalStrategy(
  { usernameField: 'email', passwordField: 'password' },
  async (email, password, done) => {
    try {
      const { data: user, error } = await supabase
        .from('users').select('*').eq('email', email).maybeSingle();

      // Supabase 接続エラー（タイムアウト・サーキットブレーカー open・5xx 等）を
      // 「メールアドレスが見つかりません」として握りつぶさない。
      // login.html はメッセージをそのまま表示するので、ユーザーに状況が伝わる文言を出す。
      if (error) {
        console.warn('[auth/local] supabase error:', error.message);
        return done(null, false, { message: '一時的に接続できません。少し時間をおいて再度お試しください。' });
      }

      if (!user)               return done(null, false, { message: 'メールアドレスが見つかりません' });
      if (!user.password_hash) return done(null, false, { message: 'このアカウントはGoogleログイン専用です' });
      if (!user.is_active)     return done(null, false, { message: 'このアカウントは無効化されています' });

      const ok = await bcrypt.compare(password, user.password_hash);
      if (!ok) return done(null, false, { message: 'パスワードが正しくありません' });

      done(null, user);
    } catch(e) { done(e); }
  }
));

// ==================== 認証ミドルウェア ====================
function requireAuth(req, res, next) {
  if (req.isAuthenticated()) return next();
  if (req.xhr || req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'ログインが必要です', redirect: '/login.html' });
  }
  // 通知 URL（例: /haruka.html?creative=xxx）を踏んで未ログインだった場合、
  // ログイン後に元の URL へ戻れるよう ?next= に originalUrl を保持する。
  // GET 以外、または originalUrl が /haruka.html 以外（オープンリダイレクト防止）
  // の場合は素朴に /login.html へ。
  const originalUrl = req.originalUrl || '';
  if (req.method === 'GET' && /^\/haruka\.html(\?|$)/.test(originalUrl)) {
    return res.redirect('/login.html?next=' + encodeURIComponent(originalUrl));
  }
  res.redirect('/login.html');
}

/**
 * Stage 0 / Step 2 (ADR 003): user_roles ベースの requireRole。
 *
 * 旧: req.user.role が allowedRoles に含まれるかの単純比較。
 * 新: ユーザーの "実効ロール集合" (X-View-As 反映) と allowedRoles の集合一致判定。
 *
 * 互換ルール:
 *   - allowedRoles に 'producer_director' を指定した場合、producer + director を
 *     両方持つユーザーも通す
 *   - allowedRoles に 'producer' / 'director' を指定した場合、合成値 'producer_director' を
 *     持つユーザーも通す
 *   - dual-read fallback: user_roles が空の場合は users.role を 1 ロールとして解釈
 *
 * 例: requireRole('admin','secretary') → admin or secretary を持つユーザーのみ通る
 */
function requireRole(...allowedRoles) {
  return async (req, res, next) => {
    if (!req.isAuthenticated()) return res.status(401).json({ error: 'ログインが必要です' });
    try {
      const codes = await rolesUtil.getEffectiveRoleCodes(req, { isSuperAdminUser });
      if (rolesUtil.roleCodesMatchAny(codes, allowedRoles)) return next();
      return res.status(403).json({ error: 'この操作の権限がありません' });
    } catch (e) {
      console.error('[AUTH] requireRole failed:', e.message);
      return res.status(500).json({ error: '権限判定に失敗しました' });
    }
  };
}

const ROLES = {
  ADMIN: 'admin', SECRETARY: 'secretary', DIRECTOR: 'director',
  EDITOR: 'editor', CLIENT: 'client',
};

/**
 * Stage 0 / Step 2 (ADR 003): user_roles ベースの requireLevel。
 *
 * 旧: req.user.role の level と minRole の level を直接比較。
 * 新: ユーザーが持つ "全ロールの最大 level" と minRole の level を比較。
 *     producer_director を持つ場合は producer / director の最大 level を取る。
 *     level マッピングは utils/roles.js#ROLE_LEVEL（マスタ拡張は将来課題）。
 */
function requireLevel(minRole) {
  return async (req, res, next) => {
    if (!req.isAuthenticated()) return res.status(401).json({ error: 'ログインが必要です' });
    try {
      const codes = await rolesUtil.getEffectiveRoleCodes(req, { isSuperAdminUser });
      const userMax = rolesUtil.getMaxRoleLevel(codes);
      const required = rolesUtil.getRoleLevel(minRole);
      if (required <= 0) {
        // 未知の minRole は安全側で deny
        return res.status(500).json({ error: 'ロール level の定義に誤りがあります' });
      }
      if (userMax >= required) return next();
      return res.status(403).json({ error: '権限が不足しています' });
    } catch (e) {
      console.error('[AUTH] requireLevel failed:', e.message);
      return res.status(500).json({ error: '権限判定に失敗しました' });
    }
  };
}

// 最高管理者（admin かつ SUPER_ADMIN_EMAILS にメール一致）のみ通過
const SUPER_ADMIN_EMAILS = (process.env.SUPER_ADMIN_EMAILS || 'hiikun.ascs@gmail.com,satoru.takahashi@haruka-film.com')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
function isSuperAdminUser(user) {
  if (!user) return false;
  if (user.role !== 'admin') return false;
  return SUPER_ADMIN_EMAILS.includes((user.email || '').toLowerCase());
}
function requireSuperAdmin(req, res, next) {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'ログインが必要です' });
  if (!isSuperAdminUser(req.user)) return res.status(403).json({ error: '最高管理者のみ実行できます' });
  next();
}

// ==================== VIEW AS（X-View-As ヘッダ）解決 ====================
// 受け取れる preview ロール一覧。ここに無い文字列は無視（実ロールにフォールバック）。
//
// Stage 0 / Step 2 (ADR 003): roles マスタ参照に揃えるため utils/roles.js の
// VALID_PREVIEW_ROLES と同一集合を保つ。ここはハードコードのまま残すが、
// utils/roles.js 側と同期している前提（差分が出たら片方を更新したら両方を見直す）。
const VALID_PREVIEW_ROLES = rolesUtil.VALID_PREVIEW_ROLES;

/**
 * リクエストの "実効ロール" を **単一文字列で** 返す（同期API、互換用）。
 *
 * セキュリティ仕様:
 *   - X-View-As ヘッダはリクエスト元が **最高管理者 (isSuperAdminUser)** の場合に限り尊重する。
 *   - それ以外（一般ユーザーが偽造）は完全に無視し、実ユーザーのロールを返す。
 *   - ヘッダ値が VALID_PREVIEW_ROLES に含まれない場合も無視。
 *
 * 注意:
 *   - これは **同期版** で、互換のため `req.user.role` (旧 TEXT 列) をそのまま返す。
 *   - 認可判定の正本は utils/roles.js#getEffectiveRoleCodes (async, user_roles ベース) に移行中。
 *   - 新規コードは `getEffectiveRolePrimary(req)` (async) または `getEffectiveRoleCodes(req)` を使う。
 *   - dual-read fallback として残す。Stage 0 Step 3 で users.role 列廃止時にここも書き換える。
 */
function getEffectiveRole(req) {
  if (!req || !req.user) return null;
  const headerRole = String((req.headers && req.headers['x-view-as']) || '').trim().toLowerCase();
  if (headerRole && VALID_PREVIEW_ROLES.has(headerRole) && isSuperAdminUser(req.user)) {
    return headerRole;
  }
  return req.user.role;
}

/**
 * リクエストの "実効ロール" を **単一プライマリコード** で返す（async版）。
 *
 * - user_roles 経由で実ロール集合を取り、`pickPrimaryRoleCode` で互換用の単一値に畳む。
 * - X-View-As ヘッダは最高管理者のみ尊重（VALID_PREVIEW_ROLES 内のみ）。
 *   producer_director プレビュー時は ['producer','director'] に展開された後、
 *   pickPrimaryRoleCode で再度 'producer_director' に戻る（合成値の互換挙動）。
 *
 * 利用シーン: 既存の同期版 getEffectiveRole から段階的に置き換える際、
 *   呼び出し側を await 化できるなら新規コードはこちらを使う。
 */
async function getEffectiveRolePrimary(req) {
  if (!req || !req.user) return null;
  const codes = await rolesUtil.getEffectiveRoleCodes(req, { isSuperAdminUser });
  return rolesUtil.pickPrimaryRoleCode(codes);
}

/**
 * リクエストの "実効ロール" を **コード配列** で返す（async版、構造体寄り）。
 * 新規コード推奨API。`{ codes }` の形でラップしたい場合は呼び出し側で。
 */
async function getEffectiveRoleCodes(req) {
  return rolesUtil.getEffectiveRoleCodes(req, { isSuperAdminUser });
}

// ==================== DB駆動の権限チェック ====================
// Stage 0 / Step 2 (ADR 003): role_permissions の読み込みを dual-read 化。
//   - 新: role_permissions.role_id (UUID) → roles JOIN でコードを得る
//   - 旧: role_permissions.role TEXT (合成値 'producer_director' を含む)
// 両方を読み、ロールコードと permission_key の組み合わせでキャッシュする。
// 合成値 'producer_director' の TEXT 行は role_id NULL のまま残っているため、
// role TEXT 経由でしか引けない。これを producer / director の和集合として
// 扱うのは utils/roles.js#roleCodesHavePermission 側で吸収する。
let _permsCache = null; // Map<"code|key", boolean>
let _permsLoadedAt = 0;
const PERMS_TTL_MS = 60 * 1000; // 60秒

async function loadPermissions(force = false) {
  if (!force && _permsCache && Date.now() - _permsLoadedAt < PERMS_TTL_MS) return _permsCache;
  try {
    const { data, error } = await supabase
      .from('role_permissions').select('role, permission_key, allowed, role_id, roles(code)');
    if (error) throw error;
    const map = new Map();
    (data || []).forEach(r => {
      // role_id 由来のコード（マスタ参照）と、旧 role TEXT 値の両方をキーに登録。
      // 'producer_director' は roles マスタに無いため、TEXT 値経由で残る。
      const codeFromId = r.roles && r.roles.code;
      const codeFromText = r.role;
      const codes = [codeFromId, codeFromText].filter(Boolean);
      for (const c of codes) {
        const key = `${c}|${r.permission_key}`;
        // 既存が true なら維持（複数行ある場合の OR 集約）
        if (map.get(key) !== true) map.set(key, !!r.allowed);
      }
    });
    _permsCache = map;
    _permsLoadedAt = Date.now();
  } catch(e) {
    console.error('[PERMS] load failed:', e.message);
    if (!_permsCache) _permsCache = new Map();
  }
  return _permsCache;
}

function invalidatePermissionsCache() {
  _permsLoadedAt = 0;
}

/**
 * ロールコード起点の permission チェック。
 * - 互換のため、旧 'producer_director' 値が渡された場合は producer + director の
 *   和集合として解釈する（合成値の TEXT 行が直接 hit する経路も残す）
 * - admin は常に許可（ロックアウト防止）
 */
async function userHasPermission(userRole, key) {
  if (!userRole || !key) return false;
  if (userRole === 'admin') return true; // ロックアウト防止
  const perms = await loadPermissions();
  // 1) 渡されたコードそのまま（旧 'producer_director' を含む）
  if (perms.get(`${userRole}|${key}`) === true) return true;
  // 2) producer_director を持っているユーザーは producer/director 設定も継承
  if (userRole === 'producer_director') {
    if (perms.get(`producer|${key}`) === true) return true;
    if (perms.get(`director|${key}`) === true) return true;
  }
  // 3) 逆に producer / director を持つユーザーは合成値の TEXT 行（移行期に残る）も適用
  if (userRole === 'producer' || userRole === 'director') {
    if (perms.get(`producer_director|${key}`) === true) return true;
  }
  return false;
}

function requirePermission(key) {
  return async (req, res, next) => {
    if (!req.isAuthenticated()) return res.status(401).json({ error: 'ログインが必要です' });
    try {
      // Stage 0 Step 2 (ADR 003): user_roles ベースの判定を優先。
      //   1) X-View-As 反映で実効ロールコード集合を取得
      //   2) 集合に対して role_permissions(role_id) JOIN ベースで判定
      //   3) 集合が空（dual-read fallback）の場合は旧 req.user.role での単発判定にフォールバック
      const codes = await rolesUtil.getEffectiveRoleCodes(req, { isSuperAdminUser });
      let ok = false;
      if (codes.length > 0) {
        ok = await rolesUtil.roleCodesHavePermission(codes, key);
      } else {
        const effectiveRole = getEffectiveRole(req); // 旧経路
        ok = await userHasPermission(effectiveRole, key);
      }
      if (ok) return next();
      return res.status(403).json({ error: 'この操作の権限がありません' });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  };
}

module.exports = {
  passport,
  requireAuth,
  requireRole,
  requireLevel,
  requirePermission,
  requireSuperAdmin,
  userHasPermission,
  isSuperAdminUser,
  // 互換: 単一文字列を返す同期版（既存呼び出し側との互換のため残す）
  getEffectiveRole,
  // 新: user_roles ベースの async ヘルパ群（routes 側を順次置換）
  getEffectiveRolePrimary,
  getEffectiveRoleCodes,
  invalidatePermissionsCache,
  ROLES,
};
