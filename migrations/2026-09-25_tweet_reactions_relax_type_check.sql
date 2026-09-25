-- ============================================================
-- つぶやきリアクションの種類を「基本 5 種」以外にも広げる（ADR 044）
--   ユーザー要望（2026-09-25）「基本スタンプに＋ボタンを置いて、爆笑などいろんな絵文字を
--   リアクションとして選べるようにしたい」
--
-- 役割:
--   ・tweet_reactions / tweet_comment_reactions の reaction_type に付いていた
--       CHECK (reaction_type IN ('good','heart','clap','smile','surprised'))
--     を外す（この列挙のままだと 🤣 などを押した瞬間に check_violation で 500 になる）。
--   ・代わりに「英小文字で始まる 英小文字・数字・_ の 1〜32 文字」という形式だけを CHECK で縛る。
--     どの種類（どの絵文字）を許可するかはコード側 utils/reactions.js が正
--     （portfolio_reactions と同じ流儀。絵文字を 1 つ足すたびに migration を書かなくてよい）。
--   ・既存行（基本 5 種）はすべて新しい形式 CHECK を満たすので、データ移行なし。
--
-- 冪等性:
--   DO ブロックで「reaction_type を参照する CHECK 制約」を制約名に依存せず全部落とし、
--   形式 CHECK を固定名で付け直す（2 回流しても同じ結果）。
--   tweet_comment_reactions が無い環境（#1173 未適用）では、そのテーブル分だけスキップする。
--
-- 適用方法:
--   1) Supabase ダッシュボード → SQL Editor を開く
--   2) このファイル全文を貼り付けて Run
-- ============================================================

DO $$
DECLARE
  t TEXT;
  r RECORD;
BEGIN
  FOREACH t IN ARRAY ARRAY['tweet_reactions', 'tweet_comment_reactions'] LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      RAISE NOTICE '% が存在しないためスキップ', t;
      CONTINUE;
    END IF;

    -- reaction_type を参照する CHECK 制約をすべて落とす（列挙 CHECK・過去の形式 CHECK いずれも）
    FOR r IN
      SELECT conname
      FROM pg_constraint
      WHERE contype = 'c'
        AND conrelid = to_regclass('public.' || t)
        AND pg_get_constraintdef(oid) ILIKE '%reaction_type%'
    LOOP
      EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', t, r.conname);
      RAISE NOTICE '%.% を削除', t, r.conname;
    END LOOP;

    -- 形式だけを縛る CHECK を付け直す（許可値の列挙はしない）
    EXECUTE format(
      'ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (reaction_type ~ %L)',
      t, t || '_reaction_type_format_check', '^[a-z][a-z0-9_]{0,31}$'
    );
    EXECUTE format(
      'COMMENT ON COLUMN public.%I.reaction_type IS %L',
      t, '基本 5 種（good/heart/clap/smile/surprised）＋拡張パレット（lol/fire/tada …）。許可値は utils/reactions.js が正・DB は形式のみ CHECK（ADR 044）'
    );
  END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';
