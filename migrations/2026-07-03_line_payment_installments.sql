-- ADR 029: 一式成果物（HP/LP等）の分割支払スケジュール（Stage 1）
--
-- ユーザー要件（2026-07-03）:
--   HP/LPには着手金（先払い）・納品後（後払い）の概念がある。
--   例: 60万円を30万+30万に分割し、「何月に30万円」と月を指定して
--   明細書・請求書に「着手金」「納品完了分（2分の2）」と分かる表記で載せる。
--   一括請求は分割1行（納品完了分 1/1）で表現し、集計は常に本テーブルを見る。
--
-- コード側（UI・請求書・集計・売上への反映）は Stage 2。

CREATE TABLE IF NOT EXISTS line_payment_installments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  line_id UUID NOT NULL REFERENCES project_estimate_lines(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL DEFAULT 1,
  total_count INTEGER NOT NULL DEFAULT 1,
  label TEXT NOT NULL,
  target_month DATE NOT NULL,
  client_amount INTEGER NOT NULL DEFAULT 0,
  payment_amount INTEGER NOT NULL DEFAULT 0,
  payee_user_id UUID REFERENCES users(id),
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT lpi_seq_check CHECK (seq >= 1 AND total_count >= 1 AND seq <= total_count),
  CONSTRAINT lpi_amount_check CHECK (client_amount >= 0 AND payment_amount >= 0)
);

COMMENT ON TABLE line_payment_installments IS
  'ADR 029: 一式成果物（HP/LP等）の分割支払スケジュール。請求書表記は「{line名} {label}（{seq}/{total_count}）」。対象月は target_month（月初日）で明示指定し、納品完了日基準（ADR 026）の例外とする。';
COMMENT ON COLUMN line_payment_installments.label IS '例: 着手金 / 中間金 / 納品完了分';
COMMENT ON COLUMN line_payment_installments.target_month IS '計上月（月初日）。この月の請求書・売上に載る';
COMMENT ON COLUMN line_payment_installments.payee_user_id IS '制作者支払の受取人';

CREATE INDEX IF NOT EXISTS idx_lpi_line ON line_payment_installments (line_id);
CREATE INDEX IF NOT EXISTS idx_lpi_month ON line_payment_installments (target_month);
CREATE INDEX IF NOT EXISTS idx_lpi_payee ON line_payment_installments (payee_user_id) WHERE payee_user_id IS NOT NULL;
