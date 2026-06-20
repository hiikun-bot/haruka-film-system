-- 2026-06-06 クライアント削除のカスケードを完成させる
--
-- 背景（バグ報告 #ecb4215d）:
--   クライアント削除モーダルは「関連する案件・クリエイティブ・請求情報も全て削除されます」と
--   表示しているのに、実際に削除すると「関連データが存在するため削除できません」で失敗していた。
--   原因は projects.client_id をはじめ一部の FK に ON DELETE CASCADE が無く、
--   案件（projects）や請求書（invoices）が残っているとクライアント削除が外部キー制約で弾かれていたため。
--
-- 修正方針:
--   クライアント1件の削除で、配下（案件 → クリエイティブ／請求 など）まで連鎖削除されるよう
--   FK を張り替える。所有関係にあるもの（案件・請求書・請求明細）は ON DELETE CASCADE、
--   参照に過ぎないもの（サイクル・見積行への横断参照）は ON DELETE SET NULL にする。
--
-- 既存の連鎖（変更不要・参考）:
--   clients ← client_teams / client_products / client_appeal_axes / client_configs  … 既に CASCADE
--   clients ← project_revenue_entries.client_id                                      … 既に SET NULL
--   projects ← creatives / project_* 多数                                            … 既に CASCADE
--   invoices ← invoice_items ← invoice_item_details                                  … 既に CASCADE
--
-- 冪等性: 制約名に依存せず、対象 (table, column) の既存 FK を introspection で全て drop してから
--   張り直す。複数回実行しても安全。

BEGIN;

-- 1) 対象カラム上の既存 FK 制約を名前に依らず全て削除
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT rel.relname AS tbl, con.conname AS name
    FROM pg_constraint con
    JOIN pg_class rel       ON rel.oid = con.conrelid
    JOIN pg_namespace nsp   ON nsp.oid = rel.relnamespace
    JOIN pg_attribute att   ON att.attrelid = con.conrelid AND att.attnum = ANY (con.conkey)
    WHERE con.contype = 'f'
      AND nsp.nspname = 'public'
      AND (
        (rel.relname = 'projects'      AND att.attname = 'client_id')   OR
        (rel.relname = 'invoices'      AND att.attname = 'project_id')  OR
        (rel.relname = 'invoices'      AND att.attname = 'cycle_id')    OR
        (rel.relname = 'invoice_items' AND att.attname = 'creative_id') OR
        (rel.relname = 'invoice_items' AND att.attname = 'line_id')     OR
        (rel.relname = 'creatives'     AND att.attname = 'line_id')
      )
  LOOP
    EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', r.tbl, r.name);
  END LOOP;
END $$;

-- 2) 連鎖削除を完成させる FK を張り直す（所有 = CASCADE）
ALTER TABLE projects
  ADD CONSTRAINT projects_client_id_fkey
  FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE;

ALTER TABLE invoices
  ADD CONSTRAINT invoices_project_id_fkey
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;

ALTER TABLE invoice_items
  ADD CONSTRAINT invoice_items_creative_id_fkey
  FOREIGN KEY (creative_id) REFERENCES creatives(id) ON DELETE CASCADE;

-- 3) 横断参照は SET NULL（消えても本体は残す／連鎖をブロックしない）
ALTER TABLE invoices
  ADD CONSTRAINT invoices_cycle_id_fkey
  FOREIGN KEY (cycle_id) REFERENCES project_cycles(id) ON DELETE SET NULL;

ALTER TABLE creatives
  ADD CONSTRAINT creatives_line_id_fkey
  FOREIGN KEY (line_id) REFERENCES project_estimate_lines(id) ON DELETE SET NULL;

ALTER TABLE invoice_items
  ADD CONSTRAINT invoice_items_line_id_fkey
  FOREIGN KEY (line_id) REFERENCES project_estimate_lines(id) ON DELETE SET NULL;

COMMIT;
