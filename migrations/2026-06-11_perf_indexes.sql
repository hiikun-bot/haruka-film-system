-- =====================================================================
-- パフォーマンス用インデックス追加（頻出クエリの未インデックス列）
--
-- routes/haruka.js / routes/accounting.js の実クエリを調査し、
-- order / eq / gte-lt で頻繁に使われるのに supabase_schema.sql・
-- 既存 migration のどちらにもインデックスが無い列のみを対象にした。
--
-- 1) projects(created_at DESC)
--    想定クエリ:
--      SELECT * FROM projects ORDER BY created_at DESC;
--    用途:
--      - GET /api/projects（トップの案件一覧。routes/haruka.js:663-671）
--      - 経理側の案件一覧（routes/accounting.js:107-111）
--    最も叩かれる一覧 API のソート列なのに index が無かった。
--
-- 2) projects(client_id)
--    想定クエリ:
--      SELECT id FROM projects WHERE client_id = ?;
--    用途:
--      - クライアント納品実績 / 削除前チェック（routes/haruka.js:12395, 12438）
--      - クライアント詳細の案件参照（routes/haruka.js:13898, 13913）
--    FK だが index 未作成で、クライアント単位の参照が Seq Scan になっていた。
--
-- 3) project_cycles(project_id, year DESC, month DESC)
--    想定クエリ:
--      SELECT * FROM project_cycles WHERE project_id = ?
--      ORDER BY year DESC, month DESC;
--    用途:
--      - GET /api/projects/:id/cycles（routes/haruka.js:1319-1323）
--    FK index 無し。フィルタ＋ソートを 1 本で賄う複合にした。
--
-- 4) creatives(created_at)
--    想定クエリ:
--      SELECT ... FROM creatives
--      WHERE created_at >= ? AND created_at < ?;  -- 月初〜翌月初
--    用途:
--      - クリエイター実績サマリー集計（routes/haruka.js:4838-4849。
--        statusFilter が delivered 以外のとき created_at で月範囲を切る）
--    final_deadline 側は idx_creatives_final_deadline で索引済みだが
--    created_at 側は未索引だった。
--
-- 5) users(created_at)
--    想定クエリ:
--      SELECT * FROM users ORDER BY created_at ASC;
--    用途:
--      - 管理系のユーザー一覧（routes/haruka.js:9420）
--    小さめのテーブルだがソート省略に効き、維持コストはほぼゼロ。
--
-- 6) clients(created_at DESC)
--    想定クエリ:
--      SELECT * FROM clients ORDER BY created_at DESC;
--    用途:
--      - GET /api/clients（クライアント一覧。routes/haruka.js:391-402）
--    users と同じくソート省略目的。
--
-- 対象外にしたもの（重複・カバー済みのため）:
--   - creative_files.uploaded_at: 実クエリはすべて creative_id /
--     drive_file_id で絞っており、既存の
--     idx_creative_files_creative_id (creative_id, uploaded_at DESC) と
--     idx_creative_files_drive_file_id でカバー済み。単独 index は重複。
--   - project_tasks / bug_reports / creative_edit_logs /
--     notification_logs: 既存 migration で索引済み。
--   - user_activity_logs: コードから参照されるがリポジトリの
--     スキーマ管理外（手動作成テーブル）のため本 migration では触らない。
-- =====================================================================

CREATE INDEX IF NOT EXISTS idx_projects_created_at
  ON projects (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_projects_client_id
  ON projects (client_id);

CREATE INDEX IF NOT EXISTS idx_project_cycles_project_year_month
  ON project_cycles (project_id, year DESC, month DESC);

CREATE INDEX IF NOT EXISTS idx_creatives_created_at
  ON creatives (created_at);

CREATE INDEX IF NOT EXISTS idx_users_created_at
  ON users (created_at);

CREATE INDEX IF NOT EXISTS idx_clients_created_at
  ON clients (created_at DESC);

NOTIFY pgrst, 'reload schema';
