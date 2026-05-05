-- =====================================================
-- Creative Categories (Stage A: マスタ駆動カテゴリ基盤)
-- =====================================================
-- 目的:
--   案件・クリエイティブの種別をハードコード ('video'|'design'|'lp'|'hp'|'other')
--   からマスタテーブル creative_categories に切り替えるための基盤を整える。
--
--   - 4 新規テーブル作成（カテゴリ、工程テンプレ、テンプレ項目、案件単価縦持ち）
--   - 既存テーブル (projects / creatives) にカラムを追加
--   - 5 初期カテゴリ＋工程テンプレを投入
--   - 既存データ移行（project_type / creative_type → category_id、
--     project_rates / project_director_rates / project_producer_rates →
--     project_category_rates 縦持ち）
--
-- 旧テーブル (project_rates, project_director_rates, project_producer_rates,
-- products, appeal_axes, project_products, project_appeal_axes …) の
-- DROP は **Stage A では行わない**。Stage C で実施する。
--
-- 冪等性:
--   CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS / ON CONFLICT DO NOTHING
--   を徹底し、二重実行しても破壊しない。
--
-- RLS:
--   既存テーブルと同方針（ENABLE のみ／サーバーは service_role でアクセス）。
-- =====================================================

BEGIN;

-- -----------------------------------------------------
-- 1) creative_categories : カテゴリマスタ
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS creative_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  render_kind TEXT NOT NULL CHECK (render_kind IN ('video','image','longpage','iframe','pdf')),
  sort_order INT NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  color TEXT,                          -- ガント色分け / バッジ色 (#RRGGBB)
  default_status_template_id UUID,     -- creative_status_templates(id) を後から FK 設定
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_creative_categories_active_sort
  ON creative_categories(is_active, sort_order);
ALTER TABLE creative_categories ENABLE ROW LEVEL SECURITY;

-- -----------------------------------------------------
-- 2) creative_status_templates : 工程テンプレ（カテゴリごとに複数可）
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS creative_status_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id UUID REFERENCES creative_categories(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  is_default BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_creative_status_templates_category
  ON creative_status_templates(category_id);
ALTER TABLE creative_status_templates ENABLE ROW LEVEL SECURITY;

-- creative_categories.default_status_template_id の FK を後付け
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'creative_categories_default_template_fkey'
  ) THEN
    ALTER TABLE creative_categories
      ADD CONSTRAINT creative_categories_default_template_fkey
      FOREIGN KEY (default_status_template_id)
      REFERENCES creative_status_templates(id)
      ON DELETE SET NULL;
  END IF;
END $$;

-- -----------------------------------------------------
-- 3) creative_status_template_items : 工程テンプレ項目（順序付き）
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS creative_status_template_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id UUID REFERENCES creative_status_templates(id) ON DELETE CASCADE,
  code TEXT NOT NULL,                  -- 'storyboard', 'editing' 等
  label TEXT NOT NULL,
  sort_order INT NOT NULL,
  is_milestone BOOLEAN NOT NULL DEFAULT false,
  default_days INT,                    -- 標準所要日数
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (template_id, code)
);
CREATE INDEX IF NOT EXISTS idx_csti_template_sort
  ON creative_status_template_items(template_id, sort_order);
ALTER TABLE creative_status_template_items ENABLE ROW LEVEL SECURITY;

-- -----------------------------------------------------
-- 4) project_category_rates : 案件×カテゴリ単価（縦持ち）
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS project_category_rates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  category_id UUID NOT NULL REFERENCES creative_categories(id) ON DELETE CASCADE,
  unit_price NUMERIC,
  director_unit_price NUMERIC,
  producer_unit_price NUMERIC,
  rank TEXT,                           -- 既存 'A'|'B'|'C' を保持（任意）
  base_fee INTEGER,
  script_fee INTEGER,
  ai_fee INTEGER,
  other_fee INTEGER,
  other_fee_note TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, category_id, rank)
);
CREATE INDEX IF NOT EXISTS idx_pcr_project ON project_category_rates(project_id);
CREATE INDEX IF NOT EXISTS idx_pcr_category ON project_category_rates(category_id);
ALTER TABLE project_category_rates ENABLE ROW LEVEL SECURITY;

-- -----------------------------------------------------
-- 5) projects / creatives へのカラム追加
-- -----------------------------------------------------
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS primary_category_id UUID REFERENCES creative_categories(id);
CREATE INDEX IF NOT EXISTS idx_projects_primary_category
  ON projects(primary_category_id);

ALTER TABLE creatives
  ADD COLUMN IF NOT EXISTS category_id UUID REFERENCES creative_categories(id);
