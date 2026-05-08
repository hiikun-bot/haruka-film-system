-- ============================================================
-- 全体連絡: 代理完了 (proxy ack) の履歴列を追加
-- ============================================================
-- 仕様:
--   管理者 (users.role='admin') / 秘書 (users.role='secretary') が
--   未完了メンバーの代わりに「代理完了」できる。
--   その履歴を残すために、誰がいつ代理で押したかを announcement_acks に記録する。
--
--   - 本人が押した場合: 両列とも NULL
--   - 代理で押した場合: proxy_acked_by_user_id = 押した管理者/秘書 / proxy_acked_at = 押した時刻
--
-- 対象テーブル: announcement_acks
-- 関連 PR: feat(teams): 代理完了 (proxy ack)
-- ============================================================

ALTER TABLE announcement_acks
  ADD COLUMN IF NOT EXISTS proxy_acked_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS proxy_acked_at TIMESTAMPTZ;

-- 代理操作の履歴を時系列で見たいケースのためのインデックス（軽量）
CREATE INDEX IF NOT EXISTS idx_announcement_acks_proxy_by
  ON announcement_acks(proxy_acked_by_user_id)
  WHERE proxy_acked_by_user_id IS NOT NULL;

COMMENT ON COLUMN announcement_acks.proxy_acked_by_user_id IS
  '代理で完了マークした管理者/秘書の user_id。本人が押した場合は NULL。';
COMMENT ON COLUMN announcement_acks.proxy_acked_at IS
  '代理で完了マークされた時刻。本人が押した場合は NULL。';
