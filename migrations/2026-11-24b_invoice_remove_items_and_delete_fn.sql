-- ADR 046 追補 2026-11-24（4）: 下書き請求書から明細を外す・請求書を消す処理を DB の 1 トランザクションで行う
--
-- 直す不具合（外部レビューの指摘・2026-11-24 確認）:
--   1. 納品の取り消し（POST /creatives/:id/delivery-revert）・管理者のステータス強制変更（POST /creatives/:id/admin-status）は、
--      「請求書が下書きか読む → 明細を消す → 残りの明細を読んで合計を書く」を別々の問い合わせで行っていた。
--      読んでから消すまでのあいだに提出されると、提出済みの請求書から明細だけが消え、合計は古いまま残る
--   2. 残りの明細の読み取りに失敗しても空として計算し直すので、下書きの合計が 0 円になる経路があった
--   3. 請求書の削除（DELETE /invoices/:id）も「下書きか読む → 明細を消す → 請求書を消す」が別々で、
--      そのあいだに提出された請求書を明細ごと消せてしまった
--
-- 仕組み:
--   - invoice_remove_items_recalc() … 請求書 1 件ぶん。ロックの中で「状態の確認 → 明細の削除 → 合計の書き込み」を行う。
--     合計の計算式はアプリ（utils/invoice-editor.js の computeTotals）が正なので、アプリが「消したあとに残るはずの明細」の
--     指紋と、その明細から計算した合計を渡す。関数はロックの中で残りの明細が指紋と同じかを確かめ、違えば何もせず STALE を返す
--     （アプリが読み直してやり直す）。invoice_editor_submit と同じ考え方
--   - invoice_delete_editable() … 請求書 1 件を明細ごと消す。ロックの中で状態を確かめる。消した行の領収書ファイル id を返す
--     （アプリが Drive のゴミ箱へ送る）
--   - ロックの順は invoice_editor_submit（2026-11-24_invoice_editor_atomic_submit.sql）と同じ:
--       発行者の advisory lock（hashtextextended('invoice_billing:' || issuer_id, 0)）→ invoices FOR UPDATE → invoice_items
--     保存（invoice_editor_save_draft）・領収書（attach_invoice_item_receipt）も invoices → invoice_items の順なので循環しない
--   - 外してよい状態は draft / rejected だけ（引数でそれ以外を渡すと例外）。提出済み・承認済みの請求書は書き換えない
--   - 合計を書くときは updated_at を進める（開いたままのエディタの自動保存が楽観ロックで止まり、再読み込みになる）
--
-- 前提: 2026-11-24_invoice_editor_atomic_submit.sql（invoice_billing_claims）と 2026-11-23_invoice_items_expense_receipt.sql
--       （invoice_items.receipt_file_id）が本番に適用済みであること（どちらも適用済み）。
--   下書き・差し戻し中の請求書は invoice_billing_claims を持たない（提出時に作られ、差し戻しで解放される）。
--   請求書を消すと invoice_billing_claims は外部キー ON DELETE CASCADE で消える。
--
-- 関数は SECURITY INVOKER（既定）・search_path 固定・EXECUTE は service_role のみ。新しいテーブルは作らない。
-- 何度流しても同じ結果になる（CREATE OR REPLACE）。

BEGIN;

-- ==================== 1. 下書きから明細を外し、合計を書き直す ====================
-- p_invoice_id        : 請求書
-- p_editable_statuses : 外してよい状態（draft / rejected の部分集合。admin-status は {draft}、納品の取り消しは {draft,rejected}）
-- p_delete_ids        : 外す明細 id（この請求書の行だけ消える。もう無い id は無視）
-- p_remaining         : 外したあとに残るはずの明細の指紋 [{id, creative_id, cost_type, unit_price, quantity, total_amount}]（残り全行）
-- p_expected          : アプリが合計を計算したときの請求書の値 {tax_mode, withholding_enabled}
-- p_invoice           : 残りの明細から計算した合計
--                         新方式（exclusive）… {subtotal_amount, tax_amount, total_amount, withholding_amount, payout_amount}
--                         旧方式（inclusive）… {total_amount}
-- 戻り値 : {ok:true, deleted_ids:[id], updated_at}
--          {ok:false, code:'NOT_FOUND'|'NOT_EDITABLE'|'STALE'|'CONFLICT', status?}
CREATE OR REPLACE FUNCTION invoice_remove_items_recalc(
  p_invoice_id        UUID,
  p_editable_statuses TEXT[],
  p_delete_ids        UUID[],
  p_remaining         JSONB,
  p_expected          JSONB,
  p_invoice           JSONB
) RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
AS $fn$
DECLARE
  v_issuer   UUID;
  v_inv      invoices%ROWTYPE;
  v_diff     INTEGER;
  v_deleted  JSONB := '[]'::jsonb;
  v_updated  TIMESTAMPTZ;
