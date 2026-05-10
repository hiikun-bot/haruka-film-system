-- クライアントごとの Slack チャンネル URL と Chatwork ルーム ID を保持
ALTER TABLE clients ADD COLUMN IF NOT EXISTS slack_channel_url TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS chatwork_room_id TEXT;
NOTIFY pgrst, 'reload schema';
