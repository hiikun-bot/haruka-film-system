-- ADR 026: 支払い本数カウントの基準を「納品完了日時（delivered_at）」に変更する。
--
-- 背景:
--   現行の集計（aggregateCreatorSummary / aggregateCreativeByAssignee の delivered モード、
--   /invoices/preview-items）は final_deadline（最終締切日）で対象月を判定している。
--   そのため「締切 6/30 の案件を 7/1 に納品完了にした」場合も 6 月扱いになり、
--   メンバーの実請求（実際に納品した月ベース）とズレる。
--
-- 新ルール（ユーザー決定 2026-07-02）:
--   - その月の最終日 23:59（JST）までに「納品」ステータスになったものだけを当月本数にカウントする。
--   - 7/1 に納品完了になったものは 7 月扱い。
--   - delivered_at は管理者が補正でき、補正すればカウント月も変わる（Stage 2 で編集 UI 追加）。
--
-- この migration は Stage 1（列追加 + backfill のみ）。コード側の参照切替は Stage 2 で行う。

ALTER TABLE creatives ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;

COMMENT ON COLUMN creatives.delivered_at IS
  '納品完了日時（status が「納品」になった実時刻）。支払い本数カウントは JST でこの月を判定する（ADR 026）。管理者補正可。';

-- 集計は「delivered_at が当月範囲」で引くため部分インデックスを張る
CREATE INDEX IF NOT EXISTS idx_creatives_delivered_at
  ON creatives (delivered_at)
  WHERE delivered_at IS NOT NULL;

-- ==================== Backfill（納品済みのみ対象） ====================

-- 1) creative_status_transitions の最後の「→納品」遷移時刻（2026-05-09 以降は全遷移が記録されている）
UPDATE creatives c
   SET delivered_at = t.last_delivered_at
  FROM (
    SELECT creative_id, MAX(changed_at) AS last_delivered_at
      FROM creative_status_transitions
     WHERE to_status = '納品'
     GROUP BY creative_id
  ) t
 WHERE c.id = t.creative_id
   AND c.status = '納品'
   AND c.delivered_at IS NULL;

-- 2) 納品完了モード（強制納品）の実時刻
UPDATE creatives
   SET delivered_at = force_delivered_at
 WHERE status = '納品'
   AND delivered_at IS NULL
   AND force_delivered_at IS NOT NULL;

-- 3) 履歴が無い古い納品分は final_deadline（JST 0時）で埋め、従来カウントと同じ月に揃える
--    （final_deadline は DATE 列。JST の 0 時として timestamptz 化する）
UPDATE creatives
   SET delivered_at = (final_deadline::timestamp AT TIME ZONE 'Asia/Tokyo')
 WHERE status = '納品'
   AND delivered_at IS NULL
   AND final_deadline IS NOT NULL;

-- 4) それも無い行は updated_at で埋める（最終保険。件数はごく少数の想定）
UPDATE creatives
   SET delivered_at = updated_at
 WHERE status = '納品'
   AND delivered_at IS NULL;
