-- 2026-09-03_portfolio_reactions.sql
-- 作品ギャラリー（ポートフォリオ）の 👏 拍手（リアクション）と 💬 ひとこと
-- 設計: docs/design/decisions/037-portfolio-reactions.md
--
-- 目的:
--   納品作品のギャラリーは一方通行で、他のメンバーからの反応が付かなかった。
--   つぶやきと同じ 5 種のリアクション（👍 ❤️ 👏 😊 😳）と短いコメントを作品に
--   付けられるようにし、作った本人（制作担当）にベル通知を届ける。
--
-- テーブルは tweets 系（tweet_reactions / tweet_comments）や死蔵の posts 系と統合しない。
--   対象（tweet_id vs creative_id）・ライフサイクル（つぶやきは期限切れで消える／作品は残る）・
--   通知の宛先（投稿者 1 人 vs 制作担当の複数人）が違うため、専用テーブルとして分離する
--   （docs/design/philosophy.md 4 項「概念の統合より分離」・open-questions Q3 の判断を継続）。
--
-- reaction_type に CHECK は付けない（tweet_reactions と同じ流儀。許可値はコード側
--   utils/reactions.js が正で、ここに書くと二重管理になるため）。
--
-- 冪等性: IF NOT EXISTS を徹底。二重実行しても壊れない。
-- 既存データへの影響: 新規テーブルのみ。既存の作品表示は何も変わらない。

BEGIN;

-- -----------------------------------------------------
-- 1) 作品へのリアクション（1 人 × 1 作品 × 1 種別 で 1 行。トグル運用）
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS portfolio_reactions (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  creative_id   UUID        NOT NULL REFERENCES creatives(id) ON DELETE CASCADE,
  user_id       UUID        NOT NULL REFERENCES users(id)     ON DELETE CASCADE,
  reaction_type TEXT        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (creative_id, user_id, reaction_type)
);
-- 一覧 API が「表示中の作品の集合」で一括取得する
CREATE INDEX IF NOT EXISTS idx_portfolio_reactions_creative
  ON portfolio_reactions (creative_id);
-- 「この人が最近押したもの」（将来の活動表示用）
CREATE INDEX IF NOT EXISTS idx_portfolio_reactions_user_created
  ON portfolio_reactions (user_id, created_at);

COMMENT ON TABLE  portfolio_reactions IS '作品ギャラリーのリアクション（👍 ❤️ 👏 😊 😳）。1人×1作品×1種別で1行';
COMMENT ON COLUMN portfolio_reactions.reaction_type IS 'good / heart / clap / smile / surprised（utils/reactions.js が正）';

-- -----------------------------------------------------
-- 2) 作品へのひとこと（短いコメント。論理削除）
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS portfolio_comments (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  creative_id UUID        NOT NULL REFERENCES creatives(id) ON DELETE CASCADE,
  user_id     UUID        NOT NULL REFERENCES users(id)     ON DELETE CASCADE,
  body        TEXT        NOT NULL CHECK (char_length(body) <= 500),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_portfolio_comments_creative
  ON portfolio_comments (creative_id, created_at);

COMMENT ON TABLE  portfolio_comments IS '作品ギャラリーのひとこと（最大500字・論理削除）';

-- -----------------------------------------------------
-- 3) RLS（他テーブルと同じく ENABLE のみ。アクセスはサーバーの service role 経由）
-- -----------------------------------------------------
ALTER TABLE portfolio_reactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE portfolio_comments  ENABLE ROW LEVEL SECURITY;

-- -----------------------------------------------------
-- 4) 通知の ON/OFF 列（notification_settings）
--    notification_logs.notification_type には CHECK が無いので、種別追加に伴う
--    テーブル変更はこの 2 列だけ（creative_registered と同じ手順）。
-- -----------------------------------------------------
ALTER TABLE notification_settings
  ADD COLUMN IF NOT EXISTS portfolio_reaction_enabled BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS portfolio_comment_enabled  BOOLEAN NOT NULL DEFAULT true;

COMMIT;
