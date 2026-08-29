-- 分析・集計（analytics.view）をプロデューサー層に開放
--
-- 目的:
--   - 分析タブの経営系メニュー（月次売上・粗利／クリエイター別作成本数／案件×担当者集計／
--     案件別ファイル名一覧／単価未設定チェッカー）を TAGON さん・川崎さんら
--     プロデューサー権限を持つメンバーにも共有できるようにする
--   - 従来は admin / secretary のみ（2026-05-10d_analytics_bug_reports_permission.sql 時点の想定）
--
-- 対象ロール: producer / producer_director（合成値。#1052 以降「兼任者のみ」に適用される TEXT 行。
--   兼任者は producer 行からも継承されるが、権限マトリクス UI の PD 列表示を実態と揃えるため明示 seed）
-- director 単独・editor / designer / external_director は据え置き（経営数値のため非開放）。
--
-- ADR 003（roles-as-master-data）/ ADR 015（VIEW AS チェックリスト）準拠。

INSERT INTO role_permissions (role, permission_key, allowed) VALUES
  ('producer',          'analytics.view', true),
  ('producer_director', 'analytics.view', true)
ON CONFLICT (role, permission_key) DO UPDATE SET allowed = EXCLUDED.allowed;

-- role_id の dual-write（ADR 003）: roles マスタに存在するロールへ role_id を補完
UPDATE role_permissions rp
   SET role_id = r.id
  FROM roles r
 WHERE rp.permission_key = 'analytics.view'
   AND rp.role = r.code
   AND rp.role_id IS NULL;
