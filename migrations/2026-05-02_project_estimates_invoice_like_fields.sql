-- ============================================================
-- 案件収支機能 Phase A — 見積書フィールド追加
-- ------------------------------------------------------------
-- 目的:
--   見積を「見積書」として運用できるようにする。
--   発行日 / 有効期限 / 取引先（敬称含む）/ 見積書番号 を保持。
--
-- 追加カラム（すべて加算のみ・既存無影響）:
--   subject         件名（既存の title を別意味で使う場合の保険、当面 title と同義）
--   issue_date      発行日
--   valid_until     有効期限
--   recipient_name  取引先名（クライアント名以外を入れたい場合の上書き）
--   honorific       敬称（御中 / 様 / なし）
--   estimate_number 見積書番号（自動採番、例: 20260502-1）
--
-- ロールバック:
--   ALTER TABLE project_estimates DROP COLUMN ... で個別削除可能。
--   無害なので残置でもOK。
-- ============================================================

ALTER TABLE project_estimates ADD COLUMN IF NOT EXISTS issue_date DATE;
ALTER TABLE project_estimates ADD COLUMN IF NOT EXISTS valid_until DATE;
ALTER TABLE project_estimates ADD COLUMN IF NOT EXISTS recipient_name TEXT;
ALTER TABLE project_estimates ADD COLUMN IF NOT EXISTS honorific TEXT DEFAULT '御中'
  CHECK (honorific IS NULL OR honorific IN ('御中', '様', ''));
ALTER TABLE project_estimates ADD COLUMN IF NOT EXISTS estimate_number TEXT;

CREATE INDEX IF NOT EXISTS idx_project_estimates_estimate_number
  ON project_estimates(estimate_number)
  WHERE estimate_number IS NOT NULL;

NOTIFY pgrst, 'reload schema';
