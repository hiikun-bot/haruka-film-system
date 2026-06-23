-- 2026-06-23_msquare_folders.sql
-- 素材広場: 任意フォルダ（クライアント→案件 直下 / ルート直下）  ADR 023
--
-- 背景:
--   素材広場では「クライアント → 案件」の 2 階層までを resolveProjectFolder() が
--   Drive 上に ensure しているが、1 案件の中で素材を撮影回・用途ごとにまとめる
--   「箱」が無かった（例: 6/12 Zoom 動画 / 6/13 対談動画 を分けたい）。
--
--   本 migration で素材広場の任意フォルダを material_square_folders に永続化し、
--   素材 (video_file_organization_tests) に所属フォルダ folder_id を持たせる。
--
-- 階層ルール（ADR 023 / CHECK 制約で担保）:
--   - project_id あり → client_id 必須。Drive 上は ルート/クライアント/案件/フォルダ。
--   - client/project とも NULL → 素材広場ルート直下のフォルダ。
--   - 「クライアントのみ（案件 NULL）」は不許可。
--
-- 影響:
--   - 新テーブル material_square_folders
--   - video_file_organization_tests.folder_id（任意・案件削除や フォルダ削除に追従）
--   既存行は folder_id = NULL（＝未振り分け＝案件フォルダ直下のまま）。後方互換あり。

-- ==================== 素材広場フォルダ ====================
CREATE TABLE IF NOT EXISTS material_square_folders (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  -- Drive 上の実フォルダ
  drive_folder_id TEXT NOT NULL,
  drive_url       TEXT,
  -- 所属。project_id あり=案件直下 / 両方 NULL=素材広場ルート直下
  client_id       UUID REFERENCES clients(id)  ON DELETE CASCADE,
  project_id      UUID REFERENCES projects(id) ON DELETE CASCADE,
  created_by      UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 案件直下なら必ずクライアントも紐づく（クライアントのみ選択は不可）
  CONSTRAINT msf_client_required_when_project
    CHECK (project_id IS NULL OR client_id IS NOT NULL)
);

-- 案件直下フォルダの参照（一覧の主クエリ）
CREATE INDEX IF NOT EXISTS idx_msf_project ON material_square_folders(project_id);
-- ルート直下フォルダの参照（client/project とも NULL）
CREATE INDEX IF NOT EXISTS idx_msf_root    ON material_square_folders(client_id, project_id);

-- ==================== 素材 → フォルダ所属 ====================
ALTER TABLE video_file_organization_tests
  ADD COLUMN IF NOT EXISTS folder_id UUID
    REFERENCES material_square_folders(id) ON DELETE SET NULL;

-- フォルダ単位の素材一覧 / 件数バッジ
CREATE INDEX IF NOT EXISTS idx_vfot_folder
  ON video_file_organization_tests(folder_id);
