-- 「前回」セクション各メッセージへのスレッド形式返信を保存。
-- 親メッセージは creative_version_history の 1 行
--   (revise / submit / approve_handoff / deliver 等の各ラウンドイベント) を指す。
-- 編集・削除（論理削除 = deleted_at）可。
-- クライアントは未対応のため author は内部スタッフ (users) のみ。
--
-- Stage 1: migration のみ。コード実装（API / UI）は別 PR で後追い。

CREATE TABLE IF NOT EXISTS creative_round_replies (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  creative_id        uuid NOT NULL REFERENCES creatives(id) ON DELETE CASCADE,
  version_history_id uuid NOT NULL REFERENCES creative_version_history(id) ON DELETE CASCADE,
  body               text NOT NULL CHECK (length(body) > 0 AND length(body) <= 4000),
  author_user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz
);

COMMENT ON TABLE creative_round_replies IS
  'クリエイティブ詳細モーダル「前回」セクション各メッセージへのスレッド返信。親は creative_version_history.id。';

-- スレッド取得用（親メッセージ単位で時系列ロード）
CREATE INDEX IF NOT EXISTS idx_crr_vhid_created
  ON creative_round_replies(version_history_id, created_at)
  WHERE deleted_at IS NULL;

-- クリエイティブ単位のバルク取得用（モーダル open 時に creative 全件先読み）
CREATE INDEX IF NOT EXISTS idx_crr_creative_created
  ON creative_round_replies(creative_id, created_at)
  WHERE deleted_at IS NULL;

-- updated_at 自動更新 trigger（既存テーブルの慣例に合わせる: 直近の
-- member_working_hours_daily / member_working_hours_profile と同じパターン）
CREATE OR REPLACE FUNCTION trg_creative_round_replies_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS creative_round_replies_updated_at ON creative_round_replies;
CREATE TRIGGER creative_round_replies_updated_at
  BEFORE UPDATE ON creative_round_replies
  FOR EACH ROW EXECUTE FUNCTION trg_creative_round_replies_updated_at();
