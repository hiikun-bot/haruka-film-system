-- メンバー編集モーダルで保存される全フィールドが users テーブルに揃っていることを保証する
-- safety migration（冪等）。
--
-- 背景:
--   メンバー編集モーダル（modal-member）の 5 タブの全フィールドが、
--   既存 PR・migration で個別に追加されてきたが、本番 DB の schema-sync が
--   一部失敗していたケースで silent skip され、PUT /api/members/:id が
--   フォールバックで該当列を「無いものとして drop」してしまうと、
--   ユーザーから見ると「保存しても反映されない」状態になる
--   （Supabase silent skip パターン: feedback_supabase_silent_skip_pattern）。
--
--   そこで、メンバー編集で保存する列を全部このファイルにまとめて、
--   本番 DB に確実に揃っていることを保証する。
--
-- 適用方法:
--   Supabase ダッシュボード → SQL Editor に貼って Run。冪等。
--   もしくは PR マージ後、Railway の起動時 schema-sync で自動適用される
--   （db/migrate.js の criticalAlters に同等内容を追加済み）。
--
-- 既存データを壊さないよう、すべて NULL 許容 / DEFAULT 付きで追加する。

-- ---------- 基本情報タブ ----------
ALTER TABLE users ADD COLUMN IF NOT EXISTS nickname             TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS hide_birth_year      BOOLEAN DEFAULT false;

-- ---------- 稼働時間タブ ----------
ALTER TABLE users ADD COLUMN IF NOT EXISTS note                 TEXT;
-- weekday_hours / weekend_hours は元々 JSONB で存在するためここでは触らない
ALTER TABLE users ADD COLUMN IF NOT EXISTS default_creative_tab TEXT;

-- ---------- 連絡先タブ ----------
-- slack_dm_id / chatwork_dm_id は users 初期スキーマで存在する想定だが、
-- 万一に備えて IF NOT EXISTS で保険を貼る
ALTER TABLE users ADD COLUMN IF NOT EXISTS slack_dm_id          TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS chatwork_dm_id       TEXT;

-- ---------- 口座情報タブ ----------
ALTER TABLE users ADD COLUMN IF NOT EXISTS bank_name            TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS bank_code            TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS branch_name          TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS branch_code          TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS account_type         TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS account_number       TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS account_holder_kana  TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone                TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS postal_code          TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS address              TEXT;

-- ---------- 機材・休日タブ ----------
ALTER TABLE users ADD COLUMN IF NOT EXISTS holiday_weekdays     JSONB DEFAULT '[0,6]'::jsonb;
ALTER TABLE users ADD COLUMN IF NOT EXISTS camera_model         TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS tripod_info          TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS lighting_info        TEXT;

-- PostgREST スキーマキャッシュ即時リロード
NOTIFY pgrst, 'reload schema';
