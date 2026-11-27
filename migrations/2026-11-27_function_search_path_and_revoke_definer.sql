-- DB 関数の search_path 固定と、SECURITY DEFINER 関数の EXECUTE 権限の整理（ADR 048 追補 2026-11-27）
--
-- 背景: Supabase Security Advisor の Warning
--   - function_search_path_mutable : search_path が固定されていない関数がある
--   - SECURITY DEFINER 関数（get_my_role / get_my_job_type / is_active_user /
--     is_admin_or_producer / is_director_or_above）を anon / authenticated が EXECUTE できる
-- HFS は server.js が service_role だけで DB を使い、Supabase Auth は使っていない。
-- anon キーは Realtime（notification_logs / tweets の購読）にしか使っていない。
--
-- やること
--   STEP 1: リポジトリで定義している関数 20 本に SET search_path = public, pg_temp を付ける。
--           本体が参照するのは public のテーブルと pg_catalog の組み込み関数（now() 等）だけ。
--           存在しない関数は to_regprocedure が NULL を返すので飛ばす。
--   STEP 2: 上記 5 本（ダッシュボードで作られたもの。リポジトリに定義が無く引数型が不明なので、
--           pg_proc から名前で全オーバーロードを拾う）について
--             (a) search_path を固定する。ただし本体に「auth. を付けない uid(」があれば固定しない（NOTICE）
--             (b) PUBLIC / anon / authenticated から EXECUTE を外し、service_role には付け直す。
--                 ただし Realtime 対象テーブル（supabase_realtime publication）のポリシーが
--                 その関数を呼んでいる場合は外さない（Realtime の購読は anon で評価されるため。NOTICE）
--
-- ロック: ALTER FUNCTION / REVOKE は pg_proc の 1 行を書き換えるだけで、テーブルロックは取らない。
--         念のため lock_timeout を 5 秒にしている（待たされたら失敗して全体がロールバックされるだけ）。
-- 冪等: 何度流しても同じ状態になる。
--
-- ★ 実行手順: このファイル全体を SQL Editor に貼って 1 回で実行してよい（COMMIT は使っていない）。
--   実行後、末尾の確認クエリで結果を見る。NOTICE に「スキップ」が出たら内容を確認すること。

-- ============================== STEP 1 ==============================
DO $$
DECLARE
  sig  text;
  fn   regprocedure;
  n    integer := 0;
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  FOREACH sig IN ARRAY ARRAY[
    'public.contract_deny_modification()',
    'public.contract_version_guard()',
    'public.delete_cost_entry_from_invoice_item()',
    'public.delete_revenue_entry_from_invoice()',
    'public.notify_ball_returned()',
    'public.set_creative_cost_overrides_updated_at()',
    'public.sync_cost_entry_from_invoice_item()',
    'public.sync_revenue_entry_from_invoice()',
    'public.touch_filename_templates_updated_at()',
    'public.trg_creative_round_replies_updated_at()',
    'public.trg_member_working_hours_daily_updated_at()',
    'public.trg_member_working_hours_profile_updated_at()',
    'public.trg_set_user_oauth_tokens_updated_at()',
    'public.trg_set_vfot_updated_at()',
    'public.trg_set_vous_updated_at()',
    'public.update_post_comment_count()',
    'public.update_post_reaction_count()',
    'public.update_tweet_comment_count()',
    'public.update_tweet_reaction_count()',
    'public.validate_filename_template_tokens(jsonb)'
  ]
  LOOP
    fn := to_regprocedure(sig);
    IF fn IS NULL THEN
      RAISE NOTICE 'スキップ（関数が無い）: %', sig;
      CONTINUE;
    END IF;
    EXECUTE format('ALTER FUNCTION %s SET search_path = public, pg_temp', fn);
    n := n + 1;
  END LOOP;
  RAISE NOTICE 'STEP 1: search_path を固定した関数 % 本', n;
END
$$;

-- ============================== STEP 2 ==============================
DO $$
DECLARE
  r          record;
  fname      text;
  in_policy  text;
  n_path     integer := 0;
  n_revoke   integer := 0;
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  FOREACH fname IN ARRAY ARRAY[
    'get_my_role',
    'get_my_job_type',
    'is_active_user',
    'is_admin_or_producer',
    'is_director_or_above'
  ]
  LOOP
    FOR r IN
      SELECT p.oid::regprocedure AS fn, p.prosrc, p.prosecdef
        FROM pg_proc p
        JOIN pg_namespace ns ON ns.oid = p.pronamespace
       WHERE ns.nspname = 'public' AND p.proname = fname
    LOOP
      -- (a) search_path 固定（auth. を付けずに uid() を呼んでいる本体は固定すると解決できなくなるので触らない）
      IF r.prosrc ~* '(^|[^.a-z0-9_"])uid\s*\(' THEN
        RAISE NOTICE 'スキップ（本体が auth. なしで uid() を呼んでいる）search_path: %', r.fn;
      ELSE
        EXECUTE format('ALTER FUNCTION %s SET search_path = public, pg_temp', r.fn);
        n_path := n_path + 1;
      END IF;

      -- (b) Realtime 対象テーブルのポリシーから呼ばれていれば anon / authenticated の EXECUTE は残す
      SELECT string_agg(DISTINCT pol.tablename || '.' || pol.policyname, ', ')
        INTO in_policy
        FROM pg_policies pol
        JOIN pg_publication_tables pt
          ON pt.schemaname = pol.schemaname AND pt.tablename = pol.tablename
       WHERE pt.pubname = 'supabase_realtime'
         AND (COALESCE(pol.qual, '') ~* ('\m' || fname || '\s*\(')
           OR COALESCE(pol.with_check, '') ~* ('\m' || fname || '\s*\('));

      IF in_policy IS NOT NULL THEN
        RAISE NOTICE 'スキップ（Realtime 対象のポリシー % が呼んでいる）REVOKE: %', in_policy, r.fn;
      ELSE
        EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', r.fn);
        EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon, authenticated', r.fn);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', r.fn);
        n_revoke := n_revoke + 1;
      END IF;

      IF NOT r.prosecdef THEN
        RAISE NOTICE '参考: % は SECURITY DEFINER ではない', r.fn;
      END IF;
    END LOOP;
  END LOOP;
  RAISE NOTICE 'STEP 2: search_path 固定 % 本 / EXECUTE を外した関数 % 本', n_path, n_revoke;
