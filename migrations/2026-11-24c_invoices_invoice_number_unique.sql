-- 請求書番号（invoices.invoice_number）が重ならないことを DB で保証する（2026-11-24）
--
-- 背景: 請求書番号は「その月の番号の最大 + 1」で振り、同時に作って一意制約違反（23505）になったら
--       番号を取り直す（utils/invoice-number.js・PR #1333）。この取り直しは一意制約があって初めて効く。
--       supabase_schema.sql では invoice_number TEXT UNIQUE だが、本番に制約が入っているかを
--       アプリ側から確かめられないため、無い場合だけ一意インデックスを作る（ある場合は何もしない）。
--
-- 事前確認（2026-11-24・本番 select のみ）: invoices 44 件で同じ番号の重複は 0 件。作成は失敗しない。
-- 何度流しても安全（冪等）。

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_class t ON t.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = i.indkey[0]
    WHERE n.nspname = 'public'
      AND t.relname = 'invoices'
      AND i.indisunique
      AND i.indnatts = 1
      AND i.indpred IS NULL
      AND a.attname = 'invoice_number'
  ) THEN
    CREATE UNIQUE INDEX invoices_invoice_number_uniq ON public.invoices (invoice_number);
    RAISE NOTICE 'invoices.invoice_number の一意インデックスを作りました';
  ELSE
    RAISE NOTICE 'invoices.invoice_number はすでに一意です（何もしません）';
  END IF;
END
$$;

-- 確認用（1 行以上出れば OK）
-- SELECT indexname, indexdef FROM pg_indexes
--  WHERE schemaname = 'public' AND tablename = 'invoices' AND indexdef ILIKE '%UNIQUE%invoice_number%';
