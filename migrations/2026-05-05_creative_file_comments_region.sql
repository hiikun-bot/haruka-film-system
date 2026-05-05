-- creative_file_comments.region を追加（静止画レビューの矩形範囲指定コメント用）
-- 適用: Supabase SQL Editor に貼って Run。冪等。
--
-- 形式: jsonb で { x, y, w, h, image_side?: 'A'|'B'|null }
--   - x, y, w, h は 0〜1 の正規化座標（画像の自然解像度に対する比率）
--   - image_side は将来の A/B 比較表示で「どちらの画像か」を識別するためのオプション
-- 既存のテキスト専用コメントは region=NULL のまま動作する（後方互換）。

ALTER TABLE creative_file_comments
  ADD COLUMN IF NOT EXISTS region JSONB;

-- 領域コメントのみ取り出すクエリ用（NULL を除外する部分インデックス）
CREATE INDEX IF NOT EXISTS idx_cfc_region_not_null
  ON creative_file_comments(creative_file_id)
  WHERE region IS NOT NULL;

NOTIFY pgrst, 'reload schema';
