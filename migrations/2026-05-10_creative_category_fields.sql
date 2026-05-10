-- =====================================================
-- Creative Category Fields  (ADR 012)
-- =====================================================
-- 目的:
--   クリエイティブ詳細モーダルのフィールドを、カテゴリごとに
--   ON/OFF・並び順・ラベル上書き・必須化できるようにする。
--   さらにカスタムフィールドを追加できるようにする（値は別テーブル）。
--
-- 既存:
--   - creative_categories (Stage A / migrations/2026-05-05_creative_categories.sql)
--     既存 code: 'video' / 'image' / 'hp' / 'lp' / 'line'
--
-- 冪等性:
--   - CREATE TABLE IF NOT EXISTS / ON CONFLICT DO NOTHING
--   - seed は (category_id, field_key) UNIQUE で重複ガード
-- =====================================================

BEGIN;

-- -----------------------------------------------------
-- 1) creative_category_fields : カテゴリ × フィールドの可視性・並び順・ラベル
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS creative_category_fields (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id     UUID NOT NULL REFERENCES creative_categories(id) ON DELETE CASCADE,
  field_key       TEXT NOT NULL,
  field_kind      TEXT NOT NULL DEFAULT 'builtin'
                    CHECK (field_kind IN ('builtin','custom')),
  custom_type     TEXT
                    CHECK (custom_type IN ('text','textarea','url','select')),
  custom_options  JSONB,
  visible         BOOLEAN NOT NULL DEFAULT true,
  sort_order      INT     NOT NULL DEFAULT 100,
  label           TEXT,
  required        BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (category_id, field_key)
);

CREATE INDEX IF NOT EXISTS idx_ccf_category_sort
  ON creative_category_fields(category_id, sort_order);

ALTER TABLE creative_category_fields ENABLE ROW LEVEL SECURITY;

-- -----------------------------------------------------
-- 2) creative_custom_field_values : カスタムフィールドの値
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS creative_custom_field_values (
  creative_id  UUID NOT NULL REFERENCES creatives(id) ON DELETE CASCADE,
  field_key    TEXT NOT NULL,
  value        TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (creative_id, field_key)
);

CREATE INDEX IF NOT EXISTS idx_ccfv_creative
  ON creative_custom_field_values(creative_id);

ALTER TABLE creative_custom_field_values ENABLE ROW LEVEL SECURITY;

-- -----------------------------------------------------
-- 3) seed: 既存5カテゴリの初期フィールドセット
--    - 既存の creative_categories の code/name は維持（上書きしない）
--    - (category_id, field_key) UNIQUE の ON CONFLICT で重複ガード
-- -----------------------------------------------------

-- video: 全項目 ON
INSERT INTO creative_category_fields (category_id, field_key, visible, sort_order, label) VALUES
  ((SELECT id FROM creative_categories WHERE code='video'), 'product',           true, 10, '商材'),
  ((SELECT id FROM creative_categories WHERE code='video'), 'appeal_axis',       true, 20, '訴求軸'),
  ((SELECT id FROM creative_categories WHERE code='video'), 'media_format_size', true, 30, '媒体・尺・サイズ'),
  ((SELECT id FROM creative_categories WHERE code='video'), 'talent',            true, 40, 'タレント'),
  ((SELECT id FROM creative_categories WHERE code='video'), 'script_url',        true, 50, '台本URL'),
  ((SELECT id FROM creative_categories WHERE code='video'), 'regulation_url',    true, 60, 'レギュレーション'),
  ((SELECT id FROM creative_categories WHERE code='video'), 'client_review_url', true, 70, 'クライアント確認URL')
ON CONFLICT (category_id, field_key) DO NOTHING;

-- image (静止画/デザイン): 台本URL / タレント OFF、媒体ラベルは「サイズ」
INSERT INTO creative_category_fields (category_id, field_key, visible, sort_order, label) VALUES
  ((SELECT id FROM creative_categories WHERE code='image'), 'product',           true,  10, '商材'),
  ((SELECT id FROM creative_categories WHERE code='image'), 'appeal_axis',       true,  20, '訴求軸'),
  ((SELECT id FROM creative_categories WHERE code='image'), 'media_format_size', true,  30, 'サイズ'),
  ((SELECT id FROM creative_categories WHERE code='image'), 'talent',            false, 40, 'タレント'),
  ((SELECT id FROM creative_categories WHERE code='image'), 'script_url',        false, 50, '台本URL'),
  ((SELECT id FROM creative_categories WHERE code='image'), 'regulation_url',    true,  60, 'レギュレーション'),
  ((SELECT id FROM creative_categories WHERE code='image'), 'client_review_url', true,  70, 'クライアント確認URL')
ON CONFLICT (category_id, field_key) DO NOTHING;

-- LP / HP / LINE 共通テンプレ: 媒体・尺・サイズ / タレント / 台本URL すべて OFF
DO $$
DECLARE
  cid  UUID;
  c    TEXT;
  codes TEXT[] := ARRAY['lp','hp','line'];
BEGIN
  FOREACH c IN ARRAY codes LOOP
    SELECT id INTO cid FROM creative_categories WHERE code = c LIMIT 1;
    IF cid IS NULL THEN
      CONTINUE;
    END IF;
    INSERT INTO creative_category_fields (category_id, field_key, visible, sort_order, label) VALUES
      (cid, 'product',           true,  10, '商材'),
      (cid, 'appeal_axis',       true,  20, '訴求軸'),
      (cid, 'media_format_size', false, 30, '媒体・尺・サイズ'),
      (cid, 'talent',            false, 40, 'タレント'),
      (cid, 'script_url',        false, 50, '台本URL'),
      (cid, 'regulation_url',    true,  60, 'レギュレーション'),
      (cid, 'client_review_url', true,  70, 'クライアント確認URL')
    ON CONFLICT (category_id, field_key) DO NOTHING;
  END LOOP;
END $$;

-- -----------------------------------------------------
-- 4) PostgREST にスキーマリロード通知
-- -----------------------------------------------------
NOTIFY pgrst, 'reload schema';

COMMIT;

-- =====================================================
-- ロールバック手順（手動）
-- =====================================================
-- BEGIN;
--   DROP TABLE IF EXISTS creative_custom_field_values;
--   DROP TABLE IF EXISTS creative_category_fields;
-- COMMIT;
