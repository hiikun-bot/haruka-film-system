-- creatives.team_id → teams.id の FK 不整合を修復するワンショット migration
--
-- 適用方法:
--   Supabase ダッシュボード → SQL Editor に貼り付けて Run。
--   冪等なので何度実行しても安全。
--
-- 経緯:
--   PR #36 で creatives.team_id を ALTER TABLE ADD COLUMN IF NOT EXISTS で追加した際、
--   先に column だけが FK 無しで作られていたケースがあり、IF NOT EXISTS が以後の FK 追加をスキップしてしまった。
--   結果 PostgREST が creatives→teams のリレーションを認識できず /api/creatives が 500 を返していた。
--   PR #46 でコード側は埋め込みを廃止して FK 不要にしたが、本ファイルでDB整合性も復元する。

-- 1) 削除済みチームを参照する孤立 team_id を NULL 化（FK バリデーションを通すため）
UPDATE creatives c
SET team_id = NULL
WHERE team_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM teams t WHERE t.id = c.team_id
  );

-- 2) FK が無ければ creatives_team_id_fkey を追加
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'creatives_team_id_fkey'
      AND conrelid = 'public.creatives'::regclass
  ) THEN
    ALTER TABLE public.creatives
      ADD CONSTRAINT creatives_team_id_fkey
      FOREIGN KEY (team_id)
      REFERENCES public.teams(id)
      ON DELETE SET NULL;
  END IF;
END $$;

-- 3) team_id にインデックス（フィルタ・JOIN 用）
CREATE INDEX IF NOT EXISTS idx_creatives_team_id ON public.creatives(team_id);

-- 4) PostgREST のスキーマキャッシュをリロード（FK を即時認識させる）
NOTIFY pgrst, 'reload schema';
