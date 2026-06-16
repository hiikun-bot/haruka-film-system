-- ADR 022: 成果物グループ（見積明細）にランクを第一級の列として持たせる
-- https://github.com/hiikun-bot/haruka-film-system/blob/main/docs/design/decisions/022-estimate-line-rank.md
-- 2026-06-06 本番 Supabase に適用済み（rank 列・category_rank_rates）。
-- ランクは編集者/デザイナーへの支払単価の段階（A/B/C）。client 請求(client_unit_price)はランク非依存。

-- 1) project_estimate_lines.rank（NULL|A|B|C）
ALTER TABLE project_estimate_lines ADD COLUMN IF NOT EXISTS rank TEXT;
COMMENT ON COLUMN project_estimate_lines.rank IS
  'ADR 022: 成果物グループの作業ランク(NULL|A|B|C)。editor/designer の支払単価選別に使う。client_unit_price はランク非依存。';

-- 2) ランク別 支払単価マスタ（category × rank × role → 1本あたり支払額）
CREATE TABLE IF NOT EXISTS category_rank_rates (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id UUID NOT NULL REFERENCES creative_categories(id) ON DELETE CASCADE,
  rank        TEXT NOT NULL,                            -- 'A' | 'B' | 'C'
  role_id     UUID NOT NULL REFERENCES roles(id),       -- 制作ロール（editor / designer 等）
  unit_price  INTEGER NOT NULL,                         -- 1 本あたり支払額（円・税抜）
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (category_id, rank, role_id)
);
COMMENT ON TABLE category_rank_rates IS
  'ADR 022: カテゴリ×ランク×制作ロールごとの支払単価マスタ。成果物グループ作成時に line_costs を自動入力する既定値。client 請求はランク非依存で対象外。';

-- 3) Stage 4: 既存 name の "Aランク"/"Bランク"/"Cランク" を rank 列へバックフィル
--    （未適用。旧データに該当があれば実行する）
UPDATE project_estimate_lines
SET rank = CASE
  WHEN name ILIKE '%Aランク%' THEN 'A'
  WHEN name ILIKE '%Bランク%' THEN 'B'
  WHEN name ILIKE '%Cランク%' THEN 'C'
  ELSE rank
END
WHERE rank IS NULL AND name IS NOT NULL AND name ~ '[ABC]ランク';
