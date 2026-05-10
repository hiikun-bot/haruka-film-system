-- 2026-05-10: クリエイティブの修正回数を「社内修正 / CL修正」で分けてカウントする
--
-- 背景:
--   旧 revision_count は「Dチェック後修正 / Pチェック後修正 / クライアントチェック後修正」
--   への遷移時に一律 +1 されていたため、「社内ループの回数」と「クライアントループの回数」
--   を区別できなかった。
--
--   今回の改修で:
--     internal_revision_count = D後修正 + P後修正 への遷移回数
--     client_revision_count   = CL後修正 への遷移回数
--   をそれぞれ独立にカウントし、詳細モーダルのバッジを「社内 N回 · CL N回」と並記する。
--
-- 後方互換:
--   ・旧 revision_count 列は当面そのまま残す（合計値の write も継続）。
--   ・既存データのバックフィル: 既存 revision_count 値を internal_revision_count にコピー。
--     正確な再集計（creative_status_transitions 由来の集計）は将来の保守タスクとする。
--     旧データは internal で寄せた状態で表示される（ユーザー体感としては「社内 N回」と
--     見える）が、新規遷移以降は正しく分離される。
--
-- 安全性:
--   ・どちらも DEFAULT 0 NOT NULL。既存行は 0 で埋まり、その上で UPDATE で
--     旧 revision_count を internal にコピー。
--   ・schema-sync が遅れている本番でも IF NOT EXISTS で冪等。

ALTER TABLE creatives
  ADD COLUMN IF NOT EXISTS internal_revision_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS client_revision_count   integer NOT NULL DEFAULT 0;

UPDATE creatives
   SET internal_revision_count = COALESCE(revision_count, 0)
 WHERE internal_revision_count = 0
   AND COALESCE(revision_count, 0) > 0;
