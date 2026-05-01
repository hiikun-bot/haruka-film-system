-- 全体連絡（アナウンスメント）機能用テーブル
-- ダッシュボードに表示される全社向け連絡 + 各メンバーの完了状況。
-- 投稿時に system_settings.broadcast_slack_channel_url が設定されていれば
-- そのチャンネルへも自動で同じメッセージを投稿する。
--
-- 適用方法:
--   1) Supabase ダッシュボード → SQL Editor を開く
--   2) このファイル全文を貼り付けて Run
--   (db/migrate.js の自動同期が走っていれば不要)

CREATE TABLE IF NOT EXISTS announcements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  body TEXT,
  posted_by UUID REFERENCES users(id) ON DELETE SET NULL,
  posted_at TIMESTAMPTZ DEFAULT now(),
  deadline_at TIMESTAMPTZ,
  is_active BOOLEAN DEFAULT true,
  slack_pushed_at TIMESTAMPTZ,
  slack_push_result TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_announcements_active ON announcements(is_active, posted_at DESC);

CREATE TABLE IF NOT EXISTS announcement_acks (
  announcement_id UUID NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  done_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (announcement_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_announcement_acks_user ON announcement_acks(user_id);

-- PostgREST のスキーマキャッシュをリロード
NOTIFY pgrst, 'reload schema';
