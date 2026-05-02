-- teams.team_type CHECK 制約を更新し、'secretary'（秘書チーム）を許可する
-- 背景: PR #129 で「秘書」種別をコード側に追加したが、本番DBの teams_team_type_check
--       制約が ('video','design') のみだったため、秘書チーム作成時に
--       "new row for relation \"teams\" violates check constraint \"teams_team_type_check\""
--       が発生していた。本マイグレーションで CHECK を再定義し 'secretary' を許可する。
--
-- 冪等性: DROP CONSTRAINT IF EXISTS で既存制約を落としてから ADD する。
--          既存データが ('video','design','secretary') 以外を含む場合は失敗するため、
--          そのケースは事前に値を確認・修正してから再実行すること。

BEGIN;

ALTER TABLE teams DROP CONSTRAINT IF EXISTS teams_team_type_check;

ALTER TABLE teams
  ADD CONSTRAINT teams_team_type_check
  CHECK (team_type IN ('video', 'design', 'secretary'));

COMMIT;
