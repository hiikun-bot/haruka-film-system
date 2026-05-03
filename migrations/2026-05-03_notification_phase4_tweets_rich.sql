-- ============================================================
-- 通知機能 Phase 1 段階4 — つぶやき拡張（B案）
--
-- 経緯（重要）:
--   通知 Phase 1 当初設計では新テーブル `posts / post_reactions / post_comments` を
--   作成する予定で、段階1 migration（2026-05-03_notification_phase1.sql）でテーブル
--   定義だけ先行投入されている。
--   しかしダッシュボード上で稼働中の既存 `tweets`（280字 + 画像 + ピン留め + ❤️ いいね）
--   を活かす方が UX として自然なため、ユーザーと相談の結果 **B案: 既存 tweets 拡張** を
--   採択した。
--
-- このため:
--   ・新規テーブル posts/post_reactions/post_comments は **塩漬け**（DROPしない・使わない）
--   ・本 migration では `tweets` を拡張し、`tweet_reactions` / `tweet_comments` を新設
--   ・既存 `tweet_likes` は 互換性維持のため **温存**（DROPしない）
--
-- 役割:
--   ・tweets に mentioned_user_ids / reaction_count / comment_count を追加
--   ・tweet_reactions（5種スタンプ: good/heart/clap/smile/surprised）新設
--   ・tweet_comments（500字 + メンション + 論理削除）新設
--   ・既存 tweet_likes を tweet_reactions(heart) に冪等コピー（元テーブルは温存）
--   ・リアクション数 / コメント数の自動カウントトリガー
--   ・RLS（自分のみ INSERT/DELETE/UPDATE、SELECT は全員）
--   ・supabase_realtime publication への登録
--
-- 冪等性:
--   ・ALTER ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS
--   ・トリガーは DROP IF EXISTS → CREATE
--   ・関数は CREATE OR REPLACE
--   ・publication ADD TABLE は DO ブロックで重複時スキップ
-- ============================================================

-- ------------------------------------------------------------
-- 1. tweets テーブル拡張
-- ------------------------------------------------------------
ALTER TABLE tweets ADD COLUMN IF NOT EXISTS mentioned_user_ids UUID[] DEFAULT '{}';
ALTER TABLE tweets ADD COLUMN IF NOT EXISTS reaction_count INT NOT NULL DEFAULT 0;
ALTER TABLE tweets ADD COLUMN IF NOT EXISTS comment_count  INT NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_tweets_mentioned
  ON tweets USING GIN(mentioned_user_ids);

-- ------------------------------------------------------------
-- 2. tweet_reactions（5種類のリアクションスタンプ）
--    UNIQUE(tweet_id, user_id, reaction_type) で同一種別の重複防止。
--    種別違いの複数同時押しは可（good と heart を両方押す等）。
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tweet_reactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tweet_id UUID NOT NULL REFERENCES tweets(id) ON DELETE CASCADE,
  user_id  UUID NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  reaction_type TEXT NOT NULL CHECK (reaction_type IN ('good','heart','clap','smile','surprised')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tweet_id, user_id, reaction_type)
);

CREATE INDEX IF NOT EXISTS idx_tweet_reactions_tweet ON tweet_reactions(tweet_id);
CREATE INDEX IF NOT EXISTS idx_tweet_reactions_user  ON tweet_reactions(user_id);

-- ------------------------------------------------------------
-- 3. tweet_comments（投稿への返信コメント）
--    500字、メンション対応、論理削除（deleted_at）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tweet_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tweet_id UUID NOT NULL REFERENCES tweets(id) ON DELETE CASCADE,
  user_id  UUID NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  body TEXT NOT NULL CHECK (char_length(body) <= 500),
  mentioned_user_ids UUID[] DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_tweet_comments_tweet
  ON tweet_comments(tweet_id, created_at);
CREATE INDEX IF NOT EXISTS idx_tweet_comments_mentioned
  ON tweet_comments USING GIN(mentioned_user_ids);

-- ------------------------------------------------------------
-- 4. 既存 tweet_likes → tweet_reactions(heart) への冪等コピー
--    旧❤️いいねを新リアクション体系に取り込み、新UIから見えるようにする。
--    重複は ON CONFLICT で握りつぶす（複数回 migration を流しても安全）。
--    元の tweet_likes はそのまま残す（既存 /api/tweets/:id/like API 互換のため）。
-- ------------------------------------------------------------
INSERT INTO tweet_reactions (tweet_id, user_id, reaction_type, created_at)
SELECT tweet_id, user_id, 'heart', created_at FROM tweet_likes
ON CONFLICT (tweet_id, user_id, reaction_type) DO NOTHING;

