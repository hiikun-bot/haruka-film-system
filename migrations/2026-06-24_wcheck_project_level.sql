-- ADR 024 改訂: Wチェック要否を「案件(project)単位」に移行（バグ報告 aa11784a フォローアップ）
--
-- 当初はクリエイティブ個別（creatives.wcheck_required）で実装したが、運用要望により
-- 案件(project)単位へ一本化する。静止画案件は基本「あり」。
--
-- 実効値 = projects.wcheck_required ?? creative_categories.wcheck_default(image=true)

-- 1. 案件単位の要否フラグ
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS wcheck_required BOOLEAN;

-- 2. 既存の静止画案件は「あり」を既定にする（基本あり）。
--    NULL でも category 既定 true を継承するが、案件マスターで現在値を明示表示できるよう true をセット。
UPDATE projects SET wcheck_required = true
WHERE wcheck_required IS NULL
  AND primary_category_id IN (SELECT id FROM creative_categories WHERE code = 'image');

-- 3. 旧: クリエイティブ個別フラグを案件単位へ一本化（resolution から除外済み）。
--    既存の凍結値(false 等)を NULL に戻して無効化する。列自体は破壊回避のため残置。
UPDATE creatives SET wcheck_required = NULL WHERE wcheck_required IS NOT NULL;