ALTER TABLE creatives
  ADD COLUMN IF NOT EXISTS status_code TEXT;
CREATE INDEX IF NOT EXISTS idx_creatives_category
  ON creatives(category_id);

-- =====================================================
-- 6) 初期カテゴリ投入（5 つ）
-- =====================================================
INSERT INTO creative_categories (code, name, render_kind, sort_order, color) VALUES
  ('video', '動画',     'video',    10, '#2563EB'),
  ('image', '静止画',   'image',    20, '#16A34A'),
  ('hp',    'HP',       'longpage', 30, '#9333EA'),
  ('lp',    'LP',       'longpage', 40, '#DB2777'),
  ('line',  'LINE配信', 'iframe',   50, '#22C55E')
ON CONFLICT (code) DO NOTHING;

-- =====================================================
-- 7) 工程テンプレ + 項目投入（カテゴリごと）
-- =====================================================

-- video: 台本→素材・ナレ→編集→Dチェック→修正→Pチェック→修正→CL確認→修正→納品
WITH cat AS (SELECT id FROM creative_categories WHERE code = 'video' LIMIT 1),
     ins AS (
       INSERT INTO creative_status_templates (category_id, name, is_default)
       SELECT cat.id, '動画 標準工程', true FROM cat
       WHERE NOT EXISTS (
         SELECT 1 FROM creative_status_templates t
         WHERE t.category_id = cat.id AND t.name = '動画 標準工程'
       )
       RETURNING id
     )
INSERT INTO creative_status_template_items (template_id, code, label, sort_order, is_milestone, default_days)
SELECT id, v.code, v.label, v.sort_order, v.is_milestone, v.default_days FROM ins,
  (VALUES
    ('storyboard',     '台本制作',        10, true,  2),
    ('material',       '素材・ナレ作成',  20, false, 2),
    ('editing',        '編集',            30, true,  3),
    ('director_check', 'Dチェック',       40, false, 1),
    ('director_fix',   'D修正',           50, false, 1),
    ('producer_check', 'Pチェック',       60, false, 1),
    ('producer_fix',   'P修正',           70, false, 1),
    ('client_review',  'CL確認',          80, true,  1),
    ('client_fix',     'CL修正',          90, false, 1),
    ('delivery',       '納品',           100, true,  0)
  ) AS v(code, label, sort_order, is_milestone, default_days)
ON CONFLICT (template_id, code) DO NOTHING;

-- image: 構成→デザイン→Dチェック→修正→CL確認→修正→納品
WITH cat AS (SELECT id FROM creative_categories WHERE code = 'image' LIMIT 1),
     ins AS (
       INSERT INTO creative_status_templates (category_id, name, is_default)
       SELECT cat.id, '静止画 標準工程', true FROM cat
       WHERE NOT EXISTS (
         SELECT 1 FROM creative_status_templates t
         WHERE t.category_id = cat.id AND t.name = '静止画 標準工程'
       )
       RETURNING id
     )
INSERT INTO creative_status_template_items (template_id, code, label, sort_order, is_milestone, default_days)
SELECT id, v.code, v.label, v.sort_order, v.is_milestone, v.default_days FROM ins,
  (VALUES
    ('composition',    '構成',           10, true,  1),
    ('design',         'デザイン',       20, true,  3),
    ('director_check', 'Dチェック',      30, false, 1),
    ('director_fix',   'D修正',          40, false, 1),
    ('client_review',  'CL確認',         50, true,  1),
    ('client_fix',     'CL修正',         60, false, 1),
    ('delivery',       '納品',           70, true,  0)
  ) AS v(code, label, sort_order, is_milestone, default_days)
ON CONFLICT (template_id, code) DO NOTHING;

-- hp: ヒアリング→構成案→デザイン→修正→コーディング→検証→公開準備→公開
WITH cat AS (SELECT id FROM creative_categories WHERE code = 'hp' LIMIT 1),
     ins AS (
       INSERT INTO creative_status_templates (category_id, name, is_default)
       SELECT cat.id, 'HP 標準工程', true FROM cat
       WHERE NOT EXISTS (
         SELECT 1 FROM creative_status_templates t
         WHERE t.category_id = cat.id AND t.name = 'HP 標準工程'
       )
       RETURNING id
     )
