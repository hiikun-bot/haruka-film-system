-- ナレッジ画面「動画視聴」タブ用のマスタテーブル
--
-- 目的: 勉強会・障害対応・チーム事例・バズ動画など、チームに役立つ動画 URL を 1 箇所に集約する。
-- ナレッジ画面に上位タブを新設し、デフォルトの「添削指導」と並列で「動画視聴」を提供する。
-- 投稿は全員可。再生回数 (learning_video_views) は admin のみ閲覧可能（API 側でガード）。

-- カテゴリ（admin が画面から追加可能）
CREATE TABLE IF NOT EXISTS learning_video_categories (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL UNIQUE,
  sort_order  int  NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- 動画本体
CREATE TABLE IF NOT EXISTS learning_videos (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title         text NOT NULL,
  url           text NOT NULL,
  thumbnail_url text,                    -- NULL なら YouTube 推定 / プレースホルダ
  description   text,
  category_id   uuid REFERENCES learning_video_categories(id) ON DELETE SET NULL,
  posted_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  is_archived   boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_learning_videos_created_at ON learning_videos(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_learning_videos_category   ON learning_videos(category_id);
CREATE INDEX IF NOT EXISTS idx_learning_videos_posted_by  ON learning_videos(posted_by);

-- 再生ログ（カードクリック単位で 1 行ずつ記録、再生回数 = COUNT）
CREATE TABLE IF NOT EXISTS learning_video_views (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id   uuid NOT NULL REFERENCES learning_videos(id) ON DELETE CASCADE,
  user_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  viewed_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_learning_video_views_video_id ON learning_video_views(video_id);
CREATE INDEX IF NOT EXISTS idx_learning_video_views_viewed_at ON learning_video_views(viewed_at DESC);

-- 初期カテゴリ投入（重複は無視）
INSERT INTO learning_video_categories (name, sort_order) VALUES
  ('勉強会',         10),
  ('障害対応',       20),
  ('チーム事例',     30),
  ('バズ動画',       40),
  ('面白い',         50),
  ('参考になった',   60),
  ('その他',         99)
ON CONFLICT (name) DO NOTHING;

NOTIFY pgrst, 'reload schema';
