-- 大容量 D&D 用 Resumable Upload（ブラウザ→Drive 直送）に必要な
-- ユーザー OAuth トークンの永続化テーブル。
--
-- 既存の Drive 操作はサービスアカウント（GOOGLE_SERVICE_ACCOUNT_KEY）で行っているが、
-- ブラウザから直接 Drive Resumable Upload API を叩くにはユーザーOAuthトークンが必要。
-- 一度ユーザーが同意画面で承認すれば、refresh_token を本テーブルに保存し、
-- 以後はサーバーが access_token を再発行して使う。
--
-- スコープは drive.file のみ（非機密 / Workspace Internal 限定で審査・検証不要）。

CREATE TABLE IF NOT EXISTS user_oauth_tokens (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider            TEXT NOT NULL DEFAULT 'google',
  -- スコープ識別子（drive.file 等）。複数スコープを別行で管理する想定。
  -- 同一 (user_id, provider, scope_key) でユニーク。
  scope_key           TEXT NOT NULL DEFAULT 'drive.file',
  -- 実際に許可されたスコープ文字列（スペース区切り）。検証・debug 用。
  granted_scopes      TEXT,
  access_token        TEXT NOT NULL,
  refresh_token       TEXT,            -- 初回承認時のみ Google から返る。再承認しないと再取得不可。
  token_type          TEXT,            -- 'Bearer' 等
  expires_at          TIMESTAMPTZ,     -- access_token の失効時刻（Google からの expires_in より算出）
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT user_oauth_tokens_unique UNIQUE (user_id, provider, scope_key)
);

COMMENT ON TABLE user_oauth_tokens IS
  'ユーザーOAuthトークン（現状は Google Drive Resumable Upload の drive.file スコープ用）。refresh_token を保存し、サーバー側で access_token をリフレッシュして利用する。';
COMMENT ON COLUMN user_oauth_tokens.scope_key IS
  'スコープ識別子（drive.file 等）。複数スコープを別行で管理する場合のキー。';
COMMENT ON COLUMN user_oauth_tokens.refresh_token IS
  '初回承認時のみ Google から返る。失われた場合は再度 OAuth 同意フローを通す必要がある。';

CREATE INDEX IF NOT EXISTS idx_user_oauth_tokens_user
  ON user_oauth_tokens(user_id, provider);

-- updated_at の自動更新トリガ
CREATE OR REPLACE FUNCTION trg_set_user_oauth_tokens_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_user_oauth_tokens_updated_at ON user_oauth_tokens;
CREATE TRIGGER trg_user_oauth_tokens_updated_at
BEFORE UPDATE ON user_oauth_tokens
FOR EACH ROW EXECUTE FUNCTION trg_set_user_oauth_tokens_updated_at();
