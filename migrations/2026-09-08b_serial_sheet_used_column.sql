-- ============================================================================
-- ADR 038 追補: 連番連動シートの「使用中判定の列」
--
-- 背景:
--   ネコ・イヌスエールの管理シートは A 列「No」に 1〜304 が事前に振られており、
--   「A 列の最大値 + 1」では 305 になってしまう（実際の最終使用番号は 13 → 次は 14）。
--   → 「CR名」列（B）が埋まっている行だけを使用中とみなし、その中で番号の最大値 + 1 を採る。
--
-- 変更:
--   projects.serial_sheet_used_column TEXT NULL（A〜ZZZ）。NULL = 従来どおり番号列だけで判定。
-- ============================================================================

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS serial_sheet_used_column TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'projects_serial_sheet_used_column_check') THEN
    ALTER TABLE projects
      ADD CONSTRAINT projects_serial_sheet_used_column_check
      CHECK (serial_sheet_used_column IS NULL OR serial_sheet_used_column ~ '^[A-Z]{1,3}$');
  END IF;
END$$;

COMMENT ON COLUMN projects.serial_sheet_used_column IS
  'ADR 038 追補: 連番連動シートで「この列が空でない行だけを使用中」とみなす列（例: B=CR名）。NULL = 番号列のみで判定。';
