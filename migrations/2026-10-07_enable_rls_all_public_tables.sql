-- public スキーマの全テーブルで RLS（行レベルセキュリティ）を有効化する（ADR 048）
--
-- 背景: Supabase Security Advisor（2026-10-03 診断）が
--   - rls_disabled_in_public  : RLS が無効なテーブルが public スキーマにある
--   - sensitive_columns_exposed: 機密列を持つテーブルが API から無制限に読める
-- を Critical として通知。コード上 ENABLE ROW LEVEL SECURITY があるのは 127 テーブル中 23 のみ。
--
-- 方針: HFS のアプリは server.js が service_role キーだけで DB を読み書きし（RLS をバイパス）、
--   ブラウザに渡る anon キーは notification_logs の Realtime 購読にしか使っていない。
--   よって「全テーブル RLS 有効 ＋ anon/authenticated 向けポリシー無し（= 全拒否）」にしても
--   アプリ側の動作は変わらず、anon キーからのデータ閲覧・改変だけが止まる。
--
-- ★ 実行手順（2 回に分けて実行する）
--   STEP 1: 下の DO ブロック「だけ」を SQL Editor に貼って実行する。
--           1 テーブルごとに COMMIT するため、他の文と一緒に流すと
--           「invalid transaction termination」になる。
--           ※ 当初は 1 トランザクションで 104 テーブルを順にロックしていたが、
--             稼働中アプリの JOIN クエリとロック待ちの輪ができて deadlock detected (40P01) で
--             全体がロールバックされた（2026-10-07）。COMMIT を挟めばロックを持ち越さないので起きない。
--   STEP 2: DROP POLICY 群と確認クエリを実行する。
--
-- 冪等: 既に有効なテーブルは触らない。ダッシュボード等で直接作ったテーブルも拾う。

-- ============================== STEP 1 ==============================
DO $$
DECLARE
  r record;
  n integer := 0;
BEGIN
  FOR r IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace ns ON ns.oid = c.relnamespace
    WHERE ns.nspname = 'public'
      AND c.relkind IN ('r', 'p')      -- 通常テーブル・パーティション親
      AND NOT c.relrowsecurity
    ORDER BY c.relname
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.relname);
    COMMIT;  -- 1 テーブルずつ確定。排他ロックを次のテーブルへ持ち越さない（deadlock 回避）
    RAISE NOTICE 'RLS enabled: %', r.relname;
    n := n + 1;
  END LOOP;
  RAISE NOTICE 'RLS を有効化したテーブル数: %', n;
END $$;

-- ============================== STEP 2 ==============================
-- 既存の「誰でも SELECT 可」ポリシーを外す
--   2026-05-03 の通知/つぶやき migration で、Supabase Auth 利用を想定して
--   USING (true) / USING (deleted_at IS NULL) の SELECT ポリシーを置いていた。
--   HFS は Supabase Auth を使っておらず（Passport + bcrypt + http_sessions）、
--   フロントも supabase.from() を一切呼ばないため、これらは anon キー保持者に
--   社内の投稿・つぶやき・リアクションを丸見えにするだけになっている。
--   INSERT/UPDATE/DELETE 側は auth.uid() 比較（常に NULL で不成立）なので無害、そのまま残す。
DROP POLICY IF EXISTS posts_select_all              ON posts;
DROP POLICY IF EXISTS post_reactions_select_all     ON post_reactions;
DROP POLICY IF EXISTS post_comments_select_all      ON post_comments;
DROP POLICY IF EXISTS tweet_reactions_select_all    ON tweet_reactions;
DROP POLICY IF EXISTS tweet_comments_select_visible ON tweet_comments;

-- 確認（0 行になれば完了。Security Advisor は数分〜数時間後に再評価される）
SELECT c.relname
FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
WHERE ns.nspname = 'public' AND c.relkind IN ('r','p') AND NOT c.relrowsecurity
ORDER BY 1;
