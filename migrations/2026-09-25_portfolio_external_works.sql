-- 2026-09-25_portfolio_external_works.sql
-- 🌐 みんなのポートフォリオ（外部作品）: 作品ギャラリーに HFS の案件外で作った作品を
--   URL（YouTube / Google ドライブ共有 / その他のリンク）やファイルアップロードで追加できるようにする。
-- 設計: docs/design/decisions/045-portfolio-external-works.md
--
-- 目的:
--   🏆 作品ページは creatives（＝HFS の案件で納品した成果物）しか並ばず、メンバーが
--   HFS 以外で作った作品（個人制作・前職・他社案件・YouTube 公開作）は載せられなかった。
--   案件・請求・集計に影響させずに「作品」としてだけ並べたいので、creatives には相乗りせず
--   専用テーブルで持つ（philosophy.md 4 項「概念の統合より分離」・ADR 042 と同じ流儀）。
--
-- 列の要点:
--   source_type … youtube（URL 貼り付け）/ drive（共有 URL 貼り付け）/ upload（HFS の Drive へ直送）/ link（その他の URL）
--   media_kind  … video / image / web（作品ページの 🎬 動画 / 🎨 静止画 タブの振り分け）
--   thumb_url   … youtube / link はサムネの URL をそのまま持つ。drive / upload は NULL（サーバーが代理配信）
--   ai_*        … AI 提案（Gemini）の生データ・モデル・概算費用（月次予算ガードの集計対象。ADR 039 D2）
--   deleted_at  … 論理削除（本人 or admin）
--
-- 冪等性: IF NOT EXISTS を徹底。二重実行しても壊れない。
-- 既存データへの影響: 新規テーブルのみ。既存の作品表示は何も変わらない。

BEGIN;

CREATE TABLE IF NOT EXISTS portfolio_external_works (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id        UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_by           UUID        REFERENCES users(id) ON DELETE SET NULL,
  source_type          TEXT        NOT NULL CHECK (source_type IN ('youtube', 'drive', 'upload', 'link')),
  source_url           TEXT,
  youtube_id           TEXT,
  drive_file_id        TEXT,
  mime_type            TEXT,
  media_kind           TEXT        NOT NULL DEFAULT 'video' CHECK (media_kind IN ('video', 'image', 'web')),
  title                TEXT        NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  description          TEXT        CHECK (description IS NULL OR char_length(description) <= 500),
  client_name          TEXT        CHECK (client_name IS NULL OR char_length(client_name) <= 100),
  portfolio_genre_code TEXT,
  portfolio_style_code TEXT,
  aspect_w             INTEGER,
  aspect_h             INTEGER,
  produced_at          DATE,
  thumb_url            TEXT,
  ai_meta              JSONB,
  ai_model             TEXT,
  ai_cost_jpy          NUMERIC(10,3),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at           TIMESTAMPTZ
);

-- 一覧 API は「持ち主 × 未削除」で引き、produced_at の新しい順に並べる
CREATE INDEX IF NOT EXISTS idx_portfolio_external_works_owner
  ON portfolio_external_works (owner_user_id, produced_at DESC)
  WHERE deleted_at IS NULL;
-- 月次予算ガード（ADR 039 D2）が「今月の AI 費用」を合算する
CREATE INDEX IF NOT EXISTS idx_portfolio_external_works_ai_cost
  ON portfolio_external_works (created_at)
  WHERE ai_cost_jpy IS NOT NULL;

COMMENT ON TABLE  portfolio_external_works IS '🌐 みんなのポートフォリオ（外部作品）。HFS の案件外の作品を作品ギャラリーに並べる（creatives とは分離）';
COMMENT ON COLUMN portfolio_external_works.source_type IS 'youtube / drive（共有URL）/ upload（HFS Drive へ直送）/ link（その他URL）';
COMMENT ON COLUMN portfolio_external_works.media_kind  IS 'video / image / web（🎬 動画 / 🎨 静止画 タブの振り分け）';
COMMENT ON COLUMN portfolio_external_works.thumb_url   IS 'youtube / link のサムネURL。drive / upload は NULL（サーバー代理配信）';
COMMENT ON COLUMN portfolio_external_works.ai_cost_jpy IS 'AI 提案（Gemini）の概算費用（円）。MONTHLY_ANALYSIS_BUDGET_JPY の集計対象';

COMMIT;
