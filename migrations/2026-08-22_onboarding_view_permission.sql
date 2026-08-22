-- 2026-08-22 オンボーディング参照権限（onboarding.view）
--
-- 背景:
--   オンボーディング管理（onboarding.page = admin/secretary）を、プロデューサー・
--   プロデューサー兼ディレクターも「参照のみ」できるようにする。
--   書き込み（作成・タスクチェック・ステータス変更・紐付け・削除）は従来どおり
--   onboarding.page 側の権限が必要。
--
-- seed:
--   ・producer 行 … producer 単独ロール＋兼任者（合成 producer_director は producer を継承）
--   ・producer_director 行 … 兼任者のみに適用される合成 TEXT 行（#1052 以降の挙動）。
--     権限マトリクスの PD 列表示と整合させるため明示的に入れる。
--     director 単独には付与されない（roleCodesHavePermission が兼任時のみ適用するため）。
--
-- 本番Supabaseへの適用が必要。

INSERT INTO role_permissions (role, permission_key, allowed) VALUES
  ('producer',          'onboarding.view', true),
  ('producer_director', 'onboarding.view', true)
ON CONFLICT (role, permission_key) DO NOTHING;
