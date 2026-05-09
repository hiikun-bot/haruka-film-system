-- ADR 013: クリエイティブ単位の単価上書き
-- - creatives.override_client_amount: クライアント請求額の上書き（NULL=line継承）
-- - creative_cost_overrides: ロール別支払額の上書き（admin のみ編集可）

-- 1) クライアント請求額の上書き列
ALTER TABLE creatives ADD COLUMN IF NOT EXISTS override_client_amount NUMERIC;
COMMENT ON COLUMN creatives.override_client_amount IS
  'ADR 013: NULL = line.client_unit_price 継承。非 NULL = この creative 単独の売上額（税抜・admin のみ編集可）';

-- 2) ロール別支払額の上書きテーブル
CREATE TABLE IF NOT EXISTS creative_cost_overrides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creative_id UUID NOT NULL REFERENCES creatives(id) ON DELETE CASCADE,
  role_id UUID NOT NULL REFERENCES roles(id),
  user_id UUID REFERENCES users(id),
  amount NUMERIC NOT NULL,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID REFERENCES users(id),
  updated_by UUID REFERENCES users(id)
);

-- (creative_id, role_id, user_id) の一意性。user_id NULL = 「ロール全体上書き」を 1 行だけ持つ
CREATE UNIQUE INDEX IF NOT EXISTS creative_cost_overrides_uniq
  ON creative_cost_overrides (
    creative_id,
    role_id,
    COALESCE(user_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

CREATE INDEX IF NOT EXISTS creative_cost_overrides_creative_idx
  ON creative_cost_overrides (creative_id);

COMMENT ON TABLE creative_cost_overrides IS
  'ADR 013: クリエイティブ単位のロール別支払額上書き。admin のみ編集可。user_id NULL = ロール全体上書き';

-- updated_at 自動更新トリガー（既存パターンに合わせて）
CREATE OR REPLACE FUNCTION set_creative_cost_overrides_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_creative_cost_overrides_updated_at ON creative_cost_overrides;
CREATE TRIGGER trg_creative_cost_overrides_updated_at
  BEFORE UPDATE ON creative_cost_overrides
  FOR EACH ROW
  EXECUTE FUNCTION set_creative_cost_overrides_updated_at();
