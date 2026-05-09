-- ADR 011 補足 (2026-05-09 v2): creatives 本体に「コメント書き込み時刻」列を追加する。
--
-- 背景:
--   PR #446 第 1 弾では snapshot 行に editor_submitted_at / director_commented_at を追加し、
--   ラウンド比較UIの編集者発言とディレクター発言を別時刻で表示できるようにした。
--   ただし director_commented_at は beforeRow.updated_at（= 修正系ステータスへ
--   遷移した瞬間）を使っていたため、「ディレクターがコメントを書いた時刻」と
--   完全には一致しないケースがあった（例: ステータスはあとで変えた／自動遷移）。
--
-- 対応:
--   creatives テーブル本体にコメント種別ごとの更新時刻を持たせ、
--   PUT /creatives/:id でコメントが書き換わるたびに対応する _updated_at を
--   `now()` で同時更新する。
--   snapshot INSERT 時は beforeRow.director_comment_updated_at を引き継いで
--   コピー保存する（過去の指摘時刻として frozen）。
--
-- 列:
--   editor_comment_updated_at   : 編集者の提出時メモを書き換えた時刻
--   director_comment_updated_at : ディレクターが指摘コメントを書き換えた時刻
--   client_comment_updated_at   : クライアントが指摘コメントを書き換えた時刻
--
-- 既存行は NULL のまま許容。フロント側は NULL のとき created_at にフォールバック。
-- 副作用なし（ALTER ADD COLUMN IF NOT EXISTS のみ）。

ALTER TABLE creatives
  ADD COLUMN IF NOT EXISTS editor_comment_updated_at TIMESTAMPTZ;

ALTER TABLE creatives
  ADD COLUMN IF NOT EXISTS director_comment_updated_at TIMESTAMPTZ;

ALTER TABLE creatives
  ADD COLUMN IF NOT EXISTS client_comment_updated_at TIMESTAMPTZ;

-- snapshot 側にも client_commented_at を追加（前 PR で editor_submitted_at /
-- director_commented_at だけ追加済みだったため、対称性のため追加）。
ALTER TABLE creative_version_history
  ADD COLUMN IF NOT EXISTS client_commented_at TIMESTAMPTZ;
