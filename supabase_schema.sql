-- HARUKA FILM SYSTEM — Supabase テーブル作成SQL
-- Supabase の SQL Editor で実行してください

-- ==================== users ====================
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'editor',
  job_type TEXT,
  rank TEXT,
  team_id UUID,
  slack_dm_id TEXT,
  chatwork_dm_id TEXT,
  is_active BOOLEAN DEFAULT true,
  left_at TIMESTAMPTZ,
  left_reason TEXT,
  birthday DATE,
  weekday_hours JSONB DEFAULT '[{"from":9,"to":18}]',
  weekend_hours JSONB,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ==================== teams ====================
CREATE TABLE IF NOT EXISTS teams (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_code TEXT UNIQUE NOT NULL,
  team_name TEXT NOT NULL,
  team_type TEXT NOT NULL,
  director_id UUID REFERENCES users(id),
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- usersのteam_idにFK追加
ALTER TABLE users ADD CONSTRAINT users_team_id_fkey
  FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE SET NULL;

-- ==================== clients ====================
CREATE TABLE IF NOT EXISTS clients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  client_code TEXT,
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ==================== slack_workspaces ====================
CREATE TABLE IF NOT EXISTS slack_workspaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  team_id TEXT NOT NULL,
  bot_token TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ==================== projects ====================
CREATE TABLE IF NOT EXISTS projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID REFERENCES clients(id),
  name TEXT NOT NULL,
  status TEXT DEFAULT '提案中',
  producer_id UUID REFERENCES users(id),
  director_id UUID REFERENCES users(id),
  sheet_url TEXT,
  admin_note TEXT,
  start_date DATE,
  end_date DATE,
  chatwork_room_id TEXT,
  slack_workspace_id UUID REFERENCES slack_workspaces(id),
  slack_channel_id TEXT,
  is_hidden BOOLEAN DEFAULT false,
  seq_counter INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ==================== project_cycles ====================
CREATE TABLE IF NOT EXISTS project_cycles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  year INTEGER NOT NULL,
  month INTEGER NOT NULL,
  planned_video_count INTEGER DEFAULT 0,
  planned_design_count INTEGER DEFAULT 0,
  deadline DATE,
  material_received_date DATE,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ==================== appeal_types ====================
CREATE TABLE IF NOT EXISTS appeal_types (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 初期データ
INSERT INTO appeal_types (code, name, sort_order) VALUES
  ('UGC', 'UGC風', 1),
  ('TV', 'TV CM風', 2),
  ('PR', 'PR動画', 3),
  ('EDU', '教育・解説', 4),
  ('SNS', 'SNS縦型', 5)
ON CONFLICT (code) DO NOTHING;

-- ==================== project_appeal_types ====================
CREATE TABLE IF NOT EXISTS project_appeal_types (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  appeal_type_id UUID REFERENCES appeal_types(id),
  seq_counter INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(project_id, appeal_type_id)
);

-- ==================== creatives ====================
CREATE TABLE IF NOT EXISTS creatives (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  cycle_id UUID REFERENCES project_cycles(id) ON DELETE SET NULL,
  file_name TEXT NOT NULL,
  creative_type TEXT NOT NULL,
  status TEXT DEFAULT '未着手',
  draft_deadline DATE,
  final_deadline DATE,
  script_url TEXT,
  frameio_url TEXT,
  delivery_url TEXT,
  final_delivery_url TEXT,
  help_flag BOOLEAN DEFAULT false,
  note TEXT,
  revision_count INTEGER DEFAULT 0,
  is_payable BOOLEAN DEFAULT false,
  special_payable BOOLEAN DEFAULT false,
  special_payable_reason TEXT,
  special_payable_by UUID REFERENCES users(id),
  special_payable_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ==================== creative_assignments ====================
CREATE TABLE IF NOT EXISTS creative_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creative_id UUID REFERENCES creatives(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id),
  role TEXT NOT NULL,
  rank_applied TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ==================== project_rates ====================
CREATE TABLE IF NOT EXISTS project_rates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  creative_type TEXT NOT NULL CHECK (creative_type IN ('video', 'design')),
  rank TEXT NOT NULL CHECK (rank IN ('A', 'B', 'C')),
  base_fee INTEGER DEFAULT 0,
  script_fee INTEGER DEFAULT 0,
  ai_fee INTEGER DEFAULT 0,
  other_fee INTEGER DEFAULT 0,
  other_fee_note TEXT,
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(project_id, creative_type, rank)
);

-- ==================== invoices ====================
CREATE TABLE IF NOT EXISTS invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_number TEXT UNIQUE NOT NULL,
  issuer_id UUID REFERENCES users(id),
  project_id UUID REFERENCES projects(id),
  cycle_id UUID REFERENCES project_cycles(id),
  total_amount INTEGER DEFAULT 0,
  status TEXT DEFAULT 'draft',
  issued_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ==================== invoice_items ====================
CREATE TABLE IF NOT EXISTS invoice_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id UUID REFERENCES invoices(id) ON DELETE CASCADE,
  creative_id UUID REFERENCES creatives(id),
  total_amount INTEGER DEFAULT 0,
  is_special BOOLEAN DEFAULT false,
  special_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ==================== invoice_item_details ====================
CREATE TABLE IF NOT EXISTS invoice_item_details (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_item_id UUID REFERENCES invoice_items(id) ON DELETE CASCADE,
  cost_type TEXT NOT NULL,
  unit_price INTEGER DEFAULT 0,
  amount INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ==================== 追加カラム（後から追加分） ====================

-- creatives にコメントカラム追加
ALTER TABLE creatives ADD COLUMN IF NOT EXISTS director_comment TEXT;
ALTER TABLE creatives ADD COLUMN IF NOT EXISTS client_comment TEXT;

-- clients にステータス・営業開始日追加
ALTER TABLE clients ADD COLUMN IF NOT EXISTS sales_start_date DATE;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS status TEXT DEFAULT '提案中';

-- teams にプロデューサー追加
ALTER TABLE teams ADD COLUMN IF NOT EXISTS producer_id UUID REFERENCES users(id);

-- projects に Google Drive フォルダURL追加
ALTER TABLE projects ADD COLUMN IF NOT EXISTS drive_folder_url TEXT;

-- project_rate_extras テーブル（その他単価）
CREATE TABLE IF NOT EXISTS project_rate_extras (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  creative_type TEXT NOT NULL CHECK (creative_type IN ('video', 'design')),
  name TEXT NOT NULL,
  fee INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ==================== creative_files ====================
CREATE TABLE IF NOT EXISTS creative_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creative_id UUID REFERENCES creatives(id) ON DELETE CASCADE,
  original_name TEXT,
  generated_name TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  version INTEGER DEFAULT 1,
  drive_file_id TEXT,
  drive_url TEXT,
  uploaded_by UUID REFERENCES users(id),
  uploaded_at TIMESTAMPTZ DEFAULT now()
);

-- ==================== マスターテーブル群 ====================
-- (creative_file_comments が master_items を参照するため先に定義)

-- ==================== 汎用マスター ====================

-- 区分マスター（商材 / 媒体 / クリエイティブFMT / 訴求軸 / サイズ など）
CREATE TABLE IF NOT EXISTS master_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  code TEXT UNIQUE NOT NULL,
  sort_order INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- 初期区分データ
INSERT INTO master_categories (name, code, sort_order) VALUES
  ('商材',                   'products',        1),
  ('媒体',                   'media',           2),
  ('クリエイティブFMT',      'creative_formats',3),
  ('訴求軸',                 'appeal_axes',     4),
  ('サイズ',                 'sizes',           5)
ON CONFLICT (code) DO NOTHING;

-- 値マスター（汎用）
-- expires_at: NULL = 無期限有効。日時を過ぎたものはプルダウンから除外される
CREATE TABLE IF NOT EXISTS master_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id UUID NOT NULL REFERENCES master_categories(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  note TEXT,
  sort_order INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(category_id, code)
);

-- ==================== creative_file_comments ====================
CREATE TABLE IF NOT EXISTS creative_file_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creative_file_id UUID REFERENCES creative_files(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  comment TEXT NOT NULL,
  timecode TEXT,
  is_knowledge BOOLEAN DEFAULT false,
  category_id UUID REFERENCES master_items(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cfc_creative_file_id ON creative_file_comments(creative_file_id);
CREATE INDEX IF NOT EXISTS idx_cfc_is_knowledge ON creative_file_comments(is_knowledge);

-- ==================== システム設定 ====================
CREATE TABLE IF NOT EXISTS system_settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ==================== クライアント・案件レベルマスター ====================

-- クライアント商材マスター
CREATE TABLE IF NOT EXISTS client_products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  note TEXT,
  sort_order INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(client_id, code)
);

-- クライアント訴求軸マスター
CREATE TABLE IF NOT EXISTS client_appeal_axes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  note TEXT,
  sort_order INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(client_id, code)
);

-- 案件商材（sync_products=OFF時に使用）
CREATE TABLE IF NOT EXISTS project_products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  note TEXT,
  sort_order INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(project_id, code)
);

-- 案件訴求軸（sync_appeal_axes=OFF時に使用）
CREATE TABLE IF NOT EXISTS project_appeal_axes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  note TEXT,
  sort_order INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(project_id, code)
);

-- projectsテーブルにsyncスイッチ追加
ALTER TABLE projects ADD COLUMN IF NOT EXISTS sync_products BOOLEAN DEFAULT true;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS sync_appeal_axes BOOLEAN DEFAULT true;

-- Slackワークスペースを直接テキストIDで持つ（UUID FKの代替）
ALTER TABLE projects ADD COLUMN IF NOT EXISTS slack_team_id TEXT;

-- projects_status_check 制約が存在する場合は削除（アプリ側でバリデーション済み）
ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_status_check;

-- クリエイティブ バージョン履歴
CREATE TABLE IF NOT EXISTS creative_version_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creative_id UUID NOT NULL REFERENCES creatives(id) ON DELETE CASCADE,
  version_num INTEGER NOT NULL,
  director_comment TEXT,
  client_comment TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- projects にレギュレーションシートURL追加
ALTER TABLE projects ADD COLUMN IF NOT EXISTS regulation_url TEXT;

-- クライアント報酬設定（案件ごと）
CREATE TABLE IF NOT EXISTS project_client_fees (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  video_unit_price INTEGER DEFAULT 0,   -- 動画1本あたり単価
  design_unit_price INTEGER DEFAULT 0,  -- デザイン1本あたり単価
  fixed_budget INTEGER,                 -- 案件固定予算（NULLなら本数×単価で計算）
  use_fixed_budget BOOLEAN DEFAULT false, -- trueなら固定予算優先
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(project_id)
);
-- ==================== 認証用カラム追加（Supabase認証移行） ====================
-- パスワード認証・Google OAuth をSupabaseで完結させる
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS google_id TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT;

-- ==================== invitations ====================
-- 招待トークン（Supabase永続化。RailwayのSQLiteは再デプロイでリセットされるため移行）
CREATE TABLE IF NOT EXISTS invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token TEXT UNIQUE NOT NULL,
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'editor',
  invited_by_email TEXT,
  used BOOLEAN DEFAULT false,
  used_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- invoices テーブルに承認フロー用カラム追加
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS year INTEGER;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS month INTEGER;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS recipient_id UUID REFERENCES users(id);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS approved_by UUID REFERENCES users(id);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS rejection_reason TEXT;

-- ==================== チェックリスト ====================

-- 基本チェックリストマスター（全案件共通）
CREATE TABLE IF NOT EXISTS checklist_masters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  description TEXT,
  sort_order INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- 案件ごとのチェックリスト項目
CREATE TABLE IF NOT EXISTS project_checklist_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  sort_order INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- クリエイティブファイルのチェック結果
CREATE TABLE IF NOT EXISTS creative_checklist_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creative_file_id UUID NOT NULL REFERENCES creative_files(id) ON DELETE CASCADE,
  item_id UUID NOT NULL,
  item_type TEXT NOT NULL CHECK (item_type IN ('global', 'project')),
  is_checked BOOLEAN DEFAULT false,
  checked_by UUID REFERENCES users(id),
  checked_at TIMESTAMPTZ,
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(creative_file_id, item_id, item_type)
);

