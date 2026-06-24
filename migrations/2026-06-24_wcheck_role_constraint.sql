-- creative_assignments.role の CHECK 制約に 'wcheck' を許可（ADR 024 / バグ報告 aa11784a）
--
-- 根本原因: 本番DBの creative_assignments には repo の migration/schema に無い CHECK 制約
--   creative_assignments_role_check が直接追加されており、これが 'wcheck' を許可していなかった。
--   そのため Wチェック担当者の INSERT が「violates check constraint creative_assignments_role_check」で
--   無音で弾かれ（コード側は warn のみで握りつぶし）、担当者がまったく保存されていなかった。
--   診断ログで insErr=...role_check として確定。
--
-- 修正: 制約を作り直し、アプリが実際に使う role を全て許可する（既存データは editor / director のみで、
--   いずれも新集合に含まれるため安全）。'wcheck' を追加して Wチェック担当者を保存できるようにする。
--
-- 冪等: DROP IF EXISTS してから ADD。再実行可。

ALTER TABLE creative_assignments
  DROP CONSTRAINT IF EXISTS creative_assignments_role_check;

ALTER TABLE creative_assignments
  ADD CONSTRAINT creative_assignments_role_check
  CHECK (role IN ('editor','designer','director_as_editor','director','producer','wcheck'));
