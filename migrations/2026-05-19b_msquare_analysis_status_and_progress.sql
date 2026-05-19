-- 素材スクエア（video_file_organization_tests）の AI 解析フェーズを
-- プレビュー生成フェーズと独立して可視化するための列追加。
--
-- 背景:
--   - preview_status / preview_progress_percent は WebP 60枚生成の進捗
--   - これまで「AI解析中」は既存 status カラムに表現が無く、UI でフェーズ判別不可
--   - ユーザー要望: 「WebP と AI解析は別の進捗 or 同じでも良いが、わかりやすく」
--
-- 用途:
--   - lib/video-organization/auto-analyze.js（PR #693）が AI 解析開始時に
--     analysis_status='processing' / analysis_progress_percent=0 をセット
--   - Gemini 呼び出し中は ~50%、結果保存中は ~90% など段階的に更新
--   - 完了で analysis_status='done' / analysis_progress_percent=NULL に戻す
--   - フロント (public/haruka.html) は preview_status と analysis_status を順番に表示:
--       🎞 プレビュー生成中 ▓▓▓░ 60%
--          ↓ プレビュー完了
--       🧠 AI解析中 ▓▓░░░ 30%
--          ↓ 解析完了
--       ✅ 解析完了
--
-- Stage 1: 列追加のみ。既存ロジック影響なし。後続コード PR で参照・更新を実装する。

ALTER TABLE video_file_organization_tests
  ADD COLUMN IF NOT EXISTS analysis_status TEXT
    CHECK (analysis_status IS NULL OR analysis_status IN (
      'pending', 'processing', 'done', 'failed', 'skipped'
    )),
  ADD COLUMN IF NOT EXISTS analysis_progress_percent SMALLINT
    CHECK (analysis_progress_percent IS NULL OR (analysis_progress_percent >= 0 AND analysis_progress_percent <= 100));

COMMENT ON COLUMN video_file_organization_tests.analysis_status IS
  'AI解析（Gemini）フェーズの状態。pending=未着手 / processing=解析中 / done=完了 / failed=失敗 / skipped=対象外（画像など）。完了/失敗後にUIで進捗バー撤去するため NULL に戻してもよい。';
COMMENT ON COLUMN video_file_organization_tests.analysis_progress_percent IS
  'AI解析中の進捗率（0-100）。analysis_status=processing の間に更新される。完了/失敗/未開始は NULL。';

-- 未処理行をワーカで bulk 処理するための部分 index（auto-analyze の翌日再開用）
CREATE INDEX IF NOT EXISTS idx_vfot_analysis_status_pending
  ON video_file_organization_tests(analysis_status)
  WHERE analysis_status IS NULL OR analysis_status IN ('pending', 'failed');
