-- ADR-035: 📝 契約管理（業務委託契約の依頼URL発行・閲覧・同意・版管理・期限監視）
--
-- 背景・目的:
--   - 2026-09-22 の法人化（株式会社HARUKA FILM）に伴い、メンバー（業務委託先）との
--     業務委託基本契約を「個人事業主 髙橋聖」と「株式会社HARUKA FILM」の別主体として
--     管理し、依頼URL発行 → 閲覧 → 同意（署名者名入力）→ 管理者承認 → 期限監視 までを
--     HFS 内で完結させる。
--   - 同意記録は「誰が・いつ・どの版に・どの端末から」を書き換え不能な形で残す。
--   - 既存メンバーの旧契約（紙・メール・チャットで締結済み）も「外部締結」として登録できる。
--
-- テーブル:
--   billing_parties             契約主体マスタ（自社情報。個人事業主 / 株式会社の2行）
--   contract_documents          文書マスタ（基本契約書・確認書・誓約書・通知…）
--   contract_document_versions  文書バージョン（公開後 immutable。PDF原本の Drive file_id + SHA-256）
--   contract_requests           依頼（URLトークン単位。1依頼 = 1メンバー × 複数文書）
--   member_contracts            メンバー契約（メンバー × 文書バージョン × 主体。状態機械の本体）
--   contract_consents           同意・閲覧の証跡（append-only・ハッシュチェーン）
--   contract_events             操作履歴（append-only）
--   users / projects            列追加（事業者区分・請求名義 / 案件の契約主体）
--
-- 新 permission_key:
--   contract.page        契約管理ページの操作（admin）
--   contract.view        契約管理ページの参照のみ・個人情報なし（producer / producer_director）
--   contract.bank_reveal 口座番号の全桁表示（admin。表示操作は contract_events に記録）
--
-- 方針:
--   - ステータス列は text + DEFAULT（CHECK を付けない社内方針）。小さく安定した enum のみ CHECK。
--   - RLS ポリシーは書かない（全テーブル一括 ENABLE 済み・service_role バイパス構成。
--     認可はアプリ層 requirePermission で担保）。
--   - contract_consents / contract_events は BEFORE UPDATE OR DELETE トリガーで拒否
--     （service_role でもトリガーは発火する＝管理者APIからも上書き不可）。
--   - users.id への FK は ON DELETE RESTRICT（契約記録を持つメンバーは物理削除できない。
--     退会は is_active=false の deactivate を使う）。
--   - 冪等: IF NOT EXISTS / ON CONFLICT DO NOTHING / CREATE OR REPLACE。
--
-- 本番Supabaseへの適用が必要。

-- ============================================================
-- 1) 契約主体マスタ（自社情報）
-- ============================================================
CREATE TABLE IF NOT EXISTS billing_parties (
  code                        TEXT PRIMARY KEY,                 -- 'individual_takahashi' | 'haruka_film_inc'
  party_kind                  TEXT NOT NULL DEFAULT 'corporation' CHECK (party_kind IN ('individual','corporation')),
  legal_name                  TEXT NOT NULL,                    -- 正式名称（契約書の甲）
  display_name                TEXT NOT NULL,                    -- 画面表示名
  trade_name                  TEXT,                             -- 屋号（個人事業主のみ）
  representative_title        TEXT,                             -- 代表取締役 / 代表
  representative_name         TEXT,                             -- 髙橋 聖
  postal_code                 TEXT,
  address                     TEXT,                             -- 本店所在地（未確定なら NULL のまま）
  corporate_number            TEXT,                             -- 法人番号（13桁・未確定なら NULL）
  invoice_registration_number TEXT,                             -- 適格請求書発行事業者登録番号（T+13桁・未確定なら NULL）
  court_name                  TEXT,                             -- 合意管轄裁判所（未確定なら NULL）
  contact_email               TEXT,
  effective_from              DATE,
  effective_to                DATE,
  is_active                   BOOLEAN NOT NULL DEFAULT true,
  sort_order                  INT NOT NULL DEFAULT 0,
  created_at                  TIMESTAMPTZ DEFAULT now(),
  updated_at                  TIMESTAMPTZ DEFAULT now()
);

INSERT INTO billing_parties
  (code, party_kind, legal_name, display_name, trade_name, representative_title, representative_name, address, effective_from, sort_order)
