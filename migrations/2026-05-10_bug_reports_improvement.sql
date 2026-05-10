-- ============================================================
-- バグ報告: 改善済みフラグ + Verup情報（version_logs）紐付け
-- ============================================================
-- 報告された内容に対して、admin が「改善した」とチェックを入れる仕組みを追加。
-- 修正履歴（version_logs.revision_no）と突合できるように、改善実装の Verup
-- レコードへの soft FK を持つ。
--
-- - improved_at        : 改善済みフラグ（NULL=未改善）
-- - improved_by_user_id: チェックを入れた管理者
-- - improvement_version_log_id: 対応 Verup（任意。Verup を出さない軽微な改善は NULL）
-- ============================================================

ALTER TABLE bug_reports
  ADD COLUMN IF NOT EXISTS improved_at timestamptz,
  ADD COLUMN IF NOT EXISTS improved_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS improvement_version_log_id uuid REFERENCES version_logs(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS bug_reports_improved_at_idx
  ON bug_reports (improved_at DESC) WHERE improved_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS bug_reports_improvement_version_log_idx
  ON bug_reports (improvement_version_log_id) WHERE improvement_version_log_id IS NOT NULL;
