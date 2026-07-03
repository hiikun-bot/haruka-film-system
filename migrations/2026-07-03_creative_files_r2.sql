-- 2026-07-03_creative_files_r2.sql
-- 動画添削の再生高速化: faststart 版を Cloudflare R2 へ複製して署名URL配信するための列。
-- R2 は「10GB 無料枠を絶対に超えない」ハイブリッド運用（超えそうなら複製せず従来Drive配信）。
--
-- ライフサイクル:
--   r2_status = 'active'  : R2 に複製済み（レビュー中）→ /direct-url・/stream は R2 署名URLで配信
--   r2_status = 'evicted' : 納品済み等で R2 から削除済み → 従来 Drive 配信にフォールバック
--   r2_status = 'failed'  : 複製に失敗（次回 backfill/再生成で再試行）
--   r2_status = NULL      : 未複製
--
-- R2 はレビュー中の動画だけを置くホットキャッシュ。納品(creatives.status='納品')で排出され、
-- Drive 上の原本がそのままバックアップになる（累積しない＝消しながら運用）。
--
-- r2_size_bytes は 10GB 無料枠の予算ガード用。使用量は
--   SUM(r2_size_bytes) WHERE r2_status='active'
-- で DB 集計し、複製前に予算（env R2_BUDGET_BYTES・既定9GB）超過をチェックする。

ALTER TABLE creative_files
  ADD COLUMN IF NOT EXISTS r2_key         text,
  ADD COLUMN IF NOT EXISTS r2_status      text,
  ADD COLUMN IF NOT EXISTS r2_size_bytes  bigint,
  ADD COLUMN IF NOT EXISTS r2_uploaded_at timestamptz;

-- 排出 sweep / backfill / 使用量集計の対象抽出用（r2_status='active' のものを引く）
CREATE INDEX IF NOT EXISTS idx_creative_files_r2_status
  ON creative_files (r2_status)
  WHERE r2_status IS NOT NULL;
