-- 🎯 マイゴール: タスクステータス拡張＋最優先＋マイルストーン（2026-08-22 ツリー画面リデザイン）
-- 1) status: 「進行中」→「対応中」に改名し、「相手待ち」「予約済み」を追加
--    （会社設立のような手続きモノで「自分の作業」と「司法書士など相手の回答待ち」を区別するため）
-- 2) priority: 「top（最優先）」を追加（高/中/低は画面に出さず、最優先だけ赤で表示する運用）
-- 3) is_milestone: 節目の日（例: 会社設立日）をマイルストーンとして表示するフラグ

-- status の CHECK を張り替え（既存データの「進行中」は「対応中」へ移行）
ALTER TABLE personal_tasks DROP CONSTRAINT IF EXISTS personal_tasks_status_check;
UPDATE personal_tasks SET status = '対応中' WHERE status = '進行中';
ALTER TABLE personal_tasks ADD CONSTRAINT personal_tasks_status_check
  CHECK (status IN ('未着手','対応中','相手待ち','予約済み','完了'));

-- priority の CHECK を張り替え（top を追加。既存の high/mid/low はそのまま有効）
ALTER TABLE personal_tasks DROP CONSTRAINT IF EXISTS personal_tasks_priority_check;
ALTER TABLE personal_tasks ADD CONSTRAINT personal_tasks_priority_check
  CHECK (priority IN ('top','high','mid','low'));

-- マイルストーンフラグ
ALTER TABLE personal_tasks ADD COLUMN IF NOT EXISTS is_milestone BOOLEAN NOT NULL DEFAULT false;
