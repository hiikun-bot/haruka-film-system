-- 分析メニュー: 請求突合チェッカー（経理向け）の閲覧権限を新設
--
-- 目的:
--   - 毎月手作業で行っている「請求書管理（INVタブ / invoices+invoice_items）と
--     実制作データ（creatives＋line_costs の per-unit 集計）の突合」を画面化する
--     （分析タブ 新ビュー billing-recon / GET /api/haruka/analytics/billing-recon）
--   - 請求金額・クライアント別売上という機微情報を扱うため、既存の analytics.view
--     （経営系・admin/secretary）と同じ範囲 = admin / secretary のみに開放する
--
-- 新 permission_key: analytics.billing_recon.view
--   - 対応 API: GET /api/haruka/analytics/billing-recon
--               POST /api/haruka/analytics/billing-recon/export-sheet
--   - フロント: 分析タブ サイドバー「経理」セクション（data-an-perm 出し分け）
--
-- ADR 003（roles-as-master-data）/ ADR 015（VIEW AS チェックリスト）準拠。
-- producer_director 行は #1052 以降「兼任者のみ」に適用される合成値 TEXT 行。

INSERT INTO role_permissions (role, permission_key, allowed) VALUES
  ('admin',             'analytics.billing_recon.view', true),
  ('secretary',         'analytics.billing_recon.view', true),
  ('producer',          'analytics.billing_recon.view', false),
  ('producer_director', 'analytics.billing_recon.view', false),
  ('director',          'analytics.billing_recon.view', false),
  ('editor',            'analytics.billing_recon.view', false),
  ('designer',          'analytics.billing_recon.view', false),
  ('external_director', 'analytics.billing_recon.view', false)
ON CONFLICT (role, permission_key) DO UPDATE SET allowed = EXCLUDED.allowed;

-- role_id の dual-write（ADR 003）: roles マスタに存在するロールへ role_id を補完
UPDATE role_permissions rp
SET role_id = r.id
FROM roles r
WHERE rp.permission_key = 'analytics.billing_recon.view'
  AND rp.role_id IS NULL
  AND r.code = rp.role;
