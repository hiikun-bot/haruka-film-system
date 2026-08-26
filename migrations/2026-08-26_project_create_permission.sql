-- 案件・クライアントの「新規作成のみ」権限（project.create）を新設し、director に開放
--
-- 目的:
--   - director 単独のメンバー（例: 片山さん）が自分の担当案件・新規クライアントを
--     自分で登録できるようにする
--   - 従来は project.create_edit（admin/secretary/producer/producer_director）が必要だったが、
--     このキーは新規作成のほかに 既存案件・クライアントの編集 / 成果物グループの支払単価
--     （line_costs）/ D費 / 分割請求 / 固定費目 の編集まで開いてしまうため、
--     director 全体には過剰。作成だけを切り出した限定キーを新設する
--     （#1054 project.notification_edit と同じ切り出しパターン）
--
-- 新 permission_key: project.create
--   - 対応 API: POST /api/haruka/clients ・ POST /api/haruka/projects
--     （requireAnyPermission('project.create_edit','project.create')。
--       PUT 系・単価・D費・分割請求・固定費目・シート同期は従来どおり project.create_edit のみ）
--   - フロント: 「＋ クライアント追加」「＋ 案件追加」ボタンを canCreateProject() で表示。
--     時間給カテゴリの時給入力行は create_edit 保持者のみ（director-fee API が create_edit ガードのため）
--
-- ADR 003（roles-as-master-data）/ ADR 015（VIEW AS チェックリスト）準拠。
-- producer_director 行は #1052 以降「兼任者のみ」に適用される合成値 TEXT 行。
-- 兼任者は producer / director 行からも継承されるが、権限マトリクス UI の PD 列
-- 表示を実態と揃えるため明示的に seed する。

INSERT INTO role_permissions (role, permission_key, allowed) VALUES
  ('admin',             'project.create', true),
  ('secretary',         'project.create', true),
  ('producer',          'project.create', true),
  ('producer_director', 'project.create', true),
  ('director',          'project.create', true),
  ('editor',            'project.create', false),
  ('designer',          'project.create', false),
  ('external_director', 'project.create', false)
ON CONFLICT (role, permission_key) DO UPDATE SET allowed = EXCLUDED.allowed;

-- role_id の dual-write（ADR 003）: roles マスタに存在するロールへ role_id を補完
UPDATE role_permissions rp
SET role_id = r.id
FROM roles r
WHERE rp.permission_key = 'project.create'
  AND rp.role_id IS NULL
  AND r.code = rp.role;
