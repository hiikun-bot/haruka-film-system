-- ============================================================
-- 案件収支機能（Project Accounting）— Step A: DB migration
-- ------------------------------------------------------------
-- 目的:
--   案件ごとの「見積 / 実績売上 / 外注費 / 粗利」を管理するテーブル群を追加。
--   invoice_items / invoices からの自動連携トリガで、既存請求データを
--   案件収支に取り込む。
--
-- 詳細設計: docs/project_accounting_design_ja.md
--
-- 適用方法:
--   1) Supabase ダッシュボード → SQL Editor を開く
--   2) このファイル全文を貼り付けて Run
--   (db/migrate.js による supabase_schema.sql 自動同期にも同内容を反映済み)
--
-- 冪等性:
--   - すべて CREATE TABLE IF NOT EXISTS / CREATE OR REPLACE / DROP IF EXISTS で記述
--   - バックフィルは NOT EXISTS で重複INSERTを避ける
--   - 何度実行しても同じ結果になる
--
-- ロールバック:
--   migrations/2026-05-02_project_accounting_step_a_down.sql を実行
--
-- 既存機能への影響:
--   - 既存テーブルへのカラム追加・制約追加は一切なし
--   - invoice_items/invoices への書き込みでトリガが追加発火するが、
--     例外時は WARNING のみで本体トランザクションは継続する
-- ============================================================

-- ==================== 0. 前提カラムの保証 ====================
-- invoices.invoice_type は本番DBに既に存在するが supabase_schema.sql に
-- 定義漏れがあるため、フレッシュDB／レプリカでも安全に動くよう保証する。
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS invoice_type TEXT;

-- ==================== 1. テーブル ====================

-- 案件収支台帳（1 project : 1 row）
CREATE TABLE IF NOT EXISTS project_finance_books (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
  contract_total INTEGER DEFAULT 0,        -- 契約総額（手入力）
  estimated_revenue INTEGER DEFAULT 0,     -- 採用見積からの売上見込
  estimated_cost INTEGER DEFAULT 0,        -- 見積原価
  actual_revenue INTEGER DEFAULT 0,        -- 実績売上（project_revenue_entries 集計）
  actual_cost INTEGER DEFAULT 0,           -- 実績原価（project_cost_entries 集計）
  status TEXT DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  closed_at TIMESTAMPTZ,
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- 案件タイプ別の入力プロファイル（HP: pages, video: count …）と正規化メトリクス
CREATE TABLE IF NOT EXISTS project_input_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
  project_type TEXT NOT NULL DEFAULT 'other'
    CHECK (project_type IN ('video', 'hp', 'lp', 'other')),
  input_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- 比較軸統一: {complexity_score, delivery_days, estimated_person_hours, outsource_ratio}
  normalized_metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  raw_request_text TEXT,                   -- ラフ依頼文の原文
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- 見積（案件に対して複数バージョンを管理可）
CREATE TABLE IF NOT EXISTS project_estimates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version INTEGER NOT NULL DEFAULT 1,
  title TEXT,
  total_amount INTEGER DEFAULT 0,
  status TEXT DEFAULT 'draft'
    CHECK (status IN ('draft', 'sent', 'accepted', 'rejected', 'archived')),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(project_id, version)
);

-- 見積明細
CREATE TABLE IF NOT EXISTS project_estimate_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  estimate_id UUID NOT NULL REFERENCES project_estimates(id) ON DELETE CASCADE,
  category TEXT,                           -- video / design / direction / fixed / other
  label TEXT NOT NULL,
  quantity NUMERIC(10,2) DEFAULT 1,
  unit TEXT,
  unit_price INTEGER DEFAULT 0,
  amount INTEGER DEFAULT 0,
  sort_order INTEGER DEFAULT 0,
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 原価エントリ（invoice_items から自動連携 + 手入力可）
CREATE TABLE IF NOT EXISTS project_cost_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source TEXT NOT NULL DEFAULT 'manual'
    CHECK (source IN ('manual', 'invoice_item')),
  source_invoice_item_id UUID REFERENCES invoice_items(id) ON DELETE CASCADE,
  source_invoice_id UUID REFERENCES invoices(id) ON DELETE SET NULL,
  cost_type TEXT,                          -- base_fee / script_fee / ai_fee / direction / other
  label TEXT,
  amount INTEGER NOT NULL DEFAULT 0,
  occurred_on DATE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,  -- 支払先メンバー
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- 売上エントリ（client invoice から自動連携 + 手入力可）
CREATE TABLE IF NOT EXISTS project_revenue_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source TEXT NOT NULL DEFAULT 'manual'
    CHECK (source IN ('manual', 'client_invoice')),
  source_invoice_id UUID REFERENCES invoices(id) ON DELETE CASCADE,
  revenue_type TEXT,                       -- deposit / final / monthly / lump_sum / other
  label TEXT,
  amount INTEGER NOT NULL DEFAULT 0,
  occurred_on DATE,
  client_id UUID REFERENCES clients(id) ON DELETE SET NULL,
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ==================== 2. インデックス ====================

