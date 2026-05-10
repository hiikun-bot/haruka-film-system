-- ADR 008 (Phase 1): クリエイティブ管理シート同期 — 案件単位の同期先 URL を保持
--
-- 目的:
--   片方向同期（システム → Google Sheets）の同期先 URL を案件単位で保持する。
--   未設定なら同期実行時に system_settings.creatives_export_master_template_url で
--   指定されたマスターテンプレートをコピーして自動で埋める。
--
-- 設計原本: docs/design/decisions/008-system-as-master-sheet-export.md
--
-- 関連 system_settings キー（値は INSERT で運用、ALTER 不要）:
--   - creatives_export_master_template_url : マスターテンプレシート URL（admin 設定）
--   - creatives_export_mapping_json        : マッピング JSON 文字列（admin 設定）

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS creatives_export_sheet_url TEXT;

COMMENT ON COLUMN projects.creatives_export_sheet_url IS
  'ADR 008: 案件単位のクリエイティブ管理シート同期先 URL。未設定なら同期実行時にマスターテンプレからコピー作成して埋める';
