-- ============================================================
-- creative_file_comments に返信スレッド構造を追加
--
-- 背景:
--   Frame.io 風レビュー画面で、ディレクター指摘コメントに編集者が
--   そのコメント直下に返信できるようにする（親子スレッド構造）。
--   親コメント削除時は ON DELETE CASCADE で返信もまとめて消す。
--
-- 設計:
--   ・parent_comment_id NULL = ルートコメント（タイムコードドット表示対象）
--   ・parent_comment_id NOT NULL = 返信（タイムコード/bbox は親に従う、ドット非表示）
--   ・GET /creative-files/:fid/comments は flat に返し、フロントでツリー化
--
-- 冪等性:
--   ・ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS
--   ・何度流しても安全
-- ============================================================

ALTER TABLE creative_file_comments
  ADD COLUMN IF NOT EXISTS parent_comment_id UUID
  REFERENCES creative_file_comments(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_cfc_parent_comment_id
  ON creative_file_comments(parent_comment_id)
  WHERE parent_comment_id IS NOT NULL;
