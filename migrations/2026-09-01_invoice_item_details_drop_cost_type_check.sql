-- 2026-09-01 invoice_item_details の古い cost_type CHECK 制約を撤去する
--
-- 背景:
--   本番DBの invoice_item_details には
--     CHECK (cost_type IN ('base_fee','script_fee','ai_fee','other_fee','director_fee'))
--   という制約が残っていた（supabase_schema.sql には未記載）。
--   その後 invoice_items 側に producer_fee / hourly_fee / hourly_expense /
--   installment_fee を追加したが、後方互換で invoice_item_details にも
--   同じ cost_type を書くため、これらの種別を含む請求書生成が
--   「violates check constraint "invoice_item_details_cost_type_check"」で 500 になっていた。
--   （invoices / invoice_items は先に INSERT 済みのため、請求書自体は作られていた）
--
-- 方針:
--   invoice_item_details は invoice_items.label が空の旧データ向けの後方互換テーブルで、
--   cost_type の正は invoice_items 側（そちらに CHECK は無い）。
--   種別が増えるたびに制約を追いかけるのは再発の元なので、制約自体を落とす。

ALTER TABLE invoice_item_details
  DROP CONSTRAINT IF EXISTS invoice_item_details_cost_type_check;
