// auth.js — 認証設定（Supabase永続化版）
const passport      = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const bcrypt         = require('bcryptjs');
const supabase       = require('./supabase');

// ==================== セッションのシリアライズ ====================
passport.serializeUser((user, done) => done(null, user.id));

passport.deserializeUser(async (id, done) => {
  try {
    const { data: user } = await supabase
      .from('users').select('*').eq('id', id).maybeSingle();
    done(null, user || false);
  } catch(e) { done(e); }
});

// ==================== Local Strategy（メール＋パスワード） ====================
passport.use(new LocalStrategy(
  { usernameField: 'email', passwordField: 'password' },
  async (email, password, done) => {
    try {
      const { data: user } = await supabase
        .from('users').select('*').eq('email', email).maybeSingle();

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

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.isAuthenticated()) return res.status(401).json({ error: 'ログインが必要です' });
    // VIEW AS 中は実効ロールで判定（最高管理者のみ X-View-As が有効）
    const effectiveRole = getEffectiveRole(req);
    if (!roles.includes(effectiveRole)) {
      return res.status(403).json({ error: 'この操作の権限がありません' });
    }
    next();
  };
}

const ROLES = {
  ADMIN: 'admin', SECRETARY: 'secretary', DIRECTOR: 'director',
  EDITOR: 'editor', CLIENT: 'client',
};

const ROLE_LEVEL = { admin: 5, secretary: 4, director: 3, editor: 2, client: 1 };

function requireLevel(minRole) {
  return (req, res, next) => {
    if (!req.isAuthenticated()) return res.status(401).json({ error: 'ログインが必要です' });
    // VIEW AS 中は実効ロールで判定（最高管理者のみ X-View-As が有効）
    const effectiveRole = getEffectiveRole(req);
    if ((ROLE_LEVEL[effectiveRole] || 0) >= (ROLE_LEVEL[minRole] || 99)) return next();
    return res.status(403).json({ error: '権限が不足しています' });
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
const VALID_PREVIEW_ROLES = new Set(['admin','secretary','producer','producer_director','director','editor','designer']);

/**
 * リクエストの "実効ロール" を返す。
 *
 * セキュリティ仕様:
 *   - X-View-As ヘッダはリクエスト元が **最高管理者 (isSuperAdminUser)** の場合に限り尊重する。
 *   - それ以外（一般ユーザーが偽造）は完全に無視し、実ユーザーのロールを返す。
 *   - ヘッダ値が VALID_PREVIEW_ROLES に含まれない場合も無視。
 *
 * 監査・ログ用途で「実際に誰がリクエストしたか」を残す場合は req.user.id / req.user.email を直接参照すること。
 * 認可判定（権限チェック・分岐）にはこのヘルパで取得した実効ロールを使う。
 */
function getEffectiveRole(req) {
  if (!req || !req.user) return null;
  const headerRole = String((req.headers && req.headers['x-view-as']) || '').trim().toLowerCase();
  if (headerRole && VALID_PREVIEW_ROLES.has(headerRole) && isSuperAdminUser(req.user)) {
    return headerRole;
  }
  return req.user.role;
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
      // VIEW AS 中は実効ロールで判定（最高管理者のみ X-View-As が有効）
      const effectiveRole = getEffectiveRole(req);
      const ok = await userHasPermission(effectiveRole, key);
      if (ok) return next();
      return res.status(403).json({ error: 'この操作の権限がありません' });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  };
}

module.exports = { passport, requireAuth, requireRole, requireLevel, requirePermission, requireSuperAdmin, userHasPermission, isSuperAdminUser, getEffectiveRole, invalidatePermissionsCache, ROLES };
