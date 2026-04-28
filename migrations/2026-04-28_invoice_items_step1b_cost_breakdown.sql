-- ============================================================
-- 請求書明細：コスト種別ごとの行に細分化（Step 1b）
-- ------------------------------------------------------------
-- 目的:
--   既存の「1 creative = 1 invoice_item + 複数 invoice_item_details」構造から、
--   「1 creative = 複数 invoice_items（コスト種別ごとの行）」へ移行する。
--
-- 変更:
--   1. invoice_items に cost_type / creative_label を追加
--   2. 既存データのバックフィル：
--      - 親 invoice_item に対応する invoice_item_details が複数あれば、
--        最初の details を親行に統合し、残りの details ごとに新規 invoice_items を INSERT
--      - creative_label に creatives.file_name を埋める
--   3. インデックス追加 (invoice_id, creative_id, sort_order)
--
-- 冪等性:
--   ALTER ... IF NOT EXISTS / WHERE 条件付き UPDATE / 既処理スキップで何度実行してもOK
--   既存 invoice_item_details は破壊せず残置（参照しないが互換のため温存）
-- ============================================================

-- 1) カラム追加
ALTER TABLE invoice_items ADD COLUMN IF NOT EXISTS cost_type      TEXT;
ALTER TABLE invoice_items ADD COLUMN IF NOT EXISTS creative_label TEXT;

-- 2) creative_label のバックフィル（クリエイティブ紐付けがある行）
UPDATE invoice_items ii
   SET creative_label = c.file_name
  FROM creatives c
 WHERE ii.creative_id = c.id
   AND ii.creative_label IS NULL
   AND c.file_name IS NOT NULL;

-- 3) 既存の親行 invoice_items を「最初の details」で更新する
--    （cost_type が NULL かつ details が存在する行のみ処理＝冪等）
WITH first_detail AS (
  SELECT DISTINCT ON (iid.invoice_item_id)
         iid.invoice_item_id,
         iid.cost_type,
         iid.unit_price,
         iid.amount
    FROM invoice_item_details iid
    JOIN invoice_items ii ON ii.id = iid.invoice_item_id
   WHERE ii.cost_type IS NULL
     AND COALESCE(iid.amount, 0) > 0
   ORDER BY iid.invoice_item_id, iid.created_at, iid.id
)
UPDATE invoice_items ii
   SET cost_type   = fd.cost_type,
       unit_price  = fd.unit_price,
       total_amount= fd.amount,
       quantity    = COALESCE(ii.quantity, 1),
       unit        = COALESCE(ii.unit, '本'),
       label       = CASE
                       WHEN ii.label IS NULL OR ii.label = ''
                         THEN COALESCE(
                                CASE fd.cost_type
                                  WHEN 'base_fee'   THEN '編集'
                                  WHEN 'script_fee' THEN '台本作成'
                                  WHEN 'ai_fee'     THEN 'AI生成（ナレーション含む）'
                                  WHEN 'other_fee'  THEN 'その他'
                                  ELSE fd.cost_type
                                END,
                                '明細'
                              )
                       ELSE ii.label
                     END
  FROM first_detail fd
 WHERE ii.id = fd.invoice_item_id;

-- 4) 残りの details を新しい invoice_items として展開する
--    （まだ展開されていない＝同じ親 invoice_item_id を持つ別の details）
INSERT INTO invoice_items (
  invoice_id, creative_id, total_amount, is_special, special_reason,
  label, quantity, unit, unit_price, sort_order, cost_type, creative_label
)
SELECT
  parent.invoice_id,
  parent.creative_id,
  iid.amount                         AS total_amount,
  parent.is_special,
  parent.special_reason,
  CASE iid.cost_type
    WHEN 'base_fee'   THEN '編集'
    WHEN 'script_fee' THEN '台本作成'
    WHEN 'ai_fee'     THEN 'AI生成（ナレーション含む）'
    WHEN 'other_fee'  THEN 'その他'
    ELSE iid.cost_type
  END                                AS label,
  1                                  AS quantity,
  '本'                                AS unit,
  iid.unit_price                     AS unit_price,
  COALESCE(parent.sort_order, 0)
    + ROW_NUMBER() OVER (
        PARTITION BY parent.id
        ORDER BY iid.created_at, iid.id
      )                              AS sort_order,
  iid.cost_type                      AS cost_type,
  parent.creative_label              AS creative_label
  FROM invoice_item_details iid
  JOIN invoice_items parent ON parent.id = iid.invoice_item_id
 WHERE COALESCE(iid.amount, 0) > 0
   -- 親の cost_type と一致する行は既にマージ済みなのでスキップ
   AND parent.cost_type IS NOT NULL
   AND parent.cost_type <> iid.cost_type
   -- 二重実行防止: 既に同 (invoice_id, creative_id, cost_type) が存在すればスキップ
   AND NOT EXISTS (
     SELECT 1 FROM invoice_items existing
      WHERE existing.invoice_id  = parent.invoice_id
        AND existing.creative_id IS NOT DISTINCT FROM parent.creative_id
        AND existing.cost_type   = iid.cost_type
        AND existing.id          <> parent.id
   );

-- 5) invoices.total_amount を再計算（細分化で件数は増えたが合計は不変）
--    安全のため、影響を受けた請求書のみ再集計
UPDATE invoices inv
   SET total_amount = sub.sum_amt,
       updated_at   = now()
  FROM (
    SELECT invoice_id, SUM(COALESCE(total_amount, 0)) AS sum_amt
      FROM invoice_items
     GROUP BY invoice_id
  ) sub
 WHERE inv.id = sub.invoice_id
   AND inv.total_amount IS DISTINCT FROM sub.sum_amt;

-- 6) インデックス（クリエイティブ単位グルーピング表示用）
CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice_creative_sort
  ON invoice_items(invoice_id, creative_id, sort_order);
