-- ADR 037: ディレクターも成果物グループ・単価を設定できるようにし、
--          承認権限を持たない人の単価変更は「有効なまま admin 承認待ち」にする
--
-- 目的:
--   - 8月請求突合で「単価 ¥0 のまま納品」が多発。全件ディレクター作成の案件で、
--     ディレクターは案件を作れる（#1093 project.create）が成果物グループ・単価は
--     project.create_edit（admin/secretary/producer/PD）しか触れないため、
--     単価入力が admin/P の「人待ち」工程になっていた
--   - ディレクターにも単価設定を開放しつつ、金額の最終決定は admin が承認する
--
-- 1) 新 permission_key
--   project.pricing_edit    : 成果物グループ・単価(line_costs)・D費バー・プリセット一括生成の作成/編集
--                             → lines 系 API は requireAnyPermission('project.create_edit','project.pricing_edit')
--   project.pricing_approve : 承認待ち単価の承認/差し戻し。保持者の単価書き込みは承認を経ずに確定
--                             → admin のみ。producer 等を即確定にしたい場合は権限マトリクスで ON にする
--
-- 2) project_estimate_lines に承認状態列を追加（既存行は全件 'approved'）
--
-- ADR 003（roles-as-master-data）/ ADR 015（VIEW AS チェックリスト）準拠。

-- ---------- 1) 権限 ----------
INSERT INTO role_permissions (role, permission_key, allowed) VALUES
  ('admin',             'project.pricing_edit', true),
  ('secretary',         'project.pricing_edit', true),
  ('producer',          'project.pricing_edit', true),
  ('producer_director', 'project.pricing_edit', true),
  ('director',          'project.pricing_edit', true),
  ('editor',            'project.pricing_edit', false),
  ('designer',          'project.pricing_edit', false),
  ('external_director', 'project.pricing_edit', false),
  ('admin',             'project.pricing_approve', true),
  ('secretary',         'project.pricing_approve', false),
  ('producer',          'project.pricing_approve', false),
  ('producer_director', 'project.pricing_approve', false),
  ('director',          'project.pricing_approve', false),
  ('editor',            'project.pricing_approve', false),
  ('designer',          'project.pricing_approve', false),
  ('external_director', 'project.pricing_approve', false)
ON CONFLICT (role, permission_key) DO UPDATE SET allowed = EXCLUDED.allowed;

-- role_id の dual-write（ADR 003）
UPDATE role_permissions rp
SET role_id = r.id
FROM roles r
WHERE rp.permission_key IN ('project.pricing_edit', 'project.pricing_approve')
  AND rp.role_id IS NULL
  AND r.code = rp.role;

-- ---------- 2) 承認状態列 ----------
ALTER TABLE project_estimate_lines
  ADD COLUMN IF NOT EXISTS pricing_approval      TEXT NOT NULL DEFAULT 'approved',
  ADD COLUMN IF NOT EXISTS pricing_requested_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS pricing_requested_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pricing_prev_snapshot JSONB,
  ADD COLUMN IF NOT EXISTS pricing_approved_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS pricing_approved_at   TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'pel_pricing_approval_check'
  ) THEN
    ALTER TABLE project_estimate_lines
      ADD CONSTRAINT pel_pricing_approval_check
      CHECK (pricing_approval IN ('approved', 'pending'));
  END IF;
END $$;

-- 承認待ち一覧（全案件横断）用の部分インデックス
CREATE INDEX IF NOT EXISTS idx_pel_pricing_pending
  ON project_estimate_lines (pricing_requested_at DESC)
  WHERE pricing_approval = 'pending';

COMMENT ON COLUMN project_estimate_lines.pricing_approval      IS 'ADR 037: approved | pending（承認権限を持たない人が単価を作成/変更すると pending）';
COMMENT ON COLUMN project_estimate_lines.pricing_prev_snapshot IS 'ADR 037: pending に落ちる直前の承認済み値 {client_unit_price, costs:[...]}。差し戻し時に復元。新規作成 line は NULL';
