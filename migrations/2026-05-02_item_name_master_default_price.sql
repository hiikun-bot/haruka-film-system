-- ============================================================
-- 品目名マスター: default_unit_price（既定単価・円）追加
-- ------------------------------------------------------------
-- 目的:
--   見積エディタで品目をマスター選択したときに、単価も自動補完できるようにする。
--   default_unit と同様に「既存値が未設定のときだけ」補完する運用を想定。
--
-- 列:
--   default_unit_price INTEGER  既定の単価（円・税抜）。NULL=未設定
--
-- ロールバック:
--   ALTER TABLE item_name_master DROP COLUMN default_unit_price;
-- ============================================================

ALTER TABLE item_name_master
  ADD COLUMN IF NOT EXISTS default_unit_price INTEGER;

NOTIFY pgrst, 'reload schema';
