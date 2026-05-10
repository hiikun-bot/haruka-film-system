-- ============================================================
-- 案件収支機能（Project Accounting）— Step A: ロールバック
-- ------------------------------------------------------------
-- このファイルは 2026-05-02_project_accounting_step_a.sql を完全に取り消す。
--
-- 実行順:
--   1) トリガを削除（invoice_items / invoices への影響を即時停止）
--   2) トリガ関数を削除
--   3) accounting テーブル群を CASCADE で削除
--
-- 注意:
--   - 既存テーブル（invoices, invoice_items, projects, ...）には一切手を加えていないので
--     down 実行後も既存機能は無影響
--   - project_cost_entries / project_revenue_entries / その他 5 テーブルのデータは失われる
--     必要なら事前に pg_dump --table=... でバックアップを取ること
-- ============================================================

-- 1) トリガ削除
DROP TRIGGER IF EXISTS tr_invoice_items_to_cost ON invoice_items;
DROP TRIGGER IF EXISTS tr_invoice_items_to_cost_del ON invoice_items;
DROP TRIGGER IF EXISTS tr_invoices_to_revenue ON invoices;
DROP TRIGGER IF EXISTS tr_invoices_to_revenue_del ON invoices;

-- 2) トリガ関数削除
DROP FUNCTION IF EXISTS sync_cost_entry_from_invoice_item();
DROP FUNCTION IF EXISTS delete_cost_entry_from_invoice_item();
DROP FUNCTION IF EXISTS sync_revenue_entry_from_invoice();
DROP FUNCTION IF EXISTS delete_revenue_entry_from_invoice();

-- 3) テーブル削除（依存関係順）
DROP TABLE IF EXISTS project_estimate_items CASCADE;
DROP TABLE IF EXISTS project_estimates CASCADE;
DROP TABLE IF EXISTS project_revenue_entries CASCADE;
DROP TABLE IF EXISTS project_cost_entries CASCADE;
DROP TABLE IF EXISTS project_input_profiles CASCADE;
DROP TABLE IF EXISTS project_finance_books CASCADE;

-- 4) PostgREST スキーマキャッシュリロード
NOTIFY pgrst, 'reload schema';
