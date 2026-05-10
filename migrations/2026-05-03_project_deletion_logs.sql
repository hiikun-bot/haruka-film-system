-- 案件削除監査ログ
-- 用途: 案件削除時に「誰が・いつ・なぜ・どのクライアント配下の案件を消したか」を記録する。
-- 親 projects は削除されるため、外部参照は持たず スナップショット で残す（project_id / client_id は参照制約なし）。
-- 既存の「請求書が紐づいている場合は削除不可」のガードはそのまま維持され、本ログには記録しない。
-- 本番Supabaseへの適用が必要。
CREATE TABLE IF NOT EXISTS project_deletion_logs (
  id              BIGSERIAL PRIMARY KEY,
  project_id      UUID,                          -- 削除された案件のID（参照制約なし／監査目的のみ）
  project_name    TEXT NOT NULL,
  client_id       UUID,                          -- 紐づいていたクライアントのID（参照制約なし／スナップショット）
  client_name     TEXT,                          -- スナップショット
  reason          TEXT NOT NULL,
  deleted_by      UUID,                          -- ユーザーID (auth.users 参照を持たない／監査目的)
  deleted_by_name TEXT,                          -- 表示用スナップショット
  related_creatives_count INT DEFAULT 0,
  deleted_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_project_deletion_logs_deleted_at
  ON project_deletion_logs(deleted_at DESC);