CREATE INDEX IF NOT EXISTS idx_ccr_file ON creative_checklist_results(creative_file_id);

-- ==================== Premiere Pro UXP 連携 ====================
-- creative_files に Premiere Pro プロジェクトID（documentID）を紐づけ
ALTER TABLE creative_files ADD COLUMN IF NOT EXISTS premiere_project_id TEXT;

-- ====================================================================================
-- ワークスペース（マルチチーム対応）
-- 各チームが独自のインフラ（Railway/Supabase/Drive）でデプロイし、
-- workspace_number で識別する。データは完全に分離される。
-- ====================================================================================

-- ==================== workspaces ====================
CREATE TABLE IF NOT EXISTS workspaces (
  id               UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_number INTEGER UNIQUE NOT NULL,        -- 1, 2, 3 ... 人間が読む番号
  name             TEXT    NOT NULL,               -- "HARUKA FILM"
  slug             TEXT    UNIQUE NOT NULL,        -- "haruka-film"（URLや識別子用）
  owner_email      TEXT,                           -- 契約者・管理者メール
  is_active        BOOLEAN DEFAULT true,
  created_at       TIMESTAMPTZ DEFAULT now(),
  updated_at       TIMESTAMPTZ DEFAULT now()
);

-- ==================== workspace_configs ====================
-- ワークスペースごとの機能フラグ・UIカスタマイズ
CREATE TABLE IF NOT EXISTS workspace_configs (
  workspace_id          UUID    PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  -- 機能フラグ
  enable_invoices       BOOLEAN DEFAULT true,   -- 請求機能
  enable_checklist      BOOLEAN DEFAULT true,   -- チェックリスト
  enable_premiere       BOOLEAN DEFAULT false,  -- Premiere連携
  enable_cl_check       BOOLEAN DEFAULT true,   -- CLチェックフロー
  enable_knowledge      BOOLEAN DEFAULT true,   -- ナレッジ
  -- UIカスタマイズ
  primary_color         TEXT    DEFAULT '#3ECFCA',
  logo_text             TEXT    DEFAULT 'HARUKA FILM',
  logo_sub_text         TEXT    DEFAULT '光を当てる、あなたのストーリーに',
  -- 請求設定
  default_billing_type  TEXT    DEFAULT 'per_video', -- per_video / fixed
  updated_at            TIMESTAMPTZ DEFAULT now()
);

