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
--   - invoice_remove_items_recalc() … 1 つの制作が載っている請求書（複数可）から明細を外し、各請求書の合計を書き直す。
--     全部を 1 トランザクションで行い、ロックの中で「状態の確認 → 明細の削除 → 合計の書き込み」を行う。
--     合計の計算式はアプリ（utils/invoice-editor.js の computeTotals）が正なので、アプリが請求書ごとに
--     「消したあとに残るはずの明細」の指紋と、その明細から計算した合計を渡す。関数はロックの中で残りの明細が指紋と同じかを
--     確かめ、違えば STALE を返す（アプリが読み直してやり直す）。invoice_editor_submit と同じ考え方
--     p_all_or_nothing=true（admin-status）なら、1 件でも外せない請求書があれば何も書かない
--   - invoice_delete_editable() … 請求書 1 件を明細ごと消す。ロックの中で状態を確かめる。消した行の領収書ファイル id を返す
--     （アプリが Drive のゴミ箱へ送る）
--   - ロックの順は invoice_editor_submit（2026-11-24_invoice_editor_atomic_submit.sql）と同じ:
--       発行者の advisory lock（hashtextextended('invoice_billing:' || issuer_id, 0)）→ invoices FOR UPDATE → invoice_items
--     複数の請求書を扱うときは、advisory lock を発行者 id の順、invoices・invoice_items を id の順に取る（この関数どうしで循環しない）。
--     保存（invoice_editor_save_draft）・領収書（attach_invoice_item_receipt）は advisory を取らず invoices → invoice_items の順なので循環しない
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
-- p_requests          : 請求書ごとの依頼 [{invoice_id, delete_ids:[id], remaining:[指紋], expected:{tax_mode, withholding_enabled}, totals:{…}}]
--                         delete_ids … 外す明細 id（その請求書の行だけ消える。もう無い id は無視）
--                         remaining  … 外したあとに残るはずの明細の指紋 [{id, creative_id, cost_type, unit_price, quantity, total_amount}]（残り全行）
--                         expected   … アプリが合計を計算したときの請求書の値
--                         totals     … 残りの明細から計算した合計
--                                        新方式（exclusive）… {subtotal_amount, tax_amount, total_amount, withholding_amount, payout_amount}
--                                        旧方式（inclusive）… {total_amount}
-- p_editable_statuses : 外してよい状態（draft / rejected の部分集合。admin-status は {draft}、納品の取り消しは {draft,rejected}）
-- p_all_or_nothing    : true なら、1 件でも NOT_EDITABLE / STALE があれば何も書かずに {ok:false} を返す
-- 戻り値 : {ok:true,  results:[{invoice_id, result:'OK'|'NOT_FOUND'|'NOT_EDITABLE'|'STALE', status?, deleted_ids?}]}
--          {ok:false, code:'NOT_EDITABLE'|'STALE', results:[…]}（p_all_or_nothing のときだけ・何も書いていない）
DROP FUNCTION IF EXISTS invoice_remove_items_recalc(UUID, TEXT[], UUID[], JSONB, JSONB, JSONB);
CREATE OR REPLACE FUNCTION invoice_remove_items_recalc(
  p_requests          JSONB,
  p_editable_statuses TEXT[],
  p_all_or_nothing    BOOLEAN
) RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
AS $fn$
DECLARE
  v_ids      UUID[];
  v_issuer   UUID;
  v_req      JSONB;
  v_inv      invoices%ROWTYPE;
  v_inv_id   UUID;
  v_del      UUID[];
  v_diff     INTEGER;
  v_code     TEXT;
  v_results  JSONB := '[]'::jsonb;
  v_ok_reqs  JSONB := '[]'::jsonb;
  v_bad      TEXT := NULL;
  v_deleted  JSONB;
  v_t        JSONB;
