-- ====================================================================
-- 2026-05-03 project_director_rates: 案件別ディレクション費（per-project, per-creative_type）
-- ====================================================================
-- Issue #192
--
-- 案件カードの「単価設定」モーダルに「ディレクター」セクションを追加し、
-- クリエイティブ単位で必ず加算される「1本あたりのディレクション費」を
-- per-project で保存できるようにする。
--
-- 設計判断（案A vs 案B → 案B採用）:
--   project_rates は (project_id, creative_type, rank) UNIQUE で動画編集者向け。
--   ディレクション費は rank 概念を持たない（ディレクター本人で1単価）ため、
--   rank=A 行に director_fee を相乗りさせる案A は意味的に冗長で誤解を生む。
--   よって新テーブル project_director_rates を分離し、
--   UNIQUE(project_id, creative_type) で 1案件×1種別=1単価を保証する。
--
-- 受取人:
--   projects.director_id で紐付くディレクターがディレクション費の受取人。
--   creative ごとに「実際のディレクター」を保持していないため、
--   案件のディレクター = ディレクション費の受取人 として扱う。
--
-- 加算ルール:
--   creatives 1件あたり director_fee を1回必ず加算（編集者と兼務でも満額）。
-- ====================================================================

CREATE TABLE IF NOT EXISTS project_director_rates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  creative_type TEXT NOT NULL CHECK (creative_type IN ('video', 'design')),
  director_fee INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(project_id, creative_type)
);

-- パフォーマンス: 案件単位の検索（一覧読み込み・予算計算）が頻発するためインデックス必須
CREATE INDEX IF NOT EXISTS idx_pdr_project ON project_director_rates(project_id);
