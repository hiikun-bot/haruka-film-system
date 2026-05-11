-- =====================================================
-- ADR 016: LP制作のフェーズ × ボール状態モデル Phase 1（migration のみ）
-- =====================================================
-- 目的:
--   ADR 010 で先に作った project_tasks / project_phase_templates 系に
--   「フェーズ × ボール状態」モデルを上乗せするための列追加 + 新テーブル新設 + LP 用 seed。
--   アプリケーションコード（routes/, public/, utils/）はこの PR では一切触らない。
--
-- このマイグレーションで行うこと:
--   1) project_phase_template_items への列追加
--      requires_internal_review / requires_client_review
--   2) project_tasks への列追加
--      ball_state_code / ball_holder_user_id / ball_moved_at
--      skip_internal_review / skip_client_review
--   3) projects への列追加
--      work_modes / maintenance_started_at
--      （scheduled_start_date / active_phase_template_id は ADR 010 で追加済み）
--   4) project_ball_state_definitions 新設（カテゴリ別ボール状態定義）
--   5) LP 用 seed
--      - LP 用フェーズテンプレ「LPフェーズテンプレ（ボール状態モデル）」5行
--      - LP 用ボール状態定義 5行（in_progress / internal_review / client_review / revising / fixed）
--      - 旧「標準LP工程」を is_default=false に降格（27行のタスク雛形は保持）
--
-- 冪等性:
--   ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS / UNIQUE 制約 + ON CONFLICT を徹底。
--
-- 依存:
--   - ADR 010 の 2026-05-09_project_schedule_phase1.sql が適用済みであること
--   - creative_categories に code='lp' が seed 済みであること
-- =====================================================

BEGIN;

-- -----------------------------------------------------
-- 1) project_phase_template_items への列追加
-- -----------------------------------------------------
ALTER TABLE project_phase_template_items
  ADD COLUMN IF NOT EXISTS requires_internal_review BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE project_phase_template_items
  ADD COLUMN IF NOT EXISTS requires_client_review   BOOLEAN NOT NULL DEFAULT true;

-- -----------------------------------------------------
-- 2) project_tasks への列追加
-- -----------------------------------------------------
ALTER TABLE project_tasks
  ADD COLUMN IF NOT EXISTS ball_state_code TEXT;
  -- NULL = 未開始 / 'fixed' = 完了 / それ以外は project_ball_state_definitions.code と同値域

ALTER TABLE project_tasks
  ADD COLUMN IF NOT EXISTS ball_holder_user_id UUID
    REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE project_tasks
  ADD COLUMN IF NOT EXISTS ball_moved_at TIMESTAMPTZ;

ALTER TABLE project_tasks
  ADD COLUMN IF NOT EXISTS skip_internal_review BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE project_tasks
  ADD COLUMN IF NOT EXISTS skip_client_review   BOOLEAN NOT NULL DEFAULT false;

-- ボール持ち（未完了）でフィルタ・絞り込みできるようにする補助インデックス
CREATE INDEX IF NOT EXISTS idx_project_tasks_ball_holder
  ON project_tasks(ball_holder_user_id)
  WHERE ball_holder_user_id IS NOT NULL AND NOT is_done;

-- -----------------------------------------------------
-- 3) projects への列追加
-- -----------------------------------------------------
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS work_modes TEXT[] NOT NULL DEFAULT ARRAY['production']::TEXT[];
  -- 'production' | 'maintenance' （複数指定可）

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS maintenance_started_at DATE;

-- -----------------------------------------------------
-- 4) project_ball_state_definitions: カテゴリ別ボール状態定義
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS project_ball_state_definitions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id     UUID NOT NULL REFERENCES creative_categories(id) ON DELETE CASCADE,
  code            TEXT NOT NULL,
  -- 'in_progress' | 'internal_review' | 'client_review' | 'revising' | 'fixed' 等
  label           TEXT NOT NULL,
  -- '社内作業' '社内チェック' '先方確認' '修正対応' 'FIX' 等
  holder_type     TEXT NOT NULL CHECK (holder_type IN ('internal','client','done')),
  sort_order      INT NOT NULL DEFAULT 0,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (category_id, code)
);

CREATE INDEX IF NOT EXISTS idx_project_ball_state_defs_category
  ON project_ball_state_definitions(category_id, sort_order) WHERE is_active;

ALTER TABLE project_ball_state_definitions ENABLE ROW LEVEL SECURITY;

-- =====================================================
-- 5) LP 用 seed
-- =====================================================

-- 5-1) 旧「標準LP工程」（ADR 010 で seed した27行テンプレ）を is_default=false に降格。
--      新テンプレと共存させるため、本体は残す（既存案件の参照を壊さないように）。
UPDATE project_phase_templates pt
SET is_default = false,
    updated_at = now()
FROM creative_categories cc
WHERE pt.category_id = cc.id
  AND cc.code = 'lp'
  AND pt.name = '標準LP工程'
  AND pt.is_default = true;

