-- ADR 046 追補（2026-10-28 起案・2026-11-24 改訂）: 請求書エディタの「保存」「CR の追加」「提出」を DB の 1 トランザクションで行う
--
-- 直す不具合:
--   1. 同じ制作物×役割（creative_id, cost_type）を含む別々の請求書を同時に提出すると、
--      重複チェック（読む）と提出確定（書く）が別トランザクションのため両方とも通ってしまう
--   2. 自動保存（PUT /invoice-editor/:id）・CR の追加（POST /invoice-editor/:id/items）と提出（POST /invoice-editor/:id/submit）が
--      重なると、提出後に明細が書き換わり、確定した合計と明細が食い違う
--
-- 仕組み:
--   - invoice_billing_claims … 「新方式（exclusive）の請求書で提出済み・承認済み」の (発行者, CR, 役割) を 1 行ずつ記録。
--     主キー (issuer_id, creative_id, cost_type) で、同じ人が同じ CR×役割を 2 回請求済みにすることを DB が物理的に拒否する
--   - invoice_editor_save_draft() … 請求書行を SELECT … FOR UPDATE でロックし、
--     tax_mode='exclusive'・status が draft / rejected・updated_at（楽観ロック）一致を確かめてから
--     明細の削除・更新・追加（HFS の CR・HFS外・立替経費・過払いの調整）、立替経費の領収書の状態の書き込み、合計の更新を行う
--   - invoice_editor_submit() … 発行者単位の advisory lock ＋ 請求書行の FOR UPDATE の中で、
--     状態・楽観ロック・明細が検証時と同じか（指紋照合）・二重請求（請求済み記録 ＋ 旧方式の提出済み明細）を確かめ、
--     請求済み記録を入れ、status='submitted' と金額列を確定する。全部 1 トランザクション
--   - 請求書の status が draft / rejected に変わったら（差し戻し・修正のためのロック解除〔ADR 046 追補 2026-11-22・
--     どちらも POST /invoices/:id/reject で status='rejected'〕・下書きへ戻す）、トリガーが請求済み記録を解放。
--     それ以外の状態（issued など）へ変わっても解放しない（記録が残る側に倒す）。
--     請求書・明細の削除は外部キー ON DELETE CASCADE で解放
--   - 既存の提出済み・承認済みの新方式請求書はバックフィル（同じ組が既に 2 件あれば先に提出された 1 件だけ記録）
--
-- 前提: 2026-11-23_invoice_items_expense_receipt.sql（立替経費の日付・支払先・領収書の列）と
--       2026-11-23b_invoice_item_receipt_attach_fn.sql（領収書のアップロード関数）が本番に適用済みであること（どちらも適用済み）。
--   領収書のアップロード関数 attach_invoice_item_receipt は invoices を FOR SHARE → invoice_items を FOR UPDATE の順で押さえる。
--   この migration の 2 つの関数も invoices（FOR UPDATE）→ invoice_items の順なので、ロックの順が揃っていてデッドロックしない。
--   アップロードは保存・提出と直列になり、提出が確定したあとのアップロードは従来どおり not_editable になる。
--
-- 旧方式（inclusive・内税）の請求書の提出・差戻・削除フローは変えない（記録も作らない）。
-- 新方式の提出時の二重請求判定には、旧方式の提出済み・承認済み明細も含める（従来どおり）。
--
-- 新テーブルは同じ migration で RLS を有効化（ADR 048）。アプリは service_role だけで読み書きするのでポリシーは作らない。
-- 関数は SECURITY INVOKER（既定）・search_path 固定・EXECUTE は service_role のみ。
-- invoices.status を書くのはアプリ（service_role）だけ。解放トリガーは SECURITY INVOKER のままなので、
-- anon / authenticated から status を変えると請求済み記録を消せずに失敗する（それで正しい）。
-- 何度流しても同じ結果になる（IF NOT EXISTS / CREATE OR REPLACE / DROP … IF EXISTS / ON CONFLICT DO NOTHING）。
-- 2026-10-28 版（PR #1251 の初版）を流していた環境でも、そのまま流し直せば新しい版に置き換わる
-- （保存の関数は引数が変わったので、古い版を DROP してから作る）。

