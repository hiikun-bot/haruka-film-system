-- 2026-06-13_creative_files_r2.sql
-- 動画添削の再生高速化: faststart 版を Cloudflare R2 へ複製して署名URL配信するための列。
--
-- ライフサイクル:
--   r2_status = 'active'  : R2 に複製済み（レビュー中）→ /stream は R2 署名URL(302)で配信
--   r2_status = 'evicted' : 納品済み等で R2 から削除済み → Drive プロキシにフォールバック
--   r2_status = 'failed'  : 複製に失敗（次回 backfill/再生成で再試行）
--   r2_status = NULL      : 未複製
--
-- R2 はレビュー中の動画だけを置くホットキャッシュ。納品(creatives.status='納品')で排出され、
-- Drive 上の原本がそのままバックアップになる（累積しない）。

ALTER TABLE creative_files
  ADD COLUMN IF NOT EXISTS r2_key         text,
  ADD COLUMN IF NOT EXISTS r2_status      text,
  ADD COLUMN IF NOT EXISTS r2_uploaded_at timestamptz;

-- 排出 sweep / backfill 対象抽出用（r2_status='active' のものを引く）
CREATE INDEX IF NOT EXISTS idx_creative_files_r2_status
  ON creative_files (r2_status)
  WHERE r2_status IS NOT NULL;
