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
  talent_flag BOOLEAN DEFAULT false,
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
-- 編集者/デザイナーのコメント・返信を分離保存（後修正再提出時に director_comment の上書き防止）
ALTER TABLE creatives ADD COLUMN IF NOT EXISTS editor_comment TEXT;

-- clients にステータス・営業開始日追加
ALTER TABLE clients ADD COLUMN IF NOT EXISTS sales_start_date DATE;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS status TEXT DEFAULT '提案中';
-- HP・SNSリンク
ALTER TABLE clients ADD COLUMN IF NOT EXISTS website_url TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS twitter_url TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS instagram_url TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS facebook_url TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS youtube_url TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS tiktok_url TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS line_url TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS other_url TEXT;
-- ペルソナ（ターゲット顧客像：年齢層・性別・ライフスタイル・悩み等の自由記述）
ALTER TABLE clients ADD COLUMN IF NOT EXISTS persona TEXT;

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

-- ==================== パフォーマンス用インデックス ====================
CREATE INDEX IF NOT EXISTS idx_creatives_project_id         ON creatives(project_id);
CREATE INDEX IF NOT EXISTS idx_creatives_cycle_id           ON creatives(cycle_id);
CREATE INDEX IF NOT EXISTS idx_creatives_final_deadline     ON creatives(final_deadline);
CREATE INDEX IF NOT EXISTS idx_creatives_status             ON creatives(status);
CREATE INDEX IF NOT EXISTS idx_creative_assignments_user_id     ON creative_assignments(user_id);
CREATE INDEX IF NOT EXISTS idx_creative_assignments_creative_id ON creative_assignments(creative_id);
CREATE INDEX IF NOT EXISTS idx_invoices_issuer_year_month   ON invoices(issuer_id, year, month);
CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice_id     ON invoice_items(invoice_id);
CREATE INDEX IF NOT EXISTS idx_creative_files_creative_id   ON creative_files(creative_id, uploaded_at DESC);

-- talent_flag カラム追加（既存DBへのマイグレーション）
ALTER TABLE creatives ADD COLUMN IF NOT EXISTS talent_flag BOOLEAN DEFAULT false;

-- creatives にチームを独立保存（担当者の team_id 派生から脱却）
ALTER TABLE creatives ADD COLUMN IF NOT EXISTS team_id UUID REFERENCES teams(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_creatives_team_id ON creatives(team_id);

-- team_id への FK を確実に付与（過去にカラムだけが FK 無しで追加された場合の修復）
-- これが無いと PostgREST は creatives → teams の埋め込み select を解決できず、
-- /api/creatives が 500 を返してフロントが allCreatives.forEach is not a function で落ちる
DO $$
BEGIN
  -- 既存の孤立 team_id を NULL 化（FK 追加時のバリデーション失敗を防ぐ）
  UPDATE public.creatives c
     SET team_id = NULL
   WHERE c.team_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.teams t WHERE t.id = c.team_id);

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'creatives_team_id_fkey' AND conrelid = 'public.creatives'::regclass
  ) THEN
    ALTER TABLE public.creatives
      ADD CONSTRAINT creatives_team_id_fkey
      FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE SET NULL;
  END IF;
END
$$;

-- チェックリストマスターに対象区分を追加（'all'=共通, 'video'=動画のみ, 'design'=デザインのみ）
ALTER TABLE checklist_masters ADD COLUMN IF NOT EXISTS target_type TEXT DEFAULT 'all';

-- レビューコメント・ナレッジカテゴリーを動画/デザイン別に分割
-- （既存の COMMENT_CAT は後方互換のため残す）
INSERT INTO master_categories (name, code, sort_order) VALUES
  ('レビューカテゴリー（動画）',   'COMMENT_CAT_VIDEO',   10),
  ('レビューカテゴリー（デザイン）','COMMENT_CAT_DESIGN',  11)
ON CONFLICT (code) DO NOTHING;

-- ==================== ロール権限（DB駆動） ====================
CREATE TABLE IF NOT EXISTS role_permissions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  role            TEXT NOT NULL,
  permission_key  TEXT NOT NULL,
  allowed         BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE(role, permission_key)
);
CREATE INDEX IF NOT EXISTS idx_role_permissions_role ON role_permissions(role);

