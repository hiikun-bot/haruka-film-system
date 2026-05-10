-- クライアント-チーム 中間表を新設
CREATE TABLE IF NOT EXISTS client_teams (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(client_id, team_id)
);
CREATE INDEX IF NOT EXISTS idx_client_teams_client ON client_teams(client_id);
CREATE INDEX IF NOT EXISTS idx_client_teams_team ON client_teams(team_id);

NOTIFY pgrst, 'reload schema';
