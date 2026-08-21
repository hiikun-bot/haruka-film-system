-- 📊 チーム状況（チーム負荷ダッシュボード）ページの閲覧権限
--
-- 目的:
--   - メンバーごとの実務負荷（進行中クリエイティブ数・持ちボール数・今週期限数・期限超過数）を
--     実データの自動集計で一覧できる「📊 チーム状況」ページを新設する
--   - 負荷の把握は「仕事を配る責任者」（admin + プロデューサー層）の業務であり、
--     メンバー全員に開放するとメンバー同士の比較・詮索につながるため、
--     閲覧は admin + producer / producer_director（兼任者）のみに限定する
--   - 自己申告ベースの個人目標管理ツールとは完全分離し、あくまで実務データの集計として扱う
--
-- 新 permission_key: team_load.page
--   - 対応 API: GET /api/haruka/team-load（サーバー側一括集計）
--   - フロント: ヘッダーナビ / モバイルドロワーの「📊 チーム状況」ボタン + #page-team-load
--
-- ADR 003（roles-as-master-data）/ ADR 015（VIEW AS チェックリスト）/ ADR 033 準拠。
-- producer_director 行は #1052 以降「兼任者のみ」に適用される合成値 TEXT 行
-- （utils/roles.js#roleCodesHavePermission の dual-read 分岐: producer と director の
--  両方を持つユーザーだけに適用される。director 単独には漏れない）。
-- 兼任者は producer 行からも継承されるが、権限マトリクス UI の PD 列表示を
-- 実態と揃えるため明示的に seed する。

INSERT INTO role_permissions (role, permission_key, allowed) VALUES
  ('admin',             'team_load.page', true),
  ('secretary',         'team_load.page', false),
  ('producer',          'team_load.page', true),
  ('producer_director', 'team_load.page', true),
  ('director',          'team_load.page', false),
  ('editor',            'team_load.page', false),
  ('designer',          'team_load.page', false),
  ('external_director', 'team_load.page', false)
ON CONFLICT (role, permission_key) DO UPDATE SET allowed = EXCLUDED.allowed;
