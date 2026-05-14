-- ADR 017 Phase 1.0: 日次稼働時間（GCal計算結果 + 手動オーバーライド）
--
-- このテーブルは「グリッド表示用のキャッシュ + 手動入力の上書き」を兼ねる。
--   - GCal 連動メンバー: sync-self が走った時点の算出値を保存（過去日はスナップショット）
--   - GCal 未連動メンバー: users.weekday_hours/weekend_hours から動的計算するため
--     基本的に行は作成しない（manual_override が入った場合のみ行が作られる）
--
-- 🔒 プライバシー (ADR 017 §1.2): computed_slots / gcal_raw_slots は
--    「時間情報のみ」(from/to 文字列の配列)。件名・場所・参加者等は一切入れない。

CREATE TABLE IF NOT EXISTS member_working_hours_daily (
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date               date NOT NULL,
  -- 自動算出（GCal連動者のみ）
  computed_slots     jsonb,                       -- [{"from":"19:00","to":"21:30"}, ...] ※時間情報のみ
  computed_hours     numeric(5,2),
  gcal_raw_slots     jsonb,                       -- 同上（GCalイベントの時間情報のみ）
  gcal_synced_at     timestamptz,
  -- 手動オーバーライド
  manual_override    boolean NOT NULL DEFAULT false,
  manual_slots       jsonb,
  manual_symbol      text,                        -- '×' '△' 'AM' 'PM' null
  manual_hours       numeric(5,2),
  manual_set_at      timestamptz,
  manual_set_by      uuid REFERENCES users(id),
  diverges_from_gcal boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, date)
);
CREATE INDEX IF NOT EXISTS idx_mwh_daily_date ON member_working_hours_daily(date);
CREATE INDEX IF NOT EXISTS idx_mwh_daily_user_date ON member_working_hours_daily(user_id, date);
COMMENT ON TABLE member_working_hours_daily IS 'ADR 017 Phase 1: 日次稼働時間（GCal計算結果 + 手動オーバーライド）';

CREATE OR REPLACE FUNCTION trg_member_working_hours_daily_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS member_working_hours_daily_updated_at ON member_working_hours_daily;
CREATE TRIGGER member_working_hours_daily_updated_at
  BEFORE UPDATE ON member_working_hours_daily
  FOR EACH ROW EXECUTE FUNCTION trg_member_working_hours_daily_updated_at();

-- ==================== 権限キー seed ====================
-- availability:view-org      … 組織全体のリソースカレンダー閲覧
-- availability:sync-own      … 自分のGCal同期実行
-- availability:edit-others   … 他メンバーの手動オーバーライド（Phase 1.0 では admin/secretary のみ）
INSERT INTO role_permissions (role, permission_key, allowed) VALUES
  ('admin',             'availability:view-org', true),
  ('secretary',         'availability:view-org', true),
  ('producer',          'availability:view-org', true),
  ('producer_director', 'availability:view-org', true),
  ('director',          'availability:view-org', true),
  ('editor',            'availability:view-org', true),
  ('designer',          'availability:view-org', true),
  ('admin',             'availability:sync-own', true),
  ('secretary',         'availability:sync-own', true),
  ('producer',          'availability:sync-own', true),
  ('producer_director', 'availability:sync-own', true),
  ('director',          'availability:sync-own', true),
  ('editor',            'availability:sync-own', true),
  ('designer',          'availability:sync-own', true),
  ('admin',             'availability:edit-others', true),
  ('secretary',         'availability:edit-others', true)
ON CONFLICT (role, permission_key) DO UPDATE SET allowed = EXCLUDED.allowed;
