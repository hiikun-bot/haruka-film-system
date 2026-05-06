-- =====================================================
-- Stage 2: 旧 rates 系テーブルから project_estimate_lines / line_costs / fixed_items へのデータ移行
-- =====================================================
-- 関連 ADR:
--   - ADR 002: docs/design/decisions/002-estimate-lines-unify-deliverable-rates.md
--   - ADR 003: docs/design/decisions/003-roles-as-master-data.md (role_id への変換)
--   - ADR 004: docs/design/decisions/004-pricing-extensibility.md
--   - ADR 005: docs/design/decisions/005-estimate-deliverable-lifecycle.md
--   - ADR 006: docs/design/decisions/006-project-fixed-costs.md
--
-- 前提:
--   - Stage 1 (PR #316): project_estimate_lines / project_estimate_line_costs /
--     project_fixed_items / creatives.line_id / invoice_items.line_id 適用済
--   - PR #310: roles マスタ (admin/secretary/producer/director/sub_producer/sub_director/editor/designer)
--   - Stage A (2026-05-05_creative_categories.sql): creative_categories マスタ /
--     project_category_rates 縦持ち化適用済
--
-- ⚠️ 適用前の検証クエリ（手動で実行・件数と合計を控える）:
--
--   SELECT 'project_rates'           AS tbl, COUNT(*) AS rows,
--          COALESCE(SUM(COALESCE(base_fee,0)+COALESCE(script_fee,0)
--                       +COALESCE(ai_fee,0)+COALESCE(other_fee,0)),0) AS total
--     FROM project_rates
--   UNION ALL
--   SELECT 'project_director_rates', COUNT(*), COALESCE(SUM(director_fee),0) FROM project_director_rates
--   UNION ALL
--   SELECT 'project_producer_rates', COUNT(*), COALESCE(SUM(producer_fee),0) FROM project_producer_rates
--   UNION ALL
--   SELECT 'project_rate_extras',    COUNT(*), COALESCE(SUM(fee),0) FROM project_rate_extras
--   UNION ALL
--   SELECT 'project_client_fees',    COUNT(*),
--          COALESCE(SUM(COALESCE(video_unit_price,0)+COALESCE(design_unit_price,0)
--                       +COALESCE(fixed_budget,0)),0)
--     FROM project_client_fees
--   UNION ALL
--   SELECT 'project_category_rates', COUNT(*),
--          COALESCE(SUM(COALESCE(unit_price,0)+COALESCE(director_unit_price,0)+COALESCE(producer_unit_price,0)),0)
--     FROM project_category_rates;
--
--   -- 既存 lines / line_costs / fixed_items の確認（再実行時のための初期状態把握）
--   SELECT 'project_estimate_lines',      COUNT(*) FROM project_estimate_lines
--   UNION ALL
--   SELECT 'project_estimate_line_costs', COUNT(*) FROM project_estimate_line_costs
--   UNION ALL
--   SELECT 'project_fixed_items',         COUNT(*) FROM project_fixed_items;
--
--   -- 旧 rates の creative_type 値分布（'video' / 'design' のみのはず）
--   SELECT 'project_rates', creative_type, COUNT(*) FROM project_rates GROUP BY 2
--   UNION ALL
--   SELECT 'project_director_rates', creative_type, COUNT(*) FROM project_director_rates GROUP BY 2
--   UNION ALL
--   SELECT 'project_producer_rates', creative_type, COUNT(*) FROM project_producer_rates GROUP BY 2
--   UNION ALL
--   SELECT 'project_rate_extras',    creative_type, COUNT(*) FROM project_rate_extras GROUP BY 2
--   ORDER BY 1, 2;
--
--   -- creatives.creative_type の値分布 (line_id バックフィル戦略の参考)
--   SELECT creative_type, COUNT(*) FROM creatives GROUP BY 1 ORDER BY 1;
--
-- =====================================================
-- マッピング戦略（採用）
-- =====================================================
--
-- ＜source = project_rates＞ (rank A/B/C × creative_type {video|design})
--   1 row → 1 line + 1 line_cost(role=editor for video / role=designer for design)
--   line.name              = '<カテゴリ名> <rank>ランク (旧 project_rates 移行)'
--   line.category_id       = video → 'video' / design → 'image'
--                            (Stage A creative_categories.sql の規則を踏襲)
--   line.planned_count     = 0  (実際の本数は creatives 件数だが、
--                                 rank 単位の集計が複雑なので Stage 4 UI で手動入力)
--   line.client_unit_price = 0  (project_rates は内部単価のみ。
--                                 クライアント請求単価は project_client_fees にある)
--   line.status            = 'estimated'  (既に発生したデータと見做す)
--   line_cost.role_id      = video→editor / design→designer
--   line_cost.unit_price   = base_fee + script_fee + ai_fee + other_fee
--   line_cost.pricing_type = 'fixed_per_unit'
--
-- ＜source = project_director_rates＞ (creative_type × director_fee, rank なし)
--   - rank なしなので、上で作った同じ project + category の lines 全件にコピーする
--     (rank A/B/C で同じディレクション費が掛かる旧仕様を踏襲)
--   - 該当カテゴリの lines が無ければ新規 line(rank=NULL, planned_count=0, client_unit_price=0) を作って付ける
--   line_cost.role_id      = director
--   line_cost.unit_price   = director_fee
--
-- ＜source = project_producer_rates＞ (creative_type × producer_fee, rank なし)
--   project_director_rates と同パターン
--   line_cost.role_id      = producer
--
-- ＜source = project_rate_extras＞ (project_id × creative_type × name × fee)
--   line ではなく project_fixed_items(item_type='expense') へ移行
--     理由: ADR 006 にて line_costs か fixed_items どちらか不明、と書かれていたが
--           rate_extras は「明細単価ではなく『その他自由名目の費用』」として
--           accounting.js でも 'rate_extra' として独立したテンプレ source 扱いされている。
--           creative や rank に紐づかない案件レベル支出として fixed_items が自然。
--   item_type   = 'expense'
--   category    = 'other'
--   name        = COALESCE(name, '(無題)')
--   amount      = fee
--   status      = 'planned'
--   notes       = '[migrated from project_rate_extras] creative_type=<video|design>'
--
-- ＜source = project_producer_rates / project_director_rates の rank 不在問題＞
--   旧テーブルは creative_type 単位で 1 行 = (project, creative_type) で UNIQUE。
--   project_rates は (project, creative_type, rank) で 3 行できる。
--   → director/producer fee は同 project × 同 category の全 rank line に同額を当てる方針。
--     これは旧アプリの計算式 (1 creative あたり director_fee 必ず加算) と整合する。
--
-- ＜source = project_client_fees＞ (per-project, video/design unit prices, fixed_budget)
--   - video_unit_price / design_unit_price → クライアント請求単価。
--     project_rates 由来で作られた既存 lines があれば、その lines の client_unit_price=0 を
--     このクライアント単価で UPDATE する（同 project × 同 category の全 rank に適用）。
--   - 既存 line が無ければ、(project, category, rank=NULL) で新 line を作る
--     (planned_count=0, client_unit_price=video_or_design_unit_price)
--   - fixed_budget (use_fixed_budget=TRUE のとき) → project_fixed_items(item_type='revenue', category='other')
--     name='固定予算 (旧 project_client_fees.fixed_budget)'
--
-- ＜source = projects.sub_director_ids / sub_producer_ids＞
--   配列カラムでありテーブルではない。fee 列が存在しないため移行対象データ無し。
--   サブD/サブPの単価は ADR 002 想定では line_costs(role='sub_director'/'sub_producer') を Stage 4 UI で入力する。
--   よって本 migration では何も移行しない（コメントのみ残す）。
--
-- ＜creatives.line_id バックフィル＞
--   ベストエフォート：
--     - 案件 × カテゴリ で line が 1 つだけ（rank 違いがない、director_rates 由来 only など）
--       → そのカテゴリの全 creatives を当該 line に紐付け
--     - 案件 × カテゴリ で複数 line（rank A/B/C 等）
--       → creative_assignments.rank_applied (or users.rank) で rank が判別できれば紐付け
--       → 判別不能なら NULL のまま（Stage 4 UI で手動修正）
--
-- =====================================================
-- 冪等性方針:
--   - lines: UNIQUE 制約が無いため、本 migration 専用マーカ name 接尾辞
--     ' (旧 project_rates 移行)' / ' (旧 project_director_rates 移行)' 等で
--     既存行が同 project_id × name で重複しないよう WHERE NOT EXISTS で守る。
--   - line_costs: UNIQUE (line_id, role_id, user_id) は user_id=NULL を distinct と扱うため
--     本 migration (user_id 常に NULL) では ON CONFLICT が効かない。WHERE NOT EXISTS で重複防止。
--   - fixed_items: name で WHERE NOT EXISTS により再実行 safe。
--   - creatives.line_id: WHERE line_id IS NULL で再実行に耐える。
-- =====================================================

BEGIN;

-- -----------------------------------------------------
-- 0) 移行前合計を一時テーブルに退避（DO ブロックの末尾でログ出力に使う）
-- -----------------------------------------------------
DROP TABLE IF EXISTS _stage2_audit;
CREATE TEMP TABLE _stage2_audit AS
SELECT
  (SELECT COALESCE(SUM(COALESCE(base_fee,0)+COALESCE(script_fee,0)
                       +COALESCE(ai_fee,0)+COALESCE(other_fee,0)),0)
     FROM project_rates)            AS old_rates_total,
  (SELECT COALESCE(SUM(director_fee),0) FROM project_director_rates)  AS old_director_total,
  (SELECT COALESCE(SUM(producer_fee),0) FROM project_producer_rates)  AS old_producer_total,
  (SELECT COALESCE(SUM(fee),0)        FROM project_rate_extras)       AS old_extras_total,
  (SELECT COALESCE(SUM(COALESCE(video_unit_price,0)+COALESCE(design_unit_price,0)),0)
     FROM project_client_fees)      AS old_client_unit_total,
  (SELECT COALESCE(SUM(fixed_budget),0)
     FROM project_client_fees WHERE use_fixed_budget=TRUE) AS old_client_fixed_budget_total,
  (SELECT COUNT(*)                    FROM project_estimate_lines)      AS pre_lines_count,
  (SELECT COUNT(*)                    FROM project_estimate_line_costs) AS pre_costs_count,
  (SELECT COUNT(*)                    FROM project_fixed_items)         AS pre_fixed_count;

