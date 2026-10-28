-- 本番に 2026-04-28_invoice_items_price_change_audit.sql が当たっておらず、
-- invoice_items.original_unit_price / price_change_reason が存在しなかった（バグ報告 #40d2f548）。
-- 請求書エディタ（ADR 046）の下書き作成はこの 2 列へ必ず書くため、「請求書を作成する」で失敗していた。
-- 冪等（IF NOT EXISTS）。最後に PostgREST のスキーマキャッシュを再読込する。

ALTER TABLE invoice_items ADD COLUMN IF NOT EXISTS original_unit_price INTEGER;
ALTER TABLE invoice_items ADD COLUMN IF NOT EXISTS price_change_reason TEXT;

NOTIFY pgrst, 'reload schema';
