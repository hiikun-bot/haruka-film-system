-- ============================================================================
-- ADR 009: クリエイティブ納品時の担当者スナップショット
-- ============================================================================
-- 案件途中でディレクター/プロデューサーが交代しても、過去納品済みクリエイティブの
-- 件数・取り分・請求金額が遡及変化しないよう、納品時点の担当者を creatives 行に
-- UUID 配列でスナップショットする。
--
-- 参照: docs/design/decisions/009-creative-completion-snapshot.md
-- ============================================================================

BEGIN;

-- 1) 列追加
ALTER TABLE creatives
  ADD COLUMN IF NOT EXISTS delivered_director_ids UUID[],
  ADD COLUMN IF NOT EXISTS delivered_producer_ids UUID[],
  ADD COLUMN IF NOT EXISTS delivered_snapshot_at  TIMESTAMPTZ;

-- 2) 配列 contains 検索用 GIN index（preview-items / generate の uid in delivered_*_ids 判定）
CREATE INDEX IF NOT EXISTS idx_creatives_delivered_director_ids
  ON creatives USING GIN (delivered_director_ids);
CREATE INDEX IF NOT EXISTS idx_creatives_delivered_producer_ids
  ON creatives USING GIN (delivered_producer_ids);

-- 3) 既存 status='納品' 行への backfill
--    creative_assignments があればそれを正、なければ projects.director_id / producer_id にフォールバック。
--    NULL 要素は array_remove で除く（director_id/producer_id が NULL の案件があるため）。
UPDATE creatives c
SET delivered_director_ids = COALESCE(
      (SELECT array_remove(array_agg(DISTINCT ca.user_id), NULL)
         FROM creative_assignments ca
        WHERE ca.creative_id = c.id AND ca.role = 'director' AND ca.user_id IS NOT NULL),
      array_remove(ARRAY[p.director_id]::uuid[], NULL)
    ),
    delivered_producer_ids = COALESCE(
      (SELECT array_remove(array_agg(DISTINCT ca.user_id), NULL)
         FROM creative_assignments ca
        WHERE ca.creative_id = c.id AND ca.role = 'producer' AND ca.user_id IS NOT NULL),
      array_remove(ARRAY[p.producer_id]::uuid[], NULL)
    ),
    delivered_snapshot_at = COALESCE(c.force_delivered_at, c.updated_at, now())
FROM projects p
WHERE c.project_id = p.id
  AND c.status = '納品'
  AND c.delivered_director_ids IS NULL;

COMMIT;

NOTIFY pgrst, 'reload schema';