-- -----------------------------------------------------
-- 1) project_rates → project_estimate_lines (1 row per (project, creative_type, rank))
--    name 接尾辞 ' (旧 project_rates 移行)' で再実行時の重複を防ぐ
-- -----------------------------------------------------
INSERT INTO project_estimate_lines
  (project_id, category_id, name, planned_count, client_unit_price, sort_order,
   currency, tax_included, status, status_changed_at)
SELECT
  pr.project_id,
  cc.id                                                         AS category_id,
  cc.name || ' ' || pr.rank || 'ランク (旧 project_rates 移行)' AS name,
  0                                                             AS planned_count,
  0                                                             AS client_unit_price,
  CASE pr.rank WHEN 'A' THEN 10 WHEN 'B' THEN 20 WHEN 'C' THEN 30 ELSE 99 END AS sort_order,
  'JPY'                                                         AS currency,
  TRUE                                                          AS tax_included,
  'estimated'                                                   AS status,
  now()                                                         AS status_changed_at
FROM project_rates pr
JOIN creative_categories cc
  ON cc.code = CASE pr.creative_type WHEN 'video' THEN 'video' WHEN 'design' THEN 'image' ELSE NULL END
WHERE NOT EXISTS (
  SELECT 1 FROM project_estimate_lines pel
   WHERE pel.project_id = pr.project_id
     AND pel.name = cc.name || ' ' || pr.rank || 'ランク (旧 project_rates 移行)'
);

