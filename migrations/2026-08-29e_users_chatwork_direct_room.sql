-- 💸 振込管理: Chatwork 個別チャット（DMルーム）IDを users マスターに追加
--
-- 背景・目的:
--   - 振込完了通知は従来【HF】全体チャットへ [To:account_id] 付きで送っていたが、
--     Chatwork でつながっているメンバーには個別チャット（ダイレクトチャット）に届けたい。
--   - Chatwork の DM ルーム ID（例: chatwork.com/#!rid369056512 の 369056512）は
--     「二者間のルーム自体の ID」で、どちらから見ても同一。ただし API 送信には
--     そのルームの参加者（CHATWORK_API_TOKEN の名義人）である必要がある。
--   - 手入力を避けるため、POST /api/haruka/admin/payouts/chatwork-sync が
--     GET /rooms（type=direct）→ /rooms/:id/members で相手 account_id を取得し、
--     users.chatwork_dm_id（アカウントID）と突合してこの列を自動更新する。
--
-- 振込完了通知の送信先優先順: chatwork_direct_room_id（DM）→ 全体チャット+[To:]（従来）。
-- 冪等: ADD COLUMN IF NOT EXISTS。

ALTER TABLE users ADD COLUMN IF NOT EXISTS chatwork_direct_room_id TEXT;

COMMENT ON COLUMN users.chatwork_direct_room_id IS 'Chatwork ダイレクトチャットのルームID（振込通知等のDM送信先。chatwork-sync で自動取得）';
