-- ナレッジ動画視聴: カテゴリに「システムの便利な使い方」を追加
-- sort_order=70: 「参考になった」(60) と「その他」(99) の間に挿入。
-- name は UNIQUE 制約なので再実行は no-op。

INSERT INTO learning_video_categories (name, sort_order) VALUES
  ('システムの便利な使い方', 70)
ON CONFLICT (name) DO NOTHING;

NOTIFY pgrst, 'reload schema';