-- -----------------------------------------------------
-- 2) project_rates → project_estimate_line_costs (role=editor for video / designer for design)
--    1 で作った line に編集者/デザイナーのコストを紐付ける
--
-- NOTE: UNIQUE (line_id, role_id, user_id) は user_id=NULL を distinct と扱うため
--       ON CONFLICT が効かない。代わりに WHERE NOT EXISTS で重複防止する。
-- -----------------------------------------------------
INSERT INTO project_estimate_line_costs
  (line_id, role_id, user_id, unit_price, currency, pricing_type)
SELECT
  pel.id,
  r.id,
  NULL::uuid                                                                 AS user_id,
  COALESCE(pr.base_fee,0)+COALESCE(pr.script_fee,0)
    +COALESCE(pr.ai_fee,0)+COALESCE(pr.other_fee,0)                          AS unit_price,
  'JPY'                                                                      AS currency,
  'fixed_per_unit'                                                           AS pricing_type
FROM project_rates pr
JOIN creative_categories cc
  ON cc.code = CASE pr.creative_type WHEN 'video' THEN 'video' WHEN 'design' THEN 'image' ELSE NULL END
JOIN project_estimate_lines pel
  ON pel.project_id = pr.project_id
 AND pel.name = cc.name || ' ' || pr.rank || 'ランク (旧 project_rates 移行)'