BEGIN
  IF p_editable_statuses IS NULL OR cardinality(p_editable_statuses) = 0
     OR EXISTS (SELECT 1 FROM unnest(p_editable_statuses) s WHERE s IS NULL OR s NOT IN ('draft', 'rejected')) THEN
    RAISE EXCEPTION 'invoice_remove_items_recalc: editable statuses must be draft/rejected (%)', p_editable_statuses
      USING ERRCODE = '22023';
  END IF;
  IF p_requests IS NULL OR jsonb_typeof(p_requests) <> 'array' THEN
    RAISE EXCEPTION 'invoice_remove_items_recalc: p_requests must be an array' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_requests) r
             WHERE NOT (r ? 'invoice_id') OR NOT (r ? 'totals') OR NOT ((r->'totals') ? 'total_amount')) THEN
    RAISE EXCEPTION 'invoice_remove_items_recalc: each request needs invoice_id and totals.total_amount' USING ERRCODE = '22023';
  END IF;
  SELECT array_agg(DISTINCT (r->>'invoice_id')::UUID) INTO v_ids FROM jsonb_array_elements(p_requests) r;
  IF v_ids IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'results', '[]'::jsonb);
  END IF;
  IF cardinality(v_ids) <> jsonb_array_length(p_requests) THEN
    RAISE EXCEPTION 'invoice_remove_items_recalc: duplicate invoice_id in p_requests' USING ERRCODE = '22023';
  END IF;

  -- 提出（invoice_editor_submit）と同じ順でロックする: 発行者の advisory（発行者 id 順）→ 請求書行（id 順）→ 明細（id 順）
  FOR v_issuer IN
    SELECT DISTINCT issuer_id FROM invoices WHERE id = ANY (v_ids) AND issuer_id IS NOT NULL ORDER BY issuer_id
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('invoice_billing:' || v_issuer::TEXT, 0));
  END LOOP;
  PERFORM 1 FROM invoices WHERE id = ANY (v_ids) ORDER BY id FOR UPDATE;
  PERFORM 1 FROM invoice_items WHERE invoice_id = ANY (v_ids) ORDER BY id FOR UPDATE;

  -- 1 周目: 確かめるだけ（まだ何も書かない）
  FOR v_req IN
    SELECT r FROM jsonb_array_elements(p_requests) r ORDER BY (r->>'invoice_id')::UUID
  LOOP
    v_inv_id := (v_req->>'invoice_id')::UUID;
    v_del := COALESCE(ARRAY(SELECT jsonb_array_elements_text(COALESCE(v_req->'delete_ids', '[]'::jsonb))::UUID), ARRAY[]::UUID[]);
    SELECT * INTO v_inv FROM invoices WHERE id = v_inv_id;
    IF NOT FOUND THEN
      v_code := 'NOT_FOUND';
    ELSIF v_inv.status IS NULL OR NOT (v_inv.status = ANY (p_editable_statuses)) THEN
      v_code := 'NOT_EDITABLE';
    ELSIF v_inv.tax_mode IS DISTINCT FROM (v_req->'expected'->>'tax_mode')
       OR v_inv.withholding_enabled IS DISTINCT FROM (v_req->'expected'->>'withholding_enabled')::BOOLEAN THEN
      v_code := 'STALE';
    ELSIF v_inv.tax_mode = 'exclusive'
       AND NOT ((v_req->'totals') ?& ARRAY['subtotal_amount', 'tax_amount', 'total_amount', 'withholding_amount', 'payout_amount']) THEN
      -- 新方式は小計〜差引の 5 列がそろっていないと NULL を書いてしまう（立替経費・源泉の集計が狂う）
      RAISE EXCEPTION 'invoice_remove_items_recalc: exclusive invoice % needs all 5 totals', v_inv_id USING ERRCODE = '22023';
    ELSE
      -- 外したあとに残る明細が、アプリが合計を計算した明細と同じか（行の増減・単価・数量・金額・CR・役割）
      WITH cur AS (
        SELECT id, creative_id, cost_type, unit_price, quantity, total_amount
        FROM invoice_items
        WHERE invoice_id = v_inv_id AND NOT (id = ANY (v_del))
      ), sent AS (
        SELECT id, creative_id, cost_type, unit_price, quantity, total_amount
        FROM jsonb_to_recordset(COALESCE(v_req->'remaining', '[]'::jsonb))
          AS x(id UUID, creative_id UUID, cost_type TEXT, unit_price INTEGER, quantity NUMERIC, total_amount INTEGER)
      )
      SELECT count(*) INTO v_diff FROM (
        (SELECT * FROM cur EXCEPT ALL SELECT * FROM sent)
        UNION ALL
        (SELECT * FROM sent EXCEPT ALL SELECT * FROM cur)
      ) d;
      v_code := CASE WHEN v_diff > 0 THEN 'STALE' ELSE 'OK' END;
    END IF;

    IF v_code = 'OK' THEN
      v_ok_reqs := v_ok_reqs || jsonb_build_array(v_req);
    ELSE
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'invoice_id', v_inv_id, 'result', v_code, 'status', CASE WHEN v_code = 'NOT_FOUND' THEN NULL ELSE v_inv.status END));
      IF v_code = 'NOT_EDITABLE' THEN v_bad := 'NOT_EDITABLE';
      ELSIF v_code = 'STALE' AND v_bad IS NULL THEN v_bad := 'STALE';
      END IF;
    END IF;
  END LOOP;

  IF COALESCE(p_all_or_nothing, false) AND v_bad IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', v_bad, 'results', v_results);
  END IF;

  -- 2 周目: 確かめた請求書だけ、明細を消して合計を書く
  FOR v_req IN SELECT value FROM jsonb_array_elements(v_ok_reqs)
  LOOP
    v_inv_id := (v_req->>'invoice_id')::UUID;
    v_del := COALESCE(ARRAY(SELECT jsonb_array_elements_text(COALESCE(v_req->'delete_ids', '[]'::jsonb))::UUID), ARRAY[]::UUID[]);
    v_t := v_req->'totals';
    v_deleted := '[]'::jsonb;
    IF cardinality(v_del) > 0 THEN
      -- 内訳は外部キー ON DELETE CASCADE でも消えるが、明示して消す
      DELETE FROM invoice_item_details
      WHERE invoice_item_id IN (SELECT id FROM invoice_items WHERE invoice_id = v_inv_id AND id = ANY (v_del));
      WITH d AS (
        DELETE FROM invoice_items WHERE invoice_id = v_inv_id AND id = ANY (v_del)
        RETURNING id
      )
      SELECT COALESCE(jsonb_agg(id), '[]'::jsonb) INTO v_deleted FROM d;
    END IF;
    SELECT * INTO v_inv FROM invoices WHERE id = v_inv_id;
    IF v_inv.tax_mode = 'exclusive' THEN
      UPDATE invoices SET
        subtotal_amount    = (v_t->>'subtotal_amount')::INTEGER,
        tax_amount         = (v_t->>'tax_amount')::INTEGER,
        total_amount       = (v_t->>'total_amount')::INTEGER,
        withholding_amount = (v_t->>'withholding_amount')::INTEGER,
        payout_amount      = (v_t->>'payout_amount')::INTEGER,
        updated_at         = clock_timestamp()
      WHERE id = v_inv_id;
    ELSE
      UPDATE invoices SET
        total_amount = (v_t->>'total_amount')::INTEGER,
        updated_at   = clock_timestamp()
      WHERE id = v_inv_id;
    END IF;
    v_results := v_results || jsonb_build_array(jsonb_build_object(
      'invoice_id', v_inv_id, 'result', 'OK', 'status', v_inv.status, 'deleted_ids', v_deleted));
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'results', v_results);
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
REVOKE ALL ON FUNCTION invoice_remove_items_recalc(JSONB, TEXT[], BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION invoice_remove_items_recalc(JSONB, TEXT[], BOOLEAN) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION invoice_remove_items_recalc(JSONB, TEXT[], BOOLEAN) TO service_role;
REVOKE ALL ON FUNCTION invoice_delete_editable(UUID, TEXT[], UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION invoice_delete_editable(UUID, TEXT[], UUID) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION invoice_delete_editable(UUID, TEXT[], UUID) TO service_role;

COMMENT ON FUNCTION invoice_remove_items_recalc(JSONB, TEXT[], BOOLEAN) IS
  'ADR046追補: 下書き・差し戻し中の請求書（複数可）から明細を外し合計を書き直す。発行者の advisory lock → invoices FOR UPDATE → invoice_items の順でロックし、状態・残り明細の指紋を確かめてから 1 トランザクションで書く';
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