VALUES
  ('individual_takahashi', 'individual',  '髙橋 聖',            '個人事業主 髙橋聖',  'HARUKA FILM', '代表',       '髙橋 聖', '兵庫県尼崎市上坂部1丁目8番1－424号', NULL,         10),
  ('haruka_film_inc',      'corporation', '株式会社HARUKA FILM', '株式会社HARUKA FILM', NULL,          '代表取締役', '髙橋 聖', NULL,                                 '2026-09-22', 20)
ON CONFLICT (code) DO NOTHING;

-- ============================================================
-- 2) 文書マスタ
-- ============================================================
CREATE TABLE IF NOT EXISTS contract_documents (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_type    TEXT NOT NULL,   -- basic_agreement | rules_confirmation | client_pledge | succession_notice | amendment_memo | individual_contract | termination_notice
  party_code  TEXT REFERENCES billing_parties(code),   -- NULL = 主体を問わない
  client_id   UUID REFERENCES clients(id) ON DELETE SET NULL,  -- client_pledge のみ
  title       TEXT NOT NULL,
  description TEXT,
  sort_order  INT NOT NULL DEFAULT 0,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_contract_documents_type ON contract_documents(doc_type, is_active);

-- ============================================================
-- 3) 文書バージョン（公開後 immutable）
-- ============================================================
CREATE TABLE IF NOT EXISTS contract_document_versions (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id           UUID NOT NULL REFERENCES contract_documents(id) ON DELETE CASCADE,
  version_no            INT  NOT NULL,
  version_label         TEXT,                                   -- 例: 'v2 法人版'
  status                TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','superseded','retired')),
  effective_from        DATE,                                   -- 適用開始日
  body_html             TEXT,                                   -- 画面表示用本文（任意。PDF原本が正）
  pdf_drive_file_id     TEXT,                                   -- PDF原本（Drive）
  pdf_file_name         TEXT,
  pdf_size_bytes        BIGINT,
  pdf_sha256            TEXT,                                   -- PDF原本のハッシュ
  body_sha256           TEXT,                                   -- body_html のハッシュ
  fill_fields           JSONB NOT NULL DEFAULT '[]'::jsonb,     -- 差し込み項目定義 [{key,label,source}]
  change_summary        TEXT,                                   -- 変更概要（再同意依頼文に使う）
  requires_reconsent    BOOLEAN NOT NULL DEFAULT true,          -- true=旧版の有効契約を「再同意が必要」にする
  published_at          TIMESTAMPTZ,
  published_by          UUID REFERENCES users(id) ON DELETE SET NULL,
  supersedes_version_id UUID REFERENCES contract_document_versions(id) ON DELETE SET NULL,
  created_by            UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ DEFAULT now(),
  updated_at            TIMESTAMPTZ DEFAULT now(),
  UNIQUE (document_id, version_no)
);
CREATE INDEX IF NOT EXISTS idx_contract_document_versions_doc ON contract_document_versions(document_id, version_no DESC);

-- 公開後は内容を変更できない（変更は新バージョンとして登録する）
CREATE OR REPLACE FUNCTION contract_version_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION '公開済みの文書バージョンは削除できません（%）', OLD.id;
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status <> 'draft' THEN
    IF NEW.status = 'draft' THEN
      RAISE EXCEPTION '公開済みの文書バージョンを下書きに戻すことはできません（%）', OLD.id;
    END IF;
    IF NEW.document_id      IS DISTINCT FROM OLD.document_id
    OR NEW.version_no       IS DISTINCT FROM OLD.version_no
    OR NEW.body_html        IS DISTINCT FROM OLD.body_html
    OR NEW.pdf_drive_file_id IS DISTINCT FROM OLD.pdf_drive_file_id
    OR NEW.pdf_sha256       IS DISTINCT FROM OLD.pdf_sha256
    OR NEW.body_sha256      IS DISTINCT FROM OLD.body_sha256
    OR NEW.fill_fields      IS DISTINCT FROM OLD.fill_fields
    OR NEW.effective_from   IS DISTINCT FROM OLD.effective_from
    OR NEW.published_at     IS DISTINCT FROM OLD.published_at
    OR NEW.published_by     IS DISTINCT FROM OLD.published_by THEN
      RAISE EXCEPTION '公開済みの文書バージョンの内容は変更できません。新しいバージョンとして登録してください（%）', OLD.id;
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_contract_version_guard ON contract_document_versions;
CREATE TRIGGER trg_contract_version_guard
  BEFORE UPDATE OR DELETE ON contract_document_versions
  FOR EACH ROW EXECUTE FUNCTION contract_version_guard();