-- 初期化: tweets.reaction_count を実数で再計算
UPDATE tweets t
SET reaction_count = COALESCE(
  (SELECT COUNT(*) FROM tweet_reactions r WHERE r.tweet_id = t.id),
  0
);

-- 初期化: tweets.comment_count も同様（過去データがあれば）
UPDATE tweets t
SET comment_count = COALESCE(
  (SELECT COUNT(*) FROM tweet_comments c WHERE c.tweet_id = t.id AND c.deleted_at IS NULL),
  0
);

-- ------------------------------------------------------------
-- 5. トリガー関数 — リアクション数の自動カウント
--    （既存 update_post_reaction_count() のパターンに揃える）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION update_tweet_reaction_count()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE tweets SET reaction_count = reaction_count + 1
    WHERE id = NEW.tweet_id;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE tweets SET reaction_count = GREATEST(reaction_count - 1, 0)
    WHERE id = OLD.tweet_id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_tweet_reactions_count ON tweet_reactions;
CREATE TRIGGER trg_tweet_reactions_count
AFTER INSERT OR DELETE ON tweet_reactions
FOR EACH ROW EXECUTE FUNCTION update_tweet_reaction_count();

-- ------------------------------------------------------------
-- 6. トリガー関数 — コメント数の自動カウント（論理削除対応）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION update_tweet_comment_count()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE tweets SET comment_count = comment_count + 1
    WHERE id = NEW.tweet_id;
  ELSIF TG_OP = 'UPDATE'
        AND NEW.deleted_at IS NOT NULL
        AND OLD.deleted_at IS NULL THEN
    UPDATE tweets SET comment_count = GREATEST(comment_count - 1, 0)
    WHERE id = NEW.tweet_id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_tweet_comments_count ON tweet_comments;
CREATE TRIGGER trg_tweet_comments_count
AFTER INSERT OR UPDATE ON tweet_comments
FOR EACH ROW EXECUTE FUNCTION update_tweet_comment_count();

-- ------------------------------------------------------------
-- 7. RLS（既存通知系 posts/post_reactions と同じ方針）
--    バックエンドは service_role でバイパスするが、将来クライアント直アクセス時の保険。
-- ------------------------------------------------------------
ALTER TABLE tweet_reactions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tweet_reactions_select_all ON tweet_reactions;
CREATE POLICY tweet_reactions_select_all ON tweet_reactions
  FOR SELECT USING (true);
DROP POLICY IF EXISTS tweet_reactions_insert_own ON tweet_reactions;
CREATE POLICY tweet_reactions_insert_own ON tweet_reactions
  FOR INSERT WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS tweet_reactions_delete_own ON tweet_reactions;
CREATE POLICY tweet_reactions_delete_own ON tweet_reactions
  FOR DELETE USING (user_id = auth.uid());

ALTER TABLE tweet_comments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tweet_comments_select_visible ON tweet_comments;
CREATE POLICY tweet_comments_select_visible ON tweet_comments
  FOR SELECT USING (deleted_at IS NULL);
DROP POLICY IF EXISTS tweet_comments_insert_own ON tweet_comments;
CREATE POLICY tweet_comments_insert_own ON tweet_comments
  FOR INSERT WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS tweet_comments_update_own ON tweet_comments;
CREATE POLICY tweet_comments_update_own ON tweet_comments
  FOR UPDATE USING (user_id = auth.uid());

-- ------------------------------------------------------------
-- 8. Supabase Realtime publication 登録
--    tweets / tweet_reactions / tweet_comments を Realtime 配信に乗せる。
--    既登録の場合は重複エラーになるので DO ブロックで握りつぶす。
-- ------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE tweets;
  EXCEPTION
    WHEN duplicate_object THEN NULL;
    WHEN undefined_object THEN
      RAISE NOTICE 'publication supabase_realtime not found — Realtime未有効プロジェクトかもしれません';
  END;
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE tweet_reactions;
  EXCEPTION
    WHEN duplicate_object THEN NULL;
    WHEN undefined_object THEN NULL;
  END;
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE tweet_comments;
  EXCEPTION
    WHEN duplicate_object THEN NULL;
    WHEN undefined_object THEN NULL;
  END;
END $$;
