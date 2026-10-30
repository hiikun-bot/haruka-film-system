-- 🏦 ADR 054: GMOあおぞらネット銀行 API による総合振込と源泉徴収台帳（Stage A: migration）
--
-- 背景・目的:
--   - 法人化（株式会社HARUKA FILM・2026-09-22）で振込元が法人口座（GMOあおぞらネット銀行）になった。
--     毎月の報酬振込を「振込管理（#page-payout）で対象者を選ぶ → 総合振込依頼を API で送る →
--     銀行アプリで本人が承認する」の2操作にし、1件ずつの手入力（口座間違い・金額間違い）をなくす。
--   - 依頼時点の「誰に・どの口座へ・いくら」を明細として凍結し、支払日ベースの源泉徴収台帳
--     （源泉所得税の納付・支払調書）を集計ボタンで出せるようにする。
--   - 乗っ取り対策として、メンバーの口座列が変わった日時を DB トリガで記録し、変更から7日間は
--     依頼対象に含めない（画面に ⚠ と残日数）。
--
-- テーブル:
--   bank_api_connections     銀行 API 接続（1 provider につき有効1件。OAuth トークンは AES-256-GCM で暗号化保管。
--                            鍵は Railway 環境変数 AOZORA_TOKEN_ENCRYPTION_KEY・DB には平文を置かない）
--   payout_transfer_batches  総合振込依頼 1回 = 1行（冪等キー・受付番号 apply_no・銀行側の状態をポーリングで反映）
--   payout_transfer_items    明細（依頼時点の口座・金額・請求書の税額/源泉額のスナップショット。台帳の元データ）
--   bank_api_audit_logs      接続・切断・トークン更新・事前照会・依頼・照会・取消・完了・失敗の操作履歴
--                            （detail にトークン・口座番号などの秘密情報は入れない）
--   users                    + bank_info_updated_at（口座列が変わったとき BEFORE UPDATE トリガで now()）
--   payout_records           + paid_via（manual | aozora_api）・transfer_item_id（API 振込の明細への参照）
--
-- 新 permission_key: payout.transfer（admin のみ true）
--   - 対応 API: /api/haruka/admin/bank/* ・ /api/haruka/admin/payouts/transfer*（Stage B）
--   - 依頼は payout.transfer かつ requireSuperAdmin（SUPER_ADMIN_EMAILS）。VIEW AS での昇格は効かない（ADR 015）
--
-- 方針:
--   - RLS は全テーブル ENABLE（ADR 048）。ポリシーは書かない（service_role のみアクセス・anon は全拒否）。
--     秘匿はアプリ層 requirePermission('payout.transfer') + requireSuperAdmin で担保。
--   - 小さく安定した enum のみ CHECK を付ける（provider / environment / status / action など）。
--   - トリガ関数には SET search_path = public を付ける（Supabase Advisor の function_search_path_mutable 対策）。
--   - 冪等: IF NOT EXISTS / CREATE OR REPLACE / DROP TRIGGER IF EXISTS / ON CONFLICT DO UPDATE。2回流しても落ちない。
--
-- 本番Supabaseへの適用が必要（適用後に PR へ db-migration-applied ラベル）。

-- ============================================================
-- 1) 銀行 API 接続（1 provider につき有効1件）
-- ============================================================
CREATE TABLE IF NOT EXISTS bank_api_connections (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider                 TEXT NOT NULL DEFAULT 'gmo_aozora' CHECK (provider IN ('gmo_aozora')),
  environment              TEXT NOT NULL CHECK (environment IN ('staging', 'production')),
  account_id               TEXT NOT NULL,                      -- 口座ID（12〜29桁・銀行側の識別子）
  account_label            TEXT,                               -- 画面表示用（例: 法人営業部 普通 ****8906）
  scopes                   TEXT,                               -- 許可されたスコープ（スペース区切り）
  access_token_enc         TEXT,                               -- AES-256-GCM 暗号文（base64）
  access_token_iv          TEXT,
  access_token_tag         TEXT,
  refresh_token_enc        TEXT,
  refresh_token_iv         TEXT,
  refresh_token_tag        TEXT,
  access_token_expires_at  TIMESTAMPTZ,
  connected_by             UUID REFERENCES users(id) ON DELETE SET NULL,
  connected_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at               TIMESTAMPTZ,                        -- NULL = 有効
  last_used_at             TIMESTAMPTZ,
  updated_at               TIMESTAMPTZ DEFAULT now()
);
-- 有効な接続は provider × environment で1件まで
CREATE UNIQUE INDEX IF NOT EXISTS uq_bank_api_connections_active
  ON bank_api_connections(provider, environment) WHERE revoked_at IS NULL;

ALTER TABLE bank_api_connections ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- 2) 総合振込依頼（1回 = 1行）
-- ============================================================
CREATE TABLE IF NOT EXISTS payout_transfer_batches (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id             UUID REFERENCES bank_api_connections(id) ON DELETE SET NULL,
  year                      INT NOT NULL,
  month                     INT NOT NULL CHECK (month BETWEEN 1 AND 12),
  idempotency_key           UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),  -- 銀行 API の Idempotency-Key
  transfer_designated_date  DATE NOT NULL,                     -- 振込指定日
  transfer_data_name        TEXT,                              -- 振込データ名（例: 2026年10月分報酬）
  total_count               INT NOT NULL DEFAULT 0,
  total_amount              BIGINT NOT NULL DEFAULT 0,
  fee_precheck              JSONB,                             -- 手数料事前照会の結果（件数・合計・手数料）
  request_summary           JSONB,                             -- 各明細の氏名・口座下4桁・金額（承認時の突き合わせ用）
  apply_no                  TEXT,                              -- 受付番号（16桁）
  result_code               TEXT CHECK (result_code IN ('1', '2', '8')),  -- 銀行の受付結果コード
  status                    TEXT NOT NULL DEFAULT 'requested'
                            CHECK (status IN ('requested', 'awaiting_approval', 'approved', 'processing',
                                              'completed', 'expired', 'cancelled', 'failed')),
  requested_by              UUID REFERENCES users(id) ON DELETE SET NULL,
  requested_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_at               TIMESTAMPTZ,
  completed_at              TIMESTAMPTZ,
  last_polled_at            TIMESTAMPTZ,
  last_error                TEXT,
  created_at                TIMESTAMPTZ DEFAULT now(),
  updated_at                TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payout_transfer_batches_year_month ON payout_transfer_batches(year, month);
CREATE INDEX IF NOT EXISTS idx_payout_transfer_batches_status     ON payout_transfer_batches(status);

ALTER TABLE payout_transfer_batches ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- 3) 明細（依頼時点の口座・金額のスナップショット）
-- ============================================================
CREATE TABLE IF NOT EXISTS payout_transfer_items (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id            UUID NOT NULL REFERENCES payout_transfer_batches(id) ON DELETE CASCADE,
  payout_record_id    UUID REFERENCES payout_records(id) ON DELETE SET NULL,
  user_id             UUID REFERENCES users(id) ON DELETE SET NULL,
  item_id             INT NOT NULL CHECK (item_id >= 1),      -- 銀行 API の明細番号（1〜）
  bank_code           TEXT NOT NULL,                           -- 4桁
  branch_code         TEXT NOT NULL,                           -- 3桁
  account_type_code   TEXT NOT NULL,                           -- 1=普通 2=当座 4=貯蓄
  account_number      TEXT NOT NULL,                           -- 7桁（ゼロ埋め）
  beneficiary_name    TEXT NOT NULL,                           -- 受取人名（半角カナ・全銀形式）
  amount              BIGINT NOT NULL CHECK (amount >= 0),     -- 振込額
  invoice_id          UUID REFERENCES invoices(id) ON DELETE SET NULL,
  amount_source       TEXT NOT NULL DEFAULT 'invoice' CHECK (amount_source IN ('invoice', 'pdf')),
  gross_amount        BIGINT,                                  -- 請求額（税込・台帳用）
  tax_amount          BIGINT,                                  -- 消費税額（台帳用）
  withholding_amount  BIGINT,                                  -- 源泉徴収税額（台帳用）
  status              TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'returned', 'failed')),
  error_detail        JSONB,
  created_at          TIMESTAMPTZ DEFAULT now(),
  updated_at          TIMESTAMPTZ DEFAULT now(),
  UNIQUE (batch_id, item_id)
);
CREATE INDEX IF NOT EXISTS idx_payout_transfer_items_batch  ON payout_transfer_items(batch_id);
CREATE INDEX IF NOT EXISTS idx_payout_transfer_items_user   ON payout_transfer_items(user_id);
CREATE INDEX IF NOT EXISTS idx_payout_transfer_items_record ON payout_transfer_items(payout_record_id);

ALTER TABLE payout_transfer_items ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- 4) 銀行 API 操作履歴（detail に秘密情報は入れない）
-- ============================================================
CREATE TABLE IF NOT EXISTS bank_api_audit_logs (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id  UUID REFERENCES users(id) ON DELETE SET NULL,
  action         TEXT NOT NULL CHECK (action IN ('connect', 'disconnect', 'token_refresh', 'precheck',
                                                 'request', 'poll', 'cancel', 'complete', 'error')),
  connection_id  UUID REFERENCES bank_api_connections(id) ON DELETE SET NULL,
  batch_id       UUID REFERENCES payout_transfer_batches(id) ON DELETE SET NULL,
  detail         JSONB,
  ip_address     TEXT,
  user_agent     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bank_api_audit_logs_created ON bank_api_audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bank_api_audit_logs_batch   ON bank_api_audit_logs(batch_id);

ALTER TABLE bank_api_audit_logs ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- 5) users: 口座情報の最終更新日時（口座変更から7日間は依頼対象外にするためのガード）
-- ============================================================
ALTER TABLE users ADD COLUMN IF NOT EXISTS bank_info_updated_at TIMESTAMPTZ;
COMMENT ON COLUMN users.bank_info_updated_at IS 'ADR054: 口座列（bank_code/branch_code/account_type/account_number/account_holder_kana/bank_name/branch_name）が最後に変わった日時。変更から7日間は API 振込の対象外';

CREATE OR REPLACE FUNCTION users_touch_bank_info_updated_at() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.bank_code           IS DISTINCT FROM OLD.bank_code
  OR NEW.branch_code         IS DISTINCT FROM OLD.branch_code
  OR NEW.account_type        IS DISTINCT FROM OLD.account_type
  OR NEW.account_number      IS DISTINCT FROM OLD.account_number
  OR NEW.account_holder_kana IS DISTINCT FROM OLD.account_holder_kana
  OR NEW.bank_name           IS DISTINCT FROM OLD.bank_name
  OR NEW.branch_name         IS DISTINCT FROM OLD.branch_name THEN
    NEW.bank_info_updated_at := now();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_users_touch_bank_info_updated_at ON users;
CREATE TRIGGER trg_users_touch_bank_info_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION users_touch_bank_info_updated_at();

-- ============================================================
-- 6) payout_records: 振込手段と API 明細への参照
-- ============================================================
ALTER TABLE payout_records ADD COLUMN IF NOT EXISTS paid_via TEXT;
ALTER TABLE payout_records DROP CONSTRAINT IF EXISTS payout_records_paid_via_check;
ALTER TABLE payout_records ADD CONSTRAINT payout_records_paid_via_check CHECK (paid_via IN ('manual', 'aozora_api'));
ALTER TABLE payout_records ADD COLUMN IF NOT EXISTS transfer_item_id UUID REFERENCES payout_transfer_items(id) ON DELETE SET NULL;
COMMENT ON COLUMN payout_records.paid_via         IS 'ADR054: 振込手段 manual=手動振込 / aozora_api=GMOあおぞら API 総合振込。NULL=未振込または旧データ';
COMMENT ON COLUMN payout_records.transfer_item_id IS 'ADR054: API 振込の明細（payout_transfer_items.id）。手動振込では NULL';

-- ============================================================
-- 7) 権限キー（ADR 003 roles-as-master-data）
-- ============================================================
INSERT INTO role_permissions (role, permission_key, allowed) VALUES
  ('admin',             'payout.transfer', true),
  ('secretary',         'payout.transfer', false),
  ('producer',          'payout.transfer', false),
  ('producer_director', 'payout.transfer', false),
  ('director',          'payout.transfer', false),
  ('editor',            'payout.transfer', false),
  ('designer',          'payout.transfer', false),
  ('external_director', 'payout.transfer', false)
ON CONFLICT (role, permission_key) DO UPDATE SET allowed = EXCLUDED.allowed;

-- PostgREST のスキーマキャッシュをリロード
NOTIFY pgrst, 'reload schema';
