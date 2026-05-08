-- =====================================================
-- ADR 010: 案件スケジュール / フェーズ・タスク管理 Phase 1a
-- =====================================================
-- 目的:
--   LP / HP 等カテゴリ横断で、案件単位のフェーズ・タスク・マイルストーンを
--   管理するためのスキーマを新設する（クリエイティブ単位の進捗管理とは分離）。
--
-- このマイグレーションで行うこと:
--   1) project_phase_templates           : カテゴリ別タスク雛形（マスター）
--   2) project_phase_template_items      : 雛形のタスク項目（2階層）
--   3) project_tasks                     : 案件側タスク（2階層）
--   4) projects への列追加               : scheduled_start_date / active_phase_template_id
--   5) LP / HP 標準テンプレ seed
--
-- 冪等性:
--   CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS / ON CONFLICT を徹底し
--   二重実行しても破壊しない。seed は (template_id, sort_order) 一意制約で重複を防ぐ。
--
-- ロールアウト:
--   Phase 1a (このファイル): スキーマ + seed のみ。コード変更なし。
--   Phase 1b (次PR)         : backend / frontend を実装し supabase_schema.sql に同期。
--
-- 依存:
--   - creative_categories (Stage A) に 'lp' / 'hp' が seed 済みであること
--   - projects テーブル / users テーブルが存在すること
-- =====================================================

BEGIN;

