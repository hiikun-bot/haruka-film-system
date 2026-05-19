-- 素材スクエア（video_file_organization_tests）のプレビュー生成中に
-- フロント側で「もう少しで終わる」進捗バーを出せるようにするため、
-- 進捗率（0-100）をリアルタイム保存する列を追加する。
--
-- 用途:
--   - lib/faststart.js の generatePreviewForVideoOrg がフレーム抽出ループ中に
--     `progress = floor(currentFrame / 60 * 100)` を 5フレーム置きに UPDATE
--   - フロント (public/haruka.html) は preview_status='pending'|'processing' の行に
--     `<progress value={this} max=100>` を描画
--   - preview_status='done'|'failed'|'skipped' になったら NULL に戻す（インジケータ撤去）
--
-- Stage 1: 列追加のみ。既存ロジック影響なし。後続コード PR で参照・更新を実装する。

ALTER TABLE video_file_organization_tests
  ADD COLUMN IF NOT EXISTS preview_progress_percent SMALLINT
    CHECK (preview_progress_percent IS NULL OR (preview_progress_percent >= 0 AND preview_progress_percent <= 100));

COMMENT ON COLUMN video_file_organization_tests.preview_progress_percent IS
  'プレビュー生成中の進捗率（0-100）。preview_status=processing の間に更新される。完了/失敗/未開始は NULL。';