-- 5-2) 新 LPフェーズテンプレ（ボール状態モデル）本体
INSERT INTO project_phase_templates (category_id, name, description, is_default, is_active)
SELECT id,
       'LPフェーズテンプレ（ボール状態モデル）',
       '5フェーズ構成（ヒアリング → ワイヤー → デザイン → コーディング → 納品）。フェーズ内のボール状態（社内作業 → 社内チェック → 先方確認 → 修正対応 → FIX）は project_tasks.ball_state_code で管理する。',
       true,
       true
FROM creative_categories WHERE code = 'lp'
ON CONFLICT (category_id, name) DO NOTHING;

-- 5-3) 新テンプレの items（5フェーズ見出しのみ）
WITH tpl AS (
  SELECT pt.id AS template_id
  FROM project_phase_templates pt
  JOIN creative_categories cc ON cc.id = pt.category_id
  WHERE cc.code = 'lp' AND pt.name = 'LPフェーズテンプレ（ボール状態モデル）'
  LIMIT 1
)
INSERT INTO project_phase_template_items
  (template_id, is_phase_header, title,
   default_offset_days_from_start, default_duration_days,
   default_assignee_type, is_milestone,
   requires_internal_review, requires_client_review,
   sort_order)
SELECT template_id,
       is_phase_header, title, offset_d, duration_d,
       assignee_type, is_milestone,
       requires_internal_review, requires_client_review,
       sort_order
FROM tpl,
(VALUES
  -- フェーズ見出し: ヒアリング・ワイヤー・デザインは社内チェック/先方確認なし、
  -- コーディングと納品は両方の要件確認あり（ユーザー指定どおり）
  (true,  '【ヒアリング】',     0,  3, 'meeting',   false, false, false, 1),
  (true,  '【ワイヤー】',       3,  5, 'us',        false, false, false, 2),
  (true,  '【デザイン】',       8,  7, 'us',        false, false, false, 3),
  (true,  '【コーディング】',  15, 10, 'us',        false, true,  true,  4),
  (true,  '【納品】',          25,  1, 'milestone', true,  true,  true,  5)
) AS v(is_phase_header, title, offset_d, duration_d, assignee_type, is_milestone,
       requires_internal_review, requires_client_review, sort_order)
ON CONFLICT (template_id, sort_order) DO NOTHING;

-- 5-4) LP 用ボール状態定義（5段階）
INSERT INTO project_ball_state_definitions (category_id, code, label, holder_type, sort_order)
SELECT cc.id, v.code, v.label, v.holder_type, v.sort_order
FROM creative_categories cc,
(VALUES
  ('in_progress',     '社内作業',     'internal', 1),
  ('internal_review', '社内チェック', 'internal', 2),
  ('client_review',   '先方確認',     'client',   3),
  ('revising',        '修正対応',     'internal', 4),
  ('fixed',           'FIX',          'done',     5)
) AS v(code, label, holder_type, sort_order)
WHERE cc.code = 'lp'
ON CONFLICT (category_id, code) DO NOTHING;

COMMIT;

-- =====================================================
-- 適用後の検証クエリ（任意・コメント）
-- =====================================================
-- -- 1) ボール状態定義（LP 5行を期待）
-- SELECT cc.code AS category, d.sort_order, d.code, d.label, d.holder_type
-- FROM project_ball_state_definitions d
-- JOIN creative_categories cc ON cc.id = d.category_id
-- WHERE cc.code = 'lp'
-- ORDER BY d.sort_order;
--
-- -- 2) LP の default テンプレが切り替わっていること（新テンプレ1件 / 旧テンプレ is_default=false）
-- SELECT pt.name, pt.is_default,
--        (SELECT COUNT(*) FROM project_phase_template_items i WHERE i.template_id = pt.id) AS item_count
-- FROM project_phase_templates pt
-- JOIN creative_categories cc ON cc.id = pt.category_id
-- WHERE cc.code = 'lp'
-- ORDER BY pt.is_default DESC, pt.name;
--
-- -- 3) 新テンプレ items の requires_* フラグ
-- SELECT i.sort_order, i.title, i.requires_internal_review, i.requires_client_review
-- FROM project_phase_template_items i
-- JOIN project_phase_templates pt ON pt.id = i.template_id
-- JOIN creative_categories cc ON cc.id = pt.category_id
-- WHERE cc.code = 'lp' AND pt.name = 'LPフェーズテンプレ（ボール状態モデル）'
-- ORDER BY i.sort_order;
--
-- -- 4) project_tasks の新規列がついていること
-- SELECT column_name, data_type, is_nullable, column_default
-- FROM information_schema.columns
-- WHERE table_name = 'project_tasks'
--   AND column_name IN ('ball_state_code','ball_holder_user_id','ball_moved_at',
--                       'skip_internal_review','skip_client_review');
--
-- -- 5) projects の新規列がついていること
-- SELECT column_name, data_type, is_nullable, column_default
-- FROM information_schema.columns
-- WHERE table_name = 'projects'
--   AND column_name IN ('work_modes','maintenance_started_at');
