-- =====================================================
-- 時間給作業カテゴリ（ADR 028 連携）
-- =====================================================
-- 目的:
--   時給で発生する案件（秘書業・ハビーのディレクション等）を、案件カテゴリ
--   「時間給作業」(code='hourly') として作成できるようにする。
--   このカテゴリの案件は成果物（クリエイティブ）を持たず、⏱ 作業時間報告
--   （work_hour_entries / ADR 028）で稼働を入力し、案件ごとの支払時給・請求時給で
--   金額が発生する。
--
--   仕組み:
--     - creative_categories に render_kind='timesheet'（成果物なし）を追加
--     - 案件作成時に支払時給/請求時給を入れると、既存の「時間制グループ」
--       （pricing_type='hourly' の line_cost を持つ project_estimate_lines）を
--       自動作成する（PUT /projects/:id/director-fee のロジックを流用）。
--       → 作業時間報告の案件プルダウンに自動で「時給案件」として並ぶ。
--
-- 冪等性: DROP/ADD CONSTRAINT IF (NOT) EXISTS 相当・ON CONFLICT DO NOTHING で二重実行可。
-- =====================================================

BEGIN;

-- render_kind の許容値に 'timesheet'（成果物を持たない時間給作業）を追加する。
-- 既存の CHECK 制約（inline 定義のデフォルト名: creative_categories_render_kind_check）を
-- 貼り替える。名前が異なる環境でも壊さないよう存在チェックしてから付け替える。
DO $$
DECLARE
  conname_found TEXT;
BEGIN
  SELECT c.conname INTO conname_found
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  WHERE t.relname = 'creative_categories'
    AND c.contype = 'c'
    AND pg_get_constraintdef(c.oid) ILIKE '%render_kind%';
  IF conname_found IS NOT NULL THEN
    EXECUTE format('ALTER TABLE creative_categories DROP CONSTRAINT %I', conname_found);
  END IF;
END $$;

ALTER TABLE creative_categories
  ADD CONSTRAINT creative_categories_render_kind_check
  CHECK (render_kind IN ('video','image','longpage','iframe','pdf','timesheet'));

-- 「時間給作業」カテゴリを投入（既に code='hourly' があれば触らない）
INSERT INTO creative_categories (code, name, render_kind, sort_order, color) VALUES
  ('hourly', '時間給作業', 'timesheet', 60, '#0F766E')
ON CONFLICT (code) DO NOTHING;

COMMIT;
