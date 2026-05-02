-- ============================================================
-- 案件収支機能 V2 — 契約タイプ追加
-- ------------------------------------------------------------
-- 目的:
--   従来の「contract_total 単独」では表現できない単価型・混在型契約を
--   サポートするため、project_finance_books に契約タイプと想定本数を追加。
--
-- 追加カラム:
--   contract_type      'fixed' | 'per_unit' | 'mixed'  既定 'fixed'
--   planned_unit_count INTEGER                         単価型/混在型の想定本数（合計）
--
-- 変更方針:
--   - 加算のみ（DROP COLUMN なし） → ロールバック時に何も壊れない
--   - 既存データは contract_type='fixed' で初期化される
--   - planned_unit_count は単価型/混在型の場合のみ使用
--
-- ロールバック:
--   このカラムは無害なので DROP は不要。
--   どうしても消したい場合は手動で:
--     ALTER TABLE project_finance_books DROP COLUMN contract_type;
--     ALTER TABLE project_finance_books DROP COLUMN planned_unit_count;
--
-- 適用方法:
--   1) Supabase ダッシュボード → SQL Editor を開く
--   2) このファイル全文を貼り付けて Run
--   (db/migrate.js による supabase_schema.sql 自動同期にも同内容を反映済み)
-- ============================================================

ALTER TABLE project_finance_books
  ADD COLUMN IF NOT EXISTS contract_type TEXT DEFAULT 'fixed'
  CHECK (contract_type IN ('fixed', 'per_unit', 'mixed'));

ALTER TABLE project_finance_books
  ADD COLUMN IF NOT EXISTS planned_unit_count INTEGER;

CREATE INDEX IF NOT EXISTS idx_project_finance_books_contract_type
  ON project_finance_books(contract_type);

NOTIFY pgrst, 'reload schema';
