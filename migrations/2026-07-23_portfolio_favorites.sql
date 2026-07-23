-- 2026-07-23_portfolio_favorites.sql
-- 作品ギャラリーの「マイベストポートフォリオ」（⭐）
--
-- 設計:
--   お気に入りは creatives の列ではなく (user_id, creative_id) の関連テーブルにする。
--   1つのクリエイティブに担当者が複数付くことがあり、「誰のベストか」は人ごとに違うため。
--   ⭐ を付けられるのは本人（その creative の creative_assignments に居る人）だけ。
--
--   他の人が「さんななの作品」を見たとき、初期表示は さんななのマイベストのみ。
--   さんななが1件も⭐を付けていなければ全体表示にフォールバックする（サーバー側で判定）。

CREATE TABLE IF NOT EXISTS portfolio_favorites (
  user_id     uuid        NOT NULL REFERENCES users(id)     ON DELETE CASCADE,
  creative_id uuid        NOT NULL REFERENCES creatives(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, creative_id)
);

-- 「この人のベスト一覧」を引くのが唯一のアクセスパターン
CREATE INDEX IF NOT EXISTS idx_portfolio_favorites_user
  ON portfolio_favorites (user_id, created_at DESC);
