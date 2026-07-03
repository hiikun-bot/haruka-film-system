-- ADR 009: クリエイティブ納品時のディレクター/プロデューサー スナップショット（Stage 1）
--
-- ユーザー決定（2026-07-03）:
--   「D費は案件ごとに固定のディレクターへ。作成して納品したタイミングで、その時
--    マスター（案件）に登録されているディレクターに費用を分配する。納品のタイミングでコミット」
--   → 納品時に projects.director_id / producer_id を creatives に焼き付け、
--     以降の集計・請求はスナップショットを参照する。途中でディレクターが交代しても
--     過去の納品分は書き換わらず、「いつからどのDだったか」がクリエイティブ単位で残る。
--   ※ P費は支払い対象外（2026-07-02 決定）だが、担当記録として producer 側も保持する。
--
-- コード側の書き込み・参照切替は Stage 2 で行う。

ALTER TABLE creatives ADD COLUMN IF NOT EXISTS delivered_director_ids UUID[];
ALTER TABLE creatives ADD COLUMN IF NOT EXISTS delivered_producer_ids UUID[];
ALTER TABLE creatives ADD COLUMN IF NOT EXISTS delivered_snapshot_at  TIMESTAMPTZ;

COMMENT ON COLUMN creatives.delivered_director_ids IS
  'ADR 009: 納品時点の担当ディレクター（UUID配列）。D費の分配はこのスナップショットに従う。NULL=未納品または旧データ';
COMMENT ON COLUMN creatives.delivered_producer_ids IS
  'ADR 009: 納品時点の担当プロデューサー（UUID配列）。P費は支払い対象外だが担当記録として保持';
COMMENT ON COLUMN creatives.delivered_snapshot_at IS
  'ADR 009: スナップショットを取得した日時（監査用）';

CREATE INDEX IF NOT EXISTS idx_creatives_delivered_director_ids
  ON creatives USING GIN (delivered_director_ids);
CREATE INDEX IF NOT EXISTS idx_creatives_delivered_producer_ids
  ON creatives USING GIN (delivered_producer_ids);

-- ==================== Backfill（納品済みのみ） ====================
-- 既存の納品済みクリエイティブは「現在の案件ディレクター/プロデューサー」で埋める。
-- （過去の交代履歴は残っていないため現在値が最善。6月分は支払い確定済みなので実害なし）
UPDATE creatives c
   SET delivered_director_ids = CASE WHEN p.director_id IS NOT NULL THEN ARRAY[p.director_id] END,
       delivered_producer_ids = CASE WHEN p.producer_id IS NOT NULL THEN ARRAY[p.producer_id] END,
       delivered_snapshot_at  = COALESCE(c.delivered_at, now())
  FROM projects p
 WHERE p.id = c.project_id
   AND c.status = '納品'
   AND c.delivered_snapshot_at IS NULL;
