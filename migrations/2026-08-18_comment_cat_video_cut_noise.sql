-- レビューカテゴリー（動画）に「カット」「音声・ノイズ除去」を追加
-- バグ報告 #9f0597e7: マーケティングの下に「カット」「音声・ノイズ除去」を入れてほしい
--
-- 従来 COMMENT_CAT_VIDEO の全項目が sort_order=0 で、表示順は created_at 頼みだった。
-- 途中挿入を可能にするため既存項目に明示的な sort_order を採番し、
-- マーケティング(20) と テロップ(50) の間に新項目 2 件を挿入する。
--
-- ※ 2026-08-18 に本番へ適用済み（service role 経由）。再実行しても安全（冪等）。

DO $$
DECLARE
  cat_id UUID;
BEGIN
  SELECT id INTO cat_id FROM master_categories WHERE code = 'COMMENT_CAT_VIDEO';
  IF cat_id IS NULL THEN
    RAISE NOTICE 'COMMENT_CAT_VIDEO が見つからないためスキップ';
    RETURN;
  END IF;

  -- 既存項目に明示的な sort_order を採番（10刻み、FB10/FB11 の挿入余地を確保）
  UPDATE master_items AS mi SET sort_order = v.so
  FROM (VALUES
    ('FB01',  10),  -- 冒頭フック
    ('FB02',  20),  -- マーケティング
    ('FB03',  50),  -- テロップ
    ('FB04',  60),  -- エフェクト
    ('FB05',  70),  -- SE（効果音）
    ('FB06',  80),  -- BGM
    ('FB07',  90),  -- デザイン
    ('FB08', 100),  -- CTA
    ('FB09', 110)   -- 画像・動画
  ) AS v(code, so)
  WHERE mi.category_id = cat_id AND mi.code = v.code;

  -- 新カテゴリー 2 件をマーケティングの直後に挿入
  INSERT INTO master_items (category_id, code, name, sort_order) VALUES
    (cat_id, 'FB10', 'カット',           30),
    (cat_id, 'FB11', '音声・ノイズ除去', 40)
  ON CONFLICT (category_id, code) DO NOTHING;
END
$$;
