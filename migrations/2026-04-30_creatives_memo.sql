-- creatives.memo を追加（既に存在すればスキップ）
-- 適用: Supabase SQL Editor に貼って Run。冪等。

ALTER TABLE creatives ADD COLUMN IF NOT EXISTS memo TEXT;

NOTIFY pgrst, 'reload schema';