BEGIN;

-- ==================== 1. 請求済み記録 ====================
CREATE TABLE IF NOT EXISTS invoice_billing_claims (
  issuer_id       UUID NOT NULL,
  creative_id     UUID NOT NULL,
  cost_type       TEXT NOT NULL,
  invoice_id      UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  invoice_item_id UUID REFERENCES invoice_items(id) ON DELETE CASCADE,
  claimed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT invoice_billing_claims_pkey PRIMARY KEY (issuer_id, creative_id, cost_type)
);
CREATE INDEX IF NOT EXISTS idx_invoice_billing_claims_invoice ON invoice_billing_claims (invoice_id);
CREATE INDEX IF NOT EXISTS idx_invoice_billing_claims_item    ON invoice_billing_claims (invoice_item_id);

ALTER TABLE invoice_billing_claims ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE invoice_billing_claims FROM anon, authenticated;
GRANT SELECT, INSERT, DELETE ON TABLE invoice_billing_claims TO service_role;

COMMENT ON TABLE invoice_billing_claims IS
  'ADR046追補: 新方式（exclusive）で提出済み・承認済みの請求書に入っている (発行者, CR, 役割)。主キーで二重請求を物理的に防ぐ。差戻・ロック解除・下書き戻し・削除で解放';

-- ==================== 2. 解放トリガー（差し戻し・ロック解除・下書きへ戻す） ====================
CREATE OR REPLACE FUNCTION invoice_billing_claims_release()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $fn$
BEGIN
  DELETE FROM invoice_billing_claims WHERE invoice_id = NEW.id;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS tr_invoice_billing_claims_release ON invoices;
CREATE TRIGGER tr_invoice_billing_claims_release
  AFTER UPDATE OF status ON invoices
  FOR EACH ROW
  WHEN (NEW.status IN ('draft', 'rejected'))
  EXECUTE FUNCTION invoice_billing_claims_release();

-- ==================== 3. 下書きの保存・CR の追加（PUT /invoice-editor/:id・POST /invoice-editor/:id/items） ====================
-- p_invoice        : {withholding_enabled?, subtotal_amount, tax_amount, total_amount, withholding_amount, payout_amount, notes?}
--                    withholding_enabled / notes はキーが無ければ変えない
-- p_delete_ids     : 消す明細 id（この請求書の行だけ消える）
-- p_updates        : [{id, unit_price?, quantity?, label?, price_change_reason?, manual_reason?, expense_date?, expense_payee?,
--                      sort_order?, total_amount?}]
--                    キーがある列だけ変える。行の種類で変えられる列を DB でも絞る:
--                      CR の行（creative_id あり）… 単価・理由・並び順・金額（数量は常に 1）
--                      作業時間・一式の行 … 並び順だけ（単価・数量・品目・金額は変えない）
--                      立替経費の行（cost_type='expense'）… 品目・単価・日付・支払先・並び順・金額（数量は 1）
--                      過払いの調整の行（cost_type='adjustment'）… 品目・単価・理由・並び順・金額（数量は 1）
--                      HFS外の行 … 品目・単価・数量・理由・並び順・金額
--                    1 件でも見つからなければ例外（ERRCODE P0002・HINT ITEM_NOT_FOUND）で全部取り消す。アプリは 409「再読み込みしてください」にする
-- p_inserts        : [{client_key, creative_id?, creative_label?, cost_type?, label, unit?, unit_price, quantity,
--                      manual_reason?, original_unit_price?, price_change_reason?, sort_order, total_amount,
--                      expense_date?, expense_payee?, receipt_status?, receipt_missing_reason?}]
--                    HFS外・立替経費・過払いの調整の行（PUT）と、HFS の CR の行（POST …/items）。CR の行・立替経費・調整の行の数量は 1
-- p_receipt_writes : [{id, guard_file_id, receipt_status?, receipt_missing_reason?, clear_file?}]
--                    立替経費の行の領収書の状態・理由。行の receipt_file_id が guard_file_id と同じときだけ書く
--                    （古いタブの自動保存が、別の画面で付けた写真を消さないように）。clear_file=true なら写真の記録も外す
-- 戻り値 : {ok:true, updated_at, id_map:{client_key:id}, receipt_applied:[id], receipt_conflicts:[id], deleted_receipt_file_ids:[file_id]}
--          {ok:false, code:'NOT_FOUND'|'NOT_EXCLUSIVE'|'NOT_EDITABLE'|'CONFLICT', status?, updated_at?}
DROP FUNCTION IF EXISTS invoice_editor_save_draft(UUID, TIMESTAMPTZ, JSONB, UUID[], JSONB, JSONB);
CREATE OR REPLACE FUNCTION invoice_editor_save_draft(
  p_invoice_id          UUID,
  p_expected_updated_at TIMESTAMPTZ,
  p_invoice             JSONB,
  p_delete_ids          UUID[],
  p_updates             JSONB,
  p_inserts             JSONB,
  p_receipt_writes      JSONB
) RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
AS $fn$
DECLARE
  v_inv        invoices%ROWTYPE;
  v_n          INTEGER;
  v_expected   INTEGER;
  v_rec        RECORD;
  v_w          JSONB;
  v_new_id     UUID;
  v_id_map     JSONB := '{}'::jsonb;
  v_applied    JSONB := '[]'::jsonb;
  v_conflicts  JSONB := '[]'::jsonb;
  v_trash      JSONB := '[]'::jsonb;
  v_is_cr      BOOLEAN;
  v_qty1       BOOLEAN;
  v_updated    TIMESTAMPTZ;