INSERT INTO creative_status_template_items (template_id, code, label, sort_order, is_milestone, default_days)
SELECT id, v.code, v.label, v.sort_order, v.is_milestone, v.default_days FROM ins,
  (VALUES
    ('hearing',     'ヒアリング',     10, true,  2),
    ('outline',     '構成案',         20, true,  3),
    ('design',      'デザイン',       30, true,  5),
    ('design_fix',  'デザイン修正',   40, false, 2),
    ('coding',      'コーディング',   50, true,  5),
    ('qa',          '検証',           60, false, 2),
    ('publish_prep','公開準備',       70, false, 1),
    ('publish',     '公開',           80, true,  0)
  ) AS v(code, label, sort_order, is_milestone, default_days)
ON CONFLICT (template_id, code) DO NOTHING;

-- lp: 構成案→デザイン→修正→コーディング→検証→公開
WITH cat AS (SELECT id FROM creative_categories WHERE code = 'lp' LIMIT 1),
     ins AS (
       INSERT INTO creative_status_templates (category_id, name, is_default)
       SELECT cat.id, 'LP 標準工程', true FROM cat
       WHERE NOT EXISTS (
         SELECT 1 FROM creative_status_templates t
         WHERE t.category_id = cat.id AND t.name = 'LP 標準工程'
       )
       RETURNING id
     )
INSERT INTO creative_status_template_items (template_id, code, label, sort_order, is_milestone, default_days)
SELECT id, v.code, v.label, v.sort_order, v.is_milestone, v.default_days FROM ins,
  (VALUES
    ('outline',    '構成案',       10, true,  2),
    ('design',     'デザイン',     20, true,  4),
    ('design_fix', 'デザイン修正', 30, false, 2),
    ('coding',     'コーディング', 40, true,  3),
    ('qa',         '検証',         50, false, 1),
    ('publish',    '公開',         60, true,  0)
  ) AS v(code, label, sort_order, is_milestone, default_days)
ON CONFLICT (template_id, code) DO NOTHING;

-- line: 構成→制作→配信準備→配信
WITH cat AS (SELECT id FROM creative_categories WHERE code = 'line' LIMIT 1),
     ins AS (
       INSERT INTO creative_status_templates (category_id, name, is_default)
       SELECT cat.id, 'LINE配信 標準工程', true FROM cat
       WHERE NOT EXISTS (
         SELECT 1 FROM creative_status_templates t
         WHERE t.category_id = cat.id AND t.name = 'LINE配信 標準工程'
       )
       RETURNING id
     )
INSERT INTO creative_status_template_items (template_id, code, label, sort_order, is_milestone, default_days)
SELECT id, v.code, v.label, v.sort_order, v.is_milestone, v.default_days FROM ins,
  (VALUES
    ('composition',     '構成',       10, true,  1),
    ('production',      '制作',       20, true,  2),
    ('delivery_prep',   '配信準備',   30, false, 1),
    ('broadcast',       '配信',       40, true,  0)
  ) AS v(code, label, sort_order, is_milestone, default_days)
ON CONFLICT (template_id, code) DO NOTHING;

-- 各カテゴリの default_status_template_id を、is_default=true のテンプレで埋める
UPDATE creative_categories c
SET default_status_template_id = t.id,
    updated_at = now()
FROM creative_status_templates t
WHERE t.category_id = c.id
  AND t.is_default = true
  AND (c.default_status_template_id IS NULL OR c.default_status_template_id <> t.id);

-- =====================================================
-- 8) 既存データ移行
-- =====================================================

-- 8-1) projects.project_type → primary_category_id
--   'video' → video
--   'design' → image
--   'lp' → lp / 'hp' → hp / 'other' → image (フォールバック; Stage B/C で見直し)
--   既に primary_category_id が設定されている案件は上書きしない。
UPDATE projects p
SET primary_category_id = c.id
FROM creative_categories c
WHERE p.primary_category_id IS NULL
  AND c.code = CASE
    WHEN p.project_type = 'video'  THEN 'video'
    WHEN p.project_type = 'design' THEN 'image'
    WHEN p.project_type = 'lp'     THEN 'lp'
    WHEN p.project_type = 'hp'     THEN 'hp'
    WHEN p.project_type = 'other'  THEN 'image'
    ELSE 'video'
  END;

-- 8-2) creatives.creative_type → category_id
--   prefix で判定: 'video_*' → video / 'design_*' → image / 'lp_*' → lp / 'hp_*' → hp
--   それ以外（NULL/未知） → 案件の primary_category_id を継承
UPDATE creatives cr
SET category_id = c.id
FROM creative_categories c
WHERE cr.category_id IS NULL
  AND c.code = CASE
    WHEN cr.creative_type LIKE 'video%'  THEN 'video'
    WHEN cr.creative_type LIKE 'design%' THEN 'image'
    WHEN cr.creative_type LIKE 'lp%'     THEN 'lp'
    WHEN cr.creative_type LIKE 'hp%'     THEN 'hp'
    WHEN cr.creative_type LIKE 'line%'   THEN 'line'
    ELSE NULL
  END;

