-- ADR 046 追補（2026-10-28）: 請求書エディタの「保存」「提出」を DB の 1 トランザクションで行う
--
-- 直す不具合:
--   1. 同じ制作物×役割（creative_id, cost_type）を含む別々の請求書を同時に提出すると、
--      重複チェック（読む）と提出確定（書く）が別トランザクションのため両方とも通ってしまう
--   2. 自動保存（PUT /invoice-editor/:id）と提出（POST /invoice-editor/:id/submit）が重なると、
--      提出後に明細が書き換わり、確定した合計と明細が食い違う
--
-- 仕組み:
--   - invoice_billing_claims … 「新方式（exclusive）の請求書で提出済み」の (発行者, CR, 役割) を 1 行ずつ記録。
--     主キー (issuer_id, creative_id, cost_type) で、同じ人が同じ CR×役割を 2 回提出することを DB が物理的に拒否する
--   - invoice_editor_save_draft() … 請求書行を SELECT … FOR UPDATE でロックし、
--     status が draft / rejected・updated_at（楽観ロック）一致を確かめてから明細と合計を書き換える
--   - invoice_editor_submit() … 発行者単位の advisory lock ＋ 請求書行の FOR UPDATE の中で、
--     状態・楽観ロック・明細が検証時と同じか（指紋照合）・二重請求（請求済み記録 ＋ 旧方式の提出済み明細）を確かめ、
--     請求済み記録を入れ、status='submitted' と金額列を確定する。全部 1 トランザクション
--   - 差し戻し（status→rejected）・下書きへ戻す（status→draft）でトリガーが請求済み記録を解放。
--     請求書の削除は外部キー ON DELETE CASCADE で解放
--   - 既存の提出済み・承認済みの新方式請求書はバックフィル（同じ組が既に 2 件あれば古い 1 件だけ記録）
--
-- 旧方式（inclusive・内税）の請求書の提出・差戻・削除フローは変えない（記録も作らない）。
-- 新方式の提出時の二重請求判定には、旧方式の提出済み・承認済み明細も含める（従来どおり）。
--
-- 新テーブルは同じ migration で RLS を有効化（ADR 048）。アプリは service_role だけで読み書きするのでポリシーは作らない。
-- 関数は SECURITY INVOKER（既定）・search_path 固定・EXECUTE は service_role のみ。
-- 何度流しても同じ結果になる（IF NOT EXISTS / CREATE OR REPLACE / DROP … IF EXISTS / ON CONFLICT DO NOTHING）。

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

COMMENT ON TABLE invoice_billing_claims IS
  'ADR046追補: 新方式（exclusive）で提出済み・承認済みの請求書に入っている (発行者, CR, 役割)。主キーで二重請求を物理的に防ぐ。差戻・下書き戻し・削除で解放';

-- ==================== 2. 解放トリガー（差し戻し・下書きへ戻す） ====================
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

