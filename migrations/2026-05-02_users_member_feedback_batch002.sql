-- feedback batch 002: メンバー編集まとめ改善 用 migration
--
-- 適用方法:
--   Supabase ダッシュボード → SQL Editor に貼って Run。冪等。
--
-- 主旨:
--   1. 過去 commit 50a1a3e（請求書/口座対応）でコードだけ追加され、
--      本番 DB に反映されていなかった users 個人情報カラムを補完する。
--      → これが無いと PUT /api/members/:id が "column ... does not exist" で失敗し、
--        「メンバー編集を保存しても反映されない」バグの根本原因になっていた。
--   2. メンバーごとの「休日曜日」設定カラムを追加（土曜日が仕事のメンバー対応）。
--   3. カメラ系メンバーの機材情報（カメラ機種・三脚・照明）カラムを追加。
--
-- 既存データを壊さないよう、すべて NULL 許容 / DEFAULT 付きで追加する。

-- ---------- 1. 個人情報・口座情報カラム補完 ----------
ALTER TABLE users ADD COLUMN IF NOT EXISTS nickname            TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS note                TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS bank_name           TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS bank_code           TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS branch_name         TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS branch_code         TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS account_type        TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS account_number      TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS account_holder_kana TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone               TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS postal_code         TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS address             TEXT;

-- ---------- 2. 休日曜日（[0..6] / 0=日, 6=土） ----------
-- 既定 [0,6] = 土日休み。土曜出勤のメンバーは [0] に変更する想定。
ALTER TABLE users ADD COLUMN IF NOT EXISTS holiday_weekdays JSONB DEFAULT '[0,6]'::jsonb;

-- ---------- 3. カメラ機材 ----------
ALTER TABLE users ADD COLUMN IF NOT EXISTS camera_model  TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS tripod_info   TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS lighting_info TEXT;

-- PostgREST スキーマキャッシュ即時リロード
NOTIFY pgrst, 'reload schema';
