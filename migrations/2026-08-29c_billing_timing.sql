-- ADR 034: 案件単位で計上タイミングを「納品時」/「初稿提出時」に切り替える
--
-- 背景:
--   案件によって「初稿提出時に費用請求できる」ものと「納品完了後に費用請求できる」ものがある。
--   初稿提出済み = クリエイティブが「クライアントチェック中」以降に入ったこと（先方チェックにボールが渡った時点）。
--   これまで計上月は delivered_at 固定（ADR 026）だったが、案件別に初稿提出月へ寄せられるようにする。
--
-- 影響:
--   - projects.billing_timing: 案件の計上タイミング区分（既定 on_delivery ＝ 現行と同じ挙動）
--   - creatives.first_draft_submitted_at: 初稿提出日時（「クライアントチェック中」初到達時刻）
--
-- 冪等: IF NOT EXISTS / DEFAULT 付き ADD COLUMN のみ。既存行はすべて on_delivery 扱いで計上結果は不変。

-- 1) 案件ごとの計上タイミング区分
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS billing_timing TEXT NOT NULL DEFAULT 'on_delivery';

-- CHECK 制約（存在しなければ追加）
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'projects_billing_timing_check'
  ) THEN
    ALTER TABLE projects
      ADD CONSTRAINT projects_billing_timing_check
      CHECK (billing_timing IN ('on_delivery', 'on_first_draft'));
  END IF;
END $$;

COMMENT ON COLUMN projects.billing_timing IS
  'ADR034: 計上タイミング区分。on_delivery=納品完了月に計上（既定）/ on_first_draft=初稿提出（クライアントチェック中到達）月に計上。支払い・売上の両方に適用。一式lineはinstallments優先で本区分は作用しない。';

-- 2) 初稿提出日時（「クライアントチェック中」へ初到達した時刻）
ALTER TABLE creatives
  ADD COLUMN IF NOT EXISTS first_draft_submitted_at TIMESTAMPTZ;

COMMENT ON COLUMN creatives.first_draft_submitted_at IS
  'ADR034: 初稿提出日時。ステータスが「クライアントチェック中」へ初到達した瞬間に記録し、以後は保持（手戻りでもNULLに戻さない）。billing_timing=on_first_draft の案件で計上月の基準になる。';

-- 3) 過去分 backfill: creative_status_transitions から「クライアントチェック中」への最初の遷移時刻を復元
UPDATE creatives c
SET first_draft_submitted_at = t.first_cl
FROM (
  SELECT creative_id, MIN(changed_at) AS first_cl
  FROM creative_status_transitions
  WHERE to_status = 'クライアントチェック中'
  GROUP BY creative_id
) t
WHERE c.id = t.creative_id
  AND c.first_draft_submitted_at IS NULL;