BEGIN
  IF p_editable_statuses IS NULL OR cardinality(p_editable_statuses) = 0
     OR EXISTS (SELECT 1 FROM unnest(p_editable_statuses) s WHERE s IS NULL OR s NOT IN ('draft', 'rejected')) THEN
    RAISE EXCEPTION 'invoice_remove_items_recalc: editable statuses must be draft/rejected (%)', p_editable_statuses
      USING ERRCODE = '22023';
  END IF;
  IF p_invoice IS NULL OR NOT (p_invoice ? 'total_amount') THEN
    RAISE EXCEPTION 'invoice_remove_items_recalc: p_invoice.total_amount is required' USING ERRCODE = '22023';
  END IF;

  SELECT issuer_id INTO v_issuer FROM invoices WHERE id = p_invoice_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  END IF;

  -- 提出（invoice_editor_submit）と同じ順でロックする: 発行者の advisory → 請求書行 → 明細
  IF v_issuer IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('invoice_billing:' || v_issuer::TEXT, 0));
  END IF;

  SELECT * INTO v_inv FROM invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  END IF;
  IF v_inv.issuer_id IS DISTINCT FROM v_issuer THEN
    RETURN jsonb_build_object('ok', false, 'code', 'CONFLICT');
  END IF;
  IF v_inv.status IS NULL OR NOT (v_inv.status = ANY (p_editable_statuses)) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_EDITABLE', 'status', v_inv.status);
  END IF;
  -- 合計の計算に使う請求書の値が、アプリが読んだときと同じか
  IF v_inv.tax_mode IS DISTINCT FROM (p_expected->>'tax_mode')
     OR v_inv.withholding_enabled IS DISTINCT FROM (p_expected->>'withholding_enabled')::BOOLEAN THEN
    RETURN jsonb_build_object('ok', false, 'code', 'STALE');
  END IF;

  PERFORM 1 FROM invoice_items WHERE invoice_id = p_invoice_id ORDER BY id FOR UPDATE;

  -- 外したあとに残る明細が、アプリが合計を計算した明細と同じか（行の増減・単価・数量・金額・CR・役割）
  WITH cur AS (
    SELECT id, creative_id, cost_type, unit_price, quantity, total_amount
    FROM invoice_items
    WHERE invoice_id = p_invoice_id
      AND NOT (id = ANY (COALESCE(p_delete_ids, ARRAY[]::UUID[])))
  ), sent AS (
    SELECT id, creative_id, cost_type, unit_price, quantity, total_amount
    FROM jsonb_to_recordset(COALESCE(p_remaining, '[]'::jsonb))
      AS x(id UUID, creative_id UUID, cost_type TEXT, unit_price INTEGER, quantity NUMERIC, total_amount INTEGER)
  )
  SELECT count(*) INTO v_diff FROM (
    (SELECT * FROM cur EXCEPT ALL SELECT * FROM sent)
    UNION ALL
    (SELECT * FROM sent EXCEPT ALL SELECT * FROM cur)
  ) d;
  IF v_diff > 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'STALE');
  END IF;

  -- 明細の削除（内訳は外部キー ON DELETE CASCADE でも消えるが、明示して消す）
  IF p_delete_ids IS NOT NULL AND cardinality(p_delete_ids) > 0 THEN
    DELETE FROM invoice_item_details
    WHERE invoice_item_id IN (SELECT id FROM invoice_items WHERE invoice_id = p_invoice_id AND id = ANY (p_delete_ids));
    WITH d AS (
      DELETE FROM invoice_items WHERE invoice_id = p_invoice_id AND id = ANY (p_delete_ids)
      RETURNING id
    )
    SELECT COALESCE(jsonb_agg(id), '[]'::jsonb) INTO v_deleted FROM d;
  END IF;

  -- 合計（新方式は小計〜差引の 5 列、旧方式は税込の合計だけ）と更新時刻
  IF v_inv.tax_mode = 'exclusive' THEN
    UPDATE invoices SET
      subtotal_amount    = (p_invoice->>'subtotal_amount')::INTEGER,
      tax_amount         = (p_invoice->>'tax_amount')::INTEGER,
      total_amount       = (p_invoice->>'total_amount')::INTEGER,
      withholding_amount = (p_invoice->>'withholding_amount')::INTEGER,
      payout_amount      = (p_invoice->>'payout_amount')::INTEGER,
      updated_at         = clock_timestamp()
    WHERE id = p_invoice_id
    RETURNING updated_at INTO v_updated;
  ELSE
    UPDATE invoices SET
      total_amount = (p_invoice->>'total_amount')::INTEGER,
      updated_at   = clock_timestamp()
    WHERE id = p_invoice_id
    RETURNING updated_at INTO v_updated;
  END IF;

  RETURN jsonb_build_object('ok', true, 'deleted_ids', v_deleted, 'updated_at', v_updated);
