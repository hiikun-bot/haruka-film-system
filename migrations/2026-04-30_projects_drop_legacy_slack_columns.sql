-- 旧式 Slack 列の削除 (slack_channel_url に統一済み)
-- 注: ON DELETE 動作はしない (FK の解除のみ)、本番データ確認済の前提で実行
-- 適用: Supabase SQL Editor で Run

ALTER TABLE projects DROP COLUMN IF EXISTS slack_team_id;
ALTER TABLE projects DROP COLUMN IF EXISTS slack_channel_id;
ALTER TABLE projects DROP COLUMN IF EXISTS slack_workspace_id;

NOTIFY pgrst, 'reload schema';
