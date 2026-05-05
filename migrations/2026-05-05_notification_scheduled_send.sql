-- ============================================================
-- 通知 Phase 1: 時間帯指定送信モード（予約配信）
-- 適用日: 2026-05-05
--
-- 目的:
--   notification_logs に「予約配信」の状態を持たせる。
--   - send_mode: 'immediate'（即時, 既存挙動）/ 'scheduled'（予約配信）
--   - scheduled_send_at: 予約配信の予定時刻
--   - delivered_at: 実際に配信された時刻（即時はINSERT時、予約はワーカが更新）
--   - cancelled_at / cancelled_by: 配信前にキャンセルされた場合の記録
--
-- スコープ A: 人が能動的に出す通知（全体連絡など）のみで使用。
-- システム自動通知は send_mode='immediate' のままで挙動変更なし。
--
-- 対応コード:
--   utils/notification.js（createNotification の sendMode 拡張）
--   routes/notifications.js（GET /scheduled, PATCH /:id/cancel, PATCH /:id/reschedule）
--   workers/notification-scheduler.js（1分ごとに配信）
-- ============================================================

ALTER TABLE notification_logs
  ADD COLUMN IF NOT EXISTS send_mode TEXT NOT NULL DEFAULT 'immediate';

ALTER TABLE notification_logs
  ADD COLUMN IF NOT EXISTS scheduled_send_at TIMESTAMPTZ NULL;

ALTER TABLE notification_logs
  ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ NULL;

ALTER TABLE notification_logs
  ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ NULL;

ALTER TABLE notification_logs
  ADD COLUMN IF NOT EXISTS cancelled_by UUID NULL REFERENCES users(id) ON DELETE SET NULL;

-- send_mode の許容値制約（既存値があるので IF NOT EXISTS 相当を pg 流に）
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'notification_logs_send_mode_check'
  ) THEN
    ALTER TABLE notification_logs
      ADD CONSTRAINT notification_logs_send_mode_check
      CHECK (send_mode IN ('immediate', 'scheduled'));
  END IF;
END$$;

-- 既存レコードは「即時送信済み」とみなして delivered_at を created_at で埋める
UPDATE notification_logs
   SET delivered_at = created_at
 WHERE delivered_at IS NULL
   AND cancelled_at IS NULL
   AND (send_mode IS NULL OR send_mode = 'immediate');

-- ワーカが「未配信・未キャンセル・予定時刻が来た」を高速に拾うための部分インデックス
CREATE INDEX IF NOT EXISTS idx_notification_logs_pending_delivery
  ON notification_logs (scheduled_send_at)
  WHERE delivered_at IS NULL AND cancelled_at IS NULL;

-- 受信者向け一覧（GET / /unread-count）が「配信済みのみ」絞るときに使う部分インデックス
CREATE INDEX IF NOT EXISTS idx_notification_logs_user_delivered
  ON notification_logs (user_id, created_at DESC)
  WHERE delivered_at IS NOT NULL AND cancelled_at IS NULL;

-- 差出人視点の「自分の予約一覧」が高速に取れるように
CREATE INDEX IF NOT EXISTS idx_notification_logs_sender_pending
  ON notification_logs (sender_id, scheduled_send_at)
  WHERE delivered_at IS NULL AND cancelled_at IS NULL;
