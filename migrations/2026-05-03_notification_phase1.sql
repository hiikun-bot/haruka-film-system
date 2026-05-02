-- ============================================================
-- 通知機能 Phase 1 段階1 — 通知基盤
-- 詳細設計: docs/notification/notification_TABLE_DESIGN.md
--
-- 役割（リベシティ風通知の土台になる）:
--   ・notification_logs（受信箱）
--   ・notification_settings（受信設定。Phase 2で本格活用）
--   ・posts / post_reactions / post_comments（社内タイムライン）
--   ・creatives.ball_holder_id（現在のボール保持者キャッシュ）
--   ・notify_ball_returned トリガー（ball_holder_id 変化で通知発火）
--   ・posts のリアクション数 / コメント数 自動カウントトリガー
--   ・Supabase Realtime（リアルタイム配信）の publication 登録
--
-- 冪等性（idempotency）— 同じSQLを何度流しても壊れない仕組み:
--   ・テーブルは IF NOT EXISTS
--   ・トリガーは DROP TRIGGER IF EXISTS → CREATE
--   ・関数は CREATE OR REPLACE
--   ・publication への ADD TABLE は DO ブロックで重複時スキップ
--
-- 親エージェント決定事項（設計書より優先される）:
--   ・notification_logs は新規CREATE一択（DROP は付けない。本番に未存在）
--   ・creatives.ball_holder_id を新規列として追加（既存 getBallHolder() は温存し、
--     アプリ側で結果を ball_holder_id 列にキャッシュUPDATEする）
--   ・全体通知の発火権限は admin / secretary / producer / producer_director の4ロール
-- ============================================================

