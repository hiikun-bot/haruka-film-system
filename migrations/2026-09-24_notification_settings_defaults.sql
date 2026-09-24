-- ============================================================
-- 通知の受信設定: 多すぎる種別を既定オフにし、本人が ON/OFF できるようにする（ADR 043）
--
-- 背景（2026-09-24 に本番 notification_logs 直近 90 日を集計）:
--   ・creative_registered … admin / 秘書 4 人に 2,114 件（1 人 1 日平均 10.5 件）・既読率 35%
--   ・ball_returned        … 3,436 件。creative_status（Dチェック依頼など）と同じ遷移で二重に鳴り、
--                            さらに DB トリガーが delivered_at を入れていないため配信済み扱いにならず
--                            受信箱にも出ていなかった（既読率 0%）
--   ・その他（creative_status / コメント / つぶやき / 作品の反応）は業務連絡か既読率 6〜8 割
--
-- 変更内容:
--   1) creative_status / creative_comment の ON/OFF 列を追加（既定 ON）
--      ─ creative_comment はこれまで 'post_comment'（つぶやき返信）と同じ種別で発火していた
--        「クリエイティブへのコメント」を分離した新種別（コード側で切替）
--   2) creative_registered / ball_returned の既定を OFF にし、既存行も OFF に揃える
--      （これまで ON/OFF する UI が無かったので「本人が ON にした」行は存在しない）
--   3) 設定行が無いユーザーに行を作る（通知設定 API が読むため）
--   4) notify_ball_returned トリガーを設定尊重＋配信済み（delivered_at）付きに差し替え
--
-- 冪等性: ADD COLUMN IF NOT EXISTS / SET DEFAULT / UPDATE ... WHERE / CREATE OR REPLACE
-- ============================================================

BEGIN;

-- 1) 新しい ON/OFF 列
ALTER TABLE notification_settings
  ADD COLUMN IF NOT EXISTS creative_status_enabled  BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS creative_comment_enabled BOOLEAN NOT NULL DEFAULT true;

-- 2) 多すぎる種別は既定 OFF（新規行）＋既存行も OFF に揃える
ALTER TABLE notification_settings
  ALTER COLUMN creative_registered_enabled SET DEFAULT false,
  ALTER COLUMN ball_returned_enabled       SET DEFAULT false;

UPDATE notification_settings
   SET creative_registered_enabled = false,
       ball_returned_enabled       = false,
       updated_at                  = now()
 WHERE creative_registered_enabled = true
    OR ball_returned_enabled       = true;

-- 3) 設定行が無いユーザーに既定行を作る
INSERT INTO notification_settings (user_id)
SELECT id FROM users
ON CONFLICT (user_id) DO NOTHING;

-- 4) ball_returned トリガー: 受信者の設定を見て、配信済み（delivered_at=now()）で INSERT する。
--    設定行が無い場合は既定（OFF）扱い。
CREATE OR REPLACE FUNCTION notify_ball_returned()
RETURNS TRIGGER AS $$
DECLARE
  v_enabled BOOLEAN;
BEGIN
  IF NEW.ball_holder_id IS DISTINCT FROM OLD.ball_holder_id
     AND NEW.ball_holder_id IS NOT NULL THEN
    SELECT ball_returned_enabled INTO v_enabled
      FROM notification_settings
     WHERE user_id = NEW.ball_holder_id;
    IF COALESCE(v_enabled, false) THEN
      INSERT INTO notification_logs (
        user_id,
        notification_type,
        title,
        body,
        link_url,
        meta,
        sender_id,
        send_mode,
        delivered_at
      ) VALUES (
        NEW.ball_holder_id,
        'ball_returned',
        'ボールが返ってきました',
        COALESCE(NEW.file_name, 'クリエイティブ') || 'のボールが返ってきました',
        '/creatives/' || NEW.id,
        jsonb_build_object(
          'creative_id', NEW.id,
          'creative_name', NEW.file_name,
          'previous_status', OLD.status,
          'new_status', NEW.status
        ),
        OLD.ball_holder_id,
        'immediate',
        now()
      );
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_creatives_ball_returned ON creatives;
CREATE TRIGGER trg_creatives_ball_returned
AFTER UPDATE OF ball_holder_id ON creatives
FOR EACH ROW EXECUTE FUNCTION notify_ball_returned();

COMMIT;
