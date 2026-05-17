-- Member 請求書フォルダ管理（メンバーマスター画面の「🧾 請求書」セクション用）
--
-- 目的:
--   - 各メンバーの月別 Drive フォルダ ID/URL を DB 側に保持して、画面からワンクリックで開けるようにする
--   - 生成操作の監査ログを残す
--   - 閲覧/生成の権限を role_permissions に登録（ADR 015）
--
-- 関連: scripts/create_invoice_folders.js / routes/haruka.js
-- 関連 ADR: 003 (roles), 015 (view-as)

-- ==================== member_invoice_folders ====================
-- member ごとの月別請求書フォルダ（Drive ID + URL）マッピング
CREATE TABLE IF NOT EXISTS member_invoice_folders (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  year        INT NOT NULL,
  month       INT NOT NULL CHECK (month BETWEEN 1 AND 12),
  folder_id   TEXT NOT NULL,
  folder_url  TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by  UUID REFERENCES users(id),
  UNIQUE (user_id, year, month)
);
CREATE INDEX IF NOT EXISTS idx_member_invoice_folders_user_year
  ON member_invoice_folders(user_id, year);

COMMENT ON TABLE member_invoice_folders IS '各メンバーの月別請求書フォルダ（Drive ID/URL）マッピング';

-- ==================== invoice_folder_audit_log ====================
CREATE TABLE IF NOT EXISTS invoice_folder_audit_log (
  id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  executed_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_by_user_id        UUID REFERENCES users(id),
  command_args               JSONB,
  folders_created_count      INT DEFAULT 0,
  folders_skipped_count      INT DEFAULT 0,
  permissions_granted_count  INT DEFAULT 0,
  permissions_revoked_count  INT DEFAULT 0,
  duration_ms                INT,
  status                     TEXT NOT NULL,
  error_message              TEXT
);
CREATE INDEX IF NOT EXISTS idx_invoice_folder_audit_log_executed_at
  ON invoice_folder_audit_log(executed_at DESC);

COMMENT ON TABLE invoice_folder_audit_log IS '請求書フォルダ生成/権限同期の監査ログ';

-- ==================== role_permissions seed ====================
-- 既存パターン (migrations/2026-05-14_member_working_hours_daily.sql) と同じ
-- (role TEXT, permission_key TEXT, allowed BOOLEAN) で INSERT。
--
-- invoice_folder.view_own       … 自分の請求書フォルダ URL 閲覧
-- invoice_folder.view_any       … 他メンバーの請求書フォルダ URL 閲覧（admin/secretary のみ）
-- invoice_folder.generate_own   … 自分の請求書フォルダ生成
-- invoice_folder.generate_any   … 他メンバーの請求書フォルダ代理生成（admin/secretary のみ）
INSERT INTO role_permissions (role, permission_key, allowed) VALUES
  ('admin',             'invoice_folder.view_own', true),
  ('secretary',         'invoice_folder.view_own', true),
  ('producer',          'invoice_folder.view_own', true),
  ('producer_director', 'invoice_folder.view_own', true),
  ('director',          'invoice_folder.view_own', true),
  ('sub_producer',      'invoice_folder.view_own', true),
  ('sub_director',      'invoice_folder.view_own', true),
  ('editor',            'invoice_folder.view_own', true),
  ('designer',          'invoice_folder.view_own', true),
  ('admin',             'invoice_folder.generate_own', true),
  ('secretary',         'invoice_folder.generate_own', true),
  ('producer',          'invoice_folder.generate_own', true),
  ('producer_director', 'invoice_folder.generate_own', true),
  ('director',          'invoice_folder.generate_own', true),
  ('sub_producer',      'invoice_folder.generate_own', true),
  ('sub_director',      'invoice_folder.generate_own', true),
  ('editor',            'invoice_folder.generate_own', true),
  ('designer',          'invoice_folder.generate_own', true),
  ('admin',             'invoice_folder.view_any', true),
  ('secretary',         'invoice_folder.view_any', true),
  ('admin',             'invoice_folder.generate_any', true),
  ('secretary',         'invoice_folder.generate_any', true)
ON CONFLICT (role, permission_key) DO UPDATE SET allowed = EXCLUDED.allowed;
