-- ADR 008 Stage 2: 既存の未設定チームに手動で leader を割り当てるシード
--
-- Stage 1 の backfill は teams.director_id ベース（director がいるチームのみ leader 化）。
-- 一方、ディレクター役職者がいないチーム（秘書チーム / デザインチーム）は backfill 対象外で、
-- このシードで手動補完する。スクショ確認済み: 南成美 さん / 片山紗季 さん。
--
-- 表記揺れ（半角/全角スペース、姓名間スペースの有無）に対応するため LIKE で曖昧マッチ。
-- 既に他者が leader 設定済みのチームは leader_rank IS NULL の条件で巻き込まずスキップする。

-- Sチーム（秘書チーム）: 南成美 さん
UPDATE team_members tm
SET leader_rank = 'leader'
FROM teams t, users u
WHERE tm.team_id = t.id
  AND tm.user_id = u.id
  AND t.team_code = 'S'
  AND u.full_name LIKE '%南%成美%'
  AND tm.leader_rank IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM team_members tm2
    WHERE tm2.team_id = t.id AND tm2.leader_rank = 'leader'
  );

-- Pチーム（デザインチーム全員）: 片山紗季 さん
UPDATE team_members tm
SET leader_rank = 'leader'
FROM teams t, users u
WHERE tm.team_id = t.id
  AND tm.user_id = u.id
  AND t.team_code = 'P'
  AND u.full_name LIKE '%片山%紗季%'
  AND tm.leader_rank IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM team_members tm2
    WHERE tm2.team_id = t.id AND tm2.leader_rank = 'leader'
  );

NOTIFY pgrst, 'reload schema';
