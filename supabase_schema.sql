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

-- ==================== client_teams (Nクライアント:Nチーム の中間表) ====================
CREATE TABLE IF NOT EXISTS client_teams (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(client_id, team_id)
);
CREATE INDEX IF NOT EXISTS idx_client_teams_client ON client_teams(client_id);
CREATE INDEX IF NOT EXISTS idx_client_teams_team ON client_teams(team_id);

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
  is_hidden BOOLEAN DEFAULT false,
  seq_counter INTEGER DEFAULT 0,
  project_type TEXT NOT NULL DEFAULT 'video' CHECK (project_type IN ('video','design')),
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
-- クリエイティブのメモ（クライアント要望、参考リンク、撮影メモ等）
ALTER TABLE creatives ADD COLUMN IF NOT EXISTS memo TEXT;

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

-- クリエイティブ進捗の自動通知用：クライアントごとの Slack チャンネル / Chatwork ルーム
ALTER TABLE clients ADD COLUMN IF NOT EXISTS slack_channel_url TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS chatwork_room_id TEXT;

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

-- 案件ごとの Slack チャンネル URL（チャンネルURL貼付け方式・通知送信用）
-- projects レベルで設定があれば clients.slack_channel_url より優先される
ALTER TABLE projects ADD COLUMN IF NOT EXISTS slack_channel_url TEXT;
-- 既存の projects.chatwork_room_id を通知送信時のオーバーライドとしても利用する
ALTER TABLE projects ADD COLUMN IF NOT EXISTS chatwork_room_id TEXT;

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

-- 管理者によるステータス強制変更の監査ログ
-- 「誰が・いつ・どの状態 → どの状態に・なぜ・付随削除した下書き明細」を残す
CREATE TABLE IF NOT EXISTS creative_status_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creative_id UUID NOT NULL REFERENCES creatives(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status  TEXT,
  reason     TEXT NOT NULL,
  changed_by UUID REFERENCES users(id),
  changed_at TIMESTAMPTZ DEFAULT now(),
  deleted_invoice_item_ids JSONB
);
CREATE INDEX IF NOT EXISTS idx_creative_status_audit_creative ON creative_status_audit(creative_id, changed_at DESC);

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

-- ==================== 動画ストリーミング高速化 ====================
-- mime_type / file_size: Drive メタ情報をキャッシュし、Range配信ごとの drive.files.get 呼び出しを削減
-- faststart_*: -c copy -movflags +faststart で再エンコード無しに moov を先頭へ移動した版（画質完全維持）
ALTER TABLE creative_files ADD COLUMN IF NOT EXISTS mime_type              TEXT;
ALTER TABLE creative_files ADD COLUMN IF NOT EXISTS file_size              BIGINT;
ALTER TABLE creative_files ADD COLUMN IF NOT EXISTS faststart_drive_file_id TEXT;
ALTER TABLE creative_files ADD COLUMN IF NOT EXISTS faststart_drive_url     TEXT;
ALTER TABLE creative_files ADD COLUMN IF NOT EXISTS faststart_file_size     BIGINT;
ALTER TABLE creative_files ADD COLUMN IF NOT EXISTS faststart_status        TEXT;
ALTER TABLE creative_files ADD COLUMN IF NOT EXISTS faststart_processed_at  TIMESTAMPTZ;
-- drive_file_id 経由のキャッシュ参照を高速化
CREATE INDEX IF NOT EXISTS idx_creative_files_drive_file_id ON creative_files(drive_file_id);

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

-- 誕生日の年（および年齢）を非表示にしたいユーザー向けのフラグ
-- false（デフォルト）: 通常通り年月日を表示し、年齢も表示してOK
-- true: 月日のみ表示。年齢計算・表示は行わない
ALTER TABLE users ADD COLUMN IF NOT EXISTS hide_birth_year BOOLEAN DEFAULT false;

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
-- 一覧 API 高速化（status フィルタ + final_deadline ソート の複合）
CREATE INDEX IF NOT EXISTS idx_creatives_status_deadline    ON creatives (status, final_deadline NULLS LAST);
-- 案件ページからの絞り込み（project_id + status）
CREATE INDEX IF NOT EXISTS idx_creatives_project_status     ON creatives (project_id, status);
CREATE INDEX IF NOT EXISTS idx_creative_assignments_user_id     ON creative_assignments(user_id);
CREATE INDEX IF NOT EXISTS idx_creative_assignments_creative_id ON creative_assignments(creative_id);
CREATE INDEX IF NOT EXISTS idx_invoices_issuer_year_month   ON invoices(issuer_id, year, month);
CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice_id     ON invoice_items(invoice_id);
CREATE INDEX IF NOT EXISTS idx_creative_files_creative_id   ON creative_files(creative_id, uploaded_at DESC);

