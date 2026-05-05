-- ============================================================
-- 2026-05-06: projects.project_type 列を DROP（C-2 Step 2）
-- ------------------------------------------------------------
-- 経緯:
--   * Stage A migration `2026-05-05_creative_categories.sql` で
--     projects.primary_category_id にデータをバックフィル済み
--     （projects.project_type → creative_categories.code でマッピング）。
--   * PR #309（C-2 Step 1）で `projects.project_type` を読み書き
--     するアプリケーションコードを全削除。本番 Railway デプロイ済み。
--   * 別テーブル project_input_profiles.project_type は引き続き利用中
--     （こちらは独立した列なので DROP 対象外）。
--
-- 本 migration では projects.project_type 列を物理削除する。
-- 列に紐付く CHECK 制約 `projects_project_type_check`
-- （`migrations/2026-05-02_projects_project_type.sql` で named 追加）は
-- DROP COLUMN により自動で消えるが、安全のため明示的に DROP IF EXISTS する。
-- ============================================================

BEGIN;

-- 1) named CHECK 制約を明示削除（DROP COLUMN でも自動削除されるが冪等のため）
ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_project_type_check;

-- 2) project_type 列を削除（既に存在しない場合もエラーにしない）
ALTER TABLE projects DROP COLUMN IF EXISTS project_type;

COMMIT;
