-- ADR 008 (Phase 0): クリエイティブ管理シート同期の前提テーブル
--
-- 目的:
--   修正サイクル（初稿=v0, 修正1回目=v1, ..., 最大5回）の履歴を正規化して持つ。
--   Phase 1 以降の Google Sheets 双方向同期で、Rev{n} URL / Rev{n} ステータス /
--   Rev{n} コメント の動的列展開のソースになる。
--
-- 経緯:
--   本番DB調査の結果、`creative_versions` テーブルは存在しなかった
--   （CLAUDE.md の機能地図には記載があったが実体なし。silent skip パターン）。
--   Phase 0 で新設し、既存 `creatives` から version_number=0 の行を seed する。
--
-- 設計:
--   - 既存 `creatives.editor_comment` / `director_comment` / `client_comment` は
--     v0（初稿）のスナップショット値として残す。creative_versions の v0 と
--     二重管理しない（v0 行は seed 時点のコピーとして作成。以降の v0 更新側の
--     同期 trigger は今 PR スコープ外）。
--   - 双方向同期の競合検出に使う *_comment_updated_at は creative_versions 側
--     にも対称に持つ。
--   - preview_url は v0 については delivery_url を初期値に採用
--     （初稿 = クライアント初納品のスナップショット）。
--
-- コード変更（routes / utils）は本 PR には含めない（Phase 1 で別 PR）。

CREATE TABLE IF NOT EXISTS creative_versions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  creative_id     uuid NOT NULL REFERENCES creatives(id) ON DELETE CASCADE,
  version_number  int  NOT NULL CHECK (version_number >= 0 AND version_number <= 99),
  preview_url     text,
  editor_comment  text,
  director_comment text,
  client_comment  text,
  editor_comment_updated_at   timestamptz,
  director_comment_updated_at timestamptz,
  client_comment_updated_at   timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(creative_id, version_number)
);

CREATE INDEX IF NOT EXISTS idx_creative_versions_creative_id
  ON creative_versions(creative_id);
CREATE INDEX IF NOT EXISTS idx_creative_versions_creative_id_version
  ON creative_versions(creative_id, version_number);

-- 既存 creatives から v0 行を seed
-- preview_url は delivery_url を採用（初稿 = クライアント初納品のスナップショット）
INSERT INTO creative_versions (
  creative_id, version_number, preview_url,
  editor_comment, director_comment, client_comment,
  editor_comment_updated_at, director_comment_updated_at, client_comment_updated_at,
  created_at, updated_at
)
SELECT
  c.id, 0, c.delivery_url,
  c.editor_comment, c.director_comment, c.client_comment,
  c.editor_comment_updated_at, c.director_comment_updated_at, c.client_comment_updated_at,
  COALESCE(c.created_at, now()), COALESCE(c.updated_at, now())
FROM creatives c
WHERE NOT EXISTS (
  SELECT 1 FROM creative_versions cv
  WHERE cv.creative_id = c.id AND cv.version_number = 0
);