-- talent_flag カラム追加（既存DBへのマイグレーション）
ALTER TABLE creatives ADD COLUMN IF NOT EXISTS talent_flag BOOLEAN DEFAULT false;

-- creatives にチームを独立保存（担当者の team_id 派生から脱却）
ALTER TABLE creatives ADD COLUMN IF NOT EXISTS team_id UUID REFERENCES teams(id) ON DELETE SET NULL;

-- 納品完了モード（途中工程をスキップして直接「納品」にした記録）
ALTER TABLE creatives ADD COLUMN IF NOT EXISTS force_delivered        BOOLEAN DEFAULT false;
ALTER TABLE creatives ADD COLUMN IF NOT EXISTS force_delivered_reason TEXT;
ALTER TABLE creatives ADD COLUMN IF NOT EXISTS force_delivered_at     TIMESTAMPTZ;
ALTER TABLE creatives ADD COLUMN IF NOT EXISTS force_delivered_by     UUID REFERENCES users(id);
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
  -- SOSフラグの他人クリエイティブへの操作権限（編集者/デザイナーは自分の担当のみ可。下位ロールは row レベルで判定）
  ('admin','creative.sos_others',true),('secretary','creative.sos_others',true),('producer','creative.sos_others',true),('producer_director','creative.sos_others',true),('director','creative.sos_others',true),
  -- メンバー
  ('admin','member.list',true),('secretary','member.list',true),('producer','member.list',true),('producer_director','member.list',true),('director','member.list',true),('editor','member.list',true),('designer','member.list',true),
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
  ('admin','system.view_as',true),
  -- 分析・集計（管理者・秘書のみ閲覧）
  ('admin','analytics.view',true),('secretary','analytics.view',true)
ON CONFLICT (role, permission_key) DO UPDATE SET allowed = EXCLUDED.allowed;

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

-- ==================== 全体連絡（アナウンスメント） ====================
-- ダッシュボードに表示される全社員向けの連絡。
-- 投稿者は完了状況（誰がやったか）を一覧で確認できる。
-- 投稿時に system_settings.broadcast_slack_channel_url が設定されていれば
-- そのチャンネルへも自動で同じメッセージを投稿する。
CREATE TABLE IF NOT EXISTS announcements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  body TEXT,
  posted_by UUID REFERENCES users(id) ON DELETE SET NULL,
  posted_at TIMESTAMPTZ DEFAULT now(),
  deadline_at TIMESTAMPTZ,
  is_active BOOLEAN DEFAULT true,
  slack_pushed_at TIMESTAMPTZ,
  slack_push_result TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_announcements_active ON announcements(is_active, posted_at DESC);

