-- ADR 056: 🤝 営業・名刺管理（sales_*）
-- 交流会などで出会った相手（名刺）を全員で共有し、営業〜商談〜受注の進み具合を 1 画面で見る。
-- お礼・営業メールは「本人の Gmail」から送る（本人か、本人が認めた代理だけ）。
-- メールにはプロモ動画をまとめた紹介ページ（ログイン不要の URL）を付けられる。
--
-- 冪等（IF NOT EXISTS）。新テーブルは同じファイルで RLS を有効化する（ADR 048）。
-- HFS は service_role だけで読むのでポリシーは作らない（anon からは一切見えない）。

-- ============================================================
-- 1. 連絡先（名刺 1 枚 = 1 行）。営業の進み具合（stage）もここに持つ
-- ============================================================
CREATE TABLE IF NOT EXISTS sales_contacts (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 担当（最初に登録した人）。編集できるのは担当と管理者
  owner_user_id    UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  -- 名刺の内容
  name             TEXT NOT NULL CHECK (char_length(btrim(name)) > 0),
  name_kana        TEXT,
  company          TEXT,
  department       TEXT,
  job_title        TEXT,
  email            TEXT,
  phone            TEXT,
  postal_code      TEXT,
  address          TEXT,
  website          TEXT,
  -- どのような事業をされているか（名刺から読み取り／手入力）
  business_summary TEXT,
  -- 出会いの記録
  met_on           DATE,
  met_place        TEXT,
  met_event        TEXT,
  -- 営業の進み具合
  stage            TEXT NOT NULL DEFAULT 'met'
                     CHECK (stage IN ('met', 'approach', 'negotiating', 'proposal', 'won', 'lost', 'hold')),
  stage_changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 全員に見える共有メモ（個人用メモは sales_contact_private_notes）
  shared_note      TEXT,
  next_action      TEXT,
  next_action_on   DATE,
  -- 見込み金額（円・税抜・任意）
  expected_amount  INTEGER CHECK (expected_amount IS NULL OR expected_amount >= 0),
  -- 受注後に紐づけるクライアント（任意）
  client_id        UUID REFERENCES clients(id) ON DELETE SET NULL,
  -- 「今後のご案内は不要」と言われた相手。true の間はメールを送れない
  do_not_email     BOOLEAN NOT NULL DEFAULT false,
  has_card_image   BOOLEAN NOT NULL DEFAULT false,
  archived_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sales_contacts_stage
  ON sales_contacts(stage, updated_at DESC) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_sales_contacts_owner
  ON sales_contacts(owner_user_id, updated_at DESC);
-- 同じ相手の二重登録に気づくため（メールアドレスの小文字一致で探す）
CREATE INDEX IF NOT EXISTS idx_sales_contacts_email_lower
  ON sales_contacts(lower(email)) WHERE email IS NOT NULL;

ALTER TABLE sales_contacts ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- 2. 名刺画像（一覧に載せないよう別テーブル。base64 の data URL）
-- ============================================================
CREATE TABLE IF NOT EXISTS sales_contact_cards (
  contact_id  UUID PRIMARY KEY REFERENCES sales_contacts(id) ON DELETE CASCADE,
  image_data  TEXT NOT NULL,
  -- AI が読み取った生の結果（読み間違いの検証用）
  ai_result   JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE sales_contact_cards ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- 3. 個人用メモ（書いた本人にしか見えない。管理者にも見せない）
-- ============================================================
CREATE TABLE IF NOT EXISTS sales_contact_private_notes (
  contact_id  UUID NOT NULL REFERENCES sales_contacts(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body        TEXT NOT NULL DEFAULT '',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (contact_id, user_id)
);

ALTER TABLE sales_contact_private_notes ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- 4. プロモ動画ライブラリ（YouTube / Vimeo などの URL を登録）
-- ============================================================
CREATE TABLE IF NOT EXISTS sales_promo_videos (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title       TEXT NOT NULL CHECK (char_length(btrim(title)) > 0),
  url         TEXT NOT NULL,
  -- 'youtube' | 'vimeo' | 'link'（埋め込めない URL はリンクとして出す）
  provider    TEXT NOT NULL DEFAULT 'link' CHECK (provider IN ('youtube', 'vimeo', 'link')),
  -- 埋め込み用の動画 ID（provider が youtube / vimeo のとき）
  embed_id    TEXT,
  description TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE sales_promo_videos ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- 5. 紹介ページ（動画を何本かまとめた、ログイン不要の URL）
-- ============================================================
CREATE TABLE IF NOT EXISTS sales_promo_pages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- URL に載せる推測できない文字列（/pv/<token>）
  token           TEXT NOT NULL UNIQUE,
  contact_id      UUID REFERENCES sales_contacts(id) ON DELETE SET NULL,
  created_by      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title           TEXT NOT NULL DEFAULT 'HARUKA FILM 作品のご紹介',
  -- ページ冒頭のあいさつ（任意）
  greeting        TEXT,
  -- 表示する動画（並び順どおり）
  video_ids       UUID[] NOT NULL CHECK (cardinality(video_ids) > 0),
  -- 開封の記録
  view_count      INTEGER NOT NULL DEFAULT 0,
  first_viewed_at TIMESTAMPTZ,
  last_viewed_at  TIMESTAMPTZ,
  -- 公開を止めた日時（NULL = 公開中）
  revoked_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sales_promo_pages_contact
  ON sales_promo_pages(contact_id, created_at DESC);

ALTER TABLE sales_promo_pages ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- 6. メール（下書き → 送信済み）。1 通 = 宛先 1 件
-- ============================================================
CREATE TABLE IF NOT EXISTS sales_mails (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id       UUID NOT NULL REFERENCES sales_contacts(id) ON DELETE CASCADE,
  -- 差出人（この人の Gmail から送る）。送信できるのはこの本人か、本人が認めた代理だけ
  sender_user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 下書きを作った人（代理が作った場合は差出人と別人）
  created_by       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_email         TEXT NOT NULL,
  subject          TEXT NOT NULL DEFAULT '',
  body             TEXT NOT NULL DEFAULT '',
  promo_page_id    UUID REFERENCES sales_promo_pages(id) ON DELETE SET NULL,
  ai_generated     BOOLEAN NOT NULL DEFAULT false,
  status           TEXT NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft', 'sending', 'sent', 'failed')),
  -- 実際に送信ボタンを押した人（代理送信なら差出人と別人）
  sent_by          UUID REFERENCES users(id) ON DELETE SET NULL,
  sent_at          TIMESTAMPTZ,
  gmail_message_id TEXT,
  error_message    TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sales_mails_contact
  ON sales_mails(contact_id, created_at DESC);
-- 「この差出人が今日何通送ったか」（1 日の送信上限の判定）
CREATE INDEX IF NOT EXISTS idx_sales_mails_sender_sent
  ON sales_mails(sender_user_id, sent_at DESC) WHERE status = 'sent';

ALTER TABLE sales_mails ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- 7. 代理送信の許可（owner が delegate に「自分の名前で送ってよい」と認める）
-- ============================================================
CREATE TABLE IF NOT EXISTS sales_mail_delegates (
  owner_user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delegate_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_user_id, delegate_user_id),
  CHECK (owner_user_id <> delegate_user_id)
);

CREATE INDEX IF NOT EXISTS idx_sales_mail_delegates_delegate
  ON sales_mail_delegates(delegate_user_id);

ALTER TABLE sales_mail_delegates ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- 8. AI の利用記録（名刺読み取り・メール下書き）。月の上限額の判定に使う
-- ============================================================
CREATE TABLE IF NOT EXISTS sales_ai_usage (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID REFERENCES users(id) ON DELETE SET NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('card_scan', 'mail_draft')),
  model         TEXT,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  -- 概算の費用（円）
  cost_jpy      NUMERIC(10, 4) NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sales_ai_usage_created
  ON sales_ai_usage(created_at DESC);

ALTER TABLE sales_ai_usage ENABLE ROW LEVEL SECURITY;
