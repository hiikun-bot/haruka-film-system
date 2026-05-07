-- ADR 008: チームリーダーを役職と独立した「業務上の連絡窓口」として持つ
-- Stage 1: leader_rank カラム追加 + backfill
--
-- 役職（users.role）とは独立した、チーム単位の連絡窓口属性。
-- 'leader' は 1 チーム最大 1 人（部分 unique index）、'sub_leader' は複数可、NULL = 一般メンバー。
-- バックフィルにより既存 teams.director_id に紐づく team_members 行へ leader を自動付与する。

ALTER TABLE team_members
  ADD COLUMN IF NOT EXISTS leader_rank text
  CHECK (leader_rank IS NULL OR leader_rank IN ('leader', 'sub_leader'));

-- 1 チームに leader は 1 人まで（サブリーダーは複数可）
CREATE UNIQUE INDEX IF NOT EXISTS uniq_team_members_leader
  ON team_members(team_id) WHERE leader_rank = 'leader';

-- バッジ判定で使うインデックス（team_id でフィルタ + leader_rank で絞る WHERE 検索を高速化）
CREATE INDEX IF NOT EXISTS idx_team_members_team_leader_rank
  ON team_members(team_id, leader_rank) WHERE leader_rank IS NOT NULL;

-- backfill: teams.director_id に紐づく team_members 行を leader にコピー
UPDATE team_members tm
SET leader_rank = 'leader'
FROM teams t
WHERE tm.team_id = t.id
  AND tm.user_id = t.director_id
  AND tm.leader_rank IS NULL
  AND t.director_id IS NOT NULL;

NOTIFY pgrst, 'reload schema';