-- -----------------------------------------------------
-- 1) project_phase_templates : カテゴリ別タスク雛形（マスター）
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS project_phase_templates (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id     UUID NOT NULL REFERENCES creative_categories(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,                 -- '標準LP工程' '標準HP工程' 等
  description     TEXT,
  is_default      BOOLEAN NOT NULL DEFAULT false, -- 案件作成時の初期適用フラグ
  is_active       BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_project_phase_templates_category
  ON project_phase_templates(category_id) WHERE is_active;

ALTER TABLE project_phase_templates ENABLE ROW LEVEL SECURITY;

-- カテゴリ × name で一意（seed の冪等性のため）
CREATE UNIQUE INDEX IF NOT EXISTS uniq_project_phase_templates_category_name
  ON project_phase_templates(category_id, name);

-- -----------------------------------------------------
-- 2) project_phase_template_items : 雛形のタスク項目（2階層）
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS project_phase_template_items (
  id                              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id                     UUID NOT NULL REFERENCES project_phase_templates(id) ON DELETE CASCADE,
  parent_item_id                  UUID REFERENCES project_phase_template_items(id) ON DELETE CASCADE,
  is_phase_header                 BOOLEAN NOT NULL DEFAULT false,
  title                           TEXT NOT NULL,
  default_offset_days_from_start  INT,
  default_duration_days           INT,
  default_assignee_type           TEXT NOT NULL DEFAULT 'us'
    CHECK (default_assignee_type IN ('us','client','meeting','milestone')),
  is_milestone                    BOOLEAN NOT NULL DEFAULT false,
  default_priority                TEXT NOT NULL DEFAULT 'normal'
    CHECK (default_priority IN ('low','normal','high')),
  default_note                    TEXT,
  sort_order                      INT NOT NULL DEFAULT 0,
  created_at                      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_project_phase_template_items_template
  ON project_phase_template_items(template_id, sort_order);

CREATE INDEX IF NOT EXISTS idx_project_phase_template_items_parent
  ON project_phase_template_items(parent_item_id) WHERE parent_item_id IS NOT NULL;

-- seed の冪等性のため (template_id, sort_order) を一意化
CREATE UNIQUE INDEX IF NOT EXISTS uniq_project_phase_template_items_sort
  ON project_phase_template_items(template_id, sort_order);

ALTER TABLE project_phase_template_items ENABLE ROW LEVEL SECURITY;

-- -----------------------------------------------------
-- 3) project_tasks : 案件側タスク（2階層）
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS project_tasks (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id         UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_task_id     UUID REFERENCES project_tasks(id) ON DELETE CASCADE,
  is_phase_header    BOOLEAN NOT NULL DEFAULT false,
  title              TEXT NOT NULL,
  start_date         DATE,
  original_end_date  DATE,        -- 元日程（変更前）
  current_end_date   DATE,        -- 新日程（現在予定）
  assignee_type      TEXT NOT NULL DEFAULT 'us'
    CHECK (assignee_type IN ('us','client','meeting','milestone')),
  assignee_user_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  is_milestone       BOOLEAN NOT NULL DEFAULT false,
  is_done            BOOLEAN NOT NULL DEFAULT false,
  done_at            TIMESTAMPTZ,
  priority           TEXT NOT NULL DEFAULT 'normal'
    CHECK (priority IN ('low','normal','high')),
  note               TEXT,
  sort_order         INT NOT NULL DEFAULT 0,
  template_item_id   UUID REFERENCES project_phase_template_items(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_project_tasks_project
  ON project_tasks(project_id, sort_order);

CREATE INDEX IF NOT EXISTS idx_project_tasks_assignee
  ON project_tasks(assignee_user_id)
  WHERE assignee_user_id IS NOT NULL AND NOT is_done;

CREATE INDEX IF NOT EXISTS idx_project_tasks_milestone
  ON project_tasks(current_end_date)
  WHERE is_milestone AND NOT is_done;

CREATE INDEX IF NOT EXISTS idx_project_tasks_parent
  ON project_tasks(parent_task_id) WHERE parent_task_id IS NOT NULL;

-- マイタスクパネルで「未完了かつ期日が近い」を引きやすくする補助
CREATE INDEX IF NOT EXISTS idx_project_tasks_assignee_due
  ON project_tasks(assignee_user_id, current_end_date)
  WHERE assignee_user_id IS NOT NULL AND NOT is_done;

ALTER TABLE project_tasks ENABLE ROW LEVEL SECURITY;

-- -----------------------------------------------------
-- 4) projects 列追加: scheduled_start_date / active_phase_template_id
-- -----------------------------------------------------
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS scheduled_start_date DATE;

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS active_phase_template_id UUID
  REFERENCES project_phase_templates(id) ON DELETE SET NULL;

-- =====================================================
-- 5) LP / HP 標準テンプレ seed
-- =====================================================

-- HP カテゴリは既に creative_categories に存在する想定だが、念のため UPSERT
INSERT INTO creative_categories (code, name, render_kind, sort_order, color)
VALUES ('hp', 'HP', 'longpage', 30, '#9333EA')
ON CONFLICT (code) DO NOTHING;

-- 5-1) LP 標準テンプレ本体
INSERT INTO project_phase_templates (category_id, name, description, is_default, is_active)
SELECT id, '標準LP工程', '5フェーズ・M1〜M6 マイルストーン構成（約40日）', true, true
FROM creative_categories WHERE code = 'lp'
ON CONFLICT (category_id, name) DO NOTHING;

-- 5-2) LP 標準テンプレ items
WITH tpl AS (
  SELECT pt.id AS template_id
  FROM project_phase_templates pt
  JOIN creative_categories cc ON cc.id = pt.category_id
  WHERE cc.code = 'lp' AND pt.name = '標準LP工程'
  LIMIT 1
)
INSERT INTO project_phase_template_items
  (template_id, is_phase_header, title,
   default_offset_days_from_start, default_duration_days,
   default_assignee_type, is_milestone, sort_order)
