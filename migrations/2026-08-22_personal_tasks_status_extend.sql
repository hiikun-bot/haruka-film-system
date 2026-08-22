-- 2026-08-22 マイゴール: タスクステータスの拡張（画面リデザイン Stage 1）
--
-- 背景:
--   マイゴール画面のリデザイン（さとるさん指定デザイン 2026-08-22）で、タスクの状態を
--   「自分が動くもの」と「相手の回答・予約を待つもの」で見分けられるようにする。
--     未着手 / 対応中 / 相手待ち / 予約済み / 完了 / マイルストーン
--   既存の「進行中」は「対応中」に名称変更（データも書き換え）。
--
-- Stage 分割:
--   Stage 1（本migration）: CHECK制約の拡張 + 既存データの「進行中」→「対応中」変換
--   Stage 2（コードPR）  : 画面リデザイン・API/エクスポートのステータス対応
--   ※ Stage 2 のコードは本migration適用後にマージすること（新ステータス保存がCHECKで弾かれるため）
--
-- 本番Supabaseへの適用が必要。

ALTER TABLE personal_tasks DROP CONSTRAINT IF EXISTS personal_tasks_status_check;

UPDATE personal_tasks SET status = '対応中' WHERE status = '進行中';

ALTER TABLE personal_tasks ADD CONSTRAINT personal_tasks_status_check
  CHECK (status IN ('未着手','対応中','相手待ち','予約済み','完了','マイルストーン'));
