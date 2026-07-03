-- 2026-07-03 Wチェック要否のクリエイティブ個別設定を permission_key 化する（バグ報告 892c2fea）
--
-- 背景:
--   クリエイティブ詳細の「このクリエイティブでWチェックを行う」トグル（ADR 024）は
--   これまで project.create_edit（案件作成・編集権限）が必要で、実際に制作・チェックを行う
--   デザイナー / ディレクターが Wチェック不要なクリエイティブを Dチェックへ直行させられなかった。
--   新 permission_key 'creative.wcheck_toggle' で制御する方式に変更し、デザイナー / ディレクターにも開放する。
--   以後は設定タブの権限管理画面（ROLE_PERM_LIST に creative.wcheck_toggle を追加済み）で admin が ON/OFF できる。
--
-- 既定の許可ロール:
--   admin / secretary / producer / director / designer
--   ・producer兼director（合成ロール）は producer / director 行の継承で許可される。
--   ・editor は既定 OFF（必要になれば権限管理画面から ON にできる）。
--
-- ⚠️ producer_director 行は意図的に seed しない（project.client_price と同じ理由）。
--    dual-read 互換分岐の副作用を避け、継承（producer / director 行）でカバーする。
--
-- コード側は「creative.wcheck_toggle または project.create_edit」の OR 判定のため、
-- この migration が未適用でも従来の権限保持者（admin/秘書/プロデューサー）は操作できる（挙動後退なし）。

INSERT INTO role_permissions (role, permission_key, allowed) VALUES
  ('admin',     'creative.wcheck_toggle', true),
  ('secretary', 'creative.wcheck_toggle', true),
  ('producer',  'creative.wcheck_toggle', true),
  ('director',  'creative.wcheck_toggle', true),
  ('designer',  'creative.wcheck_toggle', true)
ON CONFLICT (role, permission_key) DO NOTHING;
