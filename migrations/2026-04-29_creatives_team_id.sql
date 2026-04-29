-- creatives にチームを独立保存（担当者の team_id 派生から脱却）
-- 既存表示を壊さないため nullable で追加。NULL のときはアプリ側で従来の派生ロジックにフォールバック。
ALTER TABLE creatives ADD COLUMN IF NOT EXISTS team_id UUID REFERENCES teams(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_creatives_team_id ON creatives(team_id);
