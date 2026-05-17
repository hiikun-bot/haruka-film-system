-- 外部ディレクター案件 Phase 1: スキーマ追加（ADR 017）
--
-- 目的:
--   - GND 等の代理店経由スポット案件で、HARUKA外部のディレクターを
--     擬似ユーザーとして扱えるようにする
--   - HARUKA側で督促・代理操作を行う「窓口担当」を案件に紐付ける
--   - 外部D用のロール 'external_director' を roles マスタに追加
--
-- 関連 ADR: docs/design/decisions/017-external-director-projects.md
-- 関連 spec: docs/external-director-intake-workflow.md
--
-- 後続:
--   - UI 実装 (案件編集モーダルの「外部ディレクター案件」トグル、MemberPicker 拡張)
--   - 通知ルーティングの宛先振替 (ball_holder が is_external なら liaison へ)
--   - 採算・工数集計から is_external=true ユーザー除外
--
-- いずれも本 migration 適用後の別 PR で対応する (Stage 分割厳守)。

-- ==================== users: 外部ユーザーフラグ ====================
-- ログインしない・通知も飛ばない「擬似ユーザー」を識別する
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_external      BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS external_company TEXT;

COMMENT ON COLUMN users.is_external      IS 'true: 外部関係者の擬似ユーザー。ログイン不可・通知対象外・採算集計から除外。ADR 017';
COMMENT ON COLUMN users.external_company IS '外部ユーザーの所属（例: GND）。is_external=true のときのみ意味を持つ。ADR 017';

CREATE INDEX IF NOT EXISTS idx_users_is_external
  ON users(is_external)
  WHERE is_external = TRUE;

-- ==================== projects: 窓口担当 ====================
-- 外部D案件で、外部Dの代わりに督促・代理操作を担うHARUKA側1名
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS liaison_user_id UUID REFERENCES users(id) ON DELETE SET NULL;

COMMENT ON COLUMN projects.liaison_user_id IS '外部D案件の窓口担当（HARUKA側1名）。督促通知の振替先・代理操作の主体。内部D案件では NULL。ADR 017';

CREATE INDEX IF NOT EXISTS idx_projects_liaison_user_id
  ON projects(liaison_user_id)
  WHERE liaison_user_id IS NOT NULL;

-- ==================== roles: external_director を追加 ====================
-- ADR 003 (roles-as-master-data) 準拠
INSERT INTO roles (code, label, category, sort_order, is_creator, is_internal) VALUES
  ('external_director', '外部ディレクター', 'external', 90, FALSE, FALSE)
ON CONFLICT (code) DO NOTHING;

-- ==================== role_permissions: external_director 用シード ====================
-- 外部D本人はログインしないため、ログイン後に必要な権限は付与しない
-- 既存ロール群との並びを揃え、明示的に「許可なし」を入れることで
-- DB 駆動権限チェックで silent fallthrough を防ぐ
INSERT INTO role_permissions (role, permission_key, allowed) VALUES
  ('external_director', 'project.create_edit',     false),
  ('external_director', 'project.unit_price_view', false),
  ('external_director', 'project.fee_view',        false),
  ('external_director', 'creative.all_projects_view', false),
  ('external_director', 'invoice_folder.view_own',    false),
  ('external_director', 'invoice_folder.generate_own', false)
ON CONFLICT (role, permission_key) DO UPDATE SET allowed = EXCLUDED.allowed;
