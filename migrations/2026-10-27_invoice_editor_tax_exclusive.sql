-- ADR 046 Stage 1: HFS 内の請求書エディタ（税抜＋源泉方式）のための列追加
-- 既存の請求書はすべて tax_mode='inclusive'（内税・今までどおり）になり、金額・PDF・振込管理・分析は変わらない。
-- 新方式（tax_mode='exclusive'）の請求書だけが subtotal_amount 〜 payout_amount を使う。
-- 何度流しても同じ結果になる（IF NOT EXISTS / DROP CONSTRAINT IF EXISTS）。RLS は ADR 048 で有効化済みのテーブルなので追加不要。

-- 請求書ごとの方式フラグ（作成時に決めて変えない）
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS tax_mode TEXT NOT NULL DEFAULT 'inclusive';
ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_tax_mode_check;
ALTER TABLE invoices ADD CONSTRAINT invoices_tax_mode_check CHECK (tax_mode IN ('inclusive', 'exclusive'));

-- 新方式の内訳（サーバーで再計算して保存。total_amount は方式に関係なく「税込のご請求金額」）
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS subtotal_amount     INTEGER;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS tax_amount          INTEGER;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS withholding_enabled BOOLEAN;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS withholding_amount  INTEGER;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS payout_amount       INTEGER;

-- HFS 外の手入力行（creative_id IS NULL）の理由
ALTER TABLE invoice_items ADD COLUMN IF NOT EXISTS manual_reason TEXT;

-- 二重請求チェック（同じ creative × コスト種別が他の提出済み請求書に無いか）用
CREATE INDEX IF NOT EXISTS idx_invoice_items_creative_cost
  ON invoice_items (creative_id, cost_type)
  WHERE creative_id IS NOT NULL;

COMMENT ON COLUMN invoices.tax_mode            IS 'ADR046: inclusive=内税（旧方式・total_amount が税込） / exclusive=税抜＋消費税＋源泉（請求書エディタ）';
COMMENT ON COLUMN invoices.subtotal_amount     IS 'ADR046: 税抜小計（exclusive のみ）';
COMMENT ON COLUMN invoices.tax_amount          IS 'ADR046: 消費税 = floor(小計×10%)（exclusive のみ）';
COMMENT ON COLUMN invoices.withholding_enabled IS 'ADR046: 源泉徴収あり/なし（exclusive のみ・既定 true）';
COMMENT ON COLUMN invoices.withholding_amount  IS 'ADR046: 源泉徴収税額 = floor(小計×10.21%)（exclusive のみ）';
COMMENT ON COLUMN invoices.payout_amount       IS 'ADR046: 差引お振込額 = 税込 − 源泉（exclusive のみ。inclusive は NULL＝total_amount）';
COMMENT ON COLUMN invoice_items.manual_reason  IS 'ADR046: HFS 外の手入力行の理由（creative_id IS NULL の行で必須）';
