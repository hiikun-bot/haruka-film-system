-- 素材スクエア（video_file_organization_tests）の
--   ① プレビュー方式刷新 (faststart 一律 → 短尺 H.264 / 長尺 WebP ストーリーボード)
--   ② Resumable Upload セッション管理（大容量 D&D を Drive 直送に分岐）
-- に対応するための Stage 1 migration（列追加・テーブル追加のみ、既存ロジック影響なし）。
--
-- 後続コード PR（PR-B 〜 PR-E）は本 migration の本番適用後にマージする運用とする。
-- 既存 faststart_* 列はそのまま残し、互換配信用にコードでフォールバック参照する。

-- ============================================================
-- ① プレビュー方式刷新（preview_* 列を追加）
-- ============================================================
-- 旧 faststart_* は「常に H.264 + AAC faststart の動画」を作る前提だった。
-- 新 preview_*  は
--   - 短尺(<3分): H.264 faststart (-c copy 優先・容量ほぼ増えず)
--   - 長尺(>=3分): WebP 60枚ストーリーボード（黒フレーム回避＋等間隔抽出）
-- の2種類を strategy 列で識別する。

ALTER TABLE video_file_organization_tests
  ADD COLUMN IF NOT EXISTS preview_drive_file_id TEXT,
  ADD COLUMN IF NOT EXISTS preview_drive_url     TEXT,
  ADD COLUMN IF NOT EXISTS preview_file_size     BIGINT,
  ADD COLUMN IF NOT EXISTS preview_mime_type     TEXT,
  ADD COLUMN IF NOT EXISTS preview_status        TEXT
    CHECK (preview_status IS NULL OR preview_status IN (
      'pending', 'processing', 'done', 'failed', 'skipped'
    )),
  ADD COLUMN IF NOT EXISTS preview_strategy      TEXT
    CHECK (preview_strategy IS NULL OR preview_strategy IN (
      'h264_faststart', 'webp_storyboard'
    )),
  ADD COLUMN IF NOT EXISTS preview_duration_seconds NUMERIC,
  ADD COLUMN IF NOT EXISTS preview_processed_at  TIMESTAMPTZ;

COMMENT ON COLUMN video_file_organization_tests.preview_drive_file_id IS
  'プレビュー版（短尺=H.264 mp4 / 長尺=WebP 60枚）の Drive file id。NULL なら未生成 or 旧 faststart_* にフォールバック。';
COMMENT ON COLUMN video_file_organization_tests.preview_strategy IS
  'h264_faststart=短尺向け原本相当UX / webp_storyboard=長尺向けダイジェスト（60枚パラパラ）';
COMMENT ON COLUMN video_file_organization_tests.preview_status IS
  'pending=未着手 / processing=生成中 / done=完了 / failed=失敗 / skipped=対象外（画像など）';

-- 未処理行をワーカで bulk 処理するための部分 index
CREATE INDEX IF NOT EXISTS idx_vfot_preview_status_pending
  ON video_file_organization_tests(preview_status)
  WHERE preview_status IS NULL OR preview_status IN ('pending', 'failed');

-- ============================================================
-- ② Resumable Upload セッション管理
-- ============================================================
-- D&D 時にブラウザがファイルサイズで分岐：
--   - 短尺(<500MB): 既存 /upload (Railway 経由)
--   - 長尺(>=500MB): Drive Resumable Upload API でブラウザ→Drive 直送
-- 後者は数十分〜数時間かかるので、回線切れ・タブ再読み込みに耐える
-- 「セッション URL（Drive 側の一意なアップロード URL）」を DB に永続化する。

CREATE TABLE IF NOT EXISTS video_org_upload_sessions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- ファイル情報（ブラウザ側で File オブジェクトから取得）
  filename            TEXT NOT NULL,
  file_size           BIGINT NOT NULL,
  mime_type           TEXT,
  -- Drive 側
  parent_folder_id    TEXT NOT NULL,
  drive_session_url   TEXT NOT NULL,          -- Drive Resumable Upload の一意セッション URL
  drive_file_id       TEXT,                    -- アップロード完了後に埋まる
  -- 進捗
  uploaded_bytes      BIGINT NOT NULL DEFAULT 0,
  status              TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'uploading', 'completed', 'failed', 'cancelled', 'expired')),
  error_message       TEXT,
  -- 時刻
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at        TIMESTAMPTZ,
  -- Drive セッション URL は7日で expire するため、その後の cleanup 用
  session_expires_at  TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days')
);

COMMENT ON TABLE video_org_upload_sessions IS
  'Drive Resumable Upload のセッション管理。長尺 D&D 時にブラウザ→Drive 直送のセッション URL を保存し、中断・再開・タブ切替に耐える。';
COMMENT ON COLUMN video_org_upload_sessions.drive_session_url IS
  'Drive Resumable Upload API が返す一意なセッション URL。7日間有効。ブラウザはこの URL に対してチャンク PUT を行う。';
COMMENT ON COLUMN video_org_upload_sessions.status IS
  'pending=セッション発行済み未開始 / uploading=チャンク転送中 / completed=Drive 側完了かつ /register 済 / failed=エラー / cancelled=ユーザー中止 / expired=7日経過';

CREATE INDEX IF NOT EXISTS idx_video_org_upload_sessions_user_status
  ON video_org_upload_sessions(user_id, status);

CREATE INDEX IF NOT EXISTS idx_video_org_upload_sessions_expires
  ON video_org_upload_sessions(session_expires_at)
  WHERE status IN ('pending', 'uploading');

-- updated_at の自動更新トリガ（既存 video_file_organization_tests と同じ形式）
CREATE OR REPLACE FUNCTION trg_set_vous_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_vous_updated_at ON video_org_upload_sessions;
CREATE TRIGGER trg_vous_updated_at
BEFORE UPDATE ON video_org_upload_sessions
FOR EACH ROW EXECUTE FUNCTION trg_set_vous_updated_at();
