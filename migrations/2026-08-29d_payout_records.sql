-- 💸 振込管理（payout）: メンバーへの月次振込の消し込み管理テーブル + 閲覧権限
--
-- 背景・目的:
--   - 毎月、メンバーが Drive の請求書フォルダ（請求書/YYYY年/MM月/氏名 YYYY年MM月/）に
--     請求書PDFを提出し、管理者が個人口座から1件ずつ手動振込している。
--     「誰に振り込み済みで誰が未か」「新しいPDFが増えていないか」「請求額とシステムの
--     実制作データが乖離していないか」を1画面で消し込み管理できるようにする。
--   - 行ごとの「振込完了→送信」で、本人へ Chatwork 定型文（+任意メモ）を通知し、
--     送信履歴・振込日時・メモを記録する。
--
-- テーブル: payout_records（user × 対象年月で1行）
--   - pdf_files: Drive スキャンで検出した請求書PDFの配列
--     [{ id, name, url, modified_at, amount, amount_source }]（JSONB）
--   - invoice_amount: 請求額（税込・PDF自動抽出の合計。手修正時は amount_source='manual'）
--   - status: 'unpaid' | 'paid'（振込済み=行を緑で消し込み）
--   - diff_*: 「システムとPDFの差分チェック」ボタンの実行結果
--     （実制作データ per-unit 集計 vs 請求額。詳細JSONは diff_detail）
--
-- 新 permission_key: payout.page（admin のみ true）
--   - 対応 API: GET/POST/PATCH /api/haruka/admin/payouts*
--   - フロント: ヘッダーナビ / モバイルドロワーの「💸 振込管理」+ #page-payout
--
-- ADR 003（roles-as-master-data）/ ADR 015（VIEW AS チェックリスト）準拠。
-- RLS ポリシーは書かない（全テーブル一括 ENABLE 済み・service_role バイパス構成。
-- 振込情報の秘匿はアプリ層 requirePermission('payout.page') で担保）。
-- 冪等: CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS / ON CONFLICT DO UPDATE。

CREATE TABLE IF NOT EXISTS payout_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  year INT NOT NULL,
  month INT NOT NULL CHECK (month BETWEEN 1 AND 12),
  pdf_files JSONB NOT NULL DEFAULT '[]'::jsonb,
  invoice_amount INTEGER,
  amount_source TEXT CHECK (amount_source IN ('auto', 'manual')),
  status TEXT NOT NULL DEFAULT 'unpaid' CHECK (status IN ('unpaid', 'paid')),
  paid_at TIMESTAMPTZ,
  memo TEXT,
  message_sent_at TIMESTAMPTZ,
  message_body TEXT,
  diff_status TEXT CHECK (diff_status IN ('match', 'diff', 'unknown')),
  diff_detail JSONB,
  diff_checked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (user_id, year, month)
);

CREATE INDEX IF NOT EXISTS idx_payout_records_year_month ON payout_records(year, month);
CREATE INDEX IF NOT EXISTS idx_payout_records_user ON payout_records(user_id);

INSERT INTO role_permissions (role, permission_key, allowed) VALUES
  ('admin',             'payout.page', true),
  ('secretary',         'payout.page', false),
  ('producer',          'payout.page', false),
  ('producer_director', 'payout.page', false),
  ('director',          'payout.page', false),
  ('editor',            'payout.page', false),
  ('designer',          'payout.page', false),
  ('external_director', 'payout.page', false)
ON CONFLICT (role, permission_key) DO UPDATE SET allowed = EXCLUDED.allowed;
