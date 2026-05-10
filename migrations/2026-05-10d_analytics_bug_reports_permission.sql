-- 分析メニュー: バグ報告件数のみ全ロール開放
-- 既存の analytics.view は admin / secretary 限定のまま据え置き、
-- バグ報告件数だけ別キー analytics.bug_reports.view を新設して全ロールに付与する。
-- 将来 経営情報など他のサブメニューが増える際は analytics.view 側で制御を継続する想定。

INSERT INTO role_permissions (role, permission_key, allowed) VALUES
  ('admin',             'analytics.bug_reports.view', true),
  ('secretary',         'analytics.bug_reports.view', true),
  ('producer',          'analytics.bug_reports.view', true),
  ('producer_director', 'analytics.bug_reports.view', true),
  ('director',          'analytics.bug_reports.view', true),
  ('editor',            'analytics.bug_reports.view', true),
  ('designer',          'analytics.bug_reports.view', true)
ON CONFLICT (role, permission_key) DO UPDATE SET allowed = EXCLUDED.allowed;

-- role_id バックフィル（ADR 003 dual-write 期間の整合性確保）
UPDATE role_permissions rp
   SET role_id = r.id
  FROM roles r
 WHERE rp.permission_key = 'analytics.bug_reports.view'
   AND rp.role = r.code
   AND rp.role_id IS NULL;
