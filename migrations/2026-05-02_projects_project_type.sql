-- projects テーブルに「案件種別」カラムを追加
-- 'video' = 動画編集 / 'design' = デザイン
-- 既存案件は default 'video' で埋める（動画編集システムなので妥当）

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS project_type TEXT NOT NULL DEFAULT 'video';

-- CHECK 制約を追加（既に存在する場合はスキップ）
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'projects_project_type_check'
  ) THEN
    ALTER TABLE projects
      ADD CONSTRAINT projects_project_type_check
      CHECK (project_type IN ('video','design'));
  END IF;
END $$;
