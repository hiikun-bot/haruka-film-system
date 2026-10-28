-- 請求書（invoices）の project_id を任意にする（バグ報告 b40c092a のフォローアップ）
-- 案件に紐づかない時間報酬（秘書業など・ADR 028）や立替経費だけの請求書は project_id が決まらず、
-- NOT NULL 制約で作成できなかった。請求書は発行者×月の単位で、案件は明細（invoice_items）側で分かる。
ALTER TABLE invoices ALTER COLUMN project_id DROP NOT NULL;