-- 各メンバーの完了状況。完了ボタンを押した時に1行追加される。
CREATE TABLE IF NOT EXISTS announcement_acks (
  announcement_id UUID NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  done_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (announcement_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_announcement_acks_user ON announcement_acks(user_id);

-- ==================== つぶやき機能（社内タイムライン）====================
-- 写真（任意） + 短いコメント + ❤️ いいね のミニ社内 SNS。
-- ダッシュボード上に表示され、90 日で自動的に非表示（ピン留めは永続）。
CREATE TABLE IF NOT EXISTS tweets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL CHECK (char_length(body) <= 280),
  image_data TEXT,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '90 days'),
  is_pinned BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tweets_active ON tweets(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tweets_user ON tweets(user_id);

CREATE TABLE IF NOT EXISTS tweet_likes (
  tweet_id UUID NOT NULL REFERENCES tweets(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (tweet_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_tweet_likes_user ON tweet_likes(user_id);

-- ==================== users 個人情報カラム（過去の commit 50a1a3e で
--   コードだけ追加され、本番DBへ反映されていなかったカラムを補完） ====================
-- これが無いと PUT /api/members/:id が "column ... does not exist" で失敗し、
-- メンバー編集が「保存しても反映されない」バグになる（feedback batch 002）。
ALTER TABLE users ADD COLUMN IF NOT EXISTS nickname            TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS note                TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS bank_name           TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS bank_code           TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS branch_name         TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS branch_code         TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS account_type        TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS account_number      TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS account_holder_kana TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone               TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS postal_code         TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS address             TEXT;

-- ==================== users 休日曜日（feedback batch 002） ====================
-- 「土曜日が基本仕事」など、メンバーごとに休日にあたる曜日を設定できるようにする。
-- weekday_hours / weekend_hours は既存の時間帯設定（残す）。本カラムは「曜日カレンダー
-- 上で休日扱いにする日」のリスト。既定は土日（[0,6] = 日, 土）。
-- 配列は ISO 風 0=日, 1=月, ... 6=土。
ALTER TABLE users ADD COLUMN IF NOT EXISTS holiday_weekdays JSONB DEFAULT '[0,6]'::jsonb;

-- ==================== users カメラマン機材情報（feedback batch 002） ====================
-- 撮影系メンバーが「使用カメラ機種」「三脚」「照明」を登録できる欄。
-- すべて任意 TEXT。空文字 / NULL = 未登録。
ALTER TABLE users ADD COLUMN IF NOT EXISTS camera_model TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS tripod_info  TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS lighting_info TEXT;

-- ==================== 案件収支（Project Accounting）— Step A ====================
-- 詳細は docs/project_accounting_design_ja.md
-- スタンドアロン migration: migrations/2026-05-02_project_accounting_step_a.sql
-- 既存テーブルは無変更。トリガで invoice_items / invoices から自動連携。

-- invoices.invoice_type は本番DBに既に存在するが定義漏れがあったため明示
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS invoice_type TEXT;

-- 案件収支台帳（1 project : 1 row）
CREATE TABLE IF NOT EXISTS project_finance_books (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
  contract_total INTEGER DEFAULT 0,
  estimated_revenue INTEGER DEFAULT 0,
  estimated_cost INTEGER DEFAULT 0,
  actual_revenue INTEGER DEFAULT 0,
  actual_cost INTEGER DEFAULT 0,
  status TEXT DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  closed_at TIMESTAMPTZ,
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_project_finance_books_project ON project_finance_books(project_id);

-- 案件タイプ別の入力プロファイル（HP/LP/動画ごとに可変）と正規化メトリクス
CREATE TABLE IF NOT EXISTS project_input_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
  project_type TEXT NOT NULL DEFAULT 'other'
    CHECK (project_type IN ('video', 'hp', 'lp', 'other')),
  input_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  normalized_metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  raw_request_text TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_project_input_profiles_type ON project_input_profiles(project_type);

-- 見積（バージョン別）
CREATE TABLE IF NOT EXISTS project_estimates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version INTEGER NOT NULL DEFAULT 1,
  title TEXT,
  total_amount INTEGER DEFAULT 0,
  status TEXT DEFAULT 'draft'
    CHECK (status IN ('draft', 'sent', 'accepted', 'rejected', 'archived')),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(project_id, version)
);
CREATE INDEX IF NOT EXISTS idx_project_estimates_project ON project_estimates(project_id, version DESC);

-- 見積明細
CREATE TABLE IF NOT EXISTS project_estimate_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  estimate_id UUID NOT NULL REFERENCES project_estimates(id) ON DELETE CASCADE,
  category TEXT,
  label TEXT NOT NULL,
  quantity NUMERIC(10,2) DEFAULT 1,
  unit TEXT,
  unit_price INTEGER DEFAULT 0,
  amount INTEGER DEFAULT 0,
  sort_order INTEGER DEFAULT 0,
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_project_estimate_items_estimate ON project_estimate_items(estimate_id, sort_order);

-- 原価エントリ（invoice_items 自動連携 + 手入力可）
CREATE TABLE IF NOT EXISTS project_cost_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source TEXT NOT NULL DEFAULT 'manual'
    CHECK (source IN ('manual', 'invoice_item')),
  source_invoice_item_id UUID REFERENCES invoice_items(id) ON DELETE CASCADE,
  source_invoice_id UUID REFERENCES invoices(id) ON DELETE SET NULL,
  cost_type TEXT,
  label TEXT,
  amount INTEGER NOT NULL DEFAULT 0,
  occurred_on DATE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_project_cost_entries_project ON project_cost_entries(project_id, occurred_on DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_project_cost_entries_invoice_item
  ON project_cost_entries(source_invoice_item_id)
  WHERE source_invoice_item_id IS NOT NULL;

-- 売上エントリ（client invoice 自動連携 + 手入力可）
CREATE TABLE IF NOT EXISTS project_revenue_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source TEXT NOT NULL DEFAULT 'manual'
    CHECK (source IN ('manual', 'client_invoice')),
  source_invoice_id UUID REFERENCES invoices(id) ON DELETE CASCADE,
  revenue_type TEXT,
  label TEXT,
  amount INTEGER NOT NULL DEFAULT 0,
  occurred_on DATE,
  client_id UUID REFERENCES clients(id) ON DELETE SET NULL,
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_project_revenue_entries_project ON project_revenue_entries(project_id, occurred_on DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_project_revenue_entries_invoice
  ON project_revenue_entries(source_invoice_id)
  WHERE source_invoice_id IS NOT NULL;

-- ==================== 案件収支：トリガ関数 ====================

CREATE OR REPLACE FUNCTION sync_cost_entry_from_invoice_item() RETURNS TRIGGER AS $$
DECLARE
  v_project_id   UUID;
  v_invoice_type TEXT;
BEGIN
  IF NEW.invoice_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT i.project_id, i.invoice_type
    INTO v_project_id, v_invoice_type
    FROM invoices i
   WHERE i.id = NEW.invoice_id;

  IF v_invoice_type = 'client' THEN
    DELETE FROM project_cost_entries WHERE source_invoice_item_id = NEW.id;
    RETURN NEW;
  END IF;

  IF v_project_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF EXISTS (SELECT 1 FROM project_cost_entries WHERE source_invoice_item_id = NEW.id) THEN
    UPDATE project_cost_entries
       SET project_id        = v_project_id,
           source_invoice_id = NEW.invoice_id,
           cost_type         = COALESCE(NEW.cost_type, cost_type),
           label             = COALESCE(NEW.label, label),
           amount            = COALESCE(NEW.total_amount, 0),
           updated_at        = now()
     WHERE source_invoice_item_id = NEW.id;
  ELSE
    INSERT INTO project_cost_entries (
      project_id, source, source_invoice_item_id, source_invoice_id,
      cost_type, label, amount
    ) VALUES (
      v_project_id, 'invoice_item', NEW.id, NEW.invoice_id,
      NEW.cost_type, NEW.label, COALESCE(NEW.total_amount, 0)
    );
  END IF;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'sync_cost_entry_from_invoice_item failed (invoice_item_id=%): %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION delete_cost_entry_from_invoice_item() RETURNS TRIGGER AS $$
BEGIN
  DELETE FROM project_cost_entries WHERE source_invoice_item_id = OLD.id;
  RETURN OLD;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'delete_cost_entry_from_invoice_item failed (invoice_item_id=%): %', OLD.id, SQLERRM;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION sync_revenue_entry_from_invoice() RETURNS TRIGGER AS $$
DECLARE
  v_client_id UUID;
BEGIN
  IF NEW.invoice_type IS DISTINCT FROM 'client' THEN
    DELETE FROM project_revenue_entries WHERE source_invoice_id = NEW.id;
    RETURN NEW;
  END IF;

  IF NEW.project_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT p.client_id INTO v_client_id FROM projects p WHERE p.id = NEW.project_id;

  IF EXISTS (SELECT 1 FROM project_revenue_entries WHERE source_invoice_id = NEW.id) THEN
    UPDATE project_revenue_entries
       SET project_id  = NEW.project_id,
           amount      = COALESCE(NEW.total_amount, 0),
           client_id   = v_client_id,
           updated_at  = now()
     WHERE source_invoice_id = NEW.id;
  ELSE
    INSERT INTO project_revenue_entries (
      project_id, source, source_invoice_id, revenue_type,
      label, amount, occurred_on, client_id
    ) VALUES (
      NEW.project_id, 'client_invoice', NEW.id, 'lump_sum',
      NEW.invoice_number, COALESCE(NEW.total_amount, 0),
      COALESCE(NEW.issued_at::date, CURRENT_DATE), v_client_id
    );
  END IF;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'sync_revenue_entry_from_invoice failed (invoice_id=%): %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION delete_revenue_entry_from_invoice() RETURNS TRIGGER AS $$
BEGIN
  DELETE FROM project_revenue_entries WHERE source_invoice_id = OLD.id;
  RETURN OLD;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'delete_revenue_entry_from_invoice failed (invoice_id=%): %', OLD.id, SQLERRM;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

-- ==================== 案件収支：トリガ ====================

DROP TRIGGER IF EXISTS tr_invoice_items_to_cost ON invoice_items;
CREATE TRIGGER tr_invoice_items_to_cost
  AFTER INSERT OR UPDATE OF invoice_id, total_amount, cost_type, label
  ON invoice_items
  FOR EACH ROW
  EXECUTE FUNCTION sync_cost_entry_from_invoice_item();

DROP TRIGGER IF EXISTS tr_invoice_items_to_cost_del ON invoice_items;
CREATE TRIGGER tr_invoice_items_to_cost_del
  AFTER DELETE
  ON invoice_items
  FOR EACH ROW
  EXECUTE FUNCTION delete_cost_entry_from_invoice_item();

DROP TRIGGER IF EXISTS tr_invoices_to_revenue ON invoices;
CREATE TRIGGER tr_invoices_to_revenue
  AFTER INSERT OR UPDATE OF project_id, total_amount, invoice_type, issued_at
  ON invoices
  FOR EACH ROW
  EXECUTE FUNCTION sync_revenue_entry_from_invoice();

DROP TRIGGER IF EXISTS tr_invoices_to_revenue_del ON invoices;
CREATE TRIGGER tr_invoices_to_revenue_del
  AFTER DELETE
  ON invoices
  FOR EACH ROW
  EXECUTE FUNCTION delete_revenue_entry_from_invoice();

-- ==================== 案件収支：バックフィル ====================

INSERT INTO project_finance_books (project_id)
SELECT p.id
  FROM projects p
 WHERE NOT EXISTS (
   SELECT 1 FROM project_finance_books fb WHERE fb.project_id = p.id
 );

INSERT INTO project_cost_entries (
  project_id, source, source_invoice_item_id, source_invoice_id,
  cost_type, label, amount
)
SELECT
  i.project_id, 'invoice_item', ii.id, ii.invoice_id,
  ii.cost_type, ii.label, COALESCE(ii.total_amount, 0)
  FROM invoice_items ii
  JOIN invoices i ON i.id = ii.invoice_id
 WHERE i.project_id IS NOT NULL
   AND (i.invoice_type IS NULL OR i.invoice_type <> 'client')
   AND NOT EXISTS (
     SELECT 1 FROM project_cost_entries pce
      WHERE pce.source_invoice_item_id = ii.id
   );

INSERT INTO project_revenue_entries (
  project_id, source, source_invoice_id, revenue_type,
  label, amount, occurred_on, client_id
)
SELECT
  i.project_id, 'client_invoice', i.id, 'lump_sum',
  i.invoice_number, COALESCE(i.total_amount, 0),
  COALESCE(i.issued_at::date, CURRENT_DATE), p.client_id
  FROM invoices i
  LEFT JOIN projects p ON p.id = i.project_id
 WHERE i.invoice_type = 'client'
   AND i.project_id IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM project_revenue_entries pre
      WHERE pre.source_invoice_id = i.id
   );

-- ==================== 案件収支 V2: 契約タイプ ====================
-- 詳細: migrations/2026-05-02_project_accounting_v2_contract_type.sql
-- 加算のみ・既存無影響・ロールバック容易（カラム残置で問題なし）
ALTER TABLE project_finance_books
  ADD COLUMN IF NOT EXISTS contract_type TEXT DEFAULT 'fixed'
  CHECK (contract_type IN ('fixed', 'per_unit', 'mixed'));
ALTER TABLE project_finance_books
  ADD COLUMN IF NOT EXISTS planned_unit_count INTEGER;
CREATE INDEX IF NOT EXISTS idx_project_finance_books_contract_type
  ON project_finance_books(contract_type);

-- ==================== 案件収支 Phase A: 見積書フィールド ====================
-- 詳細: migrations/2026-05-02_project_estimates_invoice_like_fields.sql
ALTER TABLE project_estimates ADD COLUMN IF NOT EXISTS issue_date DATE;
ALTER TABLE project_estimates ADD COLUMN IF NOT EXISTS valid_until DATE;
ALTER TABLE project_estimates ADD COLUMN IF NOT EXISTS recipient_name TEXT;
ALTER TABLE project_estimates ADD COLUMN IF NOT EXISTS honorific TEXT DEFAULT '御中'
  CHECK (honorific IS NULL OR honorific IN ('御中', '様', ''));
ALTER TABLE project_estimates ADD COLUMN IF NOT EXISTS estimate_number TEXT;
CREATE INDEX IF NOT EXISTS idx_project_estimates_estimate_number
  ON project_estimates(estimate_number)
  WHERE estimate_number IS NOT NULL;

NOTIFY pgrst, 'reload schema';
