// auth.js — 認証設定（Supabase永続化版）
const passport       = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const LocalStrategy  = require('passport-local').Strategy;
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

// ==================== Google OAuth Strategy ====================
if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  passport.use(new GoogleStrategy({
    clientID:     process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL:  `${process.env.APP_URL || 'http://localhost:3000'}/auth/google/callback`,
    scope: ['profile', 'email'],
  }, async (accessToken, refreshToken, profile, done) => {
    try {
      const email     = profile.emails?.[0]?.value;
      const googleId  = profile.id;
      const name      = profile.displayName;
      const avatarUrl = profile.photos?.[0]?.value;

      if (!email) return done(null, false, { message: 'Googleアカウントにメールアドレスがありません' });

      // google_id で検索
      let { data: user } = await supabase
        .from('users').select('*').eq('google_id', googleId).maybeSingle();

      if (!user) {
        // メールアドレスで検索
        const { data: byEmail } = await supabase
          .from('users').select('*').eq('email', email).maybeSingle();

        if (byEmail) {
          // 既存ユーザーにGoogle IDを紐付け
          await supabase.from('users')
            .update({ google_id: googleId, avatar_url: avatarUrl })
            .eq('id', byEmail.id);
          user = { ...byEmail, google_id: googleId, avatar_url: avatarUrl };
        } else {
          // 初回 — 管理者メールのみ自動登録
          const isAdmin = email === process.env.ADMIN_EMAIL;
          if (!isAdmin) {
            return done(null, false, { message: '招待されていないアカウントです。管理者に招待を依頼してください。' });
          }
          const { data: newUser, error } = await supabase.from('users').insert({
            email, full_name: name, role: 'admin',
            google_id: googleId, avatar_url: avatarUrl, is_active: true
          }).select().single();
          if (error) return done(error);
          user = newUser;
        }
      } else {
        await supabase.from('users')
          .update({ avatar_url: avatarUrl }).eq('id', user.id);
      }

      if (!user.is_active) return done(null, false, { message: 'このアカウントは無効化されています' });
      done(null, user);
    } catch(e) { done(e); }
  }));
}

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
