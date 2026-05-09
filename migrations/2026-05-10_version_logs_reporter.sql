-- ============================================================
-- Verup情報: 報告者（reporter_user_id）を追加
-- ============================================================
-- PR本文の "報告者: <名前>" 行から、users.nickname / users.full_name と
-- 完全一致したユーザーを紐付けるための列。
-- 一覧での「自分の報告だけ表示」フィルタ用途。
-- ============================================================

ALTER TABLE version_logs
  ADD COLUMN IF NOT EXISTS reporter_user_id uuid REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS version_logs_reporter_user_id_idx
  ON version_logs (reporter_user_id)
  WHERE reporter_user_id IS NOT NULL;