JOIN roles r
  ON r.code = CASE pr.creative_type WHEN 'video' THEN 'editor' WHEN 'design' THEN 'designer' ELSE NULL END
WHERE COALESCE(pr.base_fee,0)+COALESCE(pr.script_fee,0)
       +COALESCE(pr.ai_fee,0)+COALESCE(pr.other_fee,0) > 0
  AND NOT EXISTS (
    SELECT 1 FROM project_estimate_line_costs plc
     WHERE plc.line_id = pel.id
       AND plc.role_id = r.id
       AND plc.user_id IS NULL
  );

-- -----------------------------------------------------
-- 3) project_director_rates → line_costs(role=director)
--    rank なし → 同 project × 同 category の全 lines に同額をコピー。
--    該当 line が無い場合は (rank=NULL, planned_count=0, client_unit_price=0) で新 line を作る。
-- -----------------------------------------------------
-- 3-a) lines が既にある (project, category) には director の cost を追加するだけ
INSERT INTO project_estimate_line_costs
  (line_id, role_id, user_id, unit_price, currency, pricing_type)
SELECT DISTINCT
  pel.id,
  r.id,
  NULL::uuid,
  pdr.director_fee,
  'JPY',
  'fixed_per_unit'
FROM project_director_rates pdr
JOIN creative_categories cc
  ON cc.code = CASE pdr.creative_type WHEN 'video' THEN 'video' WHEN 'design' THEN 'image' ELSE NULL END
JOIN project_estimate_lines pel
  ON pel.project_id = pdr.project_id
 AND pel.category_id = cc.id
JOIN roles r ON r.code = 'director'
WHERE COALESCE(pdr.director_fee,0) > 0
  AND NOT EXISTS (
    SELECT 1 FROM project_estimate_line_costs plc
     WHERE plc.line_id = pel.id AND plc.role_id = r.id AND plc.user_id IS NULL
  );

-- 3-b) (project, category) に line がまだ無い director_rates 行 → 新規 line を作る
INSERT INTO project_estimate_lines
  (project_id, category_id, name, planned_count, client_unit_price, sort_order,
   currency, tax_included, status, status_changed_at)
SELECT
  pdr.project_id,
  cc.id,
  cc.name || ' (旧 project_director_rates 移行)',
  0, 0, 50, 'JPY', TRUE, 'estimated', now()
FROM project_director_rates pdr
JOIN creative_categories cc
  ON cc.code = CASE pdr.creative_type WHEN 'video' THEN 'video' WHEN 'design' THEN 'image' ELSE NULL END
WHERE COALESCE(pdr.director_fee,0) > 0
  AND NOT EXISTS (
    SELECT 1 FROM project_estimate_lines pel
     WHERE pel.project_id = pdr.project_id
       AND pel.category_id = cc.id
  );

-- 3-c) 3-b で新規作成された line に director の cost を付ける
INSERT INTO project_estimate_line_costs
  (line_id, role_id, user_id, unit_price, currency, pricing_type)
SELECT
  pel.id, r.id, NULL::uuid, pdr.director_fee, 'JPY', 'fixed_per_unit'
FROM project_director_rates pdr
JOIN creative_categories cc
  ON cc.code = CASE pdr.creative_type WHEN 'video' THEN 'video' WHEN 'design' THEN 'image' ELSE NULL END
JOIN project_estimate_lines pel
  ON pel.project_id = pdr.project_id
 AND pel.name = cc.name || ' (旧 project_director_rates 移行)'
JOIN roles r ON r.code = 'director'
WHERE COALESCE(pdr.director_fee,0) > 0
  AND NOT EXISTS (
    SELECT 1 FROM project_estimate_line_costs plc
     WHERE plc.line_id = pel.id AND plc.role_id = r.id AND plc.user_id IS NULL
  );