CREATE INDEX IF NOT EXISTS idx_project_finance_books_project
  ON project_finance_books(project_id);

CREATE INDEX IF NOT EXISTS idx_project_input_profiles_type
  ON project_input_profiles(project_type);

CREATE INDEX IF NOT EXISTS idx_project_estimates_project
  ON project_estimates(project_id, version DESC);

CREATE INDEX IF NOT EXISTS idx_project_estimate_items_estimate
  ON project_estimate_items(estimate_id, sort_order);

CREATE INDEX IF NOT EXISTS idx_project_cost_entries_project
  ON project_cost_entries(project_id, occurred_on DESC);

-- 部分 UNIQUE: invoice_items と1:1で同期（手入力行は NULL なので対象外）
CREATE UNIQUE INDEX IF NOT EXISTS uq_project_cost_entries_invoice_item
  ON project_cost_entries(source_invoice_item_id)
  WHERE source_invoice_item_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_project_revenue_entries_project
  ON project_revenue_entries(project_id, occurred_on DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uq_project_revenue_entries_invoice
  ON project_revenue_entries(source_invoice_id)
  WHERE source_invoice_id IS NOT NULL;

-- ==================== 3. トリガ関数 ====================

-- invoice_items（staff 請求のみ）→ project_cost_entries の upsert
CREATE OR REPLACE FUNCTION sync_cost_entry_from_invoice_item() RETURNS TRIGGER AS $$
DECLARE
  v_project_id   UUID;
  v_invoice_type TEXT;
BEGIN
  IF NEW.invoice_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT i.project_id, i.invoice_type
    INTO v_project_id, v_invoice_type
    FROM invoices i
   WHERE i.id = NEW.invoice_id;

  -- クライアント請求の items は原価ではない
  IF v_invoice_type = 'client' THEN
    -- 念のため: 既に同期済みなら除去（invoice_type が後から 'client' に切替えられたケース）
    DELETE FROM project_cost_entries WHERE source_invoice_item_id = NEW.id;
    RETURN NEW;
  END IF;

  IF v_project_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF EXISTS (SELECT 1 FROM project_cost_entries WHERE source_invoice_item_id = NEW.id) THEN
    UPDATE project_cost_entries
       SET project_id      = v_project_id,
           source_invoice_id = NEW.invoice_id,
           cost_type        = COALESCE(NEW.cost_type, cost_type),
           label            = COALESCE(NEW.label, label),
           amount           = COALESCE(NEW.total_amount, 0),
           updated_at       = now()
     WHERE source_invoice_item_id = NEW.id;
  ELSE
    INSERT INTO project_cost_entries (
      project_id, source, source_invoice_item_id, source_invoice_id,
      cost_type, label, amount
    ) VALUES (
      v_project_id, 'invoice_item', NEW.id, NEW.invoice_id,
      NEW.cost_type, NEW.label, COALESCE(NEW.total_amount, 0)
    );
  END IF;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- 同期失敗で本体トランザクション（請求書ワークフロー）を巻き戻さない
  RAISE WARNING 'sync_cost_entry_from_invoice_item failed (invoice_item_id=%): %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION delete_cost_entry_from_invoice_item() RETURNS TRIGGER AS $$
BEGIN
  DELETE FROM project_cost_entries WHERE source_invoice_item_id = OLD.id;
  RETURN OLD;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'delete_cost_entry_from_invoice_item failed (invoice_item_id=%): %', OLD.id, SQLERRM;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

-- invoices（client のみ）→ project_revenue_entries の upsert
CREATE OR REPLACE FUNCTION sync_revenue_entry_from_invoice() RETURNS TRIGGER AS $$
DECLARE
  v_client_id UUID;
BEGIN
  IF NEW.invoice_type IS DISTINCT FROM 'client' THEN
    -- staff 請求は売上ではない。invoice_type が 'client' から外れたら除去
    DELETE FROM project_revenue_entries WHERE source_invoice_id = NEW.id;
    RETURN NEW;
  END IF;

  IF NEW.project_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT p.client_id INTO v_client_id FROM projects p WHERE p.id = NEW.project_id;

  IF EXISTS (SELECT 1 FROM project_revenue_entries WHERE source_invoice_id = NEW.id) THEN
    UPDATE project_revenue_entries
       SET project_id  = NEW.project_id,
           amount      = COALESCE(NEW.total_amount, 0),
           client_id   = v_client_id,
           updated_at  = now()
     WHERE source_invoice_id = NEW.id;
  ELSE
    INSERT INTO project_revenue_entries (
      project_id, source, source_invoice_id, revenue_type,
      label, amount, occurred_on, client_id
    ) VALUES (
      NEW.project_id, 'client_invoice', NEW.id, 'lump_sum',
      NEW.invoice_number, COALESCE(NEW.total_amount, 0),
      COALESCE(NEW.issued_at::date, CURRENT_DATE), v_client_id
    );
  END IF;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'sync_revenue_entry_from_invoice failed (invoice_id=%): %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION delete_revenue_entry_from_invoice() RETURNS TRIGGER AS $$
BEGIN
  DELETE FROM project_revenue_entries WHERE source_invoice_id = OLD.id;
  RETURN OLD;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'delete_revenue_entry_from_invoice failed (invoice_id=%): %', OLD.id, SQLERRM;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

-- ==================== 4. トリガ ====================

DROP TRIGGER IF EXISTS tr_invoice_items_to_cost ON invoice_items;
CREATE TRIGGER tr_invoice_items_to_cost
  AFTER INSERT OR UPDATE OF invoice_id, total_amount, cost_type, label
  ON invoice_items
  FOR EACH ROW
  EXECUTE FUNCTION sync_cost_entry_from_invoice_item();

DROP TRIGGER IF EXISTS tr_invoice_items_to_cost_del ON invoice_items;
CREATE TRIGGER tr_invoice_items_to_cost_del
  AFTER DELETE
  ON invoice_items
  FOR EACH ROW
  EXECUTE FUNCTION delete_cost_entry_from_invoice_item();

DROP TRIGGER IF EXISTS tr_invoices_to_revenue ON invoices;
CREATE TRIGGER tr_invoices_to_revenue
  AFTER INSERT OR UPDATE OF project_id, total_amount, invoice_type, issued_at
  ON invoices
  FOR EACH ROW
  EXECUTE FUNCTION sync_revenue_entry_from_invoice();

DROP TRIGGER IF EXISTS tr_invoices_to_revenue_del ON invoices;
CREATE TRIGGER tr_invoices_to_revenue_del
  AFTER DELETE
  ON invoices
  FOR EACH ROW
  EXECUTE FUNCTION delete_revenue_entry_from_invoice();

-- ==================== 5. バックフィル ====================

-- 全プロジェクトに対し finance_books を1行ずつ確保
INSERT INTO project_finance_books (project_id)
SELECT p.id
  FROM projects p
 WHERE NOT EXISTS (
   SELECT 1 FROM project_finance_books fb WHERE fb.project_id = p.id
 );

-- 既存の staff invoice_items を project_cost_entries に投入
INSERT INTO project_cost_entries (
  project_id, source, source_invoice_item_id, source_invoice_id,
  cost_type, label, amount
)
SELECT
  i.project_id,
  'invoice_item',
  ii.id,
  ii.invoice_id,
  ii.cost_type,
  ii.label,
  COALESCE(ii.total_amount, 0)
  FROM invoice_items ii
  JOIN invoices i ON i.id = ii.invoice_id
 WHERE i.project_id IS NOT NULL
   AND (i.invoice_type IS NULL OR i.invoice_type <> 'client')
   AND NOT EXISTS (
     SELECT 1 FROM project_cost_entries pce
      WHERE pce.source_invoice_item_id = ii.id
   );

-- 既存の client invoices を project_revenue_entries に投入
INSERT INTO project_revenue_entries (
  project_id, source, source_invoice_id, revenue_type,
  label, amount, occurred_on, client_id
)
SELECT
  i.project_id,
  'client_invoice',
  i.id,
  'lump_sum',
  i.invoice_number,
  COALESCE(i.total_amount, 0),
  COALESCE(i.issued_at::date, CURRENT_DATE),
  p.client_id
  FROM invoices i
  LEFT JOIN projects p ON p.id = i.project_id
 WHERE i.invoice_type = 'client'
   AND i.project_id IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM project_revenue_entries pre
      WHERE pre.source_invoice_id = i.id
   );

-- ==================== 6. PostgREST スキーマキャッシュリロード ====================
NOTIFY pgrst, 'reload schema';