SELECT template_id, is_phase_header, title, offset_d, duration_d, assignee_type, is_milestone, sort_order
FROM tpl,
(VALUES
  -- ① ヒアリング ----------------------------------------------------------
  (true,  '①ヒアリング',                        0,  4, 'us',         false,  10),
  (false, '初回ヒアリング/要件確認',            0,  1, 'meeting',    false,  20),
  (false, '素材リスト提示・不足確認',           1,  1, 'us',         false,  30),
  (false, '構成テキスト受領',                   2,  2, 'client',     false,  40),
  (false, 'ブランドガイド・素材・ロゴ受領',     2,  2, 'client',     false,  50),
  (false, '掲載先レギュレーション確認',         3,  1, 'us',         false,  60),
  (false, '質問事項最終回答受領',               4,  1, 'client',     false,  70),
  (false, '★M1 ヒアリング完了',                 4,  0, 'milestone',  true,   80),
  -- ② ワイヤー ------------------------------------------------------------
  (true,  '②ワイヤー',                          5,  5, 'us',         false,  90),
  (false, '情報設計・ワイヤー制作',             5,  4, 'us',         false, 100),
  (false, 'ワイヤー社内レビュー・修正',         8,  2, 'us',         false, 110),
  -- ③ デザイン ------------------------------------------------------------
  (true,  '③デザイン',                         10, 15, 'us',         false, 120),
  (false, 'デザインカンプ制作',                10,  4, 'us',         false, 130),
  (false, '★M2 デザイン初稿社内完成',          14,  0, 'milestone',  true,  140),
  (false, '★M3 デザイン初稿先方提出',          15,  0, 'milestone',  true,  150),
  (false, '先方レビュー(1回目FB)',             15,  2, 'client',     false, 160),
  (false, 'デザイン修正(1回目)',               17,  3, 'us',         false, 170),
  (false, '先方レビュー(2回目FB)',             20,  2, 'client',     false, 180),
  (false, 'デザイン最終調整',                  22,  2, 'us',         false, 190),
  (false, '★M4 デザイン確定(FIX)',             24,  0, 'milestone',  true,  200),
  -- ④ コーディング --------------------------------------------------------
  (true,  '④コーディング',                     25,  8, 'us',         false, 210),
  (false, 'HTML構造/基本CSS実装',              25,  3, 'us',         false, 220),
  (false, 'レスポンシブ対応(SP最適化)',        28,  2, 'us',         false, 230),
  (false, 'アニメーション・JS実装',            30,  2, 'us',         false, 240),
  (false, 'ガイドライン準拠チェック',          32,  1, 'us',         false, 250),
  -- ⑤ QA・納品 -----------------------------------------------------------
  (true,  '⑤QA・納品',                         33,  7, 'us',         false, 260),
  (false, '社内QA(各ブラウザ・各端末)',        33,  2, 'us',         false, 270),
  (false, '★M5 先方確認用コーディング提出',    35,  0, 'milestone',  true,  280),
  (false, '先方確認・最終FB受領',              35,  2, 'client',     false, 290),
  (false, '最終修正対応',                      37,  2, 'us',         false, 300),
  (false, '★M6 最終納品',                      39,  0, 'milestone',  true,  310),
  (false, '予備日・緊急対応バッファ',          39,  1, 'us',         false, 320)
) AS v(is_phase_header, title, offset_d, duration_d, assignee_type, is_milestone, sort_order)
ON CONFLICT (template_id, sort_order) DO NOTHING;

-- 5-3) HP 標準テンプレ本体
INSERT INTO project_phase_templates (category_id, name, description, is_default, is_active)
SELECT id, '標準HP工程', '3フェーズ構成（ティザー → 本サイト制作 → 実装・公開）', true, true
FROM creative_categories WHERE code = 'hp'
ON CONFLICT (category_id, name) DO NOTHING;

-- 5-4) HP 標準テンプレ items
WITH tpl AS (
  SELECT pt.id AS template_id
  FROM project_phase_templates pt
  JOIN creative_categories cc ON cc.id = pt.category_id
  WHERE cc.code = 'hp' AND pt.name = '標準HP工程'
  LIMIT 1
)
INSERT INTO project_phase_template_items
  (template_id, is_phase_header, title,
   default_offset_days_from_start, default_duration_days,
   default_assignee_type, is_milestone, sort_order)