-- -----------------------------------------------------
-- 4) project_producer_rates → line_costs(role=producer)
--    完全に director と対称
-- -----------------------------------------------------
-- 4-a) 既存 lines に producer の cost を追加
INSERT INTO project_estimate_line_costs
  (line_id, role_id, user_id, unit_price, currency, pricing_type)
SELECT DISTINCT
  pel.id, r.id, NULL::uuid, ppr.producer_fee, 'JPY', 'fixed_per_unit'
FROM project_producer_rates ppr
JOIN creative_categories cc
  ON cc.code = CASE ppr.creative_type WHEN 'video' THEN 'video' WHEN 'design' THEN 'image' ELSE NULL END
JOIN project_estimate_lines pel
  ON pel.project_id = ppr.project_id
 AND pel.category_id = cc.id
JOIN roles r ON r.code = 'producer'
WHERE COALESCE(ppr.producer_fee,0) > 0
  AND NOT EXISTS (
    SELECT 1 FROM project_estimate_line_costs plc
     WHERE plc.line_id = pel.id AND plc.role_id = r.id AND plc.user_id IS NULL
  );

-- 4-b) line がまだ無い producer_rates 行 → 新規 line
INSERT INTO project_estimate_lines
  (project_id, category_id, name, planned_count, client_unit_price, sort_order,
   currency, tax_included, status, status_changed_at)
SELECT
  ppr.project_id,
  cc.id,
  cc.name || ' (旧 project_producer_rates 移行)',
  0, 0, 60, 'JPY', TRUE, 'estimated', now()
FROM project_producer_rates ppr
JOIN creative_categories cc
  ON cc.code = CASE ppr.creative_type WHEN 'video' THEN 'video' WHEN 'design' THEN 'image' ELSE NULL END
WHERE COALESCE(ppr.producer_fee,0) > 0
  AND NOT EXISTS (
    SELECT 1 FROM project_estimate_lines pel
     WHERE pel.project_id = ppr.project_id
       AND pel.category_id = cc.id
  );

-- 4-c) 4-b で作った line に producer cost を付ける
INSERT INTO project_estimate_line_costs
  (line_id, role_id, user_id, unit_price, currency, pricing_type)
SELECT
  pel.id, r.id, NULL::uuid, ppr.producer_fee, 'JPY', 'fixed_per_unit'
FROM project_producer_rates ppr
JOIN creative_categories cc
  ON cc.code = CASE ppr.creative_type WHEN 'video' THEN 'video' WHEN 'design' THEN 'image' ELSE NULL END
JOIN project_estimate_lines pel
  ON pel.project_id = ppr.project_id
 AND pel.name = cc.name || ' (旧 project_producer_rates 移行)'
JOIN roles r ON r.code = 'producer'
WHERE COALESCE(ppr.producer_fee,0) > 0
  AND NOT EXISTS (
    SELECT 1 FROM project_estimate_line_costs plc
     WHERE plc.line_id = pel.id AND plc.role_id = r.id AND plc.user_id IS NULL
  );

-- -----------------------------------------------------
-- 5) project_rate_extras → project_fixed_items(item_type='expense', category='other')
--    line_costs ではなく fixed_items 行き。理由はファイル冒頭コメント参照。
-- -----------------------------------------------------
INSERT INTO project_fixed_items
  (project_id, item_type, category, name, amount, currency, status, notes)
SELECT
  pre.project_id,
  'expense',
  'other',
  COALESCE(NULLIF(pre.name, ''), '(無題)') || ' (旧 project_rate_extras 移行)',
  COALESCE(pre.fee, 0),
  'JPY',
  'planned',
  '[migrated from project_rate_extras] creative_type=' || COALESCE(pre.creative_type, 'unknown')
FROM project_rate_extras pre
WHERE COALESCE(pre.fee, 0) > 0
  AND NOT EXISTS (
    SELECT 1 FROM project_fixed_items pfi
     WHERE pfi.project_id = pre.project_id
       AND pfi.name = COALESCE(NULLIF(pre.name, ''), '(無題)') || ' (旧 project_rate_extras 移行)'
  );

