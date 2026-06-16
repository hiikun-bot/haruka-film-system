-- 2026-05-19_video_org_apply_statuses.sql
-- 素材広場 / 動画整理ツール: 自動振り分け (auto-apply) ステータス拡張
--
-- 背景:
--   従来は AI 解析後に管理者が手動で「✅ 適用する」ボタンを押す前提だったが、
--   実体は DRY_RUN モードのままで Drive 上は何も変わらない MVP のままだった (Stage 1)。
--   PR #TBD で「解析完了→自動で Drive のリネーム＋フォルダ移動」を実装するため、
--   既存 status CHECK 制約を以下の通り拡張する:
--     - awaiting_review : needs_human_review=true の場合に自動適用を保留している状態
--     - applied         : (既存) 自動 or 手動で Drive 適用済み
--     - apply_failed    : 自動適用で Drive 操作が失敗した状態（再適用可能）
--
-- 既存 status 値は維持する:
--   waiting_approval / processing / analysis_completed
--   apply_pending (旧 stage 1 で使われた値・実質未使用だが互換のため残す)
--   applied / failed / skipped / stopped / pending
--
-- applied_at カラムは元から存在するが、未存在環境向けに IF NOT EXISTS で防御的に追加する。

ALTER TABLE video_file_organization_tests
  DROP CONSTRAINT IF EXISTS video_file_organization_tests_status_check;

ALTER TABLE video_file_organization_tests
  ADD CONSTRAINT video_file_organization_tests_status_check
  CHECK (status IN (
    'pending', 'waiting_approval', 'processing',
    'analysis_completed', 'apply_pending',
    'awaiting_review', 'applied', 'apply_failed',
    'failed', 'skipped', 'stopped'
  ));

ALTER TABLE video_file_organization_tests
  ADD COLUMN IF NOT EXISTS applied_at TIMESTAMPTZ;

COMMENT ON COLUMN video_file_organization_tests.status IS
  'ライフサイクル: waiting_approval → processing → analysis_completed → (auto-apply) → applied | awaiting_review | apply_failed';
