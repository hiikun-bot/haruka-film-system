-- ============================================================
-- bug_reports に「至急対応」フラグを追加
-- ============================================================
-- severity（報告者の主観的な重要度）と独立した、管理者判断による「業務影響度」軸。
-- 一覧で最上位ソート + 行を薄赤背景で強調する。
--
-- ※本番では既に手動適用済み（PR #478 の追加 SQL として 2026-05-10 に実行）
--   migration ファイルとしての履歴を残すために独立ファイルで定義。
-- ============================================================

ALTER TABLE bug_reports
  ADD COLUMN IF NOT EXISTS is_urgent boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS bug_reports_is_urgent_idx
  ON bug_reports (is_urgent)
  WHERE is_urgent = true;
