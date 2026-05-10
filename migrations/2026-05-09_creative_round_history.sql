-- ADR 011: クリエイティブ「ラウンド比較型UI」のための履歴正規化
--
-- 既存の creative_version_history テーブルは存在するがフロント側が _DISABLED で
-- 書き込み・読み取りされていなかった。
-- ラウンド比較UIで「過去の指摘＋編集者の提出時連絡」をペアで保持するため、
-- 4列追加 + 1 index 追加。既存行 NULL 許容（既存スキーマとの互換確保）。
--
-- 副作用なし、既存データに影響なし、ALTER ADD COLUMN IF NOT EXISTS のみ。

-- 1) editor_comment: そのラウンドで編集者が出した「提出時メモ／連絡事項」のスナップショット
ALTER TABLE creative_version_history
  ADD COLUMN IF NOT EXISTS editor_comment TEXT;

-- 2) round_stage: D / P / CL のどのチェックラウンドかを区別
--    'd_check' | 'p_check' | 'cl_check' のいずれか（NULL は旧データ互換）
ALTER TABLE creative_version_history
  ADD COLUMN IF NOT EXISTS round_stage TEXT;

-- 3) creative_file_id: そのラウンドの「提出ファイル」を確定保存
--    ON DELETE SET NULL: ファイル削除時も履歴メタは残す
ALTER TABLE creative_version_history
  ADD COLUMN IF NOT EXISTS creative_file_id UUID
  REFERENCES creative_files(id) ON DELETE SET NULL;

-- 4) recorded_by: ラウンドを確定した actor（再提出ボタンを押した人）
ALTER TABLE creative_version_history
  ADD COLUMN IF NOT EXISTS recorded_by UUID
  REFERENCES users(id);

-- 検索用インデックス: クリエイティブ単位 + version_num 順で取得することが多い
CREATE INDEX IF NOT EXISTS idx_cvh_creative_round
  ON creative_version_history(creative_id, version_num);