-- ============================================================
-- 4) 依頼（URLトークン単位）
-- ============================================================
CREATE TABLE IF NOT EXISTS contract_requests (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  party_code           TEXT NOT NULL REFERENCES billing_parties(code),
  token                TEXT NOT NULL UNIQUE,                    -- URL用トークン（推測不能・メンバーごと）
  token_expires_at     TIMESTAMPTZ,
  due_date             DATE,                                    -- 回答期限
  status               TEXT NOT NULL DEFAULT 'open',            -- open | submitted | completed | cancelled
  channel              TEXT,                                    -- 送信チャネル: chatwork_direct | chatwork_room | slack_dm | none
  message              TEXT,                                    -- 送信した本文
  sent_at              TIMESTAMPTZ,
  send_result          JSONB,
  first_viewed_at      TIMESTAMPTZ,
  submitted_at         TIMESTAMPTZ,
  completed_at         TIMESTAMPTZ,
  cancelled_at         TIMESTAMPTZ,
  last_reminded_at     TIMESTAMPTZ,
  remind_count         INT NOT NULL DEFAULT 0,
  draft_state          JSONB,                                   -- 途中保存（現在ステップ・チェック状態）
  signer_name          TEXT,                                    -- 送信時に入力した署名者名
  onboarding_record_id UUID,                                    -- オンボーディング連携（FKなし: schema-sync順序を問わない）
  requested_by         UUID REFERENCES users(id) ON DELETE SET NULL,
  requested_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at           TIMESTAMPTZ DEFAULT now(),
  updated_at           TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_contract_requests_user   ON contract_requests(user_id, status);
CREATE INDEX IF NOT EXISTS idx_contract_requests_status ON contract_requests(status, due_date);

-- ============================================================
-- 5) メンバー契約（メンバー × 文書バージョン × 主体）
-- ============================================================
CREATE TABLE IF NOT EXISTS member_contracts (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  request_id               UUID REFERENCES contract_requests(id) ON DELETE SET NULL,
  document_id              UUID NOT NULL REFERENCES contract_documents(id),
  document_version_id      UUID NOT NULL REFERENCES contract_document_versions(id),
  party_code               TEXT NOT NULL REFERENCES billing_parties(code),
  -- 状態: draft | requested | submitted | revision_requested | active | ending | ended | reconsent_required | cancelled
  status                   TEXT NOT NULL DEFAULT 'requested',
  -- 締結方法: hfs | external_esign | paper | email | chat | other
  execution_method         TEXT NOT NULL DEFAULT 'hfs',
  external_pdf_drive_file_id TEXT,
  external_pdf_url         TEXT,
  external_note            TEXT,
  contract_date            DATE,                                -- 締結日
  start_date               DATE,                                -- 契約開始日
  end_date                 DATE,                                -- 契約終了日（自動更新なら次回満了日）
  auto_renew               BOOLEAN NOT NULL DEFAULT true,
  renew_notice_days        INT NOT NULL DEFAULT 30,             -- 更新拒絶の予告期限（日）
  switch_method            TEXT,                                -- 法人切替: new | succession
  switch_date              DATE,
  predecessor_contract_id  UUID REFERENCES member_contracts(id) ON DELETE SET NULL,
  has_existing_projects    BOOLEAN,
  existing_projects_party  TEXT REFERENCES billing_parties(code),
  billing_party_code       TEXT REFERENCES billing_parties(code),  -- 請求先（通常 party_code と同じ）
  fill_snapshot            JSONB,                               -- 同意時点の差し込み値（確定後は変更しない）
  first_viewed_at          TIMESTAMPTZ,
  viewed_completed_at      TIMESTAMPTZ,                         -- 最終ページまで閲覧
  submitted_at             TIMESTAMPTZ,
  revision_requested_at    TIMESTAMPTZ,
  revision_requested_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  revision_reason          TEXT,
  signed_at                TIMESTAMPTZ,                         -- 本人が同意した日時
  approved_at              TIMESTAMPTZ,
  approved_by              UUID REFERENCES users(id) ON DELETE SET NULL,
  ended_at                 TIMESTAMPTZ,
  ended_by                 UUID REFERENCES users(id) ON DELETE SET NULL,
  end_reason               TEXT,
  expiry_notice_stage      TEXT,                                -- 送付済みの期限通知段階（例 '60','30','renew'）
  last_expiry_notified_at  TIMESTAMPTZ,
  storage_note             TEXT,                                -- 契約書の保存場所（Drive URL 等）
  note                     TEXT,
  created_by               UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at               TIMESTAMPTZ DEFAULT now(),
  updated_at               TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_member_contracts_user     ON member_contracts(user_id, status);
CREATE INDEX IF NOT EXISTS idx_member_contracts_status   ON member_contracts(status, end_date);
CREATE INDEX IF NOT EXISTS idx_member_contracts_request  ON member_contracts(request_id);
CREATE INDEX IF NOT EXISTS idx_member_contracts_version  ON member_contracts(document_version_id);
-- 同じ文書で「有効」な契約はメンバーごとに1件
CREATE UNIQUE INDEX IF NOT EXISTS uq_member_contracts_active
  ON member_contracts(user_id, document_id) WHERE status = 'active';

-- ============================================================
-- 6) 同意・閲覧の証跡（append-only・ハッシュチェーン）
-- ============================================================
CREATE TABLE IF NOT EXISTS contract_consents (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  member_contract_id     UUID NOT NULL REFERENCES member_contracts(id),
  request_id             UUID REFERENCES contract_requests(id) ON DELETE SET NULL,
  user_id                UUID NOT NULL,                         -- FKなし（メンバー削除後も証跡を保持）
  user_email             TEXT,
  document_version_id    UUID NOT NULL REFERENCES contract_document_versions(id),
  party_code             TEXT NOT NULL,
  consent_kind           TEXT NOT NULL CHECK (consent_kind IN ('viewed','agreed','acknowledged')),
  signer_name_typed      TEXT,                                  -- 本人が入力した署名者名
  signer_name_registered TEXT,                                  -- 当時の users.full_name
  consented_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip_address             TEXT,
  user_agent             TEXT,
  pdf_sha256             TEXT,                                  -- 同意時点の PDF ハッシュ
  body_sha256            TEXT,
  fill_snapshot          JSONB,                                 -- 同意時点の差し込み値
  snapshot_drive_file_id TEXT,                                  -- 同意時点の控え（PDF/HTML）を Drive に置いた場合
  prev_record_hash       TEXT,                                  -- 直前レコードの record_hash（チェーン）
  record_hash            TEXT NOT NULL,                         -- 主要列 + prev_record_hash の SHA-256
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_contract_consents_contract ON contract_consents(member_contract_id, consented_at);
CREATE INDEX IF NOT EXISTS idx_contract_consents_user     ON contract_consents(user_id, consented_at DESC);

-- ============================================================
-- 7) 操作履歴（append-only）
-- ============================================================
CREATE TABLE IF NOT EXISTS contract_events (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  member_contract_id UUID REFERENCES member_contracts(id),
  request_id         UUID REFERENCES contract_requests(id) ON DELETE SET NULL,
  user_id            UUID,                                      -- 対象メンバー（FKなし）
  actor_user_id      UUID,                                      -- 操作者（FKなし）
  actor_name         TEXT,
  actor_role         TEXT,
  action             TEXT NOT NULL,   -- requested | sent | reminded | viewed | view_completed | draft_saved | submitted | approved | revision_requested | reconsent_requested | ended | cancelled | external_registered | bank_revealed | version_published | pdf_downloaded …
  from_status        TEXT,
  to_status          TEXT,
  detail             JSONB,
  ip_address         TEXT,
  user_agent         TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_contract_events_contract ON contract_events(member_contract_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_contract_events_user     ON contract_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_contract_events_created  ON contract_events(created_at DESC);

-- 証跡は書き換え不可（管理者APIからも上書きできない。DB管理者権限での直接操作のみ）
CREATE OR REPLACE FUNCTION contract_deny_modification() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% は追記専用の監査テーブルです（% は許可されていません）', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_contract_consents_immutable ON contract_consents;
CREATE TRIGGER trg_contract_consents_immutable
  BEFORE UPDATE OR DELETE ON contract_consents
  FOR EACH ROW EXECUTE FUNCTION contract_deny_modification();

DROP TRIGGER IF EXISTS trg_contract_events_immutable ON contract_events;
CREATE TRIGGER trg_contract_events_immutable
  BEFORE UPDATE OR DELETE ON contract_events
  FOR EACH ROW EXECUTE FUNCTION contract_deny_modification();

-- ============================================================
-- 8) users 列追加（本人が「契約・登録手続き」ステップ1〜2で入力）
-- ============================================================
ALTER TABLE users ADD COLUMN IF NOT EXISTS business_type        TEXT;         -- individual | sole_proprietor | corporation
ALTER TABLE users ADD COLUMN IF NOT EXISTS trade_name           TEXT;         -- 屋号 / 法人名
ALTER TABLE users ADD COLUMN IF NOT EXISTS representative_name  TEXT;         -- 法人の代表者名
ALTER TABLE users ADD COLUMN IF NOT EXISTS name_kana            TEXT;         -- 氏名カナ
ALTER TABLE users ADD COLUMN IF NOT EXISTS invoice_name         TEXT;         -- 請求書に使う氏名または事業者名
ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_confirmed_at TIMESTAMPTZ;  -- 本人情報を最後に確認した日時

COMMENT ON COLUMN users.business_type IS 'ADR035: 事業者区分 individual=個人 / sole_proprietor=個人事業主 / corporation=法人';
COMMENT ON COLUMN users.trade_name    IS 'ADR035: 屋号または法人名（請求名義の補助）';
COMMENT ON COLUMN users.invoice_name  IS 'ADR035: 請求書に使用する氏名または事業者名';

-- ============================================================
-- 9) projects 列追加（案件の契約主体。自動確定しない＝NULL は未設定）
-- ============================================================
ALTER TABLE projects ADD COLUMN IF NOT EXISTS contracting_party      TEXT REFERENCES billing_parties(code);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS party_switch_agreed_at TIMESTAMPTZ;
COMMENT ON COLUMN projects.contracting_party IS 'ADR035: 案件の契約主体（individual_takahashi / haruka_film_inc）。NULL=未設定。2026-09-21以前の案件は個人契約のまま扱い、法人切替は party_switch_agreed_at の合意記録で行う';

