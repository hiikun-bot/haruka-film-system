// auth.js — 認証設定モジュール
// passport.js（パスポートジェイエス）: Node.jsで最も広く使われる認証ライブラリ
// Strategy（ストラテジー）: 認証方法（Google / ローカル）ごとに設定するプラグイン

const passport      = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const LocalStrategy  = require('passport-local').Strategy;
const bcrypt         = require('bcryptjs');
const { users, invitations } = require('./db/db');

// ==================== セッションのシリアライズ ====================
// シリアライズ: ユーザー情報をセッションに保存する処理（IDのみ保存して軽量化）
passport.serializeUser((user, done) => done(null, user.id));

// デシリアライズ: セッションのIDからユーザー情報をDBで復元する処理
passport.deserializeUser((id, done) => {
  const user = users.byId(id);
  done(null, user || false);
});

// ==================== Google OAuth Strategy ====================
// OAuth（オーオース）: Googleアカウントで安全にログインするための標準プロトコル
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

      // 既存ユーザーをGoogleIDで検索
      let user = users.byGoogleId(googleId);

      if (!user) {
        // メールアドレスで既存ユーザーを検索（招待メールと紐付け）
        user = users.byEmail(email);
        if (user) {
          // 既存ユーザーにGoogle IDを紐付け
          users.update(user.id, { googleId, avatarUrl });
          user = users.byId(user.id);
        } else {
          // 初回ログイン
          // ADMIN_EMAILが設定されていてそのアドレスなら管理者、それ以外は招待が必要
          const isAdmin   = email === process.env.ADMIN_EMAIL;
          const isFirstUser = users.count() === 0;

          if (!isAdmin && !isFirstUser) {
            // 招待なしの新規登録はブロック
            return done(null, false, { message: '招待されていないアカウントです。管理者に招待を依頼してください。' });
          }

          user = users.create({
            name, email, googleId, avatarUrl,
            role: (isAdmin || isFirstUser) ? 'admin' : 'editor',
          });
        }
      } else {
        // アバター更新
        users.update(user.id, { avatarUrl });
      }

      if (!user.is_active) return done(null, false, { message: 'このアカウントは無効化されています' });

      users.touchLogin(user.id);
      return done(null, user);
    } catch(e) {
      return done(e);
    }
  }));
}

// ==================== Local Strategy（メール＋パスワード） ====================
// bcrypt（ビークリプト）: パスワードを安全にハッシュ化するライブラリ
passport.use(new LocalStrategy(
  { usernameField: 'email', passwordField: 'password' },
  async (email, password, done) => {
    try {
      const user = users.byEmail(email);
      if (!user)               return done(null, false, { message: 'メールアドレスが見つかりません' });
      if (!user.password_hash) return done(null, false, { message: 'このアカウントはGoogleログイン専用です' });
      if (!user.is_active)     return done(null, false, { message: 'このアカウントは無効化されています' });

      const ok = await bcrypt.compare(password, user.password_hash);
      if (!ok) return done(null, false, { message: 'パスワードが正しくありません' });

      users.touchLogin(user.id);
      return done(null, user);
    } catch(e) {
      return done(e);
    }
  }
));

// ==================== 招待経由の新規登録 ====================
// トークン: ランダムな文字列で生成された一時的な認証キー
async function registerWithInvitation(token, name, password) {
  invitations.purgeExpired();
  const inv = invitations.byToken(token);

  if (!inv)      throw new Error('招待リンクが無効です');
  if (inv.used)  throw new Error('この招待リンクはすでに使用されています');
  if (inv.expires_at < Math.floor(Date.now() / 1000)) throw new Error('招待リンクの有効期限が切れています（24時間）');

  const existing = users.byEmail(inv.email);
  if (existing)  throw new Error('このメールアドレスはすでに登録済みです');

  const passwordHash = await bcrypt.hash(password, 12);
  const user = users.create({ name, email: inv.email, role: inv.role, passwordHash });
  invitations.markUsed(token, user.id);
  return user;
}

// ==================== 認証ミドルウェア ====================
// ミドルウェア: リクエストとレスポンスの間で認証チェックを挟む仕組み

function requireAuth(req, res, next) {
  if (req.isAuthenticated()) return next();
  if (req.xhr || req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'ログインが必要です', redirect: '/login.html' });
  }
  res.redirect('/login.html');
}

// ロールベースのアクセス制御
// RBAC（アールバック）: Role-Based Access Control の略
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ error: 'ログインが必要です' });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'この操作の権限がありません', yourRole: req.user.role, required: roles });
    }
    next();
  };
}

// 権限定数
const ROLES = {
  ADMIN:     'admin',
  SECRETARY: 'secretary',
  DIRECTOR:  'director',
  EDITOR:    'editor',
  CLIENT:    'client',
};

// 各ロールがアクセスできる最低権限（以上のロールすべて許可）
const ROLE_LEVEL = { admin: 5, secretary: 4, director: 3, editor: 2, client: 1 };

function requireLevel(minRole) {
  return (req, res, next) => {
    if (!req.isAuthenticated()) return res.status(401).json({ error: 'ログインが必要です' });
    if ((ROLE_LEVEL[req.user.role] || 0) >= (ROLE_LEVEL[minRole] || 99)) return next();
    return res.status(403).json({ error: '権限が不足しています' });
  };
}

module.exports = { passport, requireAuth, requireRole, requireLevel, registerWithInvitation, ROLES };
