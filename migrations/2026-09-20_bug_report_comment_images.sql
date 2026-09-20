-- ============================================================
-- バグ報告コメントへの貼り付け画像（Ctrl+V 添付）
-- ============================================================
-- 目的:
--   バグ報告モーダルの 💬 コメント欄で Ctrl+V / D&D / ファイル選択した画像を
--   コメント1件に紐づけて保存する。「ここがこうだから直してほしい」と
--   スクショ＋理由をセットで議論できるようにする。
--
--   報告本体のスクリーンショット (bug_reports.screenshot_data_url) は
--   アノテーション付きの1枚だけ。それ以降のやり取りで出てくる画像は
--   こちらのテーブルに時系列で積む。
--
-- 設計は creative_comment_images（2026-07-18）と同じ:
--   ・画像本体は base64 data URL をそのまま列に格納
--   ・一覧 API では image_data を SELECT せず
--     GET /bug-report-comment-images/:id/image で遅延配信する
--     （一覧ペイロード肥大を避ける。[[project_base64_columns_payload]] の教訓）
-- ============================================================

CREATE TABLE IF NOT EXISTS bug_report_comment_images (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 報告単位でまとめて引くため冗長に持つ（コメント削除後も辿れるようにはしない＝CASCADE）
  bug_report_id uuid NOT NULL REFERENCES bug_reports(id) ON DELETE CASCADE,
  -- コメント本体は物理削除（DELETE /bug-report-comments/:id）なので CASCADE で画像も消える
  comment_id    uuid NOT NULL REFERENCES bug_report_comments(id) ON DELETE CASCADE,
  image_data    text NOT NULL,            -- data:<mime>;base64,<...>
  mime          text,
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);

COMMENT ON TABLE bug_report_comment_images IS
  'バグ報告の💬コメントに貼り付けた画像。image_data=base64 data URL。comment_id でコメント1件に紐づく（コメント削除で CASCADE）。';

-- モーダル open 時に報告単位で一括取得する（image_data は引かない）
CREATE INDEX IF NOT EXISTS idx_brci_report_created
  ON bug_report_comment_images(bug_report_id, created_at)
  WHERE deleted_at IS NULL;

-- コメント単位の引き当て
CREATE INDEX IF NOT EXISTS idx_brci_comment
  ON bug_report_comment_images(comment_id)
  WHERE deleted_at IS NULL;