END;
$fn$;

-- ==================== 2. 下書き・差し戻し中の請求書を明細ごと消す ====================
-- p_invoice_id        : 請求書
-- p_editable_statuses : 消してよい状態（draft / rejected の部分集合）
-- p_expected_issuer   : アプリが権限を確かめたときの発行者（違えば CONFLICT）。NULL なら発行者なしの請求書だけ
-- 戻り値 : {ok:true, receipt_file_ids:[file_id]}
--          {ok:false, code:'NOT_FOUND'|'NOT_EDITABLE'|'CONFLICT', status?}
CREATE OR REPLACE FUNCTION invoice_delete_editable(
  p_invoice_id        UUID,
  p_editable_statuses TEXT[],
  p_expected_issuer   UUID
) RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
AS $fn$
DECLARE
  v_issuer   UUID;
  v_inv      invoices%ROWTYPE;
  v_files    JSONB := '[]'::jsonb;
BEGIN
  IF p_editable_statuses IS NULL OR cardinality(p_editable_statuses) = 0
     OR EXISTS (SELECT 1 FROM unnest(p_editable_statuses) s WHERE s IS NULL OR s NOT IN ('draft', 'rejected')) THEN
    RAISE EXCEPTION 'invoice_delete_editable: editable statuses must be draft/rejected (%)', p_editable_statuses
      USING ERRCODE = '22023';
  END IF;

  SELECT issuer_id INTO v_issuer FROM invoices WHERE id = p_invoice_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  END IF;
  IF v_issuer IS DISTINCT FROM p_expected_issuer THEN
    RETURN jsonb_build_object('ok', false, 'code', 'CONFLICT');
  END IF;

  IF v_issuer IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('invoice_billing:' || v_issuer::TEXT, 0));
  END IF;

  SELECT * INTO v_inv FROM invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  END IF;
  IF v_inv.issuer_id IS DISTINCT FROM v_issuer THEN
    RETURN jsonb_build_object('ok', false, 'code', 'CONFLICT');
  END IF;
  IF v_inv.status IS NULL OR NOT (v_inv.status = ANY (p_editable_statuses)) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_EDITABLE', 'status', v_inv.status);
  END IF;

  PERFORM 1 FROM invoice_items WHERE invoice_id = p_invoice_id ORDER BY id FOR UPDATE;

  SELECT COALESCE(jsonb_agg(receipt_file_id) FILTER (WHERE receipt_file_id IS NOT NULL), '[]'::jsonb)
    INTO v_files FROM invoice_items WHERE invoice_id = p_invoice_id;

  DELETE FROM invoice_item_details
  WHERE invoice_item_id IN (SELECT id FROM invoice_items WHERE invoice_id = p_invoice_id);
  DELETE FROM invoice_items WHERE invoice_id = p_invoice_id;
  DELETE FROM invoices WHERE id = p_invoice_id;

  RETURN jsonb_build_object('ok', true, 'receipt_file_ids', v_files);
END;
$fn$;

-- 関数は service_role（アプリ）だけが呼べる
REVOKE ALL ON FUNCTION invoice_remove_items_recalc(UUID, TEXT[], UUID[], JSONB, JSONB, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION invoice_remove_items_recalc(UUID, TEXT[], UUID[], JSONB, JSONB, JSONB) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION invoice_remove_items_recalc(UUID, TEXT[], UUID[], JSONB, JSONB, JSONB) TO service_role;
REVOKE ALL ON FUNCTION invoice_delete_editable(UUID, TEXT[], UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION invoice_delete_editable(UUID, TEXT[], UUID) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION invoice_delete_editable(UUID, TEXT[], UUID) TO service_role;

COMMENT ON FUNCTION invoice_remove_items_recalc(UUID, TEXT[], UUID[], JSONB, JSONB, JSONB) IS
  'ADR046追補: 下書き・差し戻し中の請求書から明細を外し合計を書き直す。発行者の advisory lock → invoices FOR UPDATE → invoice_items の順でロックし、状態・残り明細の指紋を確かめてから 1 トランザクションで書く';
COMMENT ON FUNCTION invoice_delete_editable(UUID, TEXT[], UUID) IS
  'ADR046追補: 下書き・差し戻し中の請求書を明細ごと消す。invoice_editor_submit と同じ順でロックし、状態を確かめてから消す。領収書ファイル id を返す';

COMMIT;

-- PostgREST に関数を認識させる
NOTIFY pgrst, 'reload schema';

-- ==================== 確認用（流したあとに結果を見る・書き込みはしない） ====================
-- 関数ができたか（2 行）
SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname IN ('invoice_remove_items_recalc', 'invoice_delete_editable');