-- ==================== client_configs ====================
-- クライアントごとの個別カスタマイズフラグ
CREATE TABLE IF NOT EXISTS client_configs (
  client_id                  UUID    PRIMARY KEY REFERENCES clients(id) ON DELETE CASCADE,
  enable_cl_check            BOOLEAN DEFAULT true,    -- CL確認フローあり/なし
  billing_type               TEXT    DEFAULT 'per_video',
  sync_products_default      BOOLEAN DEFAULT true,    -- 商材を案件に自動同期
  sync_appeal_axes_default   BOOLEAN DEFAULT true,    -- 訴求軸を案件に自動同期
  note                       TEXT,                    -- 運用メモ
  updated_at                 TIMESTAMPTZ DEFAULT now()
);

-- ==================== workspace_id カラム追加 ====================
ALTER TABLE users             ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES workspaces(id) ON DELETE SET NULL;
ALTER TABLE clients           ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES workspaces(id) ON DELETE SET NULL;
ALTER TABLE teams             ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES workspaces(id) ON DELETE SET NULL;
ALTER TABLE master_categories ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES workspaces(id) ON DELETE SET NULL;

-- ==================== 初期データ：HARUKA FILM をワークスペース#1として登録 ====================
INSERT INTO workspaces (workspace_number, name, slug, owner_email)
VALUES (1, 'HARUKA FILM', 'haruka-film', 'hiikun.ascs@gmail.com')
ON CONFLICT (workspace_number) DO NOTHING;

INSERT INTO workspace_configs (workspace_id)
SELECT id FROM workspaces WHERE workspace_number = 1
ON CONFLICT (workspace_id) DO NOTHING;

-- ==================== 既存データをワークスペース#1に移行 ====================
UPDATE users
SET workspace_id = (SELECT id FROM workspaces WHERE workspace_number = 1)
WHERE workspace_id IS NULL;

UPDATE clients
SET workspace_id = (SELECT id FROM workspaces WHERE workspace_number = 1)
WHERE workspace_id IS NULL;

UPDATE teams
SET workspace_id = (SELECT id FROM workspaces WHERE workspace_number = 1)
WHERE workspace_id IS NULL;

UPDATE master_categories
SET workspace_id = (SELECT id FROM workspaces WHERE workspace_number = 1)
WHERE workspace_id IS NULL;

-- client_configs を既存クライアント全件に生成
INSERT INTO client_configs (client_id)
SELECT id FROM clients
ON CONFLICT (client_id) DO NOTHING;
