// server.js — HARUKA FILM SYSTEM バックエンドサーバー
// Express（エクスプレス）: Node.js用の軽量Webサーバーフレームワーク
// このファイルは認証・セッション・静的配信のみを担当し、
// アプリケーションロジックは routes/haruka.js（Supabase 経由）に集約されている。

require('dotenv').config();
const harukaRouter = require('./routes/haruka');
// 案件収支機能（feature flag: ENABLE_PROJECT_ACCOUNTING）— Step B
const accountingEnabled = ['true', '1', 'on', 'yes'].includes(String(process.env.ENABLE_PROJECT_ACCOUNTING || '').toLowerCase());
const accountingRouter = accountingEnabled ? require('./routes/accounting') : null;
const supabase = require('./supabase');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');

const { passport: passportInstance, requireAuth, requirePermission, isSuperAdminUser } = require('./auth');
const session    = require('express-session');
const bcrypt     = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const SQLiteStore = require('connect-sqlite3')(session);
const fs = require('fs');
const SESSIONS_DIR = process.env.DATA_DIR || './data';
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== ビルド ID ====================
// クライアント (`/api/build-info` + `X-Server-Build` ヘッダ) から参照される。
// Railway のビルド時環境変数があればそれを優先。なければ起動時に git から取得。
// git も失敗したら起動時刻を fallback として使い、いずれも module-level でキャッシュ。
const BUILD_ID = (() => {
  const fromEnv = process.env.RAILWAY_GIT_COMMIT_SHA
               || process.env.GIT_COMMIT_SHA
               || process.env.COMMIT_SHA
               || process.env.GIT_COMMIT
               || process.env.SOURCE_VERSION;
  if (fromEnv) return String(fromEnv).slice(0, 12);
  try {
    const { execSync } = require('child_process');
    const sha = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
    if (sha) return sha;
  } catch (_) { /* git 取れなければ次の fallback */ }
  return Date.now().toString();
})();
console.log(`[build] BUILD_ID = ${BUILD_ID}`);

// ==================== ミドルウェア ====================
// ミドルウェア: リクエストとレスポンスの間で処理を挟む仕組み

// 壊さない範囲のセキュリティヘッダのみ。CSP は既存のインライン script/style を割るため
// 本 PR では入れない（report-only 含めて段階導入は別 PR で扱う）。
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: false,
  crossOriginResourcePolicy: false,
  // HSTS は Railway 経由で常時 HTTPS のため有効化したいが、独自ドメイン側で
  // HTTPS 切れに弱いユーザーが残る可能性があるので別 PR で扱う
  strictTransportSecurity: false,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  frameguard: { action: 'deny' },
}));

app.use(cors({ origin: process.env.APP_URL || 'http://localhost:3000', credentials: true }));

// すべてのレスポンスに X-Server-Build ヘッダを付与（クライアント側のバージョン照合用）
app.use((req, res, next) => {
  res.setHeader('X-Server-Build', BUILD_ID);
  next();
});

// クライアント (haruka.html) が起動時に呼ぶ軽量エンドポイント。
// 認証不要（ヘッダ値と同じ build しか返さない）。404 ノイズを止めるための実装。
// セッション/認証 middleware より前に登録して負荷を避ける。
app.get('/api/build-info', (req, res) => {
  res.json({ build: BUILD_ID });
});

// セッション設定
// セッション: ログイン状態をサーバー側で管理する仕組み
// 本番では SESSION_SECRET 必須。未設定で起動するとフォールバック値で署名されてしまうため即時失敗させる。
const SESSION_SECRET = process.env.SESSION_SECRET;
if (process.env.NODE_ENV === 'production' && !SESSION_SECRET) {
  console.error('[FATAL] SESSION_SECRET is required in production. Refusing to start.');
  process.exit(1);
}
app.use(session({
  store: new SQLiteStore({ db: 'sessions.db', dir: process.env.DATA_DIR || './data' }),
  secret: SESSION_SECRET || 'video-ops-dev-secret-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production', // 本番ではHTTPS必須
    httpOnly: true, // JavaScriptからCookieを読めないようにしてXSS対策
    sameSite: 'lax', // 通常の遷移ログインを壊さずに CSRF 耐性を底上げ
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7日間
  },
}));