-- 残った（prefix 不明）クリエイティブは案件の primary_category_id を継承
UPDATE creatives cr
SET category_id = p.primary_category_id
FROM projects p
WHERE cr.category_id IS NULL
  AND cr.project_id = p.id
  AND p.primary_category_id IS NOT NULL;

-- 8-3) project_rates → project_category_rates（縦持ち化）
--   既存 (project_id, creative_type='video'|'design', rank) を
--   (project_id, category_id=video|image, rank) に転記。
--   重複は ON CONFLICT で無視。
INSERT INTO project_category_rates
  (project_id, category_id, rank, base_fee, script_fee, ai_fee, other_fee, other_fee_note,
   unit_price, updated_at)
SELECT
  pr.project_id,
  c.id,
  pr.rank,
  pr.base_fee,
  pr.script_fee,
  pr.ai_fee,
  pr.other_fee,
  pr.other_fee_note,
  COALESCE(pr.base_fee,0) + COALESCE(pr.script_fee,0)
    + COALESCE(pr.ai_fee,0) + COALESCE(pr.other_fee,0),
  COALESCE(pr.updated_at, now())
FROM project_rates pr
JOIN creative_categories c
  ON c.code = CASE pr.creative_type
       WHEN 'video' THEN 'video'
       WHEN 'design' THEN 'image'
       ELSE NULL
     END
ON CONFLICT (project_id, category_id, rank) DO NOTHING;

-- 8-4) project_director_rates → project_category_rates.director_unit_price
--   creative_type ('video'|'design') ごとに 1 行（rank なし）。
--   対応する rank=NULL の行が無ければ INSERT、あれば UPDATE。
DO $$
DECLARE
  r RECORD;
  cat_id UUID;
BEGIN
  -- テーブルが存在しない環境では何もしない
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'project_director_rates'
  ) THEN
    RETURN;
  END IF;

  FOR r IN SELECT * FROM project_director_rates LOOP
    SELECT id INTO cat_id FROM creative_categories
     WHERE code = CASE r.creative_type WHEN 'video' THEN 'video' WHEN 'design' THEN 'image' ELSE NULL END
     LIMIT 1;
    IF cat_id IS NULL THEN
      CONTINUE;
    END IF;
    INSERT INTO project_category_rates (project_id, category_id, rank, director_unit_price, updated_at)
    VALUES (r.project_id, cat_id, NULL, r.director_fee, COALESCE(r.updated_at, now()))
    ON CONFLICT (project_id, category_id, rank) DO UPDATE
      SET director_unit_price = EXCLUDED.director_unit_price,
          updated_at = EXCLUDED.updated_at;
  END LOOP;
END $$;

-- 8-5) project_producer_rates → project_category_rates.producer_unit_price
DO $$
DECLARE
  r RECORD;
  cat_id UUID;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'project_producer_rates'
  ) THEN
    RETURN;
  END IF;

  FOR r IN SELECT * FROM project_producer_rates LOOP
    SELECT id INTO cat_id FROM creative_categories
     WHERE code = CASE r.creative_type WHEN 'video' THEN 'video' WHEN 'design' THEN 'image' ELSE NULL END
     LIMIT 1;
    IF cat_id IS NULL THEN
      CONTINUE;
    END IF;
    INSERT INTO project_category_rates (project_id, category_id, rank, producer_unit_price, updated_at)
    VALUES (r.project_id, cat_id, NULL, r.producer_fee, COALESCE(r.updated_at, now()))
    ON CONFLICT (project_id, category_id, rank) DO UPDATE
      SET producer_unit_price = EXCLUDED.producer_unit_price,
          updated_at = EXCLUDED.updated_at;
  END LOOP;
END $$;

-- =====================================================
-- 9) PostgREST にスキーマリロード通知
-- =====================================================
NOTIFY pgrst, 'reload schema';

COMMIT;

-- =====================================================
-- ロールバック手順（手動）
-- =====================================================
-- BEGIN;
--   ALTER TABLE projects DROP COLUMN IF EXISTS primary_category_id;
--   ALTER TABLE creatives DROP COLUMN IF EXISTS category_id;
--   ALTER TABLE creatives DROP COLUMN IF EXISTS status_code;
--   DROP TABLE IF EXISTS project_category_rates;
--   DROP TABLE IF EXISTS creative_status_template_items;
--   DROP TABLE IF EXISTS creative_status_templates;
--   DROP TABLE IF EXISTS creative_categories;
-- COMMIT;
