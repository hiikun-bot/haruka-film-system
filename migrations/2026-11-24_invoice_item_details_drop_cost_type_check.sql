-- 2026-11-24 invoice_item_details の古い cost_type CHECK 制約を撤去する（PR #1131 を最新 main に合わせて作り直し）
--
-- 背景:
--   本番DBの invoice_item_details には
--     CHECK (cost_type IN ('base_fee','script_fee','ai_fee','other_fee','director_fee'))
--   という制約が残っている（supabase_schema.sql には未記載）。
--   旧方式（内税）の POST /invoices/generate は後方互換で invoice_items と同じ cost_type を
--   invoice_item_details にも書くため、producer_fee / hourly_fee / hourly_expense /
--   installment_fee を含む請求書の作成が
--   「violates check constraint "invoice_item_details_cost_type_check"」で 500 になる
--   （invoices / invoice_items は先に INSERT 済みのため、エラー表示でも請求書は作られている）。
--   その後 expense（立替経費）・月額定額（installment_fee）なども増えている。
--
-- 方針:
--   invoice_item_details は後方互換テーブルで、cost_type の正は invoice_items 側（CHECK なし）。
--   種別が増えるたびに制約を追いかけるのは再発の元なので、制約自体を落とす。
--   IF EXISTS なので、既に無い環境で流しても何も起きない。

ALTER TABLE invoice_item_details
  DROP CONSTRAINT IF EXISTS invoice_item_details_cost_type_check;
