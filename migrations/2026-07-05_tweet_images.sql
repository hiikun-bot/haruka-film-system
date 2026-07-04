-- つぶやきの複数画像対応（1投稿あたり最大4枚）
-- 既存の tweets.image_data（1枚目・レガシー）はそのまま残し、
-- 新規投稿の画像は tweet_images に position 順（0〜3）で保存する。
-- 配信は GET /api/haruka/tweets/:id/image/:pos（:pos 省略時は 0）。
--
-- 適用方法:
--   1) Supabase ダッシュボード → SQL Editor を開く
--   2) このファイル全文を貼り付けて Run

CREATE TABLE IF NOT EXISTS tweet_images (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tweet_id UUID NOT NULL REFERENCES tweets(id) ON DELETE CASCADE,
  position INT NOT NULL DEFAULT 0 CHECK (position >= 0 AND position < 4),
  image_data TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (tweet_id, position)
);
CREATE INDEX IF NOT EXISTS idx_tweet_images_tweet ON tweet_images(tweet_id);

NOTIFY pgrst, 'reload schema';
