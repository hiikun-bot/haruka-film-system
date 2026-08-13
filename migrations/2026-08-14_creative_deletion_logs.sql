-- クリエイティブ削除監査ログ
-- 用途: クリエイティブ削除時に「誰が・いつ・どのCRを消したか」を記録する。
-- 背景: 2026-08-10 バルセロナ 260810_..._0000201 が削除ログなしで消え、操作者・経緯が特定できなかった。
-- 親 creatives は削除されるため、外部参照は持たずスナップショットで残す（project_deletion_logs と同設計）。
-- snapshot / files_snapshot に削除時点の全列を JSONB で保持し、誤削除時の復元・調査を可能にする。
-- 本番Supabaseへの適用が必要。
CREATE TABLE IF NOT EXISTS creative_deletion_logs (
  id              BIGSERIAL PRIMARY KEY,
  creative_id     UUID,                          -- 削除されたクリエイティブのID（参照制約なし／監査目的のみ）
  file_name       TEXT NOT NULL,
  project_id      UUID,                          -- 所属していた案件のID（参照制約なし／スナップショット）
  project_name    TEXT,                          -- スナップショット
  client_id       UUID,                          -- 紐づいていたクライアントのID（参照制約なし／スナップショット）
  client_name     TEXT,                          -- スナップショット
  status          TEXT,                          -- 削除時点のステータス
  snapshot        JSONB,                         -- creatives 行の全列スナップショット（復元・調査用）
  files_snapshot  JSONB,                         -- creative_files のスナップショット（drive_file_id 等。Drive側は【削除】リネームで残る）
  deleted_by      UUID,                          -- ユーザーID (auth.users 参照を持たない／監査目的)
  deleted_by_name TEXT,                          -- 表示用スナップショット
  deleted_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_creative_deletion_logs_deleted_at
  ON creative_deletion_logs(deleted_at DESC);

-- 「このCR名、消えた？」調査で file_name から直接引けるようにする
CREATE INDEX IF NOT EXISTS idx_creative_deletion_logs_file_name
  ON creative_deletion_logs(file_name);
