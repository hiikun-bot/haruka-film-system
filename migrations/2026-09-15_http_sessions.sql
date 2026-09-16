-- HTTP セッション（express-session）の保存先を Railway Volume 上の SQLite から Supabase に移す（ADR 040）
--
-- 背景: セッションストアが connect-sqlite3（/app/data/sessions.db）で、その置き場のためだけに
-- Railway Volume を付けている。Volume 付きサービスは同時に 1 コンテナしかマウントできないため
-- Railway はデプロイ時に「旧コンテナ停止 → 新コンテナ起動」の順次切替になり、healthcheckPath を
-- 設定していてもデプロイのたびに約 10〜15 秒の無応答（502 "Application failed to respond"）が出る
-- （2026-09-15 12:36 JST /api/haruka/onboarding、2026-08-22 08:35 JST /creatives/:id 等）。
-- セッションを Supabase に移して Volume を外せば、旧新コンテナが重なるゼロダウンタイム切替になる。
--
-- 行の中身: sid = express-session のセッション ID（Cookie 値の署名を外したもの）、
-- sess = セッション本体（passport.user のユーザー ID・Google OAuth の state 等）、
-- expired_at = 失効時刻（Cookie の maxAge 7 日。最終アクセスからおおむね 7 日で切れる）。
-- アプリ（service_role）だけが読み書きする。RLS は有効化し anon/authenticated にはポリシーを作らない。
CREATE TABLE IF NOT EXISTS http_sessions (
  sid        text PRIMARY KEY,
  sess       jsonb NOT NULL,
  expired_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 失効行の定期削除（アプリ側の 15 分周期スイープ）用
CREATE INDEX IF NOT EXISTS idx_http_sessions_expired_at ON http_sessions (expired_at);

COMMENT ON TABLE http_sessions IS
  'express-session のセッションストア（ADR 040）。Railway Volume の sessions.db から移行。service_role のみ読み書き';
COMMENT ON COLUMN http_sessions.sid IS 'express-session のセッション ID（Cookie 値から署名を外したもの）';
COMMENT ON COLUMN http_sessions.sess IS 'セッション本体 JSON（cookie 設定・passport.user 等）';
COMMENT ON COLUMN http_sessions.expired_at IS '失効時刻。これを過ぎた行は読まれず、スイープで削除される';

ALTER TABLE http_sessions ENABLE ROW LEVEL SECURITY;

-- PostgREST のスキーマキャッシュをリロード
NOTIFY pgrst, 'reload schema';
