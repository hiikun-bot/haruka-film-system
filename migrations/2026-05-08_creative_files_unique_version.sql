-- Add UNIQUE constraint on creative_files (creative_id, version)
-- 直前のサーバ側修正 (PR #337) と組み合わせ、版番号の重複を DB レベルでも防止する
-- 本番DBに既存重複は無いことを確認済み (2026-05-08)

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'creative_files_creative_id_version_unique'
  ) THEN
    ALTER TABLE creative_files
      ADD CONSTRAINT creative_files_creative_id_version_unique
      UNIQUE (creative_id, version);
  END IF;
END $$;
