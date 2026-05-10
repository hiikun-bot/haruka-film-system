-- つぶやきの写真を任意化（本文だけでもOK）
-- これまで image_data は NOT NULL だったが、写真なしでもつぶやけるよう NULL を許容する。
--
-- 適用方法:
--   1) Supabase ダッシュボード → SQL Editor を開く
--   2) このファイル全文を貼り付けて Run
--   (db/migrate.js の自動同期が走っていれば不要)

ALTER TABLE tweets ALTER COLUMN image_data DROP NOT NULL;

NOTIFY pgrst, 'reload schema';