// プロキシ（Railway/CloudFlare等）経由のため、X-Forwarded-* を信頼
app.set('trust proxy', 1);

app.use(passportInstance.initialize());
app.use(passportInstance.session());

// ==================== IPベース自動ログイン ====================
// 環境変数:
//   AUTO_LOGIN_IPS    = 許可IPカンマ区切り（例: "203.0.113.5,198.51.100.7"）
//   AUTO_LOGIN_EMAIL  = 自動ログイン対象のユーザーメールアドレス
// クッキー auto_login_off=1 が立っている場合は自動ログインを抑止（ログアウト直後など）
const AUTO_LOGIN_IPS = (process.env.AUTO_LOGIN_IPS || '').split(',').map(s => s.trim()).filter(Boolean);
const AUTO_LOGIN_EMAIL = (process.env.AUTO_LOGIN_EMAIL || '').trim().toLowerCase();
function normalizeIP(ip) {
  if (!ip) return '';
  // IPv6 でラップされた IPv4（::ffff:1.2.3.4）を IPv4 に正規化
  const m = String(ip).match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  return m ? m[1] : String(ip).trim();
}
function getClientIP(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return normalizeIP(String(fwd).split(',')[0]);
  return normalizeIP(req.ip || req.connection?.remoteAddress || '');
}

// 自分のIPを確認するためのデバッグエンドポイント。
// 認証不要だった頃は AUTO_LOGIN_IPS / AUTO_LOGIN_EMAIL 等の内部設定を未認証で返していたため、
// 最高管理者（admin かつ SUPER_ADMIN_EMAILS）以外は 404 扱いに変更。
app.get('/auth/debug-ip', async (req, res) => {
  if (!req.isAuthenticated?.() || !isSuperAdminUser(req.user)) {
    return res.status(404).json({ error: 'Not Found' });
  }
  const ip = getClientIP(req);
  const cookieOff = !!(req.headers.cookie && /(?:^|;\s*)auto_login_off=1/.test(req.headers.cookie));
  let user_lookup = null;
  if (AUTO_LOGIN_EMAIL) {
    try {
      const { data: u, error } = await supabase
        .from('users').select('id, email, role, is_active').eq('email', AUTO_LOGIN_EMAIL).maybeSingle();
      user_lookup = error ? { error: error.message } : (u ? { found: true, id: u.id, email: u.email, role: u.role, is_active: u.is_active } : { found: false, searched_email: AUTO_LOGIN_EMAIL });
    } catch(e) { user_lookup = { error: e.message }; }
  }
  res.json({
    your_ip:        ip,
    raw_x_fwd_for:  req.headers['x-forwarded-for'] || null,
    raw_req_ip:     req.ip,
    raw_remote:     req.connection?.remoteAddress || null,
    auto_login_configured: AUTO_LOGIN_IPS.length > 0 && !!AUTO_LOGIN_EMAIL,
    auto_login_email_env:  AUTO_LOGIN_EMAIL,
    auto_login_ips_env:    AUTO_LOGIN_IPS,
    your_ip_in_allowlist:  AUTO_LOGIN_IPS.includes(ip),
    auto_login_off_cookie: cookieOff,
    is_authenticated:      req.isAuthenticated?.() || false,
    session_user_id:       req.user?.id || null,
    user_lookup,
  });
});

