-- migrations/2026-05-25_invoice_auto_gen_last_yyyymm.sql
--
-- 請求書フォルダ 月次自動生成ワーカ (workers/invoice-folder-monthly-gen.js) が
-- 「最後に生成バッチを走らせた JST 月」を保存するための system_settings レコードを用意する。
--
-- value は 'YYYY-MM' 形式（例: '2026-05'）。
-- 初期値は空文字 ''（＝まだ一度も走っていない）。worker が起動直後に
-- 現在の JST yyyy-mm と比較し、差分があれば全在籍メンバー分の今月フォルダを生成する。
--
-- 冪等性:
--   ON CONFLICT DO NOTHING で既存値があれば上書きしない。再実行しても安全。

INSERT INTO system_settings (key, value, updated_at)
VALUES ('invoice_auto_gen_last_yyyymm', '', now())
ON CONFLICT (key) DO NOTHING;
