-- 通知連携先（Slack / Chatwork）の設定権限をディレクター以上に開放
--
-- 目的:
--   - 案件・クライアントの通知連携先（slack_channel_url / chatwork_room_id）を
--     director ロールでも閲覧・編集できるようにする
--   - 従来は project.create_edit（admin/secretary/producer/producer_director）が必要で、
--     director は案件編集モーダル自体を開けず通知先を確認・変更できなかった
--
-- 新 permission_key: project.notification_edit
--   - 対応 API: PATCH /api/haruka/projects/:id/notification
--               PATCH /api/haruka/clients/:id/notification
--     （通知連携先 2 フィールドのみの限定更新。案件編集全体は従来どおり project.create_edit）
--   - フロント: 案件タブの各行 /クライアントブロックの「🔔 通知」ボタン
--     （project.create_edit 保持者は従来の編集モーダルを使うためボタン非表示）
--
-- ADR 003（roles-as-master-data）/ ADR 015（VIEW AS チェックリスト）準拠。
-- producer_director 行は #1052 以降「兼任者のみ」に適用される合成値 TEXT 行。
-- 兼任者は producer / director 行からも継承されるが、権限マトリクス UI の PD 列
-- 表示を実態と揃えるため明示的に seed する。

INSERT INTO role_permissions (role, permission_key, allowed) VALUES
  ('admin',             'project.notification_edit', true),
  ('secretary',         'project.notification_edit', true),
  ('producer',          'project.notification_edit', true),
  ('producer_director', 'project.notification_edit', true),
  ('director',          'project.notification_edit', true),
  ('editor',            'project.notification_edit', false),
  ('designer',          'project.notification_edit', false),
  ('external_director', 'project.notification_edit', false)
ON CONFLICT (role, permission_key) DO UPDATE SET allowed = EXCLUDED.allowed;
