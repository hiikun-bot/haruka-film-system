-- ============================================================
-- バグ報告: 最終更新者(last_updated_by_user_id) を追加
-- ============================================================
-- 目的:
--   バグ報告の更新（編集モーダル保存・対応方針確定）が誰によって
--   行われたかを履歴として残す。
--
--   既存仕様:
--     reporter_user_id  = 入力者（初回作成時の保存者。以降不変）
--     assignee_user_id  = 報告者（実際にバグに気づいた人）
--   今回追加:
--     last_updated_by_user_id = 最終更新者（admin が見てくれた／
--                                          方針確定／編集した最後の人）
--
-- 注意:
--   reporter_user_id は新規作成時のみセットされ、PUT/PATCH 系では
--   絶対に上書きしないこと（既に normalizeBugReportPayload で除外済）。
-- ============================================================

ALTER TABLE bug_reports
  ADD COLUMN IF NOT EXISTS last_updated_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL;
