-- つぶやき機能（社内タイムライン）用テーブル
-- 写真1枚 + 短いコメント + ❤️ いいね のミニ社内 SNS。
-- 90 日で自動的に非表示（ピン留めは永続）。
--
-- 適用方法:
--   1) Supabase ダッシュボード → SQL Editor を開く
--   2) このファイル全文を貼り付けて Run
--   (db/migrate.js の自動同期が走っていれば不要)

CREATE TABLE IF NOT EXISTS tweets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL CHECK (char_length(body) <= 280),
  image_data TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '90 days'),
  is_pinned BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tweets_active ON tweets(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tweets_user ON tweets(user_id);

CREATE TABLE IF NOT EXISTS tweet_likes (
  tweet_id UUID NOT NULL REFERENCES tweets(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (tweet_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_tweet_likes_user ON tweet_likes(user_id);

NOTIFY pgrst, 'reload schema';