-- 初期シード（既存挙動と完全一致）
INSERT INTO role_permissions (role, permission_key, allowed) VALUES
  -- ダッシュボード
  ('admin','dashboard.sales_summary',true),
  ('admin','dashboard.monthly_forecast',true),
  -- 案件
  ('admin','project.create_edit',true),('secretary','project.create_edit',true),('producer','project.create_edit',true),('producer_director','project.create_edit',true),
  ('admin','project.unit_price_view',true),('producer','project.unit_price_view',true),('producer_director','project.unit_price_view',true),
  ('admin','project.fee_view',true),('secretary','project.fee_view',true),
  -- クリエイティブ
  ('admin','creative.all_projects_view',true),('secretary','creative.all_projects_view',true),('producer','creative.all_projects_view',true),('producer_director','creative.all_projects_view',true),
  ('admin','creative.rank_price_column',true),('producer','creative.rank_price_column',true),('producer_director','creative.rank_price_column',true),('director','creative.rank_price_column',true),
  ('admin','creative.csv_import',true),('secretary','creative.csv_import',true),('producer','creative.csv_import',true),('producer_director','creative.csv_import',true),
  -- メンバー
  ('admin','member.list',true),('secretary','member.list',true),('producer','member.list',true),('producer_director','member.list',true),('director','member.list',true),
  ('admin','member.edit_password',true),('secretary','member.edit_password',true),
  ('admin','member.deactivate',true),('secretary','member.deactivate',true),
  ('admin','member.delete',true),
  -- チーム
  ('admin','team.manage',true),('secretary','team.manage',true),
  ('admin','team.assign',true),('secretary','team.assign',true),
  -- 請求
  ('admin','invoice.own',true),('secretary','invoice.own',true),('producer','invoice.own',true),('producer_director','invoice.own',true),('director','invoice.own',true),('editor','invoice.own',true),('designer','invoice.own',true),
  ('admin','invoice.all_view',true),('secretary','invoice.all_view',true),
  -- マスター
  ('admin','master.page',true),('secretary','master.page',true),
  ('admin','master.sys_config',true),
  -- システム
  ('admin','system.view_as',true)
ON CONFLICT (role, permission_key) DO NOTHING;

-- ==================== 請求書明細：自由編集対応（Step 1） ====================
-- invoice_items に明細行として必要な列を追加（既存の creative_id 紐付け行とも共存）
ALTER TABLE invoice_items ADD COLUMN IF NOT EXISTS label TEXT;
ALTER TABLE invoice_items ADD COLUMN IF NOT EXISTS quantity NUMERIC DEFAULT 1;
ALTER TABLE invoice_items ADD COLUMN IF NOT EXISTS unit TEXT DEFAULT '式';
ALTER TABLE invoice_items ADD COLUMN IF NOT EXISTS unit_price INTEGER DEFAULT 0;
ALTER TABLE invoice_items ADD COLUMN IF NOT EXISTS sort_order INTEGER DEFAULT 0;

-- 既存データのバックフィル：
-- 1) unit_price が 0 のままの行は total_amount をコピー（quantity=1 前提）
UPDATE invoice_items
   SET unit_price = COALESCE(total_amount, 0)
 WHERE (unit_price IS NULL OR unit_price = 0)
   AND COALESCE(total_amount, 0) > 0;

-- 2) label が NULL の行はクリエイティブ名を埋める（紐付けあり）
UPDATE invoice_items ii
   SET label = COALESCE(c.file_name, '明細') ||
               CASE WHEN c.creative_type IS NOT NULL THEN ' (' || c.creative_type || ')' ELSE '' END
  FROM creatives c
 WHERE ii.creative_id = c.id
   AND ii.label IS NULL;

-- 3) creative 紐付けがない既存行（手動行は今回が初）には汎用ラベル
UPDATE invoice_items
   SET label = '明細'
 WHERE label IS NULL;

-- 4) sort_order を created_at 順で番号付け（同じinvoice内で連番）
WITH numbered AS (
  SELECT id,
         ROW_NUMBER() OVER (PARTITION BY invoice_id ORDER BY created_at, id) - 1 AS rn
    FROM invoice_items
   WHERE sort_order IS NULL OR sort_order = 0
)
UPDATE invoice_items ii
   SET sort_order = numbered.rn
  FROM numbered
 WHERE ii.id = numbered.id;

-- インデックス（invoice_id × sort_order での並び替えを高速化）
CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice_sort
  ON invoice_items(invoice_id, sort_order);

-- ==================== 請求書明細：コスト種別ごとに細分化（Step 1b） ====================
-- 1 invoice_item = 1コスト種別行 へ移行
-- グルーピング表示用に creative_label をキャッシュ
ALTER TABLE invoice_items ADD COLUMN IF NOT EXISTS cost_type      TEXT;
ALTER TABLE invoice_items ADD COLUMN IF NOT EXISTS creative_label TEXT;

-- 既存行に creative_label をバックフィル（クリエイティブ紐付けあり）
UPDATE invoice_items ii
   SET creative_label = c.file_name
  FROM creatives c
 WHERE ii.creative_id = c.id
   AND ii.creative_label IS NULL
   AND c.file_name IS NOT NULL;

