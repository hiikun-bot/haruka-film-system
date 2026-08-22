-- 2026-08-22 マイゴール拡張: 期間区分（短期/中期/長期）＋ KPI（何を何回する）
--
-- 背景:
--   ユーザー要望（2026-08-22）:
--   1. 目標に「短期目標・中期目標・長期目標」の区分を付けたい → personal_goals.term
--   2. 目標を達成するためのKPIを細分化したい（「それを達成するために何を何回する？」）
--      → personal_goal_kpis（例: 営業DMを100件送る、講座を10本見る。＋1ボタンでカウントアップ）
--   3. タスクをKPIに紐付けて「KPIを達成するために何をやるか」を管理できるように
--      → personal_tasks.kpi_id
--   ※ KPIは「しっかりやる人向け」機能。UIでは目標モーダルの「詳細設定」に折りたたみ、
--     ライト層には見えない（設定しない限り目標カードにも出ない）。
--
--   マイゴールは完全個人領域（ADR 032）: 本人以外（admin 含む）一切閲覧・操作不可。
--   RLSポリシーは書かない（全テーブル一括ENABLE済み・service_roleバイパス構成。アプリ層で100%担保）。
--
-- 本番Supabaseへの適用が必要。

-- 期間区分（任意）: short=短期 / mid=中期 / long=長期
ALTER TABLE personal_goals ADD COLUMN IF NOT EXISTS term TEXT CHECK (term IN ('short','mid','long'));

-- KPI: 「何を（title）」「何回（target_count）」「今何回（current_count）」
CREATE TABLE IF NOT EXISTS personal_goal_kpis (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  goal_id UUID NOT NULL REFERENCES personal_goals(id) ON DELETE CASCADE,
  title TEXT NOT NULL,                       -- 何を（例: 営業DMを送る）
  target_count NUMERIC NOT NULL DEFAULT 1,   -- 何回（目標値）
  current_count NUMERIC NOT NULL DEFAULT 0,  -- 現在の回数（＋1ボタン/手入力で更新）
  unit TEXT NOT NULL DEFAULT '回',           -- 単位（回/件/本/人/円 など自由入力）
  due_date DATE,                             -- KPIの期限（任意）
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_personal_goal_kpis_user_id ON personal_goal_kpis(user_id);
CREATE INDEX IF NOT EXISTS idx_personal_goal_kpis_goal_id ON personal_goal_kpis(goal_id);

-- タスクのKPI紐付け（任意）。KPI削除時は紐付けだけ外してタスクは残す
ALTER TABLE personal_tasks ADD COLUMN IF NOT EXISTS kpi_id UUID REFERENCES personal_goal_kpis(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_personal_tasks_kpi_id ON personal_tasks(kpi_id);

-- タスクの優先度（任意）: high=高 / mid=中 / low=低
-- ※「担当者」は追加しない（マイゴールは完全個人ツールで担当は常に本人のため）
ALTER TABLE personal_tasks ADD COLUMN IF NOT EXISTS priority TEXT CHECK (priority IN ('high','mid','low'));
