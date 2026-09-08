-- ============================================================================
-- ADR 038: ファイル名連番のスプレッドシート連動・テンプレ既定桁数
--
-- 背景（2026-09-08 ネコスエール/イヌスエール案件の命名規約）:
--   例) 010_ネコ・イヌスエール_1080_1080_大好きなペットとの毎日に.png
--   - 連番（3桁）は案件ごとの「管理シート」の A 列で先行採番されており、
--     HFS 側は「シートの最終番号 + 1」を次の連番として使いたい。
--   - 連番の桁数はテンプレ側で決めたい（現状は案件モーダルの上級設定のみ）。
--
-- 変更:
--   1) filename_templates.serial_digits（NULL=既定3桁）を追加。
--      桁数の解決順: projects.serial_digits → filename_templates.serial_digits → 3
--   2) projects.serial_digits を NULL 許可にし、「テンプレ既定に従う」を表現できるようにする。
--      既存行の 3（旧 DEFAULT 値）は NULL に寄せる（＝テンプレ既定 3 と同義なので挙動不変）。
--   3) projects に連番の採番元（counter / sheet）とシート接続情報を追加。
--      - serial_source        'counter'（既定・従来どおり next_filename_serial 起点）/ 'sheet'
--      - serial_sheet_url     連動するスプレッドシート URL（SA に閲覧権限を共有してもらう）
--      - serial_sheet_tab     タブ名（NULL = 1 枚目）
--      - serial_sheet_column  番号が入っている列（既定 'A'）
--
-- コード側は列欠損時のフォールバック（従来カウンタ方式）を持つため、
-- この migration 未適用でも既存挙動は後退しない。
-- ============================================================================

-- 1) テンプレ既定の連番桁数
ALTER TABLE filename_templates
  ADD COLUMN IF NOT EXISTS serial_digits INT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'filename_templates_serial_digits_range') THEN
    ALTER TABLE filename_templates
      ADD CONSTRAINT filename_templates_serial_digits_range
      CHECK (serial_digits IS NULL OR serial_digits BETWEEN 1 AND 10);
  END IF;
END$$;

COMMENT ON COLUMN filename_templates.serial_digits IS
  'ADR 038: このテンプレの連番ゼロパディング桁数（NULL=既定3）。案件側 projects.serial_digits が NULL のときに使う。';

-- 2) projects.serial_digits を NULL 許可に（NULL = テンプレ既定に従う）
--    ADR 008 Phase 4 の migration（2026-05-09_phase4_filename_serial.sql）が未適用の環境では
--    列ごと新設する（NULL 許可・DEFAULT なし）。
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'projects' AND column_name = 'serial_digits'
  ) THEN
    ALTER TABLE projects ALTER COLUMN serial_digits DROP NOT NULL;
    ALTER TABLE projects ALTER COLUMN serial_digits DROP DEFAULT;
    -- 旧 DEFAULT の 3 は「明示設定」ではなく既定値なので NULL（テンプレ既定）に寄せる
    UPDATE projects SET serial_digits = NULL WHERE serial_digits = 3;
  ELSE
    ALTER TABLE projects ADD COLUMN serial_digits INT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'projects_serial_digits_range') THEN
    ALTER TABLE projects
      ADD CONSTRAINT projects_serial_digits_range
      CHECK (serial_digits IS NULL OR serial_digits BETWEEN 1 AND 10);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'projects' AND column_name = 'next_filename_serial'
  ) THEN
    ALTER TABLE projects ADD COLUMN next_filename_serial INT NOT NULL DEFAULT 1;
  END IF;
END$$;

COMMENT ON COLUMN projects.serial_digits IS
  'ADR 008 Phase 4 / ADR 038: ファイル名連番のゼロパディング桁数。NULL = テンプレ既定（filename_templates.serial_digits → 3）';

-- 3) 連番の採番元とシート接続情報
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS serial_source        TEXT NOT NULL DEFAULT 'counter',
  ADD COLUMN IF NOT EXISTS serial_sheet_url     TEXT,
  ADD COLUMN IF NOT EXISTS serial_sheet_tab     TEXT,
  ADD COLUMN IF NOT EXISTS serial_sheet_column  TEXT NOT NULL DEFAULT 'A';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'projects_serial_source_check') THEN
    ALTER TABLE projects
      ADD CONSTRAINT projects_serial_source_check
      CHECK (serial_source IN ('counter', 'sheet'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'projects_serial_sheet_column_check') THEN
    ALTER TABLE projects
      ADD CONSTRAINT projects_serial_sheet_column_check
      CHECK (serial_sheet_column ~ '^[A-Z]{1,3}$');
  END IF;
END$$;

COMMENT ON COLUMN projects.serial_source IS
  'ADR 038: 連番の採番元。counter=projects.next_filename_serial 起点（従来）/ sheet=serial_sheet_url の列の最大番号+1';
COMMENT ON COLUMN projects.serial_sheet_url IS
  'ADR 038: 連番を連動させる管理スプレッドシートの URL。サービスアカウントに閲覧権限が必要。';
COMMENT ON COLUMN projects.serial_sheet_tab IS
  'ADR 038: 連番を読むタブ名。NULL = 1 枚目のタブ。';
COMMENT ON COLUMN projects.serial_sheet_column IS
  'ADR 038: 連番が入っている列（A〜ZZZ）。既定 A。';
