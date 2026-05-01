-- 案件削除 / チーム削除のデフォルト権限を付与
-- 秘書・プロデューサー・PD に追加（管理者はコード側でバイパスされるため不要）
--
-- 適用方法:
--   1) Supabase ダッシュボード → SQL Editor を開く
--   2) このファイル全文を貼り付けて Run
--   (db/migrate.js の自動同期が走っていれば不要)

INSERT INTO role_permissions (role, permission_key, allowed) VALUES
  ('secretary',         'project.delete', true),
  ('producer',          'project.delete', true),
  ('producer_director', 'project.delete', true),
  ('secretary',         'team.delete',    true),
  ('producer',          'team.delete',    true),
  ('producer_director', 'team.delete',    true)
ON CONFLICT (role, permission_key) DO NOTHING;
