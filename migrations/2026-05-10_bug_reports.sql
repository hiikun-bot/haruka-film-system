-- ============================================================
-- バグ報告システム
-- ============================================================
-- 既存の /api/haruka/error-report (PR #188) は Slack 投稿のみで対応管理が無いため、
-- DB に登録して対応者割当・ステータス管理・履歴閲覧ができる仕組みを別途用意する。
--
-- - 匿名フラグ true の場合は reporter_user_id = null で保存し、誰が報告したか
--   記録しない（日時のみ残る）
-- - スクリーンショットは data URL (base64 png) で screenshot_data_url 列に保存
--   する簡易方式。画像サイズが膨らんできたら将来 Supabase Storage 化を検討
-- ============================================================

CREATE TABLE IF NOT EXISTS bug_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- 報告者（匿名なら null。is_anonymous=true との整合は app 層で担保）
  reporter_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  is_anonymous boolean NOT NULL DEFAULT false,

  -- 報告内容
  title text NOT NULL,
  description text,
  url text,                         -- バグ発生時の URL
  screen_label text,                -- ユーザーが選んだ画面ラベル（例: クリエイティブ詳細）

  -- 重要度・至急対応・ステータス
  severity text NOT NULL DEFAULT 'normal',  -- low / normal / high / critical
  is_urgent boolean NOT NULL DEFAULT false, -- 業務が止まる等で至急対応が必要なフラグ（severity と独立）
  status text NOT NULL DEFAULT 'open',      -- open / in_progress / resolved / wont_fix / duplicate

  -- 対応者
  assignee_user_id uuid REFERENCES users(id) ON DELETE SET NULL,

  -- 添付（data URL でそのまま保存）
  screenshot_data_url text,
  -- アノテーション情報（描画後の合成画像を screenshot_data_url に入れる前提なので参考用）
  annotations jsonb,

  -- ブラウザ・環境
  browser_info jsonb,

  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bug_reports_status_idx ON bug_reports (status);
CREATE INDEX IF NOT EXISTS bug_reports_is_urgent_idx ON bug_reports (is_urgent) WHERE is_urgent = true;
CREATE INDEX IF NOT EXISTS bug_reports_assignee_idx
  ON bug_reports (assignee_user_id) WHERE assignee_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS bug_reports_reporter_idx
  ON bug_reports (reporter_user_id) WHERE reporter_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS bug_reports_created_at_idx ON bug_reports (created_at DESC);
