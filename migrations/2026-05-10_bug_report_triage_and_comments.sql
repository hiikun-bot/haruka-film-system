-- ============================================================
-- バグ報告: 対応方針(triage) + コメント基盤
-- ============================================================
-- 目的:
--   バグ報告された後、admin が「対応する / 保留 / 却下」の方針を
--   決定する仕組み（旧称: トリアージ → UI上は「対応方針」）。
--   全員が議論できるコメント欄も同梱。
--
-- 関連:
--   ・将来 Step 3 で bug_report_improvements (PR連携) を追加
--   ・将来 Step 4 で duplicate_of_id（重複先勝ち集計）を追加
--   ・admin の Claude修正依頼ボタンは triage_decision='to_fix' のみ活性
-- ============================================================

-- ① bug_reports に対応方針カラムを追加
ALTER TABLE bug_reports
  ADD COLUMN IF NOT EXISTS triage_decision text
    CHECK (triage_decision IS NULL OR triage_decision IN ('to_fix', 'hold', 'wont_fix')),
  ADD COLUMN IF NOT EXISTS triage_decided_at timestamptz,
  ADD COLUMN IF NOT EXISTS triage_decided_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL;

-- 24h SLA チェックで「未トリアージ・open」を高速抽出するための部分インデックス
CREATE INDEX IF NOT EXISTS bug_reports_pending_triage_idx
  ON bug_reports (created_at)
  WHERE triage_decision IS NULL AND status = 'open';

-- ② コメントテーブル（誰でも投稿可・systemコメントは方針確定で自動INSERT）
CREATE TABLE IF NOT EXISTS bug_report_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bug_report_id uuid NOT NULL REFERENCES bug_reports(id) ON DELETE CASCADE,
  -- system コメントは author_user_id NULL でも可
  author_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  body text NOT NULL,
  -- 'comment' = ユーザー投稿 / 'system' = 方針変更等の自動記録
  kind text NOT NULL DEFAULT 'comment'
    CHECK (kind IN ('comment', 'system')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bug_report_comments_bug_report_id_idx
  ON bug_report_comments (bug_report_id, created_at);