app.use(async (req, res, next) => {
  if (!AUTO_LOGIN_IPS.length || !AUTO_LOGIN_EMAIL) return next();
  if (req.isAuthenticated?.()) return next();
  if (req.headers.cookie && /(?:^|;\s*)auto_login_off=1/.test(req.headers.cookie)) return next();
  if (req.path.startsWith('/auth/') || req.path.startsWith('/api/')) return next();
  const ip = getClientIP(req);
  if (!AUTO_LOGIN_IPS.includes(ip)) {
    if (req.path === '/' || req.path === '/login.html' || req.path === '/haruka.html') {
      console.log(`[AUTO-LOGIN] skip: IP=${ip} not in allowlist=${AUTO_LOGIN_IPS.join(',')}`);
    }
    return next();
  }
  try {
    const { data: user } = await supabase.from('users').select('*').eq('email', AUTO_LOGIN_EMAIL).maybeSingle();
    if (!user) { console.log(`[AUTO-LOGIN] skip: user not found for email=${AUTO_LOGIN_EMAIL}`); return next(); }
    if (!user.is_active) { console.log(`[AUTO-LOGIN] skip: user is_active=false`); return next(); }
    req.login(user, (err) => {
      if (err) { console.log(`[AUTO-LOGIN] login error:`, err.message); return next(); }
      console.log(`[AUTO-LOGIN] success: ${user.email} from IP ${ip}`);
      // ログイン直後はログイン画面に来た場合 haruka.html へリダイレクト
      // ?next=/haruka.html?creative=xxx 形式で指定があれば、許可済みパターンに限り尊重する
      if (req.path === '/login.html' || req.path === '/') {
        const nextParam = String(req.query?.next || '');
        const safeNext = /^\/haruka\.html(\?|$)/.test(nextParam) ? nextParam : '/haruka.html';
        return res.redirect(safeNext);
      }
      next();
    });
  } catch(e) {
    console.log(`[AUTO-LOGIN] exception:`, e.message);
    next();
  }
});

// limit を上げる: バグ報告のスクリーンショット (data URL) が 1〜数 MB になるため。
// デフォルト 100kb だと bug_reports POST が 413 (request entity too large) で失敗する。
app.use(express.json({ limit: '15mb' }));

// last_seen_at 更新ミドルウェア（認証済みAPIリクエストのみ、5分ごと）
const _lastSeenCache = new Map();
app.use('/api/', (req, res, next) => {
  if (!req.isAuthenticated?.() || !req.user?.id) return next();
  const uid = req.user.id;
  const now = Date.now();
  if (!_lastSeenCache.has(uid) || now - _lastSeenCache.get(uid) > 5 * 60 * 1000) {
    _lastSeenCache.set(uid, now);
    supabase.from('users').update({ last_seen_at: new Date().toISOString() }).eq('id', uid).then(() => {});
  }
  next();
});

// HARUKA FILM SYSTEM API
app.use('/api/haruka', harukaRouter);

// 通知API（Phase 1 段階1）
// /api/notifications 配下: 一覧 / 未読件数 / 既読化 / 全体通知発火
app.use('/api/notifications', require('./routes/notifications'));

// クライアント設定 API（Phase 1 段階2）
// Supabase Realtime 接続用に anon key（公開可能な公開鍵）と URL をフロントへ渡す。
// service_role キーは絶対に渡さない。anon キーは Supabase の RLS（行レベルセキュリティ）で
// 守られる前提のフロント公開鍵で、ブラウザに置いて問題ないキー。
app.get('/api/config', requireAuth, (req, res) => {
  res.json({
    supabase_url: process.env.SUPABASE_URL || '',
    supabase_anon_key: process.env.SUPABASE_ANON_KEY || '',
  });
});

// 案件収支 API（feature flag が有効な時のみマウント。flag OFF 時はそもそもエンドポイントが存在しない）
if (accountingRouter) {
  app.use('/api/accounting', accountingRouter);
  console.log('[accounting] feature flag ENABLED — /api/accounting/* available');
} else {
  console.log('[accounting] feature flag DISABLED — set ENABLE_PROJECT_ACCOUNTING=true to enable');
}

// login.html: 認証済みユーザーは haruka.html へリダイレクト
// （?next=/haruka.html?creative=xxx で来た場合はディープリンク先へ）
app.get('/login.html', (req, res) => {
  if (req.isAuthenticated?.()) {
    const nextParam = String(req.query?.next || '');
    const safeNext = /^\/haruka\.html(\?|$)/.test(nextParam) ? nextParam : '/haruka.html';
    return res.redirect(safeNext);
  }
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});
// ルート: 認証済みなら haruka.html、未認証なら login.html
app.get('/', (req, res) => {
  if (req.isAuthenticated?.()) return res.redirect('/haruka.html');
  res.redirect('/login.html');
});
// invite.html は認証不要
app.use('/invite.html', express.static(path.join(__dirname, 'public/invite.html')));
// PWA: manifest・service-workerは認証不要
app.use('/manifest.json',     express.static(path.join(__dirname, 'public/manifest.json')));
app.use('/service-worker.js', express.static(path.join(__dirname, 'public/service-worker.js')));
app.use('/icon-192.png',      express.static(path.join(__dirname, 'public/icon-192.png')));
app.use('/icon-512.png',      express.static(path.join(__dirname, 'public/icon-512.png')));
app.use('/icon-180.png',      express.static(path.join(__dirname, 'public/icon-180.png')));
// haruka.html は認証後のみ配信
app.get('/haruka.html', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'haruka.html'));
});
// その他の静的ファイル（ロゴ等）
app.use(express.static(path.join(__dirname, 'public')));


