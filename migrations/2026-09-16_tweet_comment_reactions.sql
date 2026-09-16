-- ============================================================
-- つぶやきの返信（tweet_comments）へのリアクション
--   バグ報告 #4a8b4046「つぶやきの返信に対するリアクション機能」
--
-- 役割:
--   ・tweet_comment_reactions 新設（5種スタンプ: good/heart/clap/smile/surprised）
--     つぶやき本体の tweet_reactions と同じ体系で、対象が返信（comment）になるだけ。
--   ・tweet_id を非正規化して持つ（返信一覧 GET /tweets/:id/comments で
--     「そのつぶやき配下の返信リアクション全件」を 1 クエリ・URL 長に依存せず引くため）。
--   ・UNIQUE(comment_id, user_id, reaction_type) で同一種別の重複防止。
--     種別違いの複数同時押しは可（本体と同じ）。
--   ・RLS は tweet_reactions と同方針（SELECT 全員 / INSERT・DELETE は本人のみ）。
--
-- 冪等性: CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS / DROP POLICY IF EXISTS
--
-- 適用方法:
--   1) Supabase ダッシュボード → SQL Editor を開く
--   2) このファイル全文を貼り付けて Run
-- ============================================================

CREATE TABLE IF NOT EXISTS tweet_comment_reactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  comment_id UUID NOT NULL REFERENCES tweet_comments(id) ON DELETE CASCADE,
  tweet_id   UUID NOT NULL REFERENCES tweets(id)         ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id)          ON DELETE CASCADE,
  reaction_type TEXT NOT NULL CHECK (reaction_type IN ('good','heart','clap','smile','surprised')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (comment_id, user_id, reaction_type)
);

CREATE INDEX IF NOT EXISTS idx_tweet_comment_reactions_tweet   ON tweet_comment_reactions(tweet_id);
CREATE INDEX IF NOT EXISTS idx_tweet_comment_reactions_comment ON tweet_comment_reactions(comment_id);
CREATE INDEX IF NOT EXISTS idx_tweet_comment_reactions_user    ON tweet_comment_reactions(user_id);

ALTER TABLE tweet_comment_reactions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tweet_comment_reactions_select_all ON tweet_comment_reactions;
CREATE POLICY tweet_comment_reactions_select_all ON tweet_comment_reactions
  FOR SELECT USING (true);
DROP POLICY IF EXISTS tweet_comment_reactions_insert_own ON tweet_comment_reactions;
CREATE POLICY tweet_comment_reactions_insert_own ON tweet_comment_reactions
  FOR INSERT WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS tweet_comment_reactions_delete_own ON tweet_comment_reactions;
CREATE POLICY tweet_comment_reactions_delete_own ON tweet_comment_reactions
  FOR DELETE USING (user_id = auth.uid());

NOTIFY pgrst, 'reload schema';
