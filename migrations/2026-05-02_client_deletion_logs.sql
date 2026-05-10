-- クライアント削除監査ログ
-- 用途: クライアント削除時に「誰が・いつ・なぜ・何件の関連案件があったか」を記録する。
-- 親 clients は削除されるため、外部参照は持たず スナップショット で残す（client_id は参照制約なし）。
-- 本番Supabaseへの適用が必要。
CREATE TABLE IF NOT EXISTS client_deletion_logs (
  id           BIGSERIAL PRIMARY KEY,
  client_id    UUID,                          -- 削除されたクライアントのID（参照制約なし／監査目的のみ）
  client_name  TEXT NOT NULL,
  client_short TEXT,                          -- 略称 (client_code)
  reason       TEXT NOT NULL,
  deleted_by   UUID,                          -- ユーザーID (auth.users 参照を持たない／監査目的)
  deleted_by_name TEXT,                       -- 表示用スナップショット
  related_projects_count INT DEFAULT 0,
  deleted_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_client_deletion_logs_deleted_at
  ON client_deletion_logs(deleted_at DESC);
