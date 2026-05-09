-- LP クリエイティブ工程テンプレを ADR 010 の M1〜M6 マイルストーンに揃える
--
-- 旧: 構成案(outline) / デザイン(design) / デザイン修正(design_fix) /
--     コーディング(coding) / 検証(qa) / 公開(publish)
-- 新: ヒアリング(hearing, M1) / ワイヤー・デザイン(wireframe_design, M2) /
--     先方デザイン確認(client_review, M3) / デザインFIX(design_fix, M4) /
--     コーディング(coding, M5) / 納品(delivery, M6)
--
-- 全ステップを is_milestone = true（各ステップ = マイルストーン通過の
-- チェックポイント）にする。

BEGIN;

-- 1) 新ステップを UPSERT
WITH lp_tpl AS (
  SELECT t.id AS template_id
  FROM creative_status_templates t
  JOIN creative_categories c ON c.id = t.category_id
  WHERE c.code = 'lp' AND t.is_default = true
  LIMIT 1
)
INSERT INTO creative_status_template_items
  (template_id, code, label, sort_order, is_milestone, default_days)
SELECT template_id, v.code, v.label, v.sort_order, v.is_milestone, v.default_days
FROM lp_tpl,
(VALUES
  ('hearing',          'ヒアリング',         10, true, 4),
  ('wireframe_design', 'ワイヤー・デザイン', 20, true, 10),
  ('client_review',    '先方デザイン確認',   30, true, 5),
  ('design_fix',       'デザインFIX',        40, true, 5),
  ('coding',           'コーディング',       50, true, 8),
  ('delivery',         '納品',               60, true, 0)
) AS v(code, label, sort_order, is_milestone, default_days)
ON CONFLICT (template_id, code) DO UPDATE
  SET label = EXCLUDED.label,
      sort_order = EXCLUDED.sort_order,
      is_milestone = EXCLUDED.is_milestone,
      default_days = EXCLUDED.default_days;

-- 2) 既存クリエイティブの status_code を新コードへマッピング
--    （対象: 該当 LP テンプレを参照するクリエイティブのみ）
WITH lp_tpl AS (
  SELECT t.id AS template_id, t.category_id
  FROM creative_status_templates t
  JOIN creative_categories c ON c.id = t.category_id
  WHERE c.code = 'lp' AND t.is_default = true
  LIMIT 1
),
mapping(old_code, new_code) AS (
  VALUES
    ('outline',    'hearing'),          -- 構成案 → ヒアリング (M1)
    ('design',     'wireframe_design'), -- デザイン → ワイヤー・デザイン (M2)
    ('design_fix', 'design_fix'),       -- 同名（保持）
    ('coding',     'coding'),           -- 同名（保持）
    ('qa',         'coding'),           -- 検証 → コーディング (M5 内に統合)
    ('publish',    'delivery')          -- 公開 → 納品 (M6)
)
UPDATE creatives c
SET status_code = m.new_code,
    updated_at = now()
FROM mapping m, lp_tpl
WHERE c.status_code = m.old_code
  AND c.category_id = lp_tpl.category_id;

-- 3) 旧ステップを削除
WITH lp_tpl AS (
  SELECT t.id AS template_id
  FROM creative_status_templates t
  JOIN creative_categories c ON c.id = t.category_id
  WHERE c.code = 'lp' AND t.is_default = true
  LIMIT 1
)
DELETE FROM creative_status_template_items
WHERE template_id = (SELECT template_id FROM lp_tpl)
  AND code IN ('outline', 'qa', 'publish');

COMMIT;

-- 検証クエリ
-- SELECT code, label, sort_order, is_milestone, default_days
-- FROM creative_status_template_items
-- WHERE template_id = (SELECT t.id FROM creative_status_templates t
--                      JOIN creative_categories c ON c.id = t.category_id
--                      WHERE c.code = 'lp' AND t.is_default = true LIMIT 1)
-- ORDER BY sort_order;
-- 期待: hearing, wireframe_design, client_review, design_fix, coding, delivery (6行)
