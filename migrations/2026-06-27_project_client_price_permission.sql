-- 2026-06-27 クライアント単価（client_unit_price）の閲覧・編集権限を permission_key 化する
--
-- 背景:
--   これまでクライアント単価は admin 固定（フロント isTopAdmin / バック codes.includes('admin')）だった。
--   プロデューサー層・プロデューサー兼ディレクター・秘書にも開放したいという要望を受け、
--   新 permission_key 'project.client_price' で制御する方式に変更する。
--   以後は設定タブの権限管理画面（ROLE_PERM_LIST に project.client_price を追加）で admin が ON/OFF できる。
--
-- 既定の許可ロール:
--   admin / producer / secretary
--   ・producer兼director（producer + director を両方持つ合成ロール）は producer 行で継承され許可される。
--   ・director単独は対象外。
--
-- ⚠️ producer_director 行・director 行は意図的に seed しない。
--    utils/roles.js#roleCodesHavePermission には「producer または director を持つユーザーは
--    producer_director|key が true なら許可」という dual-read 互換分岐があり、producer_director 行を
--    作ると director単独にも漏れてしまうため。フロント hasPermission 側は producer_director を
--    producer/director の継承として解決するので、producer 行だけで兼任ロールはカバーされる。

INSERT INTO role_permissions (role, permission_key, allowed) VALUES
  ('admin',     'project.client_price', true),
  ('producer',  'project.client_price', true),
  ('secretary', 'project.client_price', true)
ON CONFLICT (role, permission_key) DO NOTHING;
