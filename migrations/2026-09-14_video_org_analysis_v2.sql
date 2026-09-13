-- 素材広場 AI 解析 v2（ADR 039 D1/D2）
--
-- D1: 解析入力を「解析用プロキシ（60コマ 1fps 480p 動画 + 原本の音声トラック）」に切り替える。
--     プロビューWebP と同じ Drive フォルダに置き、再解析（日次枠の翌日再開・手動再解析）で
--     原本 2GB を再ダウンロードせずに済むよう Drive ファイル ID を保持する。
-- D2: Gemini の usageMetadata（入出力トークン）と概算費用（円）を行に記録し、
--     「1 日 N 件」ではなく「月次予算（円）」で自動解析を止められるようにする。

ALTER TABLE video_file_organization_tests
  ADD COLUMN IF NOT EXISTS analysis_proxy_video_drive_file_id text,
  ADD COLUMN IF NOT EXISTS analysis_proxy_audio_drive_file_id text,
  ADD COLUMN IF NOT EXISTS analysis_proxy_audio_seconds numeric,
  ADD COLUMN IF NOT EXISTS analysis_proxy_status text,
  ADD COLUMN IF NOT EXISTS analysis_source text,
  ADD COLUMN IF NOT EXISTS analysis_prompt_tokens integer,
  ADD COLUMN IF NOT EXISTS analysis_output_tokens integer,
  ADD COLUMN IF NOT EXISTS analysis_total_tokens integer,
  ADD COLUMN IF NOT EXISTS analysis_cost_jpy numeric(10,3);

COMMENT ON COLUMN video_file_organization_tests.analysis_proxy_video_drive_file_id IS 'Gemini 解析用プロキシ動画 (60コマ 1fps 480p, 無音) の Drive ファイル ID (ADR 039 D1)';
COMMENT ON COLUMN video_file_organization_tests.analysis_proxy_audio_drive_file_id IS 'Gemini 解析用の音声トラック (AAC mono) の Drive ファイル ID。音声なし素材は NULL (ADR 039 D1)';
COMMENT ON COLUMN video_file_organization_tests.analysis_proxy_audio_seconds IS '音声トラックに含めた秒数 (inline 上限で先頭のみになった場合は原本より短い)';
COMMENT ON COLUMN video_file_organization_tests.analysis_proxy_status IS 'done | failed | skipped(音声なし等) | NULL(未生成)';
COMMENT ON COLUMN video_file_organization_tests.analysis_source IS '解析入力の種別: proxy-video+audio | proxy-video | preview-webp | original';
COMMENT ON COLUMN video_file_organization_tests.analysis_prompt_tokens IS 'Gemini usageMetadata.promptTokenCount';
COMMENT ON COLUMN video_file_organization_tests.analysis_output_tokens IS 'Gemini usageMetadata.candidatesTokenCount (+thoughts)';
COMMENT ON COLUMN video_file_organization_tests.analysis_total_tokens IS 'Gemini usageMetadata.totalTokenCount';
COMMENT ON COLUMN video_file_organization_tests.analysis_cost_jpy IS 'モデル単価表 × トークン数 × USD/JPY の概算費用 (円)。月次予算ガードの集計元 (ADR 039 D2)';

-- 月次予算の集計は processed_at 範囲 SUM(analysis_cost_jpy)。既存の idx_vfot_processed_at を使う。