BEGIN
  SELECT * INTO v_inv FROM invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  END IF;
  IF v_inv.tax_mode IS DISTINCT FROM 'exclusive' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_EXCLUSIVE');
  END IF;
  IF v_inv.status IS NULL OR v_inv.status NOT IN ('draft', 'rejected') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_EDITABLE', 'status', v_inv.status);
  END IF;
  IF p_expected_updated_at IS NULL OR v_inv.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RETURN jsonb_build_object('ok', false, 'code', 'CONFLICT', 'updated_at', v_inv.updated_at);
  END IF;

  -- 明細の削除（この請求書の行だけ）。消した行に付いていた領収書ファイルを返す（アプリが Drive のゴミ箱へ送る）
  IF p_delete_ids IS NOT NULL AND cardinality(p_delete_ids) > 0 THEN
    WITH d AS (
      DELETE FROM invoice_items WHERE invoice_id = p_invoice_id AND id = ANY (p_delete_ids)
      RETURNING receipt_file_id
    )
    SELECT COALESCE(jsonb_agg(receipt_file_id) FILTER (WHERE receipt_file_id IS NOT NULL), '[]'::jsonb)
      INTO v_trash FROM d;
  END IF;

  -- 明細の更新（この請求書の行だけ・1 件でも見つからなければ全部取り消す）
  IF p_updates IS NOT NULL AND jsonb_typeof(p_updates) = 'array' AND jsonb_array_length(p_updates) > 0 THEN
    -- 同じ id が 2 回来たら行数が合わないので、id の種類数で数える（どちらの値が勝つかはアプリが重複を送らない前提）
    SELECT count(DISTINCT (e->>'id')) INTO v_expected FROM jsonb_array_elements(p_updates) AS e;
    UPDATE invoice_items ii SET
      unit_price = CASE
        WHEN ii.creative_id IS NULL AND ii.cost_type IN ('hourly_fee', 'hourly_expense', 'installment_fee') THEN ii.unit_price
        WHEN u.v ? 'unit_price' THEN (u.v->>'unit_price')::INTEGER
        ELSE ii.unit_price END,
      quantity = CASE
        WHEN ii.creative_id IS NOT NULL THEN 1
        WHEN ii.cost_type IN ('hourly_fee', 'hourly_expense', 'installment_fee') THEN ii.quantity
        WHEN ii.cost_type IN ('expense', 'adjustment') THEN 1
        WHEN u.v ? 'quantity' THEN (u.v->>'quantity')::NUMERIC
        ELSE ii.quantity END,
      label = CASE
        WHEN ii.creative_id IS NULL AND COALESCE(ii.cost_type, '') NOT IN ('hourly_fee', 'hourly_expense', 'installment_fee')
             AND u.v ? 'label' THEN COALESCE(u.v->>'label', '')
        ELSE ii.label END,
      price_change_reason = CASE WHEN ii.creative_id IS NOT NULL AND u.v ? 'price_change_reason'
        THEN u.v->>'price_change_reason' ELSE ii.price_change_reason END,
      manual_reason = CASE
        WHEN ii.creative_id IS NULL AND COALESCE(ii.cost_type, '') NOT IN ('hourly_fee', 'hourly_expense', 'installment_fee', 'expense')
             AND u.v ? 'manual_reason' THEN u.v->>'manual_reason'
        ELSE ii.manual_reason END,
      expense_date = CASE WHEN ii.creative_id IS NULL AND ii.cost_type = 'expense' AND u.v ? 'expense_date'
        THEN (u.v->>'expense_date')::DATE ELSE ii.expense_date END,
      expense_payee = CASE WHEN ii.creative_id IS NULL AND ii.cost_type = 'expense' AND u.v ? 'expense_payee'
        THEN u.v->>'expense_payee' ELSE ii.expense_payee END,
      sort_order = CASE WHEN u.v ? 'sort_order' THEN (u.v->>'sort_order')::INTEGER ELSE ii.sort_order END,
      total_amount = CASE
        -- 作業時間・一式の行の金額はサーバー計算の固定額（単価そのまま・アプリの lineAmount と同じ）。送られてきた値は使わない
        WHEN ii.creative_id IS NULL AND ii.cost_type IN ('hourly_fee', 'hourly_expense', 'installment_fee') THEN COALESCE(ii.unit_price, 0)
        WHEN u.v ? 'total_amount' THEN (u.v->>'total_amount')::INTEGER
        ELSE ii.total_amount END
    FROM jsonb_array_elements(p_updates) AS u(v)
    WHERE ii.id = (u.v->>'id')::UUID AND ii.invoice_id = p_invoice_id;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n <> v_expected THEN
      RAISE EXCEPTION 'invoice_editor_save_draft: item not found (% of %)', v_n, v_expected
        USING ERRCODE = 'P0002', HINT = 'ITEM_NOT_FOUND';
    END IF;
  END IF;

  -- 立替経費の領収書の状態・理由（画面が見ていた写真と DB が同じ行だけ。食い違えば書かずに返す）
  IF p_receipt_writes IS NOT NULL AND jsonb_typeof(p_receipt_writes) = 'array' THEN
    FOR v_w IN SELECT value FROM jsonb_array_elements(p_receipt_writes)
    LOOP
      UPDATE invoice_items ii SET
        receipt_status = CASE WHEN v_w ? 'receipt_status' THEN v_w->>'receipt_status' ELSE ii.receipt_status END,
        receipt_missing_reason = CASE WHEN v_w ? 'receipt_missing_reason' THEN v_w->>'receipt_missing_reason' ELSE ii.receipt_missing_reason END,
        receipt_file_id     = CASE WHEN COALESCE((v_w->>'clear_file')::BOOLEAN, false) THEN NULL ELSE ii.receipt_file_id END,
        receipt_file_name   = CASE WHEN COALESCE((v_w->>'clear_file')::BOOLEAN, false) THEN NULL ELSE ii.receipt_file_name END,
        receipt_mime_type   = CASE WHEN COALESCE((v_w->>'clear_file')::BOOLEAN, false) THEN NULL ELSE ii.receipt_mime_type END,
        receipt_uploaded_at = CASE WHEN COALESCE((v_w->>'clear_file')::BOOLEAN, false) THEN NULL ELSE ii.receipt_uploaded_at END
      WHERE ii.id = (v_w->>'id')::UUID AND ii.invoice_id = p_invoice_id
        AND ii.creative_id IS NULL AND ii.cost_type = 'expense'
        AND ii.receipt_file_id IS NOT DISTINCT FROM NULLIF(v_w->>'guard_file_id', '');
      GET DIAGNOSTICS v_n = ROW_COUNT;
      IF v_n > 0 THEN
        v_applied := v_applied || jsonb_build_array(v_w->>'id');
        IF COALESCE((v_w->>'clear_file')::BOOLEAN, false) AND NULLIF(v_w->>'guard_file_id', '') IS NOT NULL THEN
          v_trash := v_trash || jsonb_build_array(v_w->>'guard_file_id');
        END IF;
      ELSE
        v_conflicts := v_conflicts || jsonb_build_array(v_w->>'id');
      END IF;
    END LOOP;
  END IF;

  -- 行の追加（HFS外・立替経費・過払いの調整・HFS の CR）
  IF p_inserts IS NOT NULL AND jsonb_typeof(p_inserts) = 'array' THEN
    FOR v_rec IN
      SELECT * FROM jsonb_to_recordset(p_inserts) AS x(
        client_key TEXT, creative_id UUID, creative_label TEXT, cost_type TEXT, label TEXT, unit TEXT,
        unit_price INTEGER, quantity NUMERIC, manual_reason TEXT, original_unit_price INTEGER, price_change_reason TEXT,
        sort_order INTEGER, total_amount INTEGER,
        expense_date DATE, expense_payee TEXT, receipt_status TEXT, receipt_missing_reason TEXT)
    LOOP
      v_is_cr := v_rec.creative_id IS NOT NULL;
      v_qty1  := v_is_cr OR COALESCE(v_rec.cost_type, '') IN ('expense', 'adjustment');
      INSERT INTO invoice_items (
        invoice_id, creative_id, creative_label, cost_type, label, unit, unit_price, quantity,
        manual_reason, original_unit_price, price_change_reason, is_special, special_reason, sort_order, total_amount,
        expense_date, expense_payee, receipt_status, receipt_missing_reason
      ) VALUES (
        p_invoice_id, v_rec.creative_id, v_rec.creative_label, v_rec.cost_type, COALESCE(v_rec.label, ''),
        COALESCE(v_rec.unit, CASE WHEN v_is_cr THEN '本' ELSE '式' END),
        v_rec.unit_price,
        CASE WHEN v_qty1 THEN 1 ELSE COALESCE(v_rec.quantity, 1) END,
        CASE WHEN v_is_cr OR v_rec.cost_type = 'expense' THEN NULL ELSE v_rec.manual_reason END,
        CASE WHEN v_is_cr THEN v_rec.original_unit_price ELSE NULL END,
        CASE WHEN v_is_cr THEN v_rec.price_change_reason ELSE NULL END,
        false, NULL, COALESCE(v_rec.sort_order, 0), COALESCE(v_rec.total_amount, 0),
        CASE WHEN NOT v_is_cr AND v_rec.cost_type = 'expense' THEN v_rec.expense_date ELSE NULL END,
        CASE WHEN NOT v_is_cr AND v_rec.cost_type = 'expense' THEN v_rec.expense_payee ELSE NULL END,
        CASE WHEN NOT v_is_cr AND v_rec.cost_type = 'expense' THEN v_rec.receipt_status ELSE NULL END,
        CASE WHEN NOT v_is_cr AND v_rec.cost_type = 'expense' THEN v_rec.receipt_missing_reason ELSE NULL END
      ) RETURNING id INTO v_new_id;
      IF v_rec.client_key IS NOT NULL AND v_rec.client_key <> '' THEN
        v_id_map := v_id_map || jsonb_build_object(v_rec.client_key, v_new_id);
      END IF;
    END LOOP;
  END IF;

  -- 請求書の合計（アプリが保存後の明細から計算した値）と更新時刻
  UPDATE invoices SET
    withholding_enabled = CASE WHEN p_invoice ? 'withholding_enabled'
      THEN (p_invoice->>'withholding_enabled')::BOOLEAN ELSE withholding_enabled END,
    subtotal_amount     = (p_invoice->>'subtotal_amount')::INTEGER,
    tax_amount          = (p_invoice->>'tax_amount')::INTEGER,
    total_amount        = (p_invoice->>'total_amount')::INTEGER,
    withholding_amount  = (p_invoice->>'withholding_amount')::INTEGER,
    payout_amount       = (p_invoice->>'payout_amount')::INTEGER,
    notes               = CASE WHEN p_invoice ? 'notes' THEN p_invoice->>'notes' ELSE notes END,
    updated_at          = clock_timestamp()
  WHERE id = p_invoice_id
  RETURNING updated_at INTO v_updated;

  RETURN jsonb_build_object('ok', true, 'updated_at', v_updated, 'id_map', v_id_map,
    'receipt_applied', v_applied, 'receipt_conflicts', v_conflicts, 'deleted_receipt_file_ids', v_trash);
