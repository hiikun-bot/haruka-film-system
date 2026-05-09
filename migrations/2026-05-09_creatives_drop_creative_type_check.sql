-- creatives.creative_type の CHECK 制約を撤去。
-- supabase_schema.sql 側は CHECK なし TEXT NOT NULL（行 242）に統一済みで、
-- 本番DBに残っている creatives_creative_type_check が LP/HP/LINE 案件の
-- creative INSERT を弾いていたため整合させる。
ALTER TABLE creatives DROP CONSTRAINT IF EXISTS creatives_creative_type_check;
