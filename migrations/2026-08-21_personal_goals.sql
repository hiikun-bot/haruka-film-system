-- 2026-08-21 マイゴール（完全個人の目標・タスク管理）
--
-- 背景:
--   個人の目標（例: 法人設立）と、その達成に向けたタスクを「大分類 → 中分類 → タスク」の
--   3階層で管理する「🎯 マイゴール」ページ用テーブル。目標とタスクは分けて管理し、
--   タスクは goal_id で目標に紐付け可能（紐付けなしタスクも許容）。
--
--   ⚠️ 完全個人領域: 本人以外（admin 含む）は一切閲覧・操作できない（件数すら見せない）。
--   プライバシーはアプリ層で100%担保する（routes/haruka.js の全エンドポイントが
--   requireAuth のみ + req.user.id を条件に使用。admin バイパス禁止。ADR 032）。
--   RLS ポリシーは書かない（全テーブル一括 ENABLE 済み・service_role バイパス構成のため）。
--   role_permissions への INSERT も不要（permission key 無し・全ロール利用可）。
--
-- 本番Supabaseへの適用が必要。

-- 目標（ページ上部に常時固定表示・目標日カウントダウン付き）
CREATE TABLE IF NOT EXISTS personal_goals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  purpose TEXT,                -- なぜやるのか（任意）
  emoji TEXT,                  -- 表示用絵文字（任意）
  target_date DATE,            -- 目標日（カウントダウン用）
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','achieved','archived')),
  achieved_at TIMESTAMPTZ,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- タスク（大分類・中分類はテキスト自由入力。目標削除時は紐付けだけ外して残す）
CREATE TABLE IF NOT EXISTS personal_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  goal_id UUID REFERENCES personal_goals(id) ON DELETE SET NULL,
  major_category TEXT,         -- 大分類（任意）
  mid_category TEXT,           -- 中分類（任意）
  title TEXT NOT NULL,
  detail TEXT,
  memo TEXT,
  link_url TEXT,               -- 資料URL
  due_date DATE,
  status TEXT NOT NULL DEFAULT '未着手' CHECK (status IN ('未着手','進行中','完了')),
  completed_at TIMESTAMPTZ,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- FK列・絞り込み用インデックス
CREATE INDEX IF NOT EXISTS idx_personal_goals_user_id     ON personal_goals(user_id);
CREATE INDEX IF NOT EXISTS idx_personal_tasks_user_id     ON personal_tasks(user_id);
CREATE INDEX IF NOT EXISTS idx_personal_tasks_goal_id     ON personal_tasks(goal_id);
CREATE INDEX IF NOT EXISTS idx_personal_tasks_user_status ON personal_tasks(user_id, status);
CREATE INDEX IF NOT EXISTS idx_personal_tasks_due_date    ON personal_tasks(due_date);
