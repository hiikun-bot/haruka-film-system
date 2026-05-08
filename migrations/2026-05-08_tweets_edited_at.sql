-- つぶやき本文編集機能用カラム
-- PATCH /api/tweets/:id で更新される。NULL = 未編集。
-- UI 側はこの値があるとき「（編集済み）」を投稿時刻の隣に表示する。

ALTER TABLE tweets ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;
