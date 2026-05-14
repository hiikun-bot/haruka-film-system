-- ADR 017 Phase 0: GCal 連携基盤
-- メンバー個人の基本稼働時間プロフィールと GCal 接続情報。
-- 日次テーブル(_daily)は Phase 1 で追加するため本 migration には含めない。

CREATE TABLE IF NOT EXISTS member_working_hours_profile (
  user_id           uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  weekday_slots     jsonb NOT NULL DEFAULT '[]'::jsonb,
  holiday_slots     jsonb NOT NULL DEFAULT '[]'::jsonb,
  gcal_connected    boolean NOT NULL DEFAULT false,
  gcal_account_email text,
  gcal_calendar_id  text DEFAULT 'primary',
  gcal_refresh_token_encrypted text,   -- AES-256-GCM 暗号化
  gcal_token_iv     text,               -- IV (base64)
  gcal_token_auth_tag text,             -- 認証タグ (base64)
  gcal_last_synced_at timestamptz,
  gcal_last_error   text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE member_working_hours_profile IS 'ADR 017: メンバー稼働時間プロフィール（基本枠 + GCal接続）';

CREATE OR REPLACE FUNCTION trg_member_working_hours_profile_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS member_working_hours_profile_updated_at ON member_working_hours_profile;
CREATE TRIGGER member_working_hours_profile_updated_at
  BEFORE UPDATE ON member_working_hours_profile
  FOR EACH ROW EXECUTE FUNCTION trg_member_working_hours_profile_updated_at();
