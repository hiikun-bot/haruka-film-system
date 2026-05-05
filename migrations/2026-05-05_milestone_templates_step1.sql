-- ============================================================================
-- マイルストーンテンプレ基盤 Step1: DB のみ
-- 案件種別 (projects.project_type) ごとに工程テンプレを持ち、
-- 案件作成時にクリエイティブ単位の実マイルストーンを展開できるようにする。
--
-- 注意:
--   - creatives.id は UUID なので、creative_milestones.creative_id も UUID。
--   - milestone_templates は独立マスターなので BIGSERIAL（仕様準拠）。
--   - UI/JS/API は今回触らない。並行運用のため draft_deadline / final_deadline は残す。
-- ============================================================================

-- ==================== milestone_templates（種別ごとの工程テンプレ）====================
CREATE TABLE IF NOT EXISTS milestone_templates (
  id BIGSERIAL PRIMARY KEY,
  project_type TEXT NOT NULL,        -- 'video' / 'lp' / 'hp' / 'design' / 'other'
  phase_key TEXT NOT NULL,           -- 'shooting' / 'wireframe' / 'coding' ...
  phase_label TEXT NOT NULL,         -- '撮影' / 'ワイヤー' / 'コーディング'
  sort_order INT NOT NULL,
  default_offset_days INT,           -- 案件開始日からの標準オフセット（NULL可）
  default_duration_days INT,         -- 工程の標準所要日数（NULL可）
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(project_type, phase_key)
);
CREATE INDEX IF NOT EXISTS idx_milestone_templates_type_order
  ON milestone_templates(project_type, sort_order);