END
$$;

-- ============================== 確認クエリ ==============================
-- 1) public の関数で search_path が固定されていないもの（拡張が入れた関数が出る場合は対象外）
-- SELECT p.oid::regprocedure AS fn
--   FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
--  WHERE ns.nspname = 'public' AND p.prokind = 'f'
--    AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) c WHERE c LIKE 'search_path=%')
--  ORDER BY 1;
--
-- 2) 5 本の権限（anon / authenticated が false、service_role が true なら OK）
-- SELECT p.oid::regprocedure AS fn,
--        has_function_privilege('anon', p.oid, 'EXECUTE')          AS anon,
--        has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
--        has_function_privilege('service_role', p.oid, 'EXECUTE')  AS service_role,
--        p.proconfig
--   FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
--  WHERE ns.nspname = 'public'
--    AND p.proname IN ('get_my_role','get_my_job_type','is_active_user','is_admin_or_producer','is_director_or_above');

-- ============================== 戻し方（必要なときだけ） ==============================
-- search_path を元に戻す（関数ごと）:
--   ALTER FUNCTION public.notify_ball_returned() RESET search_path;
-- EXECUTE を元に戻す（5 本。引数型は確認クエリ 2 の fn 列をそのまま使う）:
--   GRANT EXECUTE ON FUNCTION public.get_my_role() TO PUBLIC, anon, authenticated;