-- -----------------------------------------------------
-- 6) project_client_fees → lines.client_unit_price UPDATE + fixed_items(revenue)
-- -----------------------------------------------------

-- 6-a) video_unit_price > 0 の場合: 該当案件の category=video の全 lines (client_unit_price=0) を UPDATE
UPDATE project_estimate_lines pel
   SET client_unit_price = pcf.video_unit_price
  FROM project_client_fees pcf
  JOIN creative_categories cc ON cc.code = 'video'
 WHERE pel.project_id = pcf.project_id
   AND pel.category_id = cc.id
   AND pel.client_unit_price = 0
   AND COALESCE(pcf.video_unit_price, 0) > 0;

-- 6-b) design_unit_price > 0 の場合: category=image の全 lines (client_unit_price=0) を UPDATE
UPDATE project_estimate_lines pel
   SET client_unit_price = pcf.design_unit_price
  FROM project_client_fees pcf
  JOIN creative_categories cc ON cc.code = 'image'
 WHERE pel.project_id = pcf.project_id
   AND pel.category_id = cc.id
   AND pel.client_unit_price = 0
   AND COALESCE(pcf.design_unit_price, 0) > 0;

-- 6-c) video_unit_price > 0 だが対応する lines が 1 つも無い場合 → 新規 line を作る
INSERT INTO project_estimate_lines
  (project_id, category_id, name, planned_count, client_unit_price, sort_order,
   currency, tax_included, status, status_changed_at)
SELECT
  pcf.project_id,
  cc.id,
  '動画クライアント単価 (旧 project_client_fees 移行)',
  0,
  pcf.video_unit_price,
  70,
  'JPY', TRUE, 'estimated', now()
FROM project_client_fees pcf
JOIN creative_categories cc ON cc.code = 'video'
WHERE COALESCE(pcf.video_unit_price, 0) > 0
  AND NOT EXISTS (
    SELECT 1 FROM project_estimate_lines pel
     WHERE pel.project_id = pcf.project_id AND pel.category_id = cc.id
  );

-- 6-d) design_unit_price > 0 だが対応する lines が 1 つも無い場合 → 新規 line を作る
INSERT INTO project_estimate_lines
  (project_id, category_id, name, planned_count, client_unit_price, sort_order,
   currency, tax_included, status, status_changed_at)
SELECT
  pcf.project_id,
  cc.id,
  '静止画クライアント単価 (旧 project_client_fees 移行)',
  0,
  pcf.design_unit_price,
  80,
  'JPY', TRUE, 'estimated', now()
FROM project_client_fees pcf
JOIN creative_categories cc ON cc.code = 'image'
WHERE COALESCE(pcf.design_unit_price, 0) > 0
  AND NOT EXISTS (
    SELECT 1 FROM project_estimate_lines pel
     WHERE pel.project_id = pcf.project_id AND pel.category_id = cc.id
  );

-- 6-e) fixed_budget (use_fixed_budget=TRUE) → fixed_items(item_type='revenue')
INSERT INTO project_fixed_items
  (project_id, item_type, category, name, amount, currency, status, notes)
SELECT
  pcf.project_id,
  'revenue',
  'other',
  '固定予算 (旧 project_client_fees.fixed_budget 移行)',
  pcf.fixed_budget,
  'JPY',
  'planned',
  COALESCE('[migrated from project_client_fees.fixed_budget] note=' || pcf.note,
           '[migrated from project_client_fees.fixed_budget]')
FROM project_client_fees pcf
WHERE pcf.use_fixed_budget = TRUE
  AND COALESCE(pcf.fixed_budget, 0) > 0
  AND NOT EXISTS (
    SELECT 1 FROM project_fixed_items pfi
     WHERE pfi.project_id = pcf.project_id
       AND pfi.name = '固定予算 (旧 project_client_fees.fixed_budget 移行)'
  );

-- -----------------------------------------------------
-- 7) creatives.line_id バックフィル（best-effort）
--   方針:
--     7-a) 案件 × カテゴリ で line がただ 1 つ → そのカテゴリの全 creatives を当該 line に紐付け
--     7-b) 複数 line のとき: creative の rank（creative_assignments.rank_applied 経由）が
--          line.name に含まれていれば紐付け
--   どちらも判別不能なら NULL のまま（Stage 4 UI で手動修正）
-- -----------------------------------------------------

