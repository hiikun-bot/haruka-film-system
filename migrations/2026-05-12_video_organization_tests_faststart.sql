-- 素材広場 (video_file_organization_tests) で faststart プレビュー版を持てるようにする。
-- クリエイティブ詳細モーダル (Frame.io風) の creative_files.faststart_* と同じ運用に揃える。
--
-- 用途:
--   - アップロード直後に fire-and-forget で ffmpeg → H.264+AAC+faststart 版を Drive に生成
--   - プレビュー配信エンドポイントは faststart_drive_file_id があればそれを優先配信
--   - H.265 / HEVC / ProRes 等のブラウザ非対応コーデックでも Web で再生可能になる
--
-- Stage 1: 列追加のみ（既存ロジック影響なし）
-- Stage 2: コード側で参照・更新（別 PR）

ALTER TABLE video_file_organization_tests
  ADD COLUMN IF NOT EXISTS faststart_drive_file_id TEXT,
  ADD COLUMN IF NOT EXISTS faststart_drive_url     TEXT,
  ADD COLUMN IF NOT EXISTS faststart_file_size     BIGINT,
  ADD COLUMN IF NOT EXISTS faststart_status        TEXT
    CHECK (faststart_status IS NULL OR faststart_status IN (
      'pending', 'processing', 'done', 'failed', 'skipped'
    )),
  ADD COLUMN IF NOT EXISTS faststart_processed_at  TIMESTAMPTZ;

COMMENT ON COLUMN video_file_organization_tests.faststart_drive_file_id IS
  'ffmpeg で生成した H.264+AAC+faststart 版 mp4 の Drive file id。NULL なら原本を直接プレビューする。';
COMMENT ON COLUMN video_file_organization_tests.faststart_status IS
  'pending=未着手 / processing=生成中 / done=完了 / failed=失敗 / skipped=対象外（画像/動画候補外）';

-- 未処理行を bulk で処理するワーカ用 index（faststart_status IS NULL の行を取りに行く）
CREATE INDEX IF NOT EXISTS idx_vfot_faststart_status
  ON video_file_organization_tests(faststart_status)
  WHERE faststart_status IS NULL OR faststart_status IN ('pending', 'failed');
