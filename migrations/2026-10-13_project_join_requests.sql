-- ADR 051: 案件への参加申請（project_join_requests）
-- 案件の登録権限が無いメンバー（編集者・デザイナー等）が、案件の P・D・管理者のうち
-- 宛先を選んで「この案件に参加したい」と理由つきで申請する。承認者は承認と同時に
-- 成果物グループの支払先メンバー（project_estimate_line_costs）として登録できる。
--
-- 冪等（IF NOT EXISTS）。新テーブルは同じファイルで RLS を有効化する（ADR 048）。

CREATE TABLE IF NOT EXISTS project_join_requests (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  requester_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 申請者が選んだ通知先（案件の P・D・管理者のうちから 1 人以上）
  recipient_ids   UUID[] NOT NULL,
  -- 申請理由（必須）
  message         TEXT NOT NULL CHECK (char_length(btrim(message)) > 0),
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  decided_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  decided_at      TIMESTAMPTZ,
  -- 承認・却下時に承認者が添えるひとこと（任意）
  decision_note   TEXT,
  -- 承認と同時に登録した支払先行（登録しなかった承認は NULL）
  created_line_cost_id UUID REFERENCES project_estimate_line_costs(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (cardinality(recipient_ids) > 0)
);

-- 同じ人が同じ案件に申請中を 2 件持たない
CREATE UNIQUE INDEX IF NOT EXISTS uq_project_join_requests_pending
  ON project_join_requests(project_id, requester_id) WHERE status = 'pending';
-- 「自分宛の申請中」一覧
CREATE INDEX IF NOT EXISTS idx_project_join_requests_recipients_pending
  ON project_join_requests USING GIN (recipient_ids) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_project_join_requests_requester
  ON project_join_requests(requester_id, created_at DESC);

ALTER TABLE project_join_requests ENABLE ROW LEVEL SECURITY;
