-- クリエイティブごとの「素材フォルダURL」（Google ドライブ）を持たせる
--
-- 目的: これまでメモ欄に「▶素材 https://drive.google.com/...」と手書きで貼っていた
--   素材フォルダのリンクを専用の列で持つ。クリエイティブ追加（個別・一括）と
--   詳細モーダルで入力・表示する（画面と API は別 PR）。
--   旧 PR #607（2026-05）を最新の main 用に作り直したもの。
--
-- 値: Google ドライブ（https://drive.google.com/...）の URL だけ。形式の検証は
--   サーバー（utils/drive-folder-url.js）で行うので DB には制約を付けない。
--   NULL 可・既存行は NULL のまま（メモ欄からの移し替えはしない）。
--   何度流しても同じ結果になる（IF NOT EXISTS）。
--
-- RLS: creatives は ADR 048（migrations/2026-10-07_enable_rls_all_public_tables.sql）で
--   public の全テーブルとまとめて有効化済み。新しいテーブルは作らないので追加の ENABLE は不要。
--   念のため確認する場合は次を流して relrowsecurity = true を見る（読むだけ）:
--     SELECT relname, relrowsecurity FROM pg_class WHERE relname = 'creatives';
--
-- Bug-Report-Id: 739526eb-1524-409b-84f3-d1103d0962c3

ALTER TABLE creatives ADD COLUMN IF NOT EXISTS material_folder_url TEXT;

COMMENT ON COLUMN creatives.material_folder_url IS '素材フォルダの Google ドライブ URL（任意・旧メモ欄の「▶素材」リンクの置き換え）';

NOTIFY pgrst, 'reload schema';