SELECT template_id, is_phase_header, title, offset_d, duration_d, assignee_type, is_milestone, sort_order
FROM tpl,
(VALUES
  -- 【ティザー公開まで】 ---------------------------------------------------
  (true,  '【ティザー公開まで】',                       0,  21, 'us',        false,  10),
  (false, 'ヒアリングシート共有',                       0,   1, 'us',        false,  20),
  (false, 'ヒアリング実施',                             1,   1, 'meeting',   false,  30),
  (false, 'サーバー・ドメイン契約/WP開設',              2,   5, 'client',    false,  40),
  (false, 'ロゴ・テキスト共有(ティザー用)',             2,   5, 'client',    false,  50),
  (false, 'ドメイン移管手続き',                         3,   7, 'client',    false,  60),
  (false, 'ティザーサイト テストサイト作成',           10,   4, 'us',        false,  70),
  (false, 'ティザーサイト実装',                        14,   5, 'us',        false,  80),
  (false, '★ティザーサイト公開',                       21,   0, 'milestone', true,   90),
  -- 【本サイト制作フェーズ】 -----------------------------------------------
  (true,  '【本サイト制作フェーズ】',                  22,  35, 'us',        false, 100),
  (false, 'サービス内容・コンテンツ確定',              22,   5, 'client',    false, 110),
  (false, '本番用テキスト・素材の共有',                22,   7, 'client',    false, 120),
  (false, 'サイトマップ提出',                          27,   3, 'us',        false, 130),
  (false, '打ち合わせ：方向性確認',                    30,   1, 'meeting',   false, 140),
  (false, 'ワイヤーフレーム提出',                      31,   5, 'us',        false, 150),
  (false, '打ち合わせ：必要に応じて',                  36,   1, 'meeting',   false, 160),
  (false, 'デザインと構築を同時進行',                  37,  18, 'us',        false, 170),
  (false, '打ち合わせ：必要に応じて',                  50,   1, 'meeting',   false, 180),
  -- 【実装・公開フェーズ】 -------------------------------------------------
  (true,  '【実装・公開フェーズ】',                    55,  30, 'us',        false, 190),
  (false, '予約/問い合わせシステムのアカウント作成',   55,   2, 'client',    false, 200),
  (false, 'ティザーサイトに予約ボタン設置/予約開始',   57,   2, 'us',        false, 210),
  (false, '撮影',                                      60,   1, 'meeting',   false, 220),
  (false, '撮影(別日設定)',                            62,   1, 'meeting',   false, 230),
  (false, '撮影素材共有',                              63,   2, 'client',    false, 240),
  (false, 'SNS初期設定',                               65,   2, 'us',        false, 250),
  (false, '写真の差し替え',                            67,   2, 'us',        false, 260),
  (false, '★プレ公開イベント(内覧会等)',               70,   0, 'milestone', true,  270),
  (false, 'テストサイト提出',                          72,   2, 'us',        false, 280),
  (false, 'サイト全体の修正フィードバック',            74,   3, 'client',    false, 290),
  (false, '★公開日',                                   85,   0, 'milestone', true,  300),
  (false, 'カラーやデザインの最終確定',                77,   3, 'client',    false, 310),
  (false, '基本的なSEO設定とセキュリティ設定',         80,   2, 'us',        false, 320),
  (false, '最終チェック/テストアップ',                 82,   2, 'meeting',   false, 330),
  (false, '最終調整',                                  84,   1, 'us',        false, 340)
) AS v(is_phase_header, title, offset_d, duration_d, assignee_type, is_milestone, sort_order)
ON CONFLICT (template_id, sort_order) DO NOTHING;

COMMIT;

-- =====================================================
-- 適用後の検証クエリ（任意・コメント）
-- =====================================================
-- SELECT pt.name, cc.code, pt.is_default,
--   (SELECT COUNT(*) FROM project_phase_template_items i WHERE i.template_id = pt.id) AS item_count
-- FROM project_phase_templates pt
-- JOIN creative_categories cc ON cc.id = pt.category_id
-- ORDER BY cc.sort_order;
--
-- 期待結果:
--   標準LP工程 / lp / true / 27
--   標準HP工程 / hp / true / 33
