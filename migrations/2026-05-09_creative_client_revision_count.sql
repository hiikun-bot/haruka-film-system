-- ADR なし。クリエイティブの「クライアント由来の修正回数」を D/P 修正と分離するため独立列を追加。
-- - revision_count: D/P 修正指示のカウント（既存）
-- - client_revision_count: クライアント由来の修正指示カウント（新規）
ALTER TABLE creatives
  ADD COLUMN IF NOT EXISTS client_revision_count integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN creatives.client_revision_count IS
  'クライアントチェック後修正への遷移回数。revision_count は D/P 修正のみカウント。';