END;
$fn$;

-- ==================== 4. 提出（POST /invoice-editor/:id/submit） ====================
-- アプリ（routes/haruka.js）が「本人の分・納品済み・参考単価・理由・領収書・合計一致」を検証した明細の指紋を渡し、
-- この関数がロックの中で「その明細のまま」「二重請求なし」を確かめてから確定する。
-- p_items       : 検証に使った明細の指紋 [{id, creative_id, cost_type, unit_price, quantity, label, price_change_reason, manual_reason}]（請求書の全行）
--                 領収書の列は入れない（ロックの外で変わるのはアップロード関数の「添付あり」だけで、判定を厳しくする方向には働かない。
--                 自動保存は updated_at を進めるので、楽観ロックで止まる）
-- p_ref_updates : 提出時点で再計算した参考単価 [{id, original_unit_price}]
-- p_totals      : {subtotal, tax, total, withholding, payout}
-- 戻り値 : {ok:true, invoice:{…}} /
--          {ok:false, code:'NOT_FOUND'|'NO_ISSUER'|'NOT_EXCLUSIVE'|'NOT_EDITABLE'|'CONFLICT'|'STALE_ITEMS'|'DUPLICATE', problems?}
CREATE OR REPLACE FUNCTION invoice_editor_submit(
  p_invoice_id          UUID,
  p_expected_updated_at TIMESTAMPTZ,
  p_items               JSONB,
  p_ref_updates         JSONB,
  p_totals              JSONB
) RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
AS $fn$
DECLARE
  v_issuer   UUID;
  v_inv      invoices%ROWTYPE;
  v_diff     INTEGER;
  v_problems JSONB;
  v_now      TIMESTAMPTZ;
