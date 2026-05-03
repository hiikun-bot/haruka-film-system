-- ====================================================================
-- 2026-05-03 project_producer_rates: 案件別プロデュース費（per-project, per-creative_type）
-- ====================================================================
-- 単価設定モーダルの「プロデューサー」セクションに対応するテーブル。
-- 設計は project_director_rates (PR #195 / migrations/2026-05-03_project_director_rates.sql)
-- と完全に揃え、producer_fee 列だけ別系統で持つ。
--
-- 設計判断:
--   project_rates は (project_id, creative_type, rank) UNIQUE で動画編集者向け。
--   プロデュース費は rank 概念を持たない（プロデューサー本人で1単価）ため、
--   rank=A 行に producer_fee を相乗りさせる案は意味的に冗長で誤解を生む。
--   よって新テーブル project_producer_rates を分離し、
--   UNIQUE(project_id, creative_type) で 1案件×1種別=1単価を保証する。
--
-- 受取人:
--   projects.producer_id で紐付くプロデューサーがプロデュース費の受取人。
--   creative ごとに「実際のプロデューサー」を保持していないため、
--   案件のプロデューサー = プロデュース費の受取人 として扱う。
--
-- 加算ルール:
--   creatives 1件あたり producer_fee を1回必ず加算（編集者・ディレクターと兼務でも満額）。
--   ディレクション費 (director_fee) と独立して加算される。
-- ====================================================================

CREATE TABLE IF NOT EXISTS project_producer_rates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  creative_type TEXT NOT NULL CHECK (creative_type IN ('video', 'design')),
  producer_fee INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(project_id, creative_type)
);

-- パフォーマンス: 案件単位の検索（一覧読み込み・予算計算）が頻発するためインデックス必須
CREATE INDEX IF NOT EXISTS idx_ppr_project ON project_producer_rates(project_id);