-- 7-a) 案件 × カテゴリ で line が 1 件だけのケース
WITH single_line AS (
  SELECT pel.project_id, pel.category_id, MIN(pel.id) AS line_id, COUNT(*) AS cnt
    FROM project_estimate_lines pel
   GROUP BY pel.project_id, pel.category_id
  HAVING COUNT(*) = 1
)
UPDATE creatives c
   SET line_id = sl.line_id
  FROM single_line sl
 WHERE c.line_id IS NULL
   AND c.project_id = sl.project_id
   AND c.category_id = sl.category_id;

-- 7-b) 複数 line のときは creative の編集者/デザイナーの rank で line を選ぶ
--      line.name に '<rank>ランク' を含むものに紐付ける
WITH creative_rank AS (
  SELECT DISTINCT ON (c.id)
         c.id AS creative_id,
         c.project_id,
         c.category_id,
         COALESCE(ca.rank_applied, u.rank) AS rank
    FROM creatives c
    LEFT JOIN creative_assignments ca
           ON ca.creative_id = c.id
          AND ca.role IN ('editor','designer')
    LEFT JOIN users u ON u.id = ca.user_id
   WHERE c.line_id IS NULL
   ORDER BY c.id, ca.created_at DESC NULLS LAST
)
UPDATE creatives c
   SET line_id = pel.id
  FROM creative_rank cr
  JOIN project_estimate_lines pel
    ON pel.project_id = cr.project_id
   AND pel.category_id = cr.category_id
   AND cr.rank IS NOT NULL
   AND pel.name LIKE '%' || cr.rank || 'ランク%'
 WHERE c.id = cr.creative_id
   AND c.line_id IS NULL;

-- -----------------------------------------------------
-- 8) 移行後の集計を NOTICE 出力（一致しなくても COMMIT する：戦略上、計算式が異なる）
-- -----------------------------------------------------
DO $$
DECLARE
  audit RECORD;
  new_lines_count        INTEGER;
  new_costs_count        INTEGER;
  new_fixed_count        INTEGER;
  new_line_costs_total   BIGINT;
  new_fixed_revenue_total BIGINT;
  new_fixed_expense_total BIGINT;
  creatives_with_line    INTEGER;
  creatives_total        INTEGER;
BEGIN
  SELECT * INTO audit FROM _stage2_audit;
  SELECT COUNT(*) INTO new_lines_count FROM project_estimate_lines;
  SELECT COUNT(*) INTO new_costs_count FROM project_estimate_line_costs;
  SELECT COUNT(*) INTO new_fixed_count FROM project_fixed_items;
  SELECT COALESCE(SUM(unit_price),0) INTO new_line_costs_total FROM project_estimate_line_costs;
  SELECT COALESCE(SUM(amount),0)     INTO new_fixed_revenue_total FROM project_fixed_items WHERE item_type='revenue';
  SELECT COALESCE(SUM(amount),0)     INTO new_fixed_expense_total FROM project_fixed_items WHERE item_type='expense';
  SELECT COUNT(*) INTO creatives_with_line FROM creatives WHERE line_id IS NOT NULL;
  SELECT COUNT(*) INTO creatives_total     FROM creatives;

  RAISE NOTICE '========================================================';
  RAISE NOTICE 'Stage 2 migration audit';
  RAISE NOTICE '--------------------------------------------------------';
  RAISE NOTICE 'OLD project_rates total           = %', audit.old_rates_total;
  RAISE NOTICE 'OLD director total                = %', audit.old_director_total;
  RAISE NOTICE 'OLD producer total                = %', audit.old_producer_total;
  RAISE NOTICE 'OLD rate_extras total             = %', audit.old_extras_total;
  RAISE NOTICE 'OLD client_fees unit_price total  = %', audit.old_client_unit_total;
  RAISE NOTICE 'OLD client_fees fixed_budget total= %', audit.old_client_fixed_budget_total;
  RAISE NOTICE '--------------------------------------------------------';
  RAISE NOTICE 'NEW lines count: % (was %)', new_lines_count, audit.pre_lines_count;
  RAISE NOTICE 'NEW line_costs count: % (was %)', new_costs_count, audit.pre_costs_count;
  RAISE NOTICE 'NEW fixed_items count: % (was %)', new_fixed_count, audit.pre_fixed_count;
  RAISE NOTICE 'NEW SUM(line_costs.unit_price)  = %', new_line_costs_total;
  RAISE NOTICE 'NEW SUM(fixed_items revenue)    = %', new_fixed_revenue_total;
  RAISE NOTICE 'NEW SUM(fixed_items expense)    = %', new_fixed_expense_total;
  RAISE NOTICE '--------------------------------------------------------';
  RAISE NOTICE 'creatives.line_id backfill: % / % (% %% mapped)',
    creatives_with_line, creatives_total,
    CASE WHEN creatives_total > 0 THEN ROUND(creatives_with_line::numeric * 100 / creatives_total, 1) ELSE 0 END;
  RAISE NOTICE '========================================================';
