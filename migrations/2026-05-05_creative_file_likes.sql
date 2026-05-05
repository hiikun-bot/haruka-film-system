-- ==================== creative_file_likes ====================
-- ファイルプレビューでの「いいね」（タイムコード付き）
-- 参照: routes/haruka.js の /api/creatives/creative-files/:id/likes
--      upsert は (creative_file_id, user_id, timecode_sec) を競合キーとする

CREATE TABLE IF NOT EXISTS creative_file_likes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creative_file_id UUID NOT NULL REFERENCES creative_files(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  timecode_sec NUMERIC(10,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (creative_file_id, user_id, timecode_sec)
);

CREATE INDEX IF NOT EXISTS idx_cfl_creative_file_id ON creative_file_likes(creative_file_id);
CREATE INDEX IF NOT EXISTS idx_cfl_user_id           ON creative_file_likes(user_id);
CREATE INDEX IF NOT EXISTS idx_cfl_created_at        ON creative_file_likes(created_at DESC);
