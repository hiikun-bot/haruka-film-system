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
  creative_type TEXT NOT NULL,
  rank TEXT NOT NULL,
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
  creative_type TEXT NOT NULL,
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
