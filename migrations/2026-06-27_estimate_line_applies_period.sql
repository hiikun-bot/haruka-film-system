-- ADR 025: 成果物グループ（見積明細）に「適用期間」を持たせ、削除せず停止できるようにする
-- https://github.com/hiikun-bot/haruka-film-system/blob/main/docs/design/decisions/025-estimate-line-applies-period.md
--
-- 背景:
--   同じ内容の成果物グループ（例:【踏襲】静止画）が単価違いで複数残ることがある。
--   過去の単価グループは紐付くクリエイティブがあるため削除できない（履歴保護で正しい挙動）。
--   しかし削除できないままだと「どれが現役か」判別できない。
--   → 削除の代わりに「停止」できるようにし、内部的に適用期間（開始日/終了日）で管理する。
--
-- モデル:
--   applies_from … 適用開始日（DATE）。INSERT 時に JST 当日を既定値で入れる。
--   applies_to   … 適用終了日（DATE, NULL 可）。
--   有効 ⇔ applies_to IS NULL ／ 停止 ⇔ applies_to に日付。
--   UI の「停止/再開」トグルがフックとなり、停止で applies_to=当日(JST)、再開で applies_to=NULL に戻す。
--
-- ※ 本機能リリース時点の既存グループは、適用開始日を一律で本日（2026-06-27 JST）に統一する。

-- 1) 適用開始日（既定値は JST 当日。Supabase/Railway は UTC 稼働のため Asia/Tokyo へ変換してから日付化）
ALTER TABLE project_estimate_lines
  ADD COLUMN IF NOT EXISTS applies_from DATE
  DEFAULT ((now() AT TIME ZONE 'Asia/Tokyo')::date);
COMMENT ON COLUMN project_estimate_lines.applies_from IS
  'ADR 025: 成果物グループ（単価）の適用開始日。既定値は JST 当日。';

-- 2) 適用終了日（NULL=現役 / 日付=停止）
ALTER TABLE project_estimate_lines
  ADD COLUMN IF NOT EXISTS applies_to DATE;
COMMENT ON COLUMN project_estimate_lines.applies_to IS
  'ADR 025: 成果物グループ（単価）の適用終了日。NULL=現役、日付あり=停止。UI の停止/再開トグルが当日(JST)/NULL を入れる。';

-- 3) 既存行の適用開始日を本機能リリース日（2026-06-27 JST）に一律統一。
--    applies_to は NULL のまま（=すべて現役）。
UPDATE project_estimate_lines
SET applies_from = DATE '2026-06-27'
WHERE applies_from IS NULL;
