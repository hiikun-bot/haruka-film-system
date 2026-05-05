-- =====================================================
-- Project Categories Expansion + Tags
-- =====================================================
-- 1) projects.project_type の許容値を 'video'|'design' から
--    'video'|'design'|'lp'|'hp'|'other' に拡張する
--    既存の DEFAULT 'video' は維持。既存データ ('video'|'design') もそのまま通る。
-- 2) project_tags テーブル（多対多タグ）を新規作成
--    （主カテゴリ＋補助タグの C 案）
-- 3) RLS は既存テーブルと同方針: ENABLE のみ → サーバーは service_role
--    でアクセスするため bypass。anon/authenticated からの直接アクセスは
--    ポリシー無し＝全拒否となる。
-- =====================================================

-- -----------------------------------------------------
-- 1) projects.project_type の CHECK 制約を入れ替え
-- -----------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'projects_project_type_check'
  ) THEN
    ALTER TABLE projects DROP CONSTRAINT projects_project_type_check;
  END IF;
  ALTER TABLE projects
    ADD CONSTRAINT projects_project_type_check
    CHECK (project_type IN ('video','design','lp','hp','other'));
END $$;

-- -----------------------------------------------------
-- 2) project_tags テーブル
--    1案件×1タグ で 1行（PK で重複防止）。
--    タグ削除時は project ON DELETE CASCADE。
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS project_tags (
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  tag        TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (project_id, tag)
);

-- タグ → 案件の逆引き / distinct タグ集計用
CREATE INDEX IF NOT EXISTS idx_project_tags_tag ON project_tags(tag);

-- 一覧の N+1 回避用（in-list で project_id 多数指定の検索）
CREATE INDEX IF NOT EXISTS idx_project_tags_project_id ON project_tags(project_id);

-- RLS 有効化（既存全テーブルと同様 service_role 経由前提）
ALTER TABLE project_tags ENABLE ROW LEVEL SECURITY;

-- PostgREST にスキーマリロードを通知
NOTIFY pgrst, 'reload schema';
