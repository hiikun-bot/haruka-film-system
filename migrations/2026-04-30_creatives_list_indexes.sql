-- =====================================================================
-- クリエイティブ一覧 API 高速化用インデックス
-- 想定クエリ:
--   SELECT ... FROM creatives
--   WHERE status != '納品'              -- include_done=false（既定）
--     AND project_id = ?                -- 案件ページからの絞り込み時
--   ORDER BY final_deadline ASC NULLS LAST
--
-- 追加で creative_assignments(user_id) は assignee_id フィルタに必要
-- （既存 supabase_schema.sql に同名定義があるが、本番 DB へ確実に
--   反映するため CREATE INDEX IF NOT EXISTS で冪等に再実行）
-- =====================================================================

-- 一覧 ORDER BY final_deadline + status フィルタの複合
CREATE INDEX IF NOT EXISTS idx_creatives_status_deadline
  ON creatives (status, final_deadline NULLS LAST);

-- 案件ページからの絞り込み（project_id, status）
CREATE INDEX IF NOT EXISTS idx_creatives_project_status
  ON creatives (project_id, status);

-- assignee_id フィルタ用（creative_id 集合を取る前段クエリ）
-- 既存スキーマにも定義があるが冪等に再実行
CREATE INDEX IF NOT EXISTS idx_creative_assignments_user_id
  ON creative_assignments (user_id);

-- file_name 検索（ilike）用 trigram インデックスは pg_trgm 拡張が
-- 必要なため本マイグレーションでは見送り。必要に応じて以下を有効化。
-- CREATE EXTENSION IF NOT EXISTS pg_trgm;
-- CREATE INDEX IF NOT EXISTS idx_creatives_file_name_trgm
--   ON creatives USING gin (file_name gin_trgm_ops);

NOTIFY pgrst, 'reload schema';