BEGIN
  SELECT issuer_id INTO v_issuer FROM invoices WHERE id = p_invoice_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  END IF;
  IF v_issuer IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NO_ISSUER');
  END IF;

  -- 同じ発行者の提出を 1 本ずつに並べる（ロック順: advisory → 請求書行。保存・領収書は請求書行からなので循環しない）
  PERFORM pg_advisory_xact_lock(hashtextextended('invoice_billing:' || v_issuer::TEXT, 0));

  SELECT * INTO v_inv FROM invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  END IF;
  IF v_inv.issuer_id IS DISTINCT FROM v_issuer THEN
    RETURN jsonb_build_object('ok', false, 'code', 'CONFLICT', 'updated_at', v_inv.updated_at);
  END IF;
  IF v_inv.tax_mode IS DISTINCT FROM 'exclusive' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_EXCLUSIVE');
  END IF;
  IF v_inv.status IS NULL OR v_inv.status NOT IN ('draft', 'rejected') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_EDITABLE', 'status', v_inv.status);
  END IF;
  IF p_expected_updated_at IS NULL OR v_inv.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RETURN jsonb_build_object('ok', false, 'code', 'CONFLICT', 'updated_at', v_inv.updated_at);
  END IF;

  -- 明細がアプリの検証時と同じか（行の増減・単価・数量・CR・役割・品目・理由のどれかが違えば止める）
  WITH cur AS (
    SELECT id, creative_id, cost_type, unit_price, quantity, label, price_change_reason, manual_reason
    FROM invoice_items WHERE invoice_id = p_invoice_id
  ), sent AS (
    SELECT id, creative_id, cost_type, unit_price, quantity, label, price_change_reason, manual_reason
    FROM jsonb_to_recordset(COALESCE(p_items, '[]'::jsonb))
      AS x(id UUID, creative_id UUID, cost_type TEXT, unit_price INTEGER, quantity NUMERIC,
           label TEXT, price_change_reason TEXT, manual_reason TEXT)
  )
  SELECT count(*) INTO v_diff FROM (
    (SELECT * FROM cur EXCEPT ALL SELECT * FROM sent)
    UNION ALL
    (SELECT * FROM sent EXCEPT ALL SELECT * FROM cur)
  ) d;
  IF v_diff > 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'STALE_ITEMS');
  END IF;

  -- 二重請求: この請求書の中での重複
  SELECT jsonb_agg(jsonb_build_object('item_id', ii.id, 'creative_id', ii.creative_id, 'cost_type', ii.cost_type,
                                      'code', 'DUPLICATE_IN_INVOICE'))
    INTO v_problems
  FROM invoice_items ii
  WHERE ii.invoice_id = p_invoice_id AND ii.creative_id IS NOT NULL AND ii.cost_type IS NOT NULL
    AND (ii.creative_id, ii.cost_type) IN (
      SELECT creative_id, cost_type FROM invoice_items
      WHERE invoice_id = p_invoice_id AND creative_id IS NOT NULL AND cost_type IS NOT NULL
      GROUP BY creative_id, cost_type HAVING count(*) > 1);
  IF v_problems IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'DUPLICATE', 'problems', v_problems);
  END IF;

  -- 二重請求: 本人の他の請求書（新方式の請求済み記録 ＋ 旧方式も含む提出済み・承認済みの明細）
  SELECT jsonb_agg(jsonb_build_object('item_id', m.id, 'creative_id', m.creative_id, 'cost_type', m.cost_type,
                                      'code', 'DUPLICATE'))
    INTO v_problems
  FROM invoice_items m
  WHERE m.invoice_id = p_invoice_id AND m.creative_id IS NOT NULL AND m.cost_type IS NOT NULL
    AND (
      EXISTS (SELECT 1 FROM invoice_billing_claims c
              WHERE c.issuer_id = v_issuer AND c.creative_id = m.creative_id AND c.cost_type = m.cost_type
                AND c.invoice_id <> p_invoice_id)
      OR EXISTS (SELECT 1 FROM invoice_items o JOIN invoices i ON i.id = o.invoice_id
                 WHERE o.creative_id = m.creative_id AND o.cost_type = m.cost_type
                   AND i.issuer_id = v_issuer AND i.status IN ('submitted', 'approved') AND i.id <> p_invoice_id)
    );
  IF v_problems IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'DUPLICATE', 'problems', v_problems);
  END IF;

  -- 参考単価を提出時点の値で控え直す
  IF p_ref_updates IS NOT NULL AND jsonb_typeof(p_ref_updates) = 'array' AND jsonb_array_length(p_ref_updates) > 0 THEN
    UPDATE invoice_items ii SET original_unit_price = (u.v->>'original_unit_price')::INTEGER
    FROM jsonb_array_elements(p_ref_updates) AS u(v)
    WHERE ii.id = (u.v->>'id')::UUID AND ii.invoice_id = p_invoice_id AND ii.creative_id IS NOT NULL;
  END IF;

  -- 請求済み記録（主キーで物理的に一意。万一ここで重複すれば unique_violation で全体が取り消される）
  DELETE FROM invoice_billing_claims WHERE invoice_id = p_invoice_id;
  INSERT INTO invoice_billing_claims (issuer_id, creative_id, cost_type, invoice_id, invoice_item_id)
  SELECT v_issuer, ii.creative_id, ii.cost_type, p_invoice_id, ii.id
  FROM invoice_items ii
  WHERE ii.invoice_id = p_invoice_id AND ii.creative_id IS NOT NULL AND ii.cost_type IS NOT NULL;

  -- 提出確定（金額列はアプリが検証済みの明細から再計算した値）
  v_now := clock_timestamp();
  UPDATE invoices SET
    status             = 'submitted',
    submitted_at       = v_now,
    updated_at         = v_now,
    subtotal_amount    = (p_totals->>'subtotal')::INTEGER,
    tax_amount         = (p_totals->>'tax')::INTEGER,
    total_amount       = (p_totals->>'total')::INTEGER,
    withholding_amount = (p_totals->>'withholding')::INTEGER,
    payout_amount      = (p_totals->>'payout')::INTEGER
  WHERE id = p_invoice_id
  RETURNING * INTO v_inv;

  RETURN jsonb_build_object('ok', true, 'invoice', to_jsonb(v_inv));
