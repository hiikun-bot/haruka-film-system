-- =====================================================================
-- creative_version_history(creative_id) 追加インデックス
-- 想定クエリ:
--   SELECT * FROM creative_version_history
--   WHERE creative_id = ?
--   ORDER BY version_num ASC, created_at ASC
--
-- 用途:
--   - GET /api/creatives/:id/rounds（クリエイティブ詳細モーダル「ラウンド比較UI」）
--   - POST /api/creatives/:id/upload 内のスナップショット存在判定
--
-- 現状 supabase_schema.sql / 既存 migration には creative_id 単独 / 複合の
-- インデックスが無く、クリエイティブ件数が増えると Seq Scan になる可能性が
-- あったため明示的に追加。詳細モーダルの体感速度に影響する。
-- =====================================================================

CREATE INDEX IF NOT EXISTS idx_creative_version_history_creative_version
  ON creative_version_history (creative_id, version_num);

NOTIFY pgrst, 'reload schema';
