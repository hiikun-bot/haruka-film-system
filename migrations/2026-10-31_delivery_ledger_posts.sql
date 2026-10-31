-- 📊 ADR 055 追補（Stage 1: migration）: 納品カウント（積み上げ台帳）の投稿記録
--
-- 背景・目的:
--   納品完了メッセージに載せる「当月の案件内 納品カウント」（PR #1281）を、HFS 自身が
--   「どのチャンネル／ルームに・どのメッセージ ID で・どの数字を」投稿したか記録する。
--   月初の自動突合（Stage 2）はこの記録を手がかりに Slack / Chatwork から投稿を読み直し、
--   DB の納品数と照らす。人が URL を渡さなくても HFS だけで突合が完結する（全自動化）。
--   Chatwork は「最新 100 件」しか一覧取得できないため、message_id を持っていないと
--   古い投稿を読み直せない（GET /rooms/{room_id}/messages/{message_id} で 1 件ずつ取れる）。
--
-- テーブル:
--   delivery_ledger_posts  台帳の投稿 1 回 = 1 行（Slack と Chatwork の両方に出したら 2 行）
--
-- RLS: ADR 048 に従い有効化（HFS は service_role だけで読み書き。anon/authenticated のポリシーは作らない）
-- 冪等: CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS。2 回流しても落ちない。
-- 本番Supabaseへの適用が必要（適用後に PR へ db-migration-applied ラベル）。

CREATE TABLE IF NOT EXISTS delivery_ledger_posts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  ym              TEXT NOT NULL,                                   -- 'YYYY-MM'（JST の当月）
  platform        TEXT NOT NULL CHECK (platform IN ('slack', 'chatwork')),
  channel_ref     TEXT NOT NULL,                                   -- Slack: channel_id ／ Chatwork: room_id
  message_id      TEXT,                                            -- Slack: ts ／ Chatwork: message_id（API が返さなければ NULL）
  kind            TEXT NOT NULL CHECK (kind IN ('single', 'bulk')),-- single=1 件の納品完了 ／ bulk=一括納品（月次消込）
  creative_ids    UUID[] NOT NULL DEFAULT '{}',                    -- 今回納品した creative（single は 1 件）
  seq             INTEGER,                                         -- single: 当月の何件目か
  added           INTEGER,                                         -- bulk: 今回の件数
  month_total     INTEGER NOT NULL,                                -- 投稿時点の当月件数
  project_total   INTEGER NOT NULL,                                -- 投稿時点の案件累計
  tag             TEXT NOT NULL,                                   -- 本文末尾の [HFS-LEDGER] 行そのまま
  posted_by       UUID REFERENCES users(id) ON DELETE SET NULL,    -- 納品操作をした人（一括は実行者）
  posted_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_delivery_ledger_posts_project_ym
  ON delivery_ledger_posts(project_id, ym, posted_at);
CREATE INDEX IF NOT EXISTS idx_delivery_ledger_posts_ym
  ON delivery_ledger_posts(ym);

ALTER TABLE delivery_ledger_posts ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE delivery_ledger_posts IS
  'ADR055: 納品完了メッセージに載せた当月納品カウント（積み上げ台帳）の投稿記録。月初の自動突合で Slack/Chatwork から読み直す手がかり';
COMMENT ON COLUMN delivery_ledger_posts.message_id IS 'Slack は ts、Chatwork は message_id。NULL は投稿 API が ID を返さなかった（または投稿失敗）';
