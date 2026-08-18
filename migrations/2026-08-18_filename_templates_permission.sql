-- 2026-08-18 ファイル名テンプレート管理をディレクター層以上に開放する
--
-- 背景:
--   設定タブ「📁 ファイル名テンプレート」（ADR 007 Stage 1）の作成・編集・削除は
--   これまで master.page（マスター管理ページ権限。既定: admin/secretary）が必要で、
--   実際に案件の命名規約を決めるディレクター/プロデューサーが自分でテンプレを整備できなかった。
--   新 permission_key 'master.filename_templates' で制御する方式に変更し、ディレクター層以上に開放する。
--   以後は設定タブの権限管理画面（ROLE_PERM_LIST に master.filename_templates を追加済み）で admin が ON/OFF できる。
--
-- 既定の許可ロール:
--   admin / secretary / producer / director
--   ・producer兼director（合成ロール）は producer / director 行の継承で許可される。
--   ・editor / designer は既定 OFF（必要になれば権限管理画面から ON にできる）。
--
-- ⚠️ producer_director 行は意図的に seed しない（creative.wcheck_toggle と同じ理由）。
--    dual-read 互換分岐の副作用を避け、継承（producer / director 行）でカバーする。
--
-- コード側は「master.page または master.filename_templates」の OR 判定のため、
-- この migration が未適用でも従来の権限保持者（admin/秘書）は操作できる（挙動後退なし）。

INSERT INTO role_permissions (role, permission_key, allowed) VALUES
  ('admin',     'master.filename_templates', true),
  ('secretary', 'master.filename_templates', true),
  ('producer',  'master.filename_templates', true),
  ('director',  'master.filename_templates', true)
ON CONFLICT (role, permission_key) DO NOTHING;
