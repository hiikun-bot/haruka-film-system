-- ==================== 適格請求書発行事業者 登録番号 ====================
-- インボイス制度対応。
--   * users.invoice_registration_number    : 自社（請求書発行者・スタッフ請求書）の登録番号
--   * clients.invoice_registration_number  : 請求先クライアントの登録番号
--
-- 形式: 「T + 半角数字13桁」（例: T1234567890123）
--   * NULL 許容（未登録メンバー / 免税事業者クライアントもあるため）
--   * DB 側では CHECK 制約を付けない（過去データ移行・空文字混入を許容するため
--     アプリ層で `/^T\d{13}$/` バリデーション。空文字は NULL として保存する想定）
--
-- 並行 worker（teams / clients）UI が新カラムへ書き込むため、本 migration を
-- 本番に先行適用しないと schema-sync の silent skip で UI 編集が落ちる。

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS invoice_registration_number TEXT;

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS invoice_registration_number TEXT;

COMMENT ON COLUMN users.invoice_registration_number
  IS '適格請求書発行事業者の登録番号（T + 半角数字13桁）。NULL = 未登録 / 免税事業者。';
COMMENT ON COLUMN clients.invoice_registration_number
  IS '適格請求書発行事業者の登録番号（T + 半角数字13桁）。NULL = 未登録 / 免税事業者。';

NOTIFY pgrst, 'reload schema';
