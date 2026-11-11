-- メンバー一覧の「メール列の閲覧のみ」権限（member.view_email）を新設し、director に開放
--
-- 目的:
--   - director 単独のメンバーが、メンバー一覧（一覧表示）でメールアドレスを見て
--     コピーできるようにする（Drive 共有・連絡先の転記のため）
--   - 従来は member.edit_password（admin / secretary / producer_director）が必要だったが、
--     このキーは メンバーの追加・編集 / PW リセット / 個人情報・口座の閲覧 まで開いてしまうため、
--     director 全体には過剰。メール列の表示だけを切り出した限定キーを新設する
--     （project.create / project.notification_edit と同じ切り出しパターン）
--
-- 新 permission_key: member.view_email
--   - フロント: renderMemberTable の showEmailCol
--     （hasPermission('member.edit_password') || hasPermission('member.view_email')）
--   - API の変更なし（GET /members は従来から member.list 保持者へ email を返している）
--   - 既にメール列が見えているロール（admin / secretary / producer_director）は true で seed し、
--     見え方を変えない。producer 単独・editor・designer・external_director は従来どおり非表示
--
-- ADR 003（roles-as-master-data）/ ADR 015（VIEW AS チェックリスト）準拠。

INSERT INTO role_permissions (role, permission_key, allowed) VALUES
  ('admin',             'member.view_email', true),
  ('secretary',         'member.view_email', true),
  ('producer',          'member.view_email', false),
  ('producer_director', 'member.view_email', true),
  ('director',          'member.view_email', true),
  ('editor',            'member.view_email', false),
  ('designer',          'member.view_email', false),
  ('external_director', 'member.view_email', false)
ON CONFLICT (role, permission_key) DO UPDATE SET allowed = EXCLUDED.allowed;

-- role_id の dual-write（ADR 003）: roles マスタに存在するロールへ role_id を補完
UPDATE role_permissions rp
SET role_id = r.id
FROM roles r
WHERE rp.permission_key = 'member.view_email'
  AND rp.role_id IS NULL
  AND r.code = rp.role;