-- ==================== 3. 下書きの保存（PUT /invoice-editor/:id） ====================
-- p_invoice : {withholding_enabled, subtotal_amount, tax_amount, total_amount, withholding_amount, payout_amount, notes?}
--             notes キーが無ければ備考は変えない
-- p_delete_ids : 消す明細 id
-- p_updates : [{id, unit_price?, quantity?, price_change_reason?, label?, manual_reason?, sort_order, total_amount}]
--             キーがある列だけ変える（CR 行の数量は常に 1、作業時間・一式の行は単価・数量・品目を変えない）
-- p_inserts : [{client_key, label, unit_price, quantity, manual_reason, sort_order, total_amount}]（HFS外の行）
-- 戻り値 : {ok:true, updated_at, id_map:{client_key:id}} / {ok:false, code:'NOT_FOUND'|'NOT_EXCLUSIVE'|'NOT_EDITABLE'|'CONFLICT', ...}
CREATE OR REPLACE FUNCTION invoice_editor_save_draft(
  p_invoice_id          UUID,
  p_expected_updated_at TIMESTAMPTZ,
  p_invoice             JSONB,
  p_delete_ids          UUID[],
  p_updates             JSONB,
  p_inserts             JSONB
) RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
AS $fn$
DECLARE
  v_inv      invoices%ROWTYPE;
  v_n        INTEGER;
  v_expected INTEGER;
  v_rec      RECORD;
  v_new_id   UUID;
  v_id_map   JSONB := '{}'::jsonb;
  v_updated  TIMESTAMPTZ;
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

  -- 明細の削除（この請求書の行だけ）
  IF p_delete_ids IS NOT NULL AND cardinality(p_delete_ids) > 0 THEN
    DELETE FROM invoice_item_details d
      USING invoice_items ii
      WHERE d.invoice_item_id = ii.id AND ii.invoice_id = p_invoice_id AND ii.id = ANY (p_delete_ids);
    DELETE FROM invoice_items WHERE invoice_id = p_invoice_id AND id = ANY (p_delete_ids);
  END IF;

  -- 明細の更新（この請求書の行だけ・1 件でも見つからなければ全部取り消す）
  IF p_updates IS NOT NULL AND jsonb_typeof(p_updates) = 'array' AND jsonb_array_length(p_updates) > 0 THEN
    v_expected := jsonb_array_length(p_updates);
    UPDATE invoice_items ii SET
      unit_price = CASE
        WHEN ii.creative_id IS NULL AND ii.cost_type IN ('hourly_fee', 'hourly_expense', 'installment_fee') THEN ii.unit_price
        WHEN u.v ? 'unit_price' THEN (u.v->>'unit_price')::INTEGER
        ELSE ii.unit_price END,
      quantity = CASE
        WHEN ii.creative_id IS NOT NULL THEN 1
        WHEN ii.cost_type IN ('hourly_fee', 'hourly_expense', 'installment_fee') THEN ii.quantity
        WHEN u.v ? 'quantity' THEN (u.v->>'quantity')::NUMERIC
        ELSE ii.quantity END,
      label = CASE
        WHEN ii.creative_id IS NULL AND COALESCE(ii.cost_type, '') NOT IN ('hourly_fee', 'hourly_expense', 'installment_fee')
             AND u.v ? 'label' THEN u.v->>'label'
        ELSE ii.label END,
      price_change_reason = CASE WHEN ii.creative_id IS NOT NULL AND u.v ? 'price_change_reason'
        THEN u.v->>'price_change_reason' ELSE ii.price_change_reason END,
      manual_reason = CASE WHEN ii.creative_id IS NULL AND u.v ? 'manual_reason'
        THEN u.v->>'manual_reason' ELSE ii.manual_reason END,
      sort_order = CASE WHEN u.v ? 'sort_order' THEN (u.v->>'sort_order')::INTEGER ELSE ii.sort_order END,
      total_amount = CASE WHEN u.v ? 'total_amount' THEN (u.v->>'total_amount')::INTEGER ELSE ii.total_amount END
    FROM jsonb_array_elements(p_updates) AS u(v)
    WHERE ii.id = (u.v->>'id')::UUID AND ii.invoice_id = p_invoice_id;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n <> v_expected THEN
      RAISE EXCEPTION 'invoice_editor_save_draft: item not found (% of %)', v_n, v_expected
        USING ERRCODE = 'P0002', HINT = 'ITEM_NOT_FOUND';
    END IF;
  END IF;

  -- HFS外の行の追加
  IF p_inserts IS NOT NULL AND jsonb_typeof(p_inserts) = 'array' THEN
    FOR v_rec IN
      SELECT * FROM jsonb_to_recordset(p_inserts) AS x(
        client_key TEXT, label TEXT, unit_price INTEGER, quantity NUMERIC,
        manual_reason TEXT, sort_order INTEGER, total_amount INTEGER)
    LOOP
      INSERT INTO invoice_items (
        invoice_id, creative_id, creative_label, cost_type, label, unit, unit_price, quantity,
        manual_reason, original_unit_price, price_change_reason, is_special, special_reason, sort_order, total_amount
      ) VALUES (
        p_invoice_id, NULL, NULL, NULL, COALESCE(v_rec.label, ''), '式', v_rec.unit_price, COALESCE(v_rec.quantity, 1),
        v_rec.manual_reason, NULL, NULL, false, NULL, COALESCE(v_rec.sort_order, 0), COALESCE(v_rec.total_amount, 0)
      ) RETURNING id INTO v_new_id;
      IF v_rec.client_key IS NOT NULL AND v_rec.client_key <> '' THEN
        v_id_map := v_id_map || jsonb_build_object(v_rec.client_key, v_new_id);
      END IF;
    END LOOP;
  END IF;

  -- 請求書の合計（サーバーで再計算した値）と更新時刻
  UPDATE invoices SET
    withholding_enabled = COALESCE((p_invoice->>'withholding_enabled')::BOOLEAN, withholding_enabled),
    subtotal_amount     = (p_invoice->>'subtotal_amount')::INTEGER,
    tax_amount          = (p_invoice->>'tax_amount')::INTEGER,
    total_amount        = (p_invoice->>'total_amount')::INTEGER,
    withholding_amount  = (p_invoice->>'withholding_amount')::INTEGER,
    payout_amount       = (p_invoice->>'payout_amount')::INTEGER,
    notes               = CASE WHEN p_invoice ? 'notes' THEN p_invoice->>'notes' ELSE notes END,
    updated_at          = clock_timestamp()
  WHERE id = p_invoice_id
  RETURNING updated_at INTO v_updated;

  RETURN jsonb_build_object('ok', true, 'updated_at', v_updated, 'id_map', v_id_map);
