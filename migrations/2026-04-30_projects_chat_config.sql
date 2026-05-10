-- 案件ごとの Slack チャンネル URL と Chatwork ルーム ID を保持
-- クリエイティブ進捗通知の送信先について、案件レベルで設定されていれば
-- クライアント設定（clients.slack_channel_url / clients.chatwork_room_id）より優先する。
--
-- 注意: projects.chatwork_room_id は既存列のため IF NOT EXISTS により no-op になる。
-- 既存値はそのまま再利用される（互換維持）。新規に slack_channel_url のみが追加される。
ALTER TABLE projects ADD COLUMN IF NOT EXISTS slack_channel_url TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS chatwork_room_id TEXT;
NOTIFY pgrst, 'reload schema';
