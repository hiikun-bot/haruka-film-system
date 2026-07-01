-- クリエイティブサイズ区分（master_categories.code='sizes'）に標準サイズをシードする。
--
-- 背景: クリエイティブ追加/編集モーダルのサイズ選択は「マスターに項目があればそれを使い、
-- 無ければハードコードのFALLBACKを使う」設計だが、フロントが区分を name='クリエイティブサイズ'
-- で探していたのに対しマスター区分名は 'サイズ'（code='sizes'）だったため常に不一致 → 永遠に
-- FALLBACK固定になっていた（バグ報告 4b0d4796）。フロント側を code 基準の解決に修正したうえで、
-- マスターが実際にプルダウンを駆動できるよう標準サイズ（新規追加の 1920×1080 を含む）を投入する。
--
-- 冪等: ON CONFLICT (category_id, code) DO NOTHING。既にユーザーが追加済みの項目は温存する。
INSERT INTO master_items (category_id, code, name, sort_order)
SELECT c.id, v.code, v.name, v.sort_order
FROM master_categories c
CROSS JOIN (VALUES
  ('1080_1080', '1080×1080', 1),
  ('1080_1920', '1080×1920', 2),
  ('1200_628',  '1200×628',  3),
  ('960_1200',  '960×1200',  4),
  ('1920_1080', '1920×1080', 5)
) AS v(code, name, sort_order)
WHERE c.code = 'sizes'
ON CONFLICT (category_id, code) DO NOTHING;
