-- ============================================================
-- 通知種別: creative_registered
-- 「誰かがクリエイティブを新規登録したら admin / secretary に通知する」
--
-- 背景:
--   POST /api/creatives で新規クリエイティブが追加されたとき、
--   admin / secretary には「誰が何を登録したか」を即座に把握したいニーズあり。
--   notification_logs.notification_type には CHECK 制約が無い設計
--   （migrations/2026-05-03_notification_phase1.sql 参照）なので、
--   テーブル変更は notification_settings への enabled 列追加のみ。
--
-- 冪等性:
--   ・ADD COLUMN IF NOT EXISTS — 何度流しても安全
-- ============================================================

ALTER TABLE notification_settings
  ADD COLUMN IF NOT EXISTS creative_registered_enabled BOOLEAN NOT NULL DEFAULT true;

-- 既存ユーザー分は DEFAULT true により自動充当されるので追加 INSERT 不要。
