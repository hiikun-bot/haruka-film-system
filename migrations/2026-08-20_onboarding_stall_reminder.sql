-- 2026-08-20 オンボーディング停滞催促（相手待ちタスクのN日停滞で自動リマインド）
--
-- workers/onboarding-stall-reminder.js が「最後に催促した日時」を記録するための列。
-- 催促間隔（既定3日）ごとの再送判定に使う。
--
-- 本番Supabaseへの適用が必要。

ALTER TABLE onboarding_records ADD COLUMN IF NOT EXISTS last_reminded_at TIMESTAMPTZ;

-- PostgREST のスキーマキャッシュをリロード
NOTIFY pgrst, 'reload schema';
