-- ============================================================
-- 品目名マスター追加（見積明細のクイック選択用）
-- ------------------------------------------------------------
-- 目的:
--   見積エディタの「品目」入力でマスターから素早く選択できるよう、
--   よく使う品目名を事前登録できるテーブルを追加。
--   動画編集 / デザイン の 2 区分で管理。
--
-- 列:
--   category   'video' | 'design'   案件タイプ別フィルタ用
--   name       品目名（例: 動画編集（Aランク）/ ナレーション / 静止画1枚）
--   default_unit 既定の単位（例: 本 / 枚 / 式）
--   sort_order 表示順
--   is_active  論理削除用
--
-- ロールバック:
--   DROP TABLE item_name_master;
-- ============================================================

CREATE TABLE IF NOT EXISTS item_name_master (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category TEXT NOT NULL CHECK (category IN ('video', 'design')),
  name TEXT NOT NULL,
  default_unit TEXT,
  sort_order INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_item_name_master_active
  ON item_name_master(is_active, category, sort_order);

-- 同じ category 内では name が重複しないようにする
CREATE UNIQUE INDEX IF NOT EXISTS uq_item_name_master_category_name
  ON item_name_master(category, name);

NOTIFY pgrst, 'reload schema';
