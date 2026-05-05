-- 画像コメントの範囲選択（bounding box）保存用
-- 正規化座標 (0..1) で {x, y, w, h} を JSONB に保存。
-- timecode と排他ではない（同時に持ちうるが UI では片方のみ）。
ALTER TABLE creative_file_comments
  ADD COLUMN IF NOT EXISTS bbox JSONB;

-- bbox を持つコメントの絞り込みを高速化（任意）
CREATE INDEX IF NOT EXISTS idx_cfc_bbox_not_null
  ON creative_file_comments ((bbox IS NOT NULL))
  WHERE bbox IS NOT NULL;
