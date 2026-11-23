-- ADR 046 追補 2026-11-23 その2: 領収書の差し替えを「請求書がまだ下書き／差し戻し中か」の確認と同じ処理で行う関数
--
-- これまで: アプリが (1) 請求書の状態を読む → (2) invoice_items を更新する、を別々の問い合わせで行っていたため、
--   (1) と (2) のあいだに提出されると、提出済みの請求書の領収書が差し替わる余地があった。
-- この関数: 請求書の行を FOR SHARE で押さえて状態を確かめ、同じトランザクションで invoice_items を書く。
--   提出（invoices の UPDATE）はこの処理が終わるまで待たされ、先に提出が確定していればこちらが 'not_editable' を返す。
--
-- 戻り値（jsonb）:
--   { "result": "ok", "prev_file_id": <書き込む前に行に入っていた領収書ファイル ID or null>, "uploaded_at": <保存時刻> }
--   { "result": "not_editable", "status": <今の状態> } … 下書き／差し戻し中ではない（提出・承認済みなど）
--   { "result": "invoice_not_found" } / { "result": "item_not_found" }
--
-- 新しいテーブルは作らない（RLS の追加は不要・invoice_items / invoices は ADR 048 で有効化済み）。
-- SECURITY INVOKER（既定）・search_path 固定。アプリは service_role で呼ぶので、anon / authenticated からは実行させない。
-- 何度流しても同じ結果になる（CREATE OR REPLACE）。

CREATE OR REPLACE FUNCTION attach_invoice_item_receipt(
  p_invoice_id UUID,
  p_item_id    UUID,
  p_file_id    TEXT,
  p_file_name  TEXT,
  p_mime_type  TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_status      TEXT;
  v_prev_file   TEXT;
  v_uploaded_at TIMESTAMPTZ := now();
BEGIN
  SELECT status INTO v_status FROM invoices WHERE id = p_invoice_id FOR SHARE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('result', 'invoice_not_found');
  END IF;
  IF v_status IS NULL OR v_status NOT IN ('draft', 'rejected') THEN
    RETURN jsonb_build_object('result', 'not_editable', 'status', v_status);
  END IF;

  SELECT receipt_file_id INTO v_prev_file
    FROM invoice_items
   WHERE id = p_item_id AND invoice_id = p_invoice_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('result', 'item_not_found');
  END IF;

  UPDATE invoice_items
     SET receipt_status         = 'attached',
         receipt_missing_reason = NULL,
         receipt_file_id        = p_file_id,
         receipt_file_name      = p_file_name,
         receipt_mime_type      = p_mime_type,
         receipt_uploaded_at    = v_uploaded_at
   WHERE id = p_item_id AND invoice_id = p_invoice_id;

  RETURN jsonb_build_object('result', 'ok', 'prev_file_id', v_prev_file, 'uploaded_at', v_uploaded_at);
END;
$$;

COMMENT ON FUNCTION attach_invoice_item_receipt(UUID, UUID, TEXT, TEXT, TEXT) IS
  'ADR046 追補 2026-11-23 その2: 請求書が draft/rejected のときだけ、立替経費の行に領収書ファイルを記録する（状態の確認と書き込みを 1 トランザクションで）';

REVOKE ALL ON FUNCTION attach_invoice_item_receipt(UUID, UUID, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION attach_invoice_item_receipt(UUID, UUID, TEXT, TEXT, TEXT) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION attach_invoice_item_receipt(UUID, UUID, TEXT, TEXT, TEXT) TO service_role;

-- PostgREST に関数を認識させる（反映まで少し待つこともある。アプリは関数が無いあいだ従来の手順で動く）
NOTIFY pgrst, 'reload schema';
