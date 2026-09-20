-- 2026-09-17_project_showcase_hidden.sql
-- 🎬 新着納品ショーケース（ホームのスライドショー）に出さない案件のフラグ
-- 設計: docs/design/decisions/042-portfolio-reactions.md（追補 2026-09-17: 🎬 新着納品ショーケース）
--
-- 目的:
--   直近 7 日に納品された作品をホームで流し、チームでその場で 👏 できるようにする。
--   機密案件（クライアント都合で社内でも広く見せたくないもの）は案件単位で除外できるようにする。
--   既定 false ＝ すべての案件が出る。true にした案件の作品は API（GET /showcase）が返さない。
--
-- 冪等性: IF NOT EXISTS。二重実行しても壊れない。
-- 既存データへの影響: 列追加のみ（DEFAULT false）。既存の案件は全件そのままショーケース対象。

BEGIN;

ALTER TABLE projects ADD COLUMN IF NOT EXISTS showcase_hidden BOOLEAN NOT NULL DEFAULT false;
COMMENT ON COLUMN projects.showcase_hidden IS 'true ならホームの🎬新着納品ショーケースに出さない（機密案件向け・ADR 042 追補）';

COMMIT;

-- PostgREST のスキーマキャッシュをリロード（列追加を即時反映）
NOTIFY pgrst, 'reload schema';
