-- ADR 008 Phase 4: ファイル名連番のカスタマイズと桁数設定
--
-- 目的:
--   1) シート側で先行採番された連番に合わせて、案件側でも「次に採番する連番」を任意に指定できるようにする
--   2) ファイル名内の連番ゼロパディング桁数（既定3、1〜10）を案件単位で変更できるようにする
--
-- 既存仕様:
--   - 一括登録 (POST /api/creatives/bulk) は既存 internal_code / file_name から「使用済み連番」を抽出し、
--     最小未使用番号を割り当てる方式だった（欠番再利用問題の根本原因）。
--   - ハードコードフォールバック側のゼロパディングは 7 桁固定。
--
-- 本 migration は projects 側に2つの新列を足し、後続のコードPRで採番ロジックを差し替える。

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS next_filename_serial INT NOT NULL DEFAULT 1;

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS serial_digits INT NOT NULL DEFAULT 3;

-- 桁数は 1〜10 の範囲で制限（旧ハードコード 7 桁を含む）
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'projects_serial_digits_range'
  ) THEN
    ALTER TABLE projects
      ADD CONSTRAINT projects_serial_digits_range
      CHECK (serial_digits BETWEEN 1 AND 10);
  END IF;
END$$;

COMMENT ON COLUMN projects.next_filename_serial IS
  'ADR 008 Phase 4: 次に bulk 採番されるファイル名連番。シート側連番とのズレ調整に使う';
COMMENT ON COLUMN projects.serial_digits IS
  'ADR 008 Phase 4: ファイル名連番のゼロパディング桁数（既定3、1〜10）';

-- 既存案件の next_filename_serial を creatives.internal_code の最大連番+1 で seed。
-- internal_code が `^(\d+)_` 形式なら採用。0件 / 列無し の場合は 1 のまま。
UPDATE projects p
SET next_filename_serial = COALESCE((
  SELECT MAX(CAST(SUBSTRING(c.internal_code FROM '^(\d+)_') AS INTEGER)) + 1
  FROM creatives c
  WHERE c.project_id = p.id
    AND c.internal_code ~ '^\d+_'
), 1)
WHERE p.next_filename_serial = 1;