-- ------------------------------------------------------------
-- 1. notification_logs（通知本体）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notification_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  notification_type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  link_url TEXT,
  meta JSONB DEFAULT '{}'::jsonb,
  is_read BOOLEAN NOT NULL DEFAULT false,
  read_at TIMESTAMPTZ,
  sender_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notification_logs_user_unread
  ON notification_logs(user_id, is_read, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notification_logs_user_created
  ON notification_logs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notification_logs_type
  ON notification_logs(notification_type);

-- ------------------------------------------------------------
-- 2. notification_settings（ユーザーごとの受信ON/OFF設定）
--    Phase 1ではレコードだけ作っておき、Phase 2でUI整備時に活用する。
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notification_settings (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  ball_returned_enabled BOOLEAN NOT NULL DEFAULT true,
  global_enabled BOOLEAN NOT NULL DEFAULT true,
  mention_enabled BOOLEAN NOT NULL DEFAULT true,
  post_reaction_enabled BOOLEAN NOT NULL DEFAULT true,
  post_comment_enabled BOOLEAN NOT NULL DEFAULT true,
  sos_enabled BOOLEAN NOT NULL DEFAULT true,
  deadline_enabled BOOLEAN NOT NULL DEFAULT true,
  assignment_enabled BOOLEAN NOT NULL DEFAULT true,
  invoice_enabled BOOLEAN NOT NULL DEFAULT true,
  browser_notification BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 既存ユーザー全員にデフォルト設定を投入（後続ユーザーは createNotification 側で auto upsert する想定）
INSERT INTO notification_settings (user_id)
SELECT id FROM users
ON CONFLICT (user_id) DO NOTHING;

-- ------------------------------------------------------------
-- 3. posts（つぶやき投稿本体）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL CHECK (char_length(body) <= 1000),
  mentioned_user_ids UUID[] DEFAULT '{}',
  reaction_count INT NOT NULL DEFAULT 0,
  comment_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_posts_created
  ON posts(created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_posts_user
  ON posts(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_mentioned
  ON posts USING GIN(mentioned_user_ids);

-- ------------------------------------------------------------
-- 4. post_reactions（リアクションスタンプ）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS post_reactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reaction_type TEXT NOT NULL CHECK (reaction_type IN ('good','heart','clap','smile','surprised')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (post_id, user_id, reaction_type)
);

CREATE INDEX IF NOT EXISTS idx_post_reactions_post ON post_reactions(post_id);

-- ------------------------------------------------------------
-- 5. post_comments（投稿への返信コメント）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS post_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL CHECK (char_length(body) <= 500),
  mentioned_user_ids UUID[] DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_post_comments_post
  ON post_comments(post_id, created_at);

-- ------------------------------------------------------------
-- 6. creatives.ball_holder_id（現在のボール保持者キャッシュ列）
--    既存の getBallHolder() は temp 計算で派生していたが、トリガーで通知を打つために
--    実列としてキャッシュする。アプリ側で更新する（status 変更・assignment 変更時）。
-- ------------------------------------------------------------
ALTER TABLE creatives
  ADD COLUMN IF NOT EXISTS ball_holder_id UUID REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_creatives_ball_holder
  ON creatives(ball_holder_id);

-- ------------------------------------------------------------
-- 7. RLS（Row Level Security）
--    DBレベルで「自分宛の通知だけ見える」「全員が投稿一覧を見える」等を強制する。
--    バックエンド（service_role キー）からは RLS バイパスで全行触れるが、
--    将来クライアント直アクセスや公開 anon キー利用時の保険になる。
-- ------------------------------------------------------------
ALTER TABLE notification_logs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS notification_select_own ON notification_logs;
CREATE POLICY notification_select_own ON notification_logs
  FOR SELECT USING (user_id = auth.uid());
DROP POLICY IF EXISTS notification_update_own ON notification_logs;
CREATE POLICY notification_update_own ON notification_logs
  FOR UPDATE USING (user_id = auth.uid());

ALTER TABLE notification_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS notification_settings_select_own ON notification_settings;
CREATE POLICY notification_settings_select_own ON notification_settings
  FOR SELECT USING (user_id = auth.uid());
DROP POLICY IF EXISTS notification_settings_update_own ON notification_settings;
CREATE POLICY notification_settings_update_own ON notification_settings
  FOR UPDATE USING (user_id = auth.uid());

ALTER TABLE posts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS posts_select_all ON posts;
CREATE POLICY posts_select_all ON posts
  FOR SELECT USING (deleted_at IS NULL);
DROP POLICY IF EXISTS posts_insert_own ON posts;
CREATE POLICY posts_insert_own ON posts
  FOR INSERT WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS posts_update_own ON posts;
CREATE POLICY posts_update_own ON posts
  FOR UPDATE USING (user_id = auth.uid());

ALTER TABLE post_reactions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS post_reactions_select_all ON post_reactions;
CREATE POLICY post_reactions_select_all ON post_reactions
  FOR SELECT USING (true);
DROP POLICY IF EXISTS post_reactions_insert_own ON post_reactions;
CREATE POLICY post_reactions_insert_own ON post_reactions
  FOR INSERT WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS post_reactions_delete_own ON post_reactions;
CREATE POLICY post_reactions_delete_own ON post_reactions
  FOR DELETE USING (user_id = auth.uid());

ALTER TABLE post_comments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS post_comments_select_all ON post_comments;
CREATE POLICY post_comments_select_all ON post_comments
  FOR SELECT USING (deleted_at IS NULL);
DROP POLICY IF EXISTS post_comments_insert_own ON post_comments;
CREATE POLICY post_comments_insert_own ON post_comments
  FOR INSERT WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS post_comments_update_own ON post_comments;
CREATE POLICY post_comments_update_own ON post_comments
  FOR UPDATE USING (user_id = auth.uid());

-- ------------------------------------------------------------
-- 8. トリガー関数 — ball 返却の自動通知
--    ball_holder_id が変化し、新しい受け手が NULL でないとき notification_logs に INSERT。
--    creative の表示名は file_name を使う（実DBの列名）。
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION notify_ball_returned()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.ball_holder_id IS DISTINCT FROM OLD.ball_holder_id
     AND NEW.ball_holder_id IS NOT NULL THEN
    INSERT INTO notification_logs (
      user_id,
      notification_type,
      title,
      body,
      link_url,
      meta,
      sender_id
    ) VALUES (
      NEW.ball_holder_id,
      'ball_returned',
      'ボールが返ってきました',
      COALESCE(NEW.file_name, 'クリエイティブ') || 'のボールが返ってきました',
      '/creatives/' || NEW.id,
      jsonb_build_object(
        'creative_id', NEW.id,
        'creative_name', NEW.file_name,
        'previous_status', OLD.status,
        'new_status', NEW.status
      ),
      OLD.ball_holder_id
    );
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_creatives_ball_returned ON creatives;
CREATE TRIGGER trg_creatives_ball_returned
AFTER UPDATE OF ball_holder_id ON creatives
FOR EACH ROW EXECUTE FUNCTION notify_ball_returned();

-- ------------------------------------------------------------
-- 9. トリガー関数 — リアクション数の自動カウント
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION update_post_reaction_count()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE posts SET reaction_count = reaction_count + 1
    WHERE id = NEW.post_id;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE posts SET reaction_count = GREATEST(reaction_count - 1, 0)
    WHERE id = OLD.post_id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_post_reactions_count ON post_reactions;
CREATE TRIGGER trg_post_reactions_count
AFTER INSERT OR DELETE ON post_reactions
FOR EACH ROW EXECUTE FUNCTION update_post_reaction_count();

-- ------------------------------------------------------------
-- 10. トリガー関数 — コメント数の自動カウント（論理削除に追従）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION update_post_comment_count()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE posts SET comment_count = comment_count + 1
    WHERE id = NEW.post_id;
  ELSIF TG_OP = 'UPDATE'
        AND NEW.deleted_at IS NOT NULL
        AND OLD.deleted_at IS NULL THEN
    UPDATE posts SET comment_count = GREATEST(comment_count - 1, 0)
    WHERE id = NEW.post_id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_post_comments_count ON post_comments;
CREATE TRIGGER trg_post_comments_count
AFTER INSERT OR UPDATE ON post_comments
FOR EACH ROW EXECUTE FUNCTION update_post_comment_count();

-- ------------------------------------------------------------
-- 11. Supabase Realtime publication 登録
--     publication（パブリケーション）— Postgres の論理レプリケーションで「どの変更を流すか」を
--     宣言する仕組み。Supabase Realtime はこの supabase_realtime publication に登録された
--     テーブルの INSERT/UPDATE/DELETE をフロントへ配信する。
--
--     notification_logs と posts のみ Realtime 配信に乗せる（段階1ではこの2つで十分）。
--     既に登録済みの場合は重複エラーを起こすので DO ブロックで握りつぶす。
-- ------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE notification_logs;
  EXCEPTION
    WHEN duplicate_object THEN NULL;
    WHEN undefined_object THEN
      RAISE NOTICE 'publication supabase_realtime not found — Realtime未有効プロジェクトかもしれません';
  END;
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE posts;
  EXCEPTION
    WHEN duplicate_object THEN NULL;
    WHEN undefined_object THEN NULL;
  END;
END $$;
