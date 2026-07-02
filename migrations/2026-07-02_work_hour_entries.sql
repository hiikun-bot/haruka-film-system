-- ADR 028: 作業時間報告（タイムシート）— 時給制の支払い・請求をシステムに取り込む。
--
-- 背景:
--   秘書業（必ず時給）とハビー等の案件時給（支払1,500円/h・請求2,500円/h）が
--   スプレッドシート精算でシステムに載っていない。既存の「作業時間報告書」
--   フォーマット（日付/開始/終了/稼働分/業務内容/立替経費/領収書）を正として取り込む。
--
-- この migration は Stage 1（テーブル・列の追加のみ）。UI・集計反映は Stage 2。

-- 時給制メンバーの明示（NULL = 時給制ではない）。メンバー画面で「時給制」表示に使う。
ALTER TABLE users ADD COLUMN IF NOT EXISTS hourly_rate INTEGER;
ALTER TABLE users ADD COLUMN IF NOT EXISTS hourly_note TEXT;
COMMENT ON COLUMN users.hourly_rate IS 'ADR 028: 既定の支払時給（円/h）。NULL=時給制ではない。秘書は必ず設定する';
COMMENT ON COLUMN users.hourly_note IS 'ADR 028: 時給の用途説明（例: 秘書業）。時給制メンバーの表示に使う';

-- 日別タイムシート
CREATE TABLE IF NOT EXISTS work_hour_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  work_date DATE NOT NULL,
  start_time TIME,
  end_time TIME,
  minutes INTEGER NOT NULL CHECK (minutes >= 0),
  description TEXT,
  project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
  line_id UUID REFERENCES project_estimate_lines(id) ON DELETE SET NULL,
  hourly_rate_applied INTEGER,
  client_hourly_rate_applied INTEGER,
  expense_amount INTEGER DEFAULT 0,
  expense_note TEXT,
  receipt_submitted BOOLEAN DEFAULT false,
  status TEXT DEFAULT 'draft',
  confirmed_by UUID REFERENCES users(id),
  confirmed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT work_hour_entries_status_check CHECK (status IN ('draft', 'confirmed'))
);

COMMENT ON TABLE work_hour_entries IS
  'ADR 028: 作業時間報告（日別タイムシート）。時給×時間＋立替経費を月次で支払い集計・請求プレビューに合算する。単価は登録時スナップショット（*_applied）。';
COMMENT ON COLUMN work_hour_entries.minutes IS '稼働分。開始/終了から自動計算（手修正可）。h換算は 分÷60 の小数第3位以下切り捨て';
COMMENT ON COLUMN work_hour_entries.project_id IS 'NULL = 秘書業等の案件非紐付き。案件時給（ハビー等）はセット';
COMMENT ON COLUMN work_hour_entries.hourly_rate_applied IS '登録時点の支払時給（円/h）スナップショット。時給改定しても過去は不変';
COMMENT ON COLUMN work_hour_entries.client_hourly_rate_applied IS '登録時点の請求時給（円/h）。案件紐付き時のみ（時間制lineのclient_unit_priceを時間単価として解釈）';
COMMENT ON COLUMN work_hour_entries.status IS 'draft=本人編集可 / confirmed=管理側確認済み（本人編集ロック）';

-- 月次集計・本人一覧用インデックス
CREATE INDEX IF NOT EXISTS idx_whe_user_date ON work_hour_entries (user_id, work_date DESC);
CREATE INDEX IF NOT EXISTS idx_whe_date ON work_hour_entries (work_date);
CREATE INDEX IF NOT EXISTS idx_whe_project ON work_hour_entries (project_id) WHERE project_id IS NOT NULL;
