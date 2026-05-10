-- ============================================================
-- 請求書明細：単価変更の監査列を追加
-- ------------------------------------------------------------
-- 目的:
--   請求書作成時に元の金額より上げた場合に「いくらから いくらに 上げたのか」を
--   後から正確に再現できるようにする。
--
-- 変更:
--   1. original_unit_price (INTEGER):
--      請求書作成時点での project_rates 由来のデフォルト単価。
--      変更されていなくても必ず invoice_items にセットする。
--   2. price_change_reason (TEXT):
--      単価が変更された場合のみ理由テキストを格納する。
--      special_reason とは別概念（special_reason は creatives.special_payable_reason 由来に戻す）。
--
-- 冪等性:
--   ALTER ... IF NOT EXISTS なので何度実行してもOK。
--   既存行は NULL のまま（過去分は再現不能だが、新規分から監査トレイル成立）。
-- ============================================================

ALTER TABLE invoice_items ADD COLUMN IF NOT EXISTS original_unit_price INTEGER;
ALTER TABLE invoice_items ADD COLUMN IF NOT EXISTS price_change_reason TEXT;
