-- migrations/2026-05-05_user_creative_filter_defaults.sql
-- メンバーごとに「クリエイティブ画面 詳細フィルターの初期値」を保存する列を追加する。
--
-- 値は JSONB（NULL 許可、デフォルト NULL）。フォーマット例:
-- {
--   "includeEnded": false,
--   "includeDelivered": false,
--   "delayedOnly": false,
--   "sosOnly": false,
--   "team": "",
--   "status": "",
--   "ballFilter": {"e": true, "d": true, "p": true, "c": true},
--   "assigneeIds": [],
--   "mode": "gantt",        -- gantt | list
--   "group": "project",     -- project | assignee
--   "range": "2week"        -- week | 2week | month | 2month
-- }
--
-- フロント側ロジックの優先順位:
--   1) localStorage に値がある   → localStorage を優先
--   2) DB に保存値がある         → DB の値で localStorage を埋めて適用
--   3) どちらも無い              → ハードコード既定値
--
-- バリデーションはサーバー側 (routes/haruka.js の users/me/creative-filter-defaults) で行う。
-- 既存ユーザーへの影響なし: NULL のまま放置されてもフロントがハードコード既定値で動く。

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS creative_filter_defaults JSONB;

COMMENT ON COLUMN users.creative_filter_defaults IS
  'クリエイティブ画面の詳細フィルター初期値（JSONB）。NULL=未設定。フロント優先順位: localStorage > DB > ハードコード。';