-- ============================================================
-- 10) 権限キー
-- ============================================================
INSERT INTO role_permissions (role, permission_key, allowed) VALUES
  ('admin',             'contract.page',        true),
  ('admin',             'contract.view',        true),
  ('admin',             'contract.bank_reveal', true),
  ('producer',          'contract.view',        true),
  ('producer_director', 'contract.view',        true)
ON CONFLICT (role, permission_key) DO NOTHING;

-- ============================================================
-- 11) 初期文書（版はまだ作らない。管理画面から PDF をアップロードして公開する）
-- ============================================================
INSERT INTO contract_documents (doc_type, party_code, title, description, sort_order)
SELECT 'basic_agreement', 'individual_takahashi', '業務委託基本契約書（個人事業主 髙橋聖）', '2026-09-21以前に締結した現行の基本契約書。既存メンバーの旧契約登録用。', 10
WHERE NOT EXISTS (SELECT 1 FROM contract_documents WHERE doc_type = 'basic_agreement' AND party_code = 'individual_takahashi');

INSERT INTO contract_documents (doc_type, party_code, title, description, sort_order)
SELECT 'basic_agreement', 'haruka_film_inc', '業務委託基本契約書（株式会社HARUKA FILM）', '法人版の基本契約書。', 20
WHERE NOT EXISTS (SELECT 1 FROM contract_documents WHERE doc_type = 'basic_agreement' AND party_code = 'haruka_film_inc');

INSERT INTO contract_documents (doc_type, party_code, title, description, sort_order)
SELECT 'rules_confirmation', NULL, '業務ルール確認書', '納品方法・連絡方法・セキュリティ・生成AI・請求書の出し方など運用ルール。', 30
WHERE NOT EXISTS (SELECT 1 FROM contract_documents WHERE doc_type = 'rules_confirmation');

-- PostgREST のスキーマキャッシュをリロード
NOTIFY pgrst, 'reload schema';
