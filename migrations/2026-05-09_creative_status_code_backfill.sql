-- =====================================================
-- creatives.status_code 初期値バックフィル（LP / HP / LINE のみ）
-- 2026-05-09 / カテゴリ別チェブロン PR
-- =====================================================
-- 目的:
--   LP / HP / LINE 案件のクリエイティブで status_code が NULL のものに
--   そのカテゴリの default テンプレの最小 sort_order の code を入れる。
--
-- 動画 / 静止画 案件は既存の status (日本語ラベル) で全機能が回っているため、
-- backfill 対象から外す（status_code 駆動の UI/フロー は LP/HP/LINE 限定）。
--
-- べき等: 既に status_code が入っているレコードは触らない。
-- =====================================================

UPDATE creatives c
SET status_code = sub.first_code
FROM (
  SELECT
    p.id AS project_id,
    (
      SELECT i.code
      FROM creative_status_template_items i
      JOIN creative_status_templates t ON t.id = i.template_id
      WHERE t.category_id = p.primary_category_id
        AND t.is_default = true
      ORDER BY i.sort_order ASC
      LIMIT 1
    ) AS first_code
  FROM projects p
  JOIN creative_categories cat ON cat.id = p.primary_category_id
  WHERE cat.code IN ('lp', 'hp', 'line')
) sub
WHERE c.project_id = sub.project_id
  AND c.status_code IS NULL
  AND sub.first_code IS NOT NULL;

-- 確認用クエリ（CI実行はしない / 手動確認用）:
-- SELECT cat.code, count(*) FROM creatives c
--   JOIN projects p ON p.id = c.project_id
--   JOIN creative_categories cat ON cat.id = p.primary_category_id
--   WHERE cat.code IN ('lp','hp','line')
--   GROUP BY cat.code, c.status_code
--   ORDER BY cat.code, c.status_code;
