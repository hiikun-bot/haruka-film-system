-- ============================================================
-- バグ報告: 重複先勝ち（duplicate_of_id）
-- ============================================================
-- 目的:
--   複数の人が同じバグを別々に報告したとき、最初の1件を「親」とし、
--   2回目以降は「親の duplicate」として登録する。集計上は親だけを数え
--   2回目以降は「ノーカウント」だが、レコード自体は残して「これは
--   #ABC と同じ内容として登録されました」と表示する。
--
-- 関連:
--   - status='duplicate' との併用。フロントの新規モーダルで「これと同じ」
--     ボタンを押すと、新規 INSERT 時点で duplicate_of_id と
--     status='duplicate' が同時にセットされる。
--   - workflow の自動紐付けで親が改善されたとき、子にも improved_at /
--     improvement_version_log_id を伝播させる（次PRで対応予定）。
-- ============================================================

ALTER TABLE bug_reports
  ADD COLUMN IF NOT EXISTS duplicate_of_id uuid REFERENCES bug_reports(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS bug_reports_duplicate_of_id_idx
  ON bug_reports (duplicate_of_id)
  WHERE duplicate_of_id IS NOT NULL;
