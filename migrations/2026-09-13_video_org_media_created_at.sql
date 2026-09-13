-- 素材広場: 撮影日時（メディア内の creation_time）を保持する列を追加（ADR 039 D4）
--
-- 背景: 振り分け時のファイル名に付ける撮影日は「元ファイル名の日付 → アップロード日」の順で
-- 決めていたため、iPhone の IMG_xxxx.MOV のように名前に日付が無い素材を後日まとめて
-- アップロードすると全てアップロード日になっていた。QuickTime/MP4 のメタデータ
-- (format.tags.creation_time) をプレビュー生成時の ffprobe で読み取り、ここに保存して最優先で使う。
--
-- 値は UTC の timestamptz（iPhone は UTC で記録）。ファイル名にする際に JST へ変換する。
ALTER TABLE video_file_organization_tests
  ADD COLUMN IF NOT EXISTS media_created_at timestamptz;

COMMENT ON COLUMN video_file_organization_tests.media_created_at IS
  '素材メタデータ上の撮影日時 (QuickTime/MP4 creation_time, UTC)。振り分け時のファイル名日付に最優先で使う (ADR 039)';