END;
$fn$;

-- 関数は service_role（アプリ）だけが呼べる
REVOKE ALL ON FUNCTION invoice_editor_save_draft(UUID, TIMESTAMPTZ, JSONB, UUID[], JSONB, JSONB, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION invoice_editor_save_draft(UUID, TIMESTAMPTZ, JSONB, UUID[], JSONB, JSONB, JSONB) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION invoice_editor_save_draft(UUID, TIMESTAMPTZ, JSONB, UUID[], JSONB, JSONB, JSONB) TO service_role;
REVOKE ALL ON FUNCTION invoice_editor_submit(UUID, TIMESTAMPTZ, JSONB, JSONB, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION invoice_editor_submit(UUID, TIMESTAMPTZ, JSONB, JSONB, JSONB) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION invoice_editor_submit(UUID, TIMESTAMPTZ, JSONB, JSONB, JSONB) TO service_role;
REVOKE ALL ON FUNCTION invoice_billing_claims_release() FROM PUBLIC;
REVOKE ALL ON FUNCTION invoice_billing_claims_release() FROM anon, authenticated;

COMMENT ON FUNCTION invoice_editor_save_draft(UUID, TIMESTAMPTZ, JSONB, UUID[], JSONB, JSONB, JSONB) IS
  'ADR046追補: 請求書エディタの下書き保存・CR の追加。請求書行を FOR UPDATE で押さえ、状態・楽観ロックを確かめてから明細と合計を 1 トランザクションで書く';
COMMENT ON FUNCTION invoice_editor_submit(UUID, TIMESTAMPTZ, JSONB, JSONB, JSONB) IS
  'ADR046追補: 請求書エディタの提出。発行者の advisory lock ＋ 請求書行の FOR UPDATE の中で、明細の指紋・二重請求を確かめて請求済み記録と提出を確定する';

-- ==================== 5. バックフィル（既存の提出済み・承認済みの新方式請求書） ====================
-- 同じ (発行者, CR, 役割) が既に 2 件以上の請求書にある場合は、先に提出された 1 件だけ記録する（残りは下の確認 SELECT に出る）
INSERT INTO invoice_billing_claims (issuer_id, creative_id, cost_type, invoice_id, invoice_item_id, claimed_at)
SELECT DISTINCT ON (i.issuer_id, ii.creative_id, ii.cost_type)
       i.issuer_id, ii.creative_id, ii.cost_type, i.id, ii.id, COALESCE(i.submitted_at, i.updated_at, now())
FROM invoice_items ii
JOIN invoices i ON i.id = ii.invoice_id
WHERE i.tax_mode = 'exclusive'
  AND i.status IN ('submitted', 'approved')
  AND i.issuer_id IS NOT NULL
  AND ii.creative_id IS NOT NULL
  AND ii.cost_type IS NOT NULL
ORDER BY i.issuer_id, ii.creative_id, ii.cost_type, i.submitted_at NULLS LAST, i.created_at, ii.created_at
ON CONFLICT ON CONSTRAINT invoice_billing_claims_pkey DO NOTHING;

COMMIT;

-- PostgREST に関数を認識させる
NOTIFY pgrst, 'reload schema';

-- ==================== 確認用（流したあとに結果を見る・書き込みはしない） ====================
-- (a) 記録できた件数
SELECT count(*) AS claims FROM invoice_billing_claims;
-- (b) 既に二重になっている組（新方式の提出済み・承認済みで、同じ人・同じ CR・同じ役割が 2 件以上）。0 行なら問題なし
SELECT i.issuer_id, ii.creative_id, ii.cost_type, count(DISTINCT i.id) AS n, array_agg(DISTINCT i.invoice_number) AS invoices
FROM invoice_items ii
JOIN invoices i ON i.id = ii.invoice_id
WHERE i.tax_mode = 'exclusive' AND i.status IN ('submitted', 'approved')
  AND ii.creative_id IS NOT NULL AND ii.cost_type IS NOT NULL
GROUP BY i.issuer_id, ii.creative_id, ii.cost_type
HAVING count(DISTINCT i.id) > 1;
-- (c) 関数ができたか（2 行）
SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname IN ('invoice_editor_save_draft', 'invoice_editor_submit');
