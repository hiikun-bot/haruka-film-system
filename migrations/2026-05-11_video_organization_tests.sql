-- 2026-05-11_video_organization_tests.sql
-- 素材広場 / 動画整理ツール（test / experimental）用テーブル
--
-- 目的:
--   Google Drive 上の動画ファイルを Vertex AI Gemini で解析し、
--   ファイル名・フォルダ振り分けの「候補」を保存する。
--   従量課金事故と Drive 上の事故リネーム/移動を防ぐため、
--   候補生成 → 人間確認 → 適用 の 3 段階を厳密に DB 上の status で管理する。
--
-- 設計判断:
--   - 既存スキーマには触らない（テスト/experimental 領域として独立テーブル）
--   - ENABLE_VIDEO_ORGANIZATION_TEST=false の環境では route 自体マウントしないため
--     テーブルが存在していても何も起きない
--   - 全 status は CHECK で限定（不正値による silent skip を防ぐ）

CREATE TABLE IF NOT EXISTS video_file_organization_tests (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Google Drive 上の対象ファイル
  drive_file_id               TEXT NOT NULL UNIQUE,
  original_filename           TEXT,
  current_filename            TEXT,
  mime_type                   TEXT,
  file_size                   BIGINT,
  drive_url                   TEXT,
  current_parent_folder_id    TEXT,
  current_parent_folder_name  TEXT,
  video_duration_seconds      NUMERIC,

  -- 状態管理（候補生成 → 確認 → 適用 の 3 段階）
  status                      TEXT NOT NULL DEFAULT 'waiting_approval'
    CHECK (status IN (
      'pending', 'waiting_approval', 'processing',
      'analysis_completed', 'apply_pending', 'applied',
      'failed', 'skipped', 'stopped'
    )),
  attempt_count               INT NOT NULL DEFAULT 0,

  -- Gemini 解析メタ
  model                       TEXT,
  prompt_version              TEXT,

  -- Gemini 解析結果（候補）— ユーザー承認まで Drive には適用しない
  summary                     TEXT,
  main_action                 TEXT,
  video_type                  TEXT,
  recommended_folder          TEXT,
  recommended_filename        TEXT,
  confidence                  INT,
  needs_human_review          BOOLEAN,
  reason                      TEXT,
  raw_response                JSONB,

  error_message               TEXT,
  dry_run                     BOOLEAN NOT NULL DEFAULT TRUE,

  -- 監査ログ
  created_by                  UUID REFERENCES users(id) ON DELETE SET NULL,
  approved_by                 UUID REFERENCES users(id) ON DELETE SET NULL,
  applied_by                  UUID REFERENCES users(id) ON DELETE SET NULL,

  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approved_at                 TIMESTAMPTZ,
  processed_at                TIMESTAMPTZ,
  applied_at                  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_vfot_status     ON video_file_organization_tests(status);
CREATE INDEX IF NOT EXISTS idx_vfot_created_at ON video_file_organization_tests(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_vfot_processed_at ON video_file_organization_tests(processed_at)
  WHERE processed_at IS NOT NULL;

-- updated_at の自動更新トリガ
CREATE OR REPLACE FUNCTION trg_set_vfot_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_vfot_updated_at ON video_file_organization_tests;
CREATE TRIGGER trg_vfot_updated_at
BEFORE UPDATE ON video_file_organization_tests
FOR EACH ROW EXECUTE FUNCTION trg_set_vfot_updated_at();
