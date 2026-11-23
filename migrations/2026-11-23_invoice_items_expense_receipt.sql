-- ADR 046 追補 2026-11-23: 立替経費の行に日付・支払先・領収書（写真の添付／「領収書なし」の理由）を持たせる
--
-- 対象は請求書エディタの「＋ 立替経費」の行（invoice_items.cost_type = 'expense'）。
-- 作業時間報告の立替経費（cost_type = 'hourly_expense'）は今回は使わない（列は NULL のまま）。
-- 領収書の写真・PDF そのものは本人の Drive 請求書フォルダ（ADR 047）の「領収書」サブフォルダに置き、
-- ここには Drive のファイル ID・表示名・種類・保存時刻だけを持つ。
--
-- すべて NULL 可・既存行は NULL のまま（遡って埋めない）。金額・消費税・源泉の計算には使わない。
-- 何度流しても同じ結果になる（IF NOT EXISTS / DROP CONSTRAINT IF EXISTS）。
--
-- RLS: invoice_items は ADR 048（migrations/2026-10-07_enable_rls_all_public_tables.sql）で
--   public の全テーブルとまとめて有効化済み。新しいテーブルは作らないので追加の ENABLE は不要。
--   念のため確認する場合は次を流して relrowsecurity = true を見る（読むだけ）:
--     SELECT relname, relrowsecurity FROM pg_class WHERE relname = 'invoice_items';

ALTER TABLE invoice_items ADD COLUMN IF NOT EXISTS expense_date           DATE;
ALTER TABLE invoice_items ADD COLUMN IF NOT EXISTS expense_payee          TEXT;
ALTER TABLE invoice_items ADD COLUMN IF NOT EXISTS receipt_status         TEXT;
ALTER TABLE invoice_items ADD COLUMN IF NOT EXISTS receipt_missing_reason TEXT;
ALTER TABLE invoice_items ADD COLUMN IF NOT EXISTS receipt_file_id        TEXT;
ALTER TABLE invoice_items ADD COLUMN IF NOT EXISTS receipt_file_name      TEXT;
ALTER TABLE invoice_items ADD COLUMN IF NOT EXISTS receipt_mime_type      TEXT;
ALTER TABLE invoice_items ADD COLUMN IF NOT EXISTS receipt_uploaded_at    TIMESTAMPTZ;

ALTER TABLE invoice_items DROP CONSTRAINT IF EXISTS invoice_items_receipt_status_check;
ALTER TABLE invoice_items ADD CONSTRAINT invoice_items_receipt_status_check
  CHECK (receipt_status IS NULL OR receipt_status IN ('attached', 'missing'));

COMMENT ON COLUMN invoice_items.expense_date           IS 'ADR046 追補 2026-11-23: 立替経費の日付（cost_type=expense の行で提出時に必須）';
COMMENT ON COLUMN invoice_items.expense_payee          IS 'ADR046 追補 2026-11-23: 立替経費の支払先（cost_type=expense の行で提出時に必須）';
COMMENT ON COLUMN invoice_items.receipt_status         IS 'ADR046 追補 2026-11-23: 領収書の状態 attached=写真/PDF を添付 / missing=領収書なし（理由必須）/ NULL=未入力';
COMMENT ON COLUMN invoice_items.receipt_missing_reason IS 'ADR046 追補 2026-11-23: 領収書なしの理由（receipt_status=missing のとき必須）';
COMMENT ON COLUMN invoice_items.receipt_file_id        IS 'ADR046 追補 2026-11-23: 領収書ファイルの Drive ID（本人の請求書月フォルダ/領収書/。公開リンクにしない・HFS の API 経由で見る）';
COMMENT ON COLUMN invoice_items.receipt_file_name      IS 'ADR046 追補 2026-11-23: 領収書ファイルの Drive 上の名前（領収書_YYYYMMDD_内容_金額円.拡張子）';
COMMENT ON COLUMN invoice_items.receipt_mime_type      IS 'ADR046 追補 2026-11-23: 領収書ファイルの種類（image/jpeg・image/png・image/heic・application/pdf）';
COMMENT ON COLUMN invoice_items.receipt_uploaded_at    IS 'ADR046 追補 2026-11-23: 領収書ファイルを保存した時刻';