END $$;

-- -----------------------------------------------------
-- 9) PostgREST にスキーマリロード通知
-- -----------------------------------------------------
NOTIFY pgrst, 'reload schema';

COMMIT;

-- =====================================================
-- 適用後の確認クエリ（手動で実行）
-- =====================================================
-- -- A. 新テーブルの件数 (NOTICE 出力と一致するか)
--   SELECT 'project_estimate_lines',      COUNT(*) FROM project_estimate_lines
-- UNION ALL
--   SELECT 'project_estimate_line_costs', COUNT(*) FROM project_estimate_line_costs
-- UNION ALL
--   SELECT 'project_fixed_items',         COUNT(*) FROM project_fixed_items;
--
-- -- B. ロール別 line_costs 件数（editor/designer/director/producer のみのはず）
-- SELECT r.code, COUNT(*) AS rows, COALESCE(SUM(plc.unit_price),0) AS total
--   FROM project_estimate_line_costs plc
--   JOIN roles r ON r.id = plc.role_id
--  GROUP BY r.code
--  ORDER BY r.code;
--
-- -- C. 案件別 line 件数のヒストグラム
-- SELECT lines_per_project, COUNT(*) AS projects
--   FROM (
--     SELECT project_id, COUNT(*) AS lines_per_project
--       FROM project_estimate_lines GROUP BY project_id
--   ) t
--  GROUP BY 1 ORDER BY 1;
--
-- -- D. creatives.line_id バックフィル成功率
-- SELECT
--   COUNT(*) FILTER (WHERE line_id IS NOT NULL) AS with_line,
--   COUNT(*)                                    AS total,
--   ROUND(COUNT(*) FILTER (WHERE line_id IS NOT NULL)::numeric * 100 / NULLIF(COUNT(*),0), 1) AS pct
--   FROM creatives;
--
-- -- E. fixed_items の内訳
-- SELECT item_type, category, COUNT(*) AS rows, SUM(amount) AS total
--   FROM project_fixed_items
--  GROUP BY item_type, category
--  ORDER BY item_type, category;

-- =====================================================
-- ロールバック手順（手動）
-- =====================================================
-- ⚠️ 本 migration で挿入した行のみを綺麗に消すには、name 接尾辞 / notes プレフィックスで識別する
-- BEGIN;
--   -- creatives.line_id を NULL に戻す（本 migration が紐付けたものを丸ごと戻す）
--   UPDATE creatives SET line_id = NULL
--    WHERE line_id IN (
--      SELECT id FROM project_estimate_lines
--       WHERE name LIKE '% (旧 project_rates 移行)%'
--          OR name LIKE '% (旧 project_director_rates 移行)%'
--          OR name LIKE '% (旧 project_producer_rates 移行)%'
--          OR name LIKE '%クライアント単価 (旧 project_client_fees 移行)%'
--    );
--   -- line_costs は line CASCADE で消える
--   DELETE FROM project_estimate_lines
--    WHERE name LIKE '% (旧 project_rates 移行)%'
--       OR name LIKE '% (旧 project_director_rates 移行)%'
--       OR name LIKE '% (旧 project_producer_rates 移行)%'
--       OR name LIKE '%クライアント単価 (旧 project_client_fees 移行)%';
--   -- fixed_items のうち本 migration が作ったもの
--   DELETE FROM project_fixed_items
--    WHERE notes LIKE '[migrated from project_rate_extras]%'
--       OR notes LIKE '[migrated from project_client_fees.fixed_budget]%';
-- COMMIT;
