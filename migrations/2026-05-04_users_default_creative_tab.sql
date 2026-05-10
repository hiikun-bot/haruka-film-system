-- migrations/2026-05-04_users_default_creative_tab.sql
-- メンバーごとに「クリエイティブ画面の初期表示タブ」を設定する列を追加する。
--
-- 値:
--   'all'    : 共通（全件）
--   'video'  : 動画編集
--   'design' : デザイン
--   NULL     : 未設定 → ロール準拠フォールバック（フロント側で判定）
--              デザイナー: design / それ以外: video
--
-- CHECK 制約はあえて付けない（将来タブを増やす可能性があるため柔軟に保つ）。
-- バリデーションはサーバー側 (routes/haruka.js の POST/PUT /members) で行う。
-- 既存ユーザーへの影響なし: NULL のまま放置されてもフロントがロール判定にフォールバックする。

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS default_creative_tab TEXT;
