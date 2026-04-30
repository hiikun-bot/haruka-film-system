-- editor / designer に member.list 権限を付与
-- 既存の role_permissions レコードに対して INSERT、既にある場合は allowed=true に UPDATE
--
-- 適用方法: Supabase SQL Editor で実行（冪等）

INSERT INTO role_permissions (role, permission_key, allowed) VALUES
  ('editor', 'member.list', true),
  ('designer', 'member.list', true)
ON CONFLICT (role, permission_key) DO UPDATE SET allowed = EXCLUDED.allowed;

-- アプリ側のキャッシュをリロード（次のリクエストで反映）
NOTIFY pgrst, 'reload schema';