// ==================== 認証ルート ====================

// メール＋パスワード ログイン
app.post('/auth/login', (req, res, next) => {
  passportInstance.authenticate('local', (err, user, info) => {
    if (err)    return next(err);
    if (!user)  return res.status(401).json({ error: info?.message || 'ログインに失敗しました' });
    req.logIn(user, async err => {
      if (err) return next(err);
      // 手動ログインしたので自動ログイン抑止クッキーをクリア
      res.setHeader('Set-Cookie', `auto_login_off=; Max-Age=0; Path=/`);
      // ログイン記録
      const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;
      const ua = req.headers['user-agent'] || '';
      await supabase.from('user_activity_logs').insert({ user_id: user.id, action: 'login', ip_address: ip, user_agent: ua });
      await supabase.from('users').update({ login_count: (user.login_count || 0) + 1, last_seen_at: new Date().toISOString() }).eq('id', user.id);
      res.json({ ok: true, user: safeUser(user) });
    });
  })(req, res, next);
});

// ログアウト
app.post('/auth/logout', (req, res) => {
  // 自動ログイン抑止（1時間）。再度ログイン画面で手動ログインすると無効化される
  res.setHeader('Set-Cookie', `auto_login_off=1; Max-Age=3600; Path=/; HttpOnly; SameSite=Lax${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
  req.logout(() => res.json({ ok: true }));
});

// 現在のログインユーザー情報（fetchからも呼ばれるのでリダイレクトせずJSON返却）
app.get('/auth/me', (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'not authenticated' });
  res.json(safeUser(req.user));
});

// ==================== 招待 API ====================
// 管理者のみ招待発行可能

// ==================== 招待管理 API（Supabase永続化） ====================

app.get('/api/invitations', requireAuth, requirePermission('member.edit_password'), async (req, res) => {
  const { data } = await supabase.from('invitations')
    .select('*').order('created_at', { ascending: false });
  res.json(data || []);
});

app.post('/api/invitations', requireAuth, requirePermission('member.edit_password'), async (req, res) => {
  const { email, role } = req.body;
  if (!email) return res.status(400).json({ error: 'メールアドレスは必須です' });

  const { data: existing } = await supabase.from('users').select('id').eq('email', email).maybeSingle();
  if (existing) return res.status(409).json({ error: 'このメールアドレスはすでに登録済みです' });

  const token = uuidv4();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const { data: inv, error } = await supabase.from('invitations').insert({
    token, email, role: role || 'editor',
    invited_by_email: req.user.email,
    expires_at: expiresAt
  }).select().single();

  if (error) return res.status(500).json({ error: error.message });
  const baseUrl = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
  const link = `${baseUrl}/invite.html?token=${token}`;
  res.json({ ...inv, inviteLink: link });
});

app.delete('/api/invitations/:id', requireAuth, requirePermission('member.delete'), async (req, res) => {
  await supabase.from('invitations').delete().eq('id', req.params.id);
  res.json({ ok: true });
});

// 招待トークン検証（招待ページで呼ぶ）
app.get('/api/invitations/verify/:token', async (req, res) => {
  const { data: inv } = await supabase.from('invitations')
    .select('*').eq('token', req.params.token).maybeSingle();
  if (!inv) return res.status(410).json({ error: '招待リンクが無効または期限切れです' });
  if (inv.used) return res.status(410).json({ error: 'この招待リンクはすでに使用されています' });
  if (new Date(inv.expires_at) < new Date()) return res.status(410).json({ error: '招待リンクの有効期限が切れています（24時間）' });
  res.json({ email: inv.email, role: inv.role });
});

// 招待経由の新規登録
app.post('/api/invitations/register', async (req, res) => {
  const { token, name, password } = req.body;
  if (!token || !name || !password) return res.status(400).json({ error: '名前・パスワード・トークンは必須です' });
  try {
    const { data: inv } = await supabase.from('invitations')
      .select('*').eq('token', token).maybeSingle();
    if (!inv) throw new Error('招待リンクが無効です');
    if (inv.used) throw new Error('この招待リンクはすでに使用されています');
    if (new Date(inv.expires_at) < new Date()) throw new Error('招待リンクの有効期限が切れています（24時間）');

    // Supabase に既存ユーザーがいないか確認
    const { data: existing } = await supabase.from('users').select('id').eq('email', inv.email).maybeSingle();
    if (existing) throw new Error('このメールアドレスはすでに登録済みです');

    // パスワードハッシュ化してSupabaseに登録（SQLite不要）
    const passwordHash = await bcrypt.hash(password, 12);
    const { data: newUser, error: sbErr } = await supabase.from('users').insert({
      email: inv.email, full_name: name, role: inv.role,
      is_active: true, password_hash: passwordHash
    }).select().single();
    if (sbErr) throw new Error('アカウントの作成に失敗しました: ' + sbErr.message);

    // 招待を使用済みにする
    await supabase.from('invitations').update({ used: true, used_at: new Date().toISOString() }).eq('token', token);

    req.logIn(newUser, err => {
      if (err) return res.status(500).json({ error: 'ログインに失敗しました' });
      res.json({ ok: true, user: safeUser(newUser) });
    });
  } catch(e) {
    res.status(400).json({ error: e.message });
  }
});

// ==================== ユーザー管理 API ====================
// ユーザー一覧 / 更新 / 削除は routes/haruka.js の /api/haruka/* (Supabase) に統合済み。
// ここに残るのはパスワード変更のみ（本人のみ・Supabase）。

app.post('/api/users/change-password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!newPassword || newPassword.length < 8) return res.status(400).json({ error: 'パスワードは8文字以上必要です' });
  const { data: u } = await supabase.from('users').select('password_hash').eq('id', req.user.id).single();
  if (u?.password_hash) {
    const ok = await bcrypt.compare(currentPassword, u.password_hash);
    if (!ok) return res.status(400).json({ error: '現在のパスワードが正しくありません' });
  }
  const hash = await bcrypt.hash(newPassword, 12);
  await supabase.from('users').update({ password_hash: hash }).eq('id', req.user.id);
  res.json({ ok: true });
});


// ==================== 既存APIに認証ガードを追加 ====================
// requireAuthはすでに静的ファイル配信に適用済み
// APIルートには役割に応じたガードを設定

// セーフユーザー: パスワードハッシュなど機密情報を除いたユーザーオブジェクト
function safeUser(u) {
  if (!u) return null;
  const { password_hash, google_id, ...safe } = u;
  // フロントエンドが参照する name フィールドを補完
  if (!safe.name && safe.full_name) safe.name = safe.full_name;
  return safe;
}

// フロントエンドのすべてのルートをindex.htmlに向ける（SPA対応）
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  requireAuth(req, res, () => {
    res.sendFile(path.join(__dirname, 'public', 'haruka.html'));
  });
});

// ==================== 自動エラー通知（サーバ側） ====================
// 1) Express error-handling middleware
//    next(err) されたエラーのうち 5xx 相当を Slack に流す。
//    既存の res.status(500).json(...) は握りつぶさない（middleware には渡らない）。
//    HTTP ループを避けるため /api/haruka/auto-error 経由ではなく直接ヘルパを呼ぶ。
// 2) process-level handlers
//    uncaughtException / unhandledRejection を Slack へ。
//    通知後もプロセスは継続（既存挙動の維持）。notify 内部は完全に try/catch されている。
const { notifyAutoError } = require('./notifications');
app.use((err, req, res, next) => {
  try {
    const status = (err && (err.status || err.statusCode)) || 500;
    if (status >= 500) {
      // 投げっぱなしで OK（fire & forget）。await しない。
      notifyAutoError({
        source: 'server',
        kind: 'express-error',
        message: err?.message || String(err),
        stack: err?.stack || null,
        url: req?.originalUrl || null,
        apiPath: req?.originalUrl || null,
        statusCode: status,
        userEmail: req?.user?.email || null,
        userAgent: req?.headers?.['user-agent'] || null,
      }).catch(() => {});
    }
  } catch (_) { /* notify 失敗で 2 重例外にしない */ }
  // レスポンス未送信ならデフォルト挙動（500）に倒す
  if (res.headersSent) return next(err);
  res.status((err && (err.status || err.statusCode)) || 500)
     .json({ error: err?.message || 'Internal Server Error' });
});

process.on('uncaughtException', (err) => {
  try { console.error('[uncaughtException]', err); } catch (_) {}
  try {
    notifyAutoError({
      source: 'server',
      kind: 'uncaughtException',
      message: err?.message || String(err),
      stack: err?.stack || null,
    }).catch(() => {});
  } catch (_) { /* 通知失敗でプロセスを巻き込まない */ }
});
process.on('unhandledRejection', (reason) => {
  try { console.error('[unhandledRejection]', reason); } catch (_) {}
  try {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    notifyAutoError({
      source: 'server',
      kind: 'unhandledRejection',
      message: err.message,
      stack: err.stack || null,
    }).catch(() => {});
  } catch (_) { /* 通知失敗でプロセスを巻き込まない */ }
});
// ==================== 初期管理者作成 ====================
async function seedAdminIfNeeded() {
  try {
    const adminEmail = process.env.ADMIN_EMAIL;
    const adminPassword = process.env.ADMIN_PASSWORD;
    console.log(`[SEED] ADMIN_EMAIL=${adminEmail || '未設定'} ADMIN_PASSWORD=${adminPassword ? '設定済み' : '未設定'}`);
    if (!adminEmail || !adminPassword) {
      console.log('[SEED] スキップ: 環境変数が未設定');
      return;
    }
    // Supabase で既存確認（認証は Supabase users テーブルを使用するため）
    const { data: existing } = await supabase.from('users').select('id').eq('email', adminEmail).maybeSingle();
    if (existing) {
      console.log(`[SEED] スキップ: ${adminEmail} はすでに登録済み`);
      return;
    }
    const hash = await bcrypt.hash(adminPassword, 12);
    const { data: created, error } = await supabase.from('users').insert({
      full_name: '管理者',
      email: adminEmail,
      role: 'admin',
      password_hash: hash,
      is_active: true,
    }).select('id').single();
    if (error) throw error;
    console.log(`[SEED] 管理者アカウントを Supabase に作成しました: ${adminEmail} (id=${created?.id})`);
  } catch(e) {
    console.error('[SEED] エラー:', e.message);
  }
}

// ==================== サーバー起動 ====================
// 起動時に supabase_schema.sql を自動適用する
// SCHEMA_AUTO_SYNC=false で無効化可能
const runSchemaSync = require('./db/migrate');

(async () => {
  if (process.env.SCHEMA_AUTO_SYNC !== 'false') {
    await runSchemaSync();
  } else {
    console.log('[schema-sync] SCHEMA_AUTO_SYNC=false により自動同期スキップ');
  }
  app.listen(PORT, async () => {
    console.log(`
  ╔═══════════════════════════════════════╗
  ║   HARUKA FILM SYSTEM サーバー起動     ║
  ║   http://localhost:${PORT}              ║
  ╚═══════════════════════════════════════╝
  `);
    await seedAdminIfNeeded();
    // 通知 Phase 1: 予約配信ワーカを起動（1分ごとに scheduled_send_at <= now の予約を配信扱いにする）
    try {
      const { startNotificationScheduler } = require('./workers/notification-scheduler');
      startNotificationScheduler();
    } catch (e) {
      console.error('[startup] notification-scheduler 起動失敗:', e.message);
    }
    // バグ報告: 24h トリアージSLA チェッカ（1時間ごとに admin へ通知）
    try {
      const { startBugTriageSlaChecker } = require('./workers/bug-triage-sla-checker');
      startBugTriageSlaChecker();
    } catch (e) {
      console.error('[startup] bug-triage-sla-checker 起動失敗:', e.message);
    }
  });
})();
