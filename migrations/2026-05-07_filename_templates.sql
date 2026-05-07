-- ============================================================================
-- ADR 007 Stage 1: ファイル名テンプレート（案件別命名規約）
--
-- 目的:
--   ファイル名生成 (`routes/haruka.js` の bulk-preview / bulk / 個別作成) を
--   設定タブで管理可能なテンプレ駆動に置き換える準備として、
--   - filename_templates マスタ
--   - projects.filename_template_id / filename_token_overrides
--   を新設する。
--
--   Stage 1 では「列追加 + 設定タブUI」のみを行い、
--   実際の参照（bulk 系の置き換え・案件モーダルからの選択）は
--   Stage 2（別PR）で migration 適用済みを確認してから行う。
--
-- 適用順:
--   1. filename_templates テーブル作成
--   2. validate_filename_template_tokens() 関数 + CHECK 制約
--   3. デフォルトテンプレ「標準（YYMMDD系）」を seed
--   4. projects ALTER（filename_template_id / filename_token_overrides）
--   5. 既存案件にデフォルトテンプレを当てる UPDATE
--   6. updated_at 自動更新トリガ
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) filename_templates: 設定タブで管理する命名規約テンプレマスタ
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS filename_templates (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  separator     text NOT NULL DEFAULT '_',
  tokens        jsonb NOT NULL DEFAULT '[]'::jsonb,   -- 順序付き配列
  is_default    boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE filename_templates IS
  'ADR 007: ファイル名テンプレート。設定タブで管理し、案件側で選択 + override する。';
COMMENT ON COLUMN filename_templates.tokens IS
  '順序付き配列。要素は { kind: "system"|"custom", key, label, default? }。serial / project_name / version 必須・serial 先頭固定（CHECK 制約）。';
COMMENT ON COLUMN filename_templates.separator IS
  'トークン間の区切り文字。既定: "_"。';
COMMENT ON COLUMN filename_templates.is_default IS
  '新規案件に当たるデフォルトテンプレ。複数 true でも壊れないが UI 上は 1 件想定。';

-- ----------------------------------------------------------------------------
-- 2) tokens 制約: serial / project_name / version 必須 + serial 先頭
--    JSONB の中身チェックは PL/pgSQL 関数経由で CHECK に組み込む。
--    サーバー側でも routes/haruka.js で同等のバリデーションを行う（二重チェック）。
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION validate_filename_template_tokens(t jsonb) RETURNS boolean AS $$
DECLARE
  keys text[];
BEGIN
  IF jsonb_typeof(t) <> 'array' OR jsonb_array_length(t) = 0 THEN
    RETURN false;
  END IF;
  SELECT array_agg(elem->>'key') INTO keys FROM jsonb_array_elements(t) AS elem;
  IF NOT ('serial' = ANY(keys))
     OR NOT ('project_name' = ANY(keys))
     OR NOT ('version' = ANY(keys)) THEN
    RETURN false;
  END IF;
  IF (t->0->>'key') <> 'serial' THEN
    RETURN false;
  END IF;
  RETURN true;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

ALTER TABLE filename_templates
  DROP CONSTRAINT IF EXISTS filename_templates_tokens_valid;
ALTER TABLE filename_templates
  ADD CONSTRAINT filename_templates_tokens_valid
  CHECK (validate_filename_template_tokens(tokens));

-- ----------------------------------------------------------------------------
-- 3) デフォルトテンプレ seed（既存ハードコード仕様を保つ）
--    既存仕様: YYMMDD_商材_媒体_FMT_訴求軸_サイズ_連番（連番末尾）
--    ADR 007 では serial 先頭必須化のため、デフォルトテンプレでは
--    serial を先頭に置き、その後ろに従来の並びを置く。
--    （案件ごとに上書きしたければ Stage 2 で別テンプレを作る運用）
-- ----------------------------------------------------------------------------
INSERT INTO filename_templates (name, separator, tokens, is_default)
SELECT
  '標準（YYMMDD系）',
  '_',
  '[
    {"kind":"system","key":"serial","label":"連番"},
    {"kind":"system","key":"project_name","label":"案件名"},
    {"kind":"system","key":"version","label":"バージョン"},
    {"kind":"system","key":"date_yymmdd","label":"制作日"},
    {"kind":"system","key":"product","label":"商品"},
    {"kind":"system","key":"media","label":"媒体"},
    {"kind":"system","key":"format","label":"FMT"},
    {"kind":"system","key":"appeal_axis","label":"訴求軸"},
    {"kind":"system","key":"size","label":"サイズ"}
  ]'::jsonb,
  true
WHERE NOT EXISTS (
  SELECT 1 FROM filename_templates WHERE is_default = true
);

-- ----------------------------------------------------------------------------
-- 4) projects への列追加（Stage 1 では列だけ。参照は Stage 2）
-- ----------------------------------------------------------------------------
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS filename_template_id uuid REFERENCES filename_templates(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS filename_token_overrides jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN projects.filename_template_id IS
  'ADR 007: この案件で使うファイル名テンプレ。NULL の場合は is_default=true のテンプレを使う想定。';
COMMENT ON COLUMN projects.filename_token_overrides IS
  'ADR 007: テンプレ内の custom トークンに対する案件固有の値・ラベル上書き。例: { "celebrity": { "label": "芸能人", "value": "上地無" } }';

-- 検索/JOIN 用インデックス（filename_template_id でグルーピング集計するケースを想定）
CREATE INDEX IF NOT EXISTS idx_projects_filename_template_id
  ON projects(filename_template_id);

-- ----------------------------------------------------------------------------
-- 5) 既存案件にデフォルトテンプレを当てる
-- ----------------------------------------------------------------------------
UPDATE projects
SET filename_template_id = (SELECT id FROM filename_templates WHERE is_default = true LIMIT 1)
WHERE filename_template_id IS NULL;

-- ----------------------------------------------------------------------------
-- 6) updated_at 自動更新トリガ
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION touch_filename_templates_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_filename_templates_updated_at ON filename_templates;
CREATE TRIGGER trg_filename_templates_updated_at
BEFORE UPDATE ON filename_templates
FOR EACH ROW EXECUTE FUNCTION touch_filename_templates_updated_at();
