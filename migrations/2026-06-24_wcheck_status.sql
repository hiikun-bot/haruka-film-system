-- ADR 024: 静止画クリエイティブの「Wチェック」工程
-- バグ報告 aa11784a
--
-- 追加するもの:
--   1. creative_categories.wcheck_default … カテゴリ既定の要否（image=true）
--   2. creatives.wcheck_required          … クリエ個別上書き（NULL=カテゴリ既定を継承）
--   3. creatives.wcheck_requested_by/at   … 直近のWチェック依頼者・依頼日時
--   4. creatives.wcheck_comment           … 直近のWチェック依頼コメント
--
-- ステータス値 'Wチェック' / 'Wチェック後修正' は creatives.status(TEXT) にそのまま入る（CHECK制約なし）。
-- creative_assignments.role = 'wcheck' も role(TEXT) にそのまま入る（CHECK制約なし）。
-- 通知は既存の notification_type='creative_status' を再利用するため notification_settings の変更は無し。
--
-- 既存データへの影響:
--   ・creatives.wcheck_required は NULL のまま → image 以外は category 既定 false なので「不要」。
--   ・image カテゴリでも既存クリエは NULL=既定継承。新規作成分のみ作成時に true をセットする（アプリ側）。
--   ・本番データを一括で必須化しない（安全な既定）。

-- 1. カテゴリ既定
ALTER TABLE creative_categories
  ADD COLUMN IF NOT EXISTS wcheck_default BOOLEAN NOT NULL DEFAULT false;

-- 静止画(image)のみ既定で必要にする
UPDATE creative_categories SET wcheck_default = true WHERE code = 'image';

-- 2〜4. クリエイティブ個別の要否・依頼メタ
ALTER TABLE creatives
  ADD COLUMN IF NOT EXISTS wcheck_required     BOOLEAN,
  ADD COLUMN IF NOT EXISTS wcheck_requested_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS wcheck_requested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS wcheck_comment      TEXT;

-- 既存の静止画クリエイティブを「不要」で凍結（第17項: 既存は現行フロー維持、本番を必須化しない）。
-- NULL = カテゴリ既定を継承 のため、image 既存クリエは放置すると wcheck_default=true を継承して
-- いきなり「必要」になってしまう。これを防ぐため、現時点で存在する image クリエだけ明示 false にする。
-- 新規作成分（migration 後に作られるクリエ）は wcheck_required = NULL のまま → カテゴリ既定(image=true)を継承し「必要」。
UPDATE creatives c SET wcheck_required = false
WHERE c.wcheck_required IS NULL
  AND COALESCE(
        c.category_id,
        (SELECT p.primary_category_id FROM projects p WHERE p.id = c.project_id)
      ) IN (SELECT id FROM creative_categories WHERE code = 'image');

-- Wチェック担当者の絞り込み高速化（任意・軽量）
CREATE INDEX IF NOT EXISTS idx_creative_assignments_wcheck
  ON creative_assignments (creative_id)
  WHERE role = 'wcheck';