-- 既存の親 invoice_items に対応する invoice_item_details の最初の1件を統合
WITH first_detail AS (
  SELECT DISTINCT ON (iid.invoice_item_id)
         iid.invoice_item_id, iid.cost_type, iid.unit_price, iid.amount
    FROM invoice_item_details iid
    JOIN invoice_items ii ON ii.id = iid.invoice_item_id
   WHERE ii.cost_type IS NULL
     AND COALESCE(iid.amount, 0) > 0
   ORDER BY iid.invoice_item_id, iid.created_at, iid.id
)
UPDATE invoice_items ii
   SET cost_type    = fd.cost_type,
       unit_price   = fd.unit_price,
       total_amount = fd.amount,
       quantity     = COALESCE(ii.quantity, 1),
       unit         = COALESCE(ii.unit, '本'),
       label        = CASE
                        WHEN ii.label IS NULL OR ii.label = ''
                          THEN COALESCE(
                                 CASE fd.cost_type
                                   WHEN 'base_fee'   THEN '編集'
                                   WHEN 'script_fee' THEN '台本作成'
                                   WHEN 'ai_fee'     THEN 'AI生成（ナレーション含む）'
                                   WHEN 'other_fee'  THEN 'その他'
                                   ELSE fd.cost_type
                                 END, '明細')
                        ELSE ii.label
                      END
  FROM first_detail fd
 WHERE ii.id = fd.invoice_item_id;

-- 残りの details を新しい invoice_items 行として展開
INSERT INTO invoice_items (
  invoice_id, creative_id, total_amount, is_special, special_reason,
  label, quantity, unit, unit_price, sort_order, cost_type, creative_label
)
SELECT
  parent.invoice_id,
  parent.creative_id,
  iid.amount,
  parent.is_special,
  parent.special_reason,
  CASE iid.cost_type
    WHEN 'base_fee'   THEN '編集'
    WHEN 'script_fee' THEN '台本作成'
    WHEN 'ai_fee'     THEN 'AI生成（ナレーション含む）'
    WHEN 'other_fee'  THEN 'その他'
    ELSE iid.cost_type
  END,
  1, '本',
  iid.unit_price,
  COALESCE(parent.sort_order, 0)
    + ROW_NUMBER() OVER (PARTITION BY parent.id ORDER BY iid.created_at, iid.id),
  iid.cost_type,
  parent.creative_label
  FROM invoice_item_details iid
  JOIN invoice_items parent ON parent.id = iid.invoice_item_id
 WHERE COALESCE(iid.amount, 0) > 0
   AND parent.cost_type IS NOT NULL
   AND parent.cost_type <> iid.cost_type
   AND NOT EXISTS (
     SELECT 1 FROM invoice_items existing
      WHERE existing.invoice_id  = parent.invoice_id
        AND existing.creative_id IS NOT DISTINCT FROM parent.creative_id
        AND existing.cost_type   = iid.cost_type
        AND existing.id          <> parent.id
   );

-- 影響を受けた請求書の合計を再計算
UPDATE invoices inv
   SET total_amount = sub.sum_amt,
       updated_at   = now()
  FROM (
    SELECT invoice_id, SUM(COALESCE(total_amount, 0)) AS sum_amt
      FROM invoice_items
     GROUP BY invoice_id
  ) sub
 WHERE inv.id = sub.invoice_id
   AND inv.total_amount IS DISTINCT FROM sub.sum_amt;

-- グルーピング表示用インデックス
CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice_creative_sort
  ON invoice_items(invoice_id, creative_id, sort_order);

-- ==================== 請求書明細：単価変更の監査列 ====================
-- 「いくらから いくらに 上げたのか」を後から再現するため、
-- 請求書作成時点での project_rates 由来デフォルト単価と、
-- 変更があった場合の理由を別カラムで保存する。
-- special_reason は creatives.special_payable_reason 由来のフィールドに戻し、
-- 単価変更とは別概念として分離する。
ALTER TABLE invoice_items ADD COLUMN IF NOT EXISTS original_unit_price INTEGER;
ALTER TABLE invoice_items ADD COLUMN IF NOT EXISTS price_change_reason TEXT;

-- ==================== セキュリティ：全 public テーブルで RLS 有効化 ====================
-- 本アプリは Supabase の service_role キーをサーバー側でのみ使用しており、
-- クライアントから anon キーで Supabase REST API を叩く構成ではない。
-- ただし多重防御として、public スキーマの全テーブルで Row Level Security を
-- 有効化し、ポリシー無し = anon/authenticated 直接アクセスは全拒否とする。
-- service_role はバイパスするので既存アプリ機能には影響しない。
DO $rls_enable$
DECLARE
  t record;
BEGIN
  FOR t IN
    SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.tablename);
  END LOOP;
END
$rls_enable$;

-- ==================== invoices.status の CHECK 制約を撤廃 ====================
-- 旧スキーマで draft/issued のみ許可する CHECK 制約があり、submitted への
-- ステータス遷移が「invoices_status_check」違反で失敗していた。
-- アプリ側で遷移ロジックをガードしているため CHECK 制約は不要。
-- (projects_status_check と同じ方針)
ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_status_check;
