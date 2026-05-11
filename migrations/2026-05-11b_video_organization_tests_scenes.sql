-- 2026-05-11b_video_organization_tests_scenes.sql
-- 素材広場 Phase 2: シーン記述・タグ・トーン・画像対応 列追加
--
-- 目的:
--   素材を後から「シーンの内容」「タグ」で検索/絞り込めるよう、
--   Gemini に視覚情報を要約させた構造化フィールドを保存する。
--
-- 列の意味:
--   tags          : ["#在宅ワーク", "#女性", "#笑顔", ...] AI が付ける 5-10 個
--   scenes        : [{"time":"0:05","description":"椅子を引く"}, ...] 最大 8 件
--   mood          : "明るい/穏やか/真剣/コミカル/シリアス/緊張感" 等
--   media_kind    : 'video' or 'image'（画像対応のため）
--   thumbnail_url : Drive の thumbnailLink（プレビュー静止画。画像はそのまま URL）

ALTER TABLE video_file_organization_tests
  ADD COLUMN IF NOT EXISTS tags          TEXT[],
  ADD COLUMN IF NOT EXISTS scenes        JSONB,
  ADD COLUMN IF NOT EXISTS mood          TEXT,
  ADD COLUMN IF NOT EXISTS media_kind    TEXT DEFAULT 'video',
  ADD COLUMN IF NOT EXISTS thumbnail_url TEXT;

-- media_kind の CHECK 制約は既存行を巻き込まないよう NOT VALID 経由で安全に追加
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'video_file_organization_tests_media_kind_check'
  ) THEN
    ALTER TABLE video_file_organization_tests
      ADD CONSTRAINT video_file_organization_tests_media_kind_check
      CHECK (media_kind IN ('video', 'image')) NOT VALID;
  END IF;
END $$;

-- タグ検索を高速化（GIN）— "#女性" を含む素材を絞り込む用途
CREATE INDEX IF NOT EXISTS idx_vfot_tags_gin ON video_file_organization_tests USING gin(tags);

-- media_kind フィルタ用
CREATE INDEX IF NOT EXISTS idx_vfot_media_kind ON video_file_organization_tests(media_kind);
