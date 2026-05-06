-- =====================================================
-- 2026-05-06: 移行 line の status と planned_count を実用値に整える
-- =====================================================
-- 経緯:
--   Stage 2 (migrations/2026-05-06_migrate_rates_to_lines.sql) は移行 line を
--   すべて status='estimated', planned_count=0 で挿入した。
--   Stage 3 (accounting.js リライト) で ADR 005 集計フィルタ
--   (status IN ('contracted','in_progress','delivered')) と
--   ADR 002 per-line 公式 (client_unit_price × planned_count) に乗せると、
--   過去案件の数字がゼロになる問題を本スクリプトで解消する。
--
-- 対象:
--   name に「(旧 ... 移行)」または「クライアント単価 (旧 project_client_fees 移行)」を含む line
--   （Stage 2 で作った行）
--   通常運用で作られた line（Stage 4 UI 経由）はマーカーが無いので影響しない
--
-- 冪等性:
--   - status は status='estimated' のものだけ更新するので再実行しても二重に進まない
--   - planned_count は planned_count=0 のものだけ更新するので再実行で増えない
--   - BEGIN/COMMIT でラップ
-- =====================================================

BEGIN;

-- 1) 移行 line の status を 'in_progress' に進める
--    ADR 005 の集計フィルタ ('contracted','in_progress','delivered') に乗るようにする
UPDATE project_estimate_lines
   SET status = 'in_progress',
       status_changed_at = COALESCE(status_changed_at, now())
 WHERE status = 'estimated'
   AND (
        name LIKE '%(旧 project_rates 移行)%'
     OR name LIKE '%(旧 project_director_rates 移行)%'
     OR name LIKE '%(旧 project_producer_rates 移行)%'
     OR name LIKE '%クライアント単価 (旧 project_client_fees 移行)%'
   );

-- 2) 移行 line の planned_count を、紐付いた creatives 件数で埋める
--    ADR 002 per-line 公式 (client_unit_price × planned_count) で
--    過去の売上/原価が再現できるようにする
UPDATE project_estimate_lines pel
   SET planned_count = sub.cnt
  FROM (
    SELECT line_id, COUNT(*) AS cnt
      FROM creatives
     WHERE line_id IS NOT NULL
     GROUP BY line_id
  ) sub
 WHERE pel.id = sub.line_id
   AND pel.planned_count = 0;

-- 検証ログ
DO $$
DECLARE
  total_lines INTEGER;
  remain_zero_count INTEGER;
  remain_estimated INTEGER;
BEGIN
  SELECT COUNT(*) INTO total_lines FROM project_estimate_lines;
  SELECT COUNT(*) INTO remain_zero_count FROM project_estimate_lines WHERE planned_count = 0;
  SELECT COUNT(*) INTO remain_estimated FROM project_estimate_lines WHERE status = 'estimated';

  RAISE NOTICE 'project_estimate_lines total = %', total_lines;
  RAISE NOTICE '  planned_count=0 残り = % (creatives.line_id 未紐付け line / または手入力前提)', remain_zero_count;
  RAISE NOTICE '  status=estimated 残り = % (移行マーカー無しの新規 line のみ残るはず)', remain_estimated;
END $$;

COMMIT;
