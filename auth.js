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
  res.redirect('/login.html');
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.isAuthenticated()) return res.status(401).json({ error: 'ログインが必要です' });
    if (!roles.includes(req.user.role)) {
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
    if ((ROLE_LEVEL[req.user.role] || 0) >= (ROLE_LEVEL[minRole] || 99)) return next();
    return res.status(403).json({ error: '権限が不足しています' });
  };
}

module.exports = { passport, requireAuth, requireRole, requireLevel, ROLES };