END;
$fn$;

-- ==================== 4. 提出（POST /invoice-editor/:id/submit） ====================
-- アプリ（routes/haruka.js）が「本人の分・納品済み・参考単価・理由・合計一致」を検証した明細の指紋を渡し、
-- この関数がロックの中で「その明細のまま」「二重請求なし」を確かめてから確定する。
-- p_items       : 検証に使った明細の指紋 [{id, creative_id, cost_type, unit_price, quantity}]（請求書の全行）
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

  -- 同じ発行者の提出を 1 本ずつに並べる（ロック順: advisory → 請求書行。保存は請求書行だけなので循環しない）
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

  -- 明細がアプリの検証時と同じか（行の増減・単価・数量・CR・役割のどれかが違えば止める）
  WITH cur AS (
    SELECT id, creative_id, cost_type, unit_price, quantity FROM invoice_items WHERE invoice_id = p_invoice_id
  ), sent AS (
    SELECT id, creative_id, cost_type, unit_price, quantity
    FROM jsonb_to_recordset(COALESCE(p_items, '[]'::jsonb))
      AS x(id UUID, creative_id UUID, cost_type TEXT, unit_price INTEGER, quantity NUMERIC)
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
    WHERE ii.id = (u.v->>'id')::UUID AND ii.invoice_id = p_invoice_id;
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
REVOKE ALL ON FUNCTION invoice_billing_claims_release() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION invoice_editor_save_draft(UUID, TIMESTAMPTZ, JSONB, UUID[], JSONB, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION invoice_editor_submit(UUID, TIMESTAMPTZ, JSONB, JSONB, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION invoice_editor_save_draft(UUID, TIMESTAMPTZ, JSONB, UUID[], JSONB, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION invoice_editor_submit(UUID, TIMESTAMPTZ, JSONB, JSONB, JSONB) TO service_role;

-- ==================== 5. バックフィル（既存の提出済み・承認済みの新方式請求書） ====================
-- 同じ (発行者, CR, 役割) が既に 2 件以上あった場合は、先に提出された 1 件だけを記録する（ON CONFLICT DO NOTHING）。
-- 残りは下の「確認用 SELECT」で洗い出して人が判断する。
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
ORDER BY i.issuer_id, ii.creative_id, ii.cost_type, i.submitted_at ASC NULLS LAST, i.created_at ASC
ON CONFLICT DO NOTHING;

COMMIT;

-- PostgREST に新しい関数を認識させる
NOTIFY pgrst, 'reload schema';

-- ==================== 確認用（読むだけ・任意） ====================
-- (a) 記録された件数
--   SELECT count(*) FROM invoice_billing_claims;
-- (b) 既に二重に提出されている新方式の組（0 件なら問題なし）
--   SELECT i.issuer_id, ii.creative_id, ii.cost_type, array_agg(i.invoice_number ORDER BY i.submitted_at) AS invoices
--   FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
--   WHERE i.tax_mode = 'exclusive' AND i.status IN ('submitted', 'approved')
--     AND ii.creative_id IS NOT NULL AND ii.cost_type IS NOT NULL
--   GROUP BY 1, 2, 3 HAVING count(*) > 1;