-- ==================== creative_milestones（案件ごとの実マイルストーン）====================
CREATE TABLE IF NOT EXISTS creative_milestones (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creative_id UUID NOT NULL REFERENCES creatives(id) ON DELETE CASCADE,
  phase_key TEXT NOT NULL,
  phase_label TEXT NOT NULL,
  sort_order INT NOT NULL,
  start_date DATE,
  end_date DATE,
  status TEXT NOT NULL DEFAULT 'pending',  -- 'pending' / 'in_progress' / 'done' / 'skipped'
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(creative_id, phase_key)
);
CREATE INDEX IF NOT EXISTS idx_creative_milestones_creative
  ON creative_milestones(creative_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_creative_milestones_dates
  ON creative_milestones(start_date, end_date);

-- ============================================================================
-- 初期テンプレデータ
-- 既存フロントの _cvRowInfo (start → draft → clientCheck → final) と
-- 動画フロー（撮影 → 編集 → 初稿 → クラチェ → 修正 → 納品）を再現
-- ============================================================================

-- ---- video ----
INSERT INTO milestone_templates (project_type, phase_key, phase_label, sort_order)
VALUES
  ('video', 'shooting',     '撮影',             1),
  ('video', 'editing',      '編集',             2),
  ('video', 'draft',        '初稿',             3),
  ('video', 'client_check', 'クライアントチェック', 4),
  ('video', 'revision',     '修正',             5),
  ('video', 'delivery',     '納品',             6)
ON CONFLICT (project_type, phase_key) DO NOTHING;

-- ---- lp（ランディングページ）----
INSERT INTO milestone_templates (project_type, phase_key, phase_label, sort_order)
VALUES
  ('lp', 'hearing',   'ヒアリング',     1),
  ('lp', 'wireframe', 'ワイヤー',       2),
  ('lp', 'design',    'デザイン',       3),
  ('lp', 'coding',    'コーディング',   4),
  ('lp', 'review',    '検収',           5),
  ('lp', 'publish',   '公開',           6)
ON CONFLICT (project_type, phase_key) DO NOTHING;

-- ---- hp（ホームページ）----
INSERT INTO milestone_templates (project_type, phase_key, phase_label, sort_order)
VALUES
  ('hp', 'hearing',  'ヒアリング',     1),
  ('hp', 'sitemap',  'サイトマップ',   2),
  ('hp', 'design',   'デザイン',       3),
  ('hp', 'coding',   'コーディング',   4),
  ('hp', 'review',   '検収',           5),
  ('hp', 'publish',  '公開',           6)
ON CONFLICT (project_type, phase_key) DO NOTHING;

-- ---- design（バナー・サムネ等）----
INSERT INTO milestone_templates (project_type, phase_key, phase_label, sort_order)
VALUES
  ('design', 'hearing',  'ヒアリング', 1),
  ('design', 'draft',    '初稿',       2),
  ('design', 'revision', '修正',       3),
  ('design', 'delivery', '納品',       4)
ON CONFLICT (project_type, phase_key) DO NOTHING;

-- ============================================================================
-- 既存 video クリエイティブの埋め戻し
--   - フロントの _cvRowInfo 推定ロジックと整合
--   - start = creative_assignments.created_at の最古 → draft - 7日 → creatives.created_at
--   - draft = draft_deadline （NULLなら final - 7日）
--   - client_check = (draft + final) / 2  ※両方ある場合のみ
--   - final = final_deadline
--   - shooting / editing / revision / delivery は人が後から埋める前提のため INSERT しない
--   - LP/HP/design 既存案件は埋め戻し対象外（データ無し）
-- ============================================================================

-- start: assignments の最古 → draft - 7日 → creatives.created_at
INSERT INTO creative_milestones (creative_id, phase_key, phase_label, sort_order, start_date, end_date, status)
SELECT
  c.id,
  'shooting',
  '撮影',
  1,
  COALESCE(
    (SELECT MIN(ca.created_at)::date FROM creative_assignments ca WHERE ca.creative_id = c.id),
    (c.draft_deadline - INTERVAL '7 days')::date,
    c.created_at::date
  ) AS start_date,
  NULL,
  CASE
    WHEN COALESCE(
      (SELECT MIN(ca.created_at)::date FROM creative_assignments ca WHERE ca.creative_id = c.id),
      (c.draft_deadline - INTERVAL '7 days')::date,
      c.created_at::date
    ) < CURRENT_DATE THEN 'done'
    ELSE 'pending'
  END
FROM creatives c
JOIN projects p ON p.id = c.project_id
WHERE p.project_type = 'video'
  AND COALESCE(
    (SELECT MIN(ca.created_at)::date FROM creative_assignments ca WHERE ca.creative_id = c.id),
    (c.draft_deadline - INTERVAL '7 days')::date,
    c.created_at::date
  ) IS NOT NULL
ON CONFLICT (creative_id, phase_key) DO NOTHING;

-- draft: draft_deadline （NULLなら final - 7日）
INSERT INTO creative_milestones (creative_id, phase_key, phase_label, sort_order, start_date, end_date, status)
SELECT
  c.id,
  'draft',
  '初稿',
  3,
  NULL,
  COALESCE(c.draft_deadline, (c.final_deadline - INTERVAL '7 days')::date) AS end_date,
  CASE
    WHEN COALESCE(c.draft_deadline, (c.final_deadline - INTERVAL '7 days')::date) < CURRENT_DATE THEN 'done'
    ELSE 'pending'
  END
FROM creatives c
JOIN projects p ON p.id = c.project_id
WHERE p.project_type = 'video'
  AND COALESCE(c.draft_deadline, (c.final_deadline - INTERVAL '7 days')::date) IS NOT NULL
ON CONFLICT (creative_id, phase_key) DO NOTHING;

-- client_check: draft と final の中点（両方ある場合のみ）
INSERT INTO creative_milestones (creative_id, phase_key, phase_label, sort_order, start_date, end_date, status)
SELECT
  c.id,
  'client_check',
  'クライアントチェック',
  4,
  NULL,
  (c.draft_deadline + ((c.final_deadline - c.draft_deadline) / 2))::date AS end_date,
  CASE
    WHEN (c.draft_deadline + ((c.final_deadline - c.draft_deadline) / 2))::date < CURRENT_DATE THEN 'done'
    ELSE 'pending'
  END
FROM creatives c
JOIN projects p ON p.id = c.project_id
WHERE p.project_type = 'video'
  AND c.draft_deadline IS NOT NULL
  AND c.final_deadline IS NOT NULL
ON CONFLICT (creative_id, phase_key) DO NOTHING;

-- final: final_deadline
INSERT INTO creative_milestones (creative_id, phase_key, phase_label, sort_order, start_date, end_date, status)
SELECT
  c.id,
  'delivery',
  '納品',
  6,
  NULL,
  c.final_deadline,
  CASE WHEN c.final_deadline < CURRENT_DATE THEN 'done' ELSE 'pending' END
FROM creatives c
JOIN projects p ON p.id = c.project_id
WHERE p.project_type = 'video'
  AND c.final_deadline IS NOT NULL
ON CONFLICT (creative_id, phase_key) DO NOTHING;
