-- 🏦 ADR 054 追補（2026-10-30・二重依頼を起こさない順序 §3-2 ／ 台帳の支払時スナップショット §5）: Stage A2
--
-- 1) payout_transfer_batches.status に 'requesting' を追加
--    依頼 API は「DB に書いてから銀行へ送る」。status='requesting' で INSERT した時点で idempotency_key が確定し、
--    銀行の応答が消えた（timeout / 接続断 / 5xx）ときは requesting のまま残して同じキーで再送する。
-- 2) payout_records.ledger_snapshot JSONB
--    振込完了（API）または消し込み（手動）の時点で、請求書の subtotal/tax/withholding/payout と支払額を凍結する。
--    後から請求書を編集しても源泉徴収台帳（Stage D）の額は変わらない。
--    形: { amount, invoice_id, invoice_number, subtotal_amount, tax_amount, withholding_amount, payout_amount, snapshot_at }
--
-- 冪等: DROP CONSTRAINT IF EXISTS → ADD CONSTRAINT ／ ADD COLUMN IF NOT EXISTS。2回流しても落ちない。
-- 本番Supabaseへの適用が必要（適用後に PR へ db-migration-applied ラベル）。

ALTER TABLE payout_transfer_batches DROP CONSTRAINT IF EXISTS payout_transfer_batches_status_check;
ALTER TABLE payout_transfer_batches ADD CONSTRAINT payout_transfer_batches_status_check
  CHECK (status IN ('requesting', 'requested', 'awaiting_approval', 'approved', 'processing',
                    'completed', 'expired', 'cancelled', 'failed'));
COMMENT ON COLUMN payout_transfer_batches.status IS
  'ADR054: requesting=銀行へ送信中/応答待ち（同じ idempotency_key で再送可） requested=受付直後 awaiting_approval=承認待ち approved=予約中 processing=手続中 completed=完了 expired=期限切れ cancelled=取消 failed=失敗';

ALTER TABLE payout_records ADD COLUMN IF NOT EXISTS ledger_snapshot JSONB;
COMMENT ON COLUMN payout_records.ledger_snapshot IS
  'ADR054: 支払時点の台帳スナップショット {amount, invoice_id, invoice_number, subtotal_amount, tax_amount, withholding_amount, payout_amount, snapshot_at}。請求書を後から直しても台帳は変わらない';

-- PostgREST のスキーマキャッシュをリロード
NOTIFY pgrst, 'reload schema';
