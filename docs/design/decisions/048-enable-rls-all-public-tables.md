# ADR 048: public スキーマの全テーブルで RLS を有効化し、anon キーからのデータアクセスを全面遮断する

- Status: Accepted
- Date: 2026-10-07
- Related: `migrations/2026-10-07_enable_rls_all_public_tables.sql`, 通知 Phase 1/4（`migrations/2026-05-03_notification_phase1.sql` / `..._phase4_tweets_rich.sql`）, ADR 040（セッションを `http_sessions` へ移行）, `GET /api/config`（anon キー配布）

## Context

Supabase の Security Advisor（2026-10-03 診断、10-07 03:24 JST にメール通知）が本番プロジェクト `haruka-film-system` に対して Critical を 2 件出した。

| lint | 内容 |
|---|---|
| `rls_disabled_in_public` | RLS が無効なテーブルが public スキーマにあり、project URL ＋ anon キーで読み書き削除できる |
| `sensitive_columns_exposed` | 機密列（パスワード・個人識別子など）を持つテーブルが API から無制限に読める |

コードを棚卸しすると、PostgREST に露出している 127 テーブルのうち `ENABLE ROW LEVEL SECURITY` が書かれているのは 23 だけで、残り 104 は RLS 無し。その中には次の列がある。

- `users`: `password_hash`, `email`, `phone`, `address`, `birthday`, `bank_name/bank_code/branch_name/branch_code/account_number`, `hourly_rate`, `slack_dm_id`, `chatwork_dm_id`
- `http_sessions.sid`（ADR 040。読めればセッション乗っ取りが可能）
- `user_oauth_tokens.access_token/refresh_token`, `slack_workspaces.bot_token`, `member_working_hours_profile.gcal_refresh_token_encrypted`
- `invitations.token`, `contract_requests.token`, `contract_consents.user_email/ip_address`
- `billing_parties`（法人の住所・法人番号・連絡先）, 単価・金額系（`director_rates`, `invoice_items`, `payout_records`, `work_hour_entries` など）

一方、HFS のデータアクセス経路は次のとおり単純である。

```
ブラウザ ──(Cookie セッション)──▶ Express(server.js) ──(service_role キー)──▶ Supabase
ブラウザ ──(anon キー: GET /api/config でログイン後に取得)──▶ Supabase Realtime
                                                               └ notification_logs の postgres_changes のみ
```

- サーバーは `service_role` キーのみを使う（`supabase.js`）。service_role は RLS をバイパスする。
- フロントが anon キーで行うのは `notification_logs` の Realtime 購読だけで、`supabase.from()` によるデータ取得は一切無い。
- 認証は Passport ＋ bcrypt ＋ 自前セッション（`http_sessions`）で、Supabase Auth は使っていない。したがって既存ポリシーの `auth.uid()` は常に NULL。
- anon キーはログイン済みメンバーなら誰でも `GET /api/config` で取得できる。Supabase の設計上も anon キーは「公開鍵」であり、秘匿を前提にしてはいけない。

つまり「anon キーを持った誰か（＝全メンバー、あるいは過去にキーが漏れた相手）が PostgREST を直接叩けば、パスワードハッシュ・銀行口座・セッション ID・OAuth トークンを読み書きできる」状態だった。漏洩が起きた証跡は確認していないが、起きていても検知できる仕組みも無い。

## Decision

1. **public スキーマの全テーブルで RLS を有効化する。** `pg_class.relrowsecurity = false` のテーブルを DO ブロックで総なめして `ENABLE ROW LEVEL SECURITY` を発行する（冪等。ダッシュボードで直接作ったテーブルも拾う）。
2. **anon / authenticated 向けのポリシーは作らない（= 全拒否）。** アプリは service_role だけで動くので、ポリシー不要。
3. **既存の「誰でも SELECT 可」ポリシーを削除する。** `posts_select_all`, `post_reactions_select_all`, `post_comments_select_all`, `tweet_reactions_select_all`, `tweet_comments_select_visible` の 5 本。Supabase Auth を使う前提で置かれたが、実際には anon キー保持者に社内の投稿・つぶやきを丸見えにするだけだった。`auth.uid()` 比較の INSERT/UPDATE/DELETE ポリシーは不成立で無害なので残す。
4. **今後の migration は `CREATE TABLE` と同じファイルで必ず `ENABLE ROW LEVEL SECURITY` を書く。** CLAUDE.md の migration ルールに追記する（本 PR で対応）。
5. **anon キーの再発行（ローテーション）は本 ADR の範囲外。** RLS 有効化で anon キーは「何も読めない鍵」になるため、ローテーションの緊急性は低い。やるなら Supabase ダッシュボードの API Keys から行い、Railway の `SUPABASE_ANON_KEY` を差し替えるだけで済む（フロントは `/api/config` 経由なのでデプロイ不要）。

## Consequences

- **アプリの動作は変わらない。** service_role 経由の読み書きは RLS の影響を受けない。
- **Realtime（通知ベル）も変わらない。** `notification_logs` はもともと RLS 有効 ＋ `user_id = auth.uid()` ポリシーで、anon 接続では以前からイベントが届かない設計になっている（通知ベルの実体はポーリング／再取得）。本 ADR で状態は変わらない。将来 Realtime を本当に使うなら、サーバーで署名した短命 JWT を渡すか、Broadcast チャネルへ切り替える。
- **Security Advisor の 2 件は解消される見込み。** 適用後、`relrowsecurity = false` が 0 行であることを SQL で確認し、ダッシュボードの Advisors を再読込して確認する。
- **副作用の候補**: `scripts/` 配下や外部ツール（GAS・Make 等）が anon キーで PostgREST を叩いていれば動かなくなる。grep の範囲では anon キーの利用は `GET /api/config` の 1 箇所のみ。
- 同じメールで指摘された別プロジェクト `feed-scheduler`（`mbbjpjvnmlethzusfmpc`）は HFS の管轄外。別途対応。

## 適用手順

1. Supabase SQL Editor で `migrations/2026-10-07_enable_rls_all_public_tables.sql` の **STEP 1（DO ブロック）だけを単独で実行**（1 テーブルごとに COMMIT。NOTICE に有効化したテーブル名が並ぶ）。初版は 1 トランザクションで全テーブルをロックして稼働中アプリと deadlock したため、この形に変更した。続けて STEP 2（DROP POLICY）を実行。
2. 同ファイル末尾の確認クエリで 0 行を確認。
3. 本番サイトでログイン → 一覧・詳細・つぶやき・通知ベルが従来どおり動くことを確認。
4. PR に `db-migration-applied` ラベルを付けてマージ。

## 追補 2026-11-27: 残り Warning の対応（関数の search_path と SECURITY DEFINER 関数の権限）

RLS 有効化後も Security Advisor に Warning が残っていた。

| lint | 対象 |
|---|---|
| `function_search_path_mutable` | search_path を固定していない関数 25 本（リポジトリ定義 20 本＋下の 5 本） |
| SECURITY DEFINER 関数を anon / authenticated が実行できる | `get_my_role` / `get_my_job_type` / `is_active_user` / `is_admin_or_producer` / `is_director_or_above` |

対応は `migrations/2026-11-27_function_search_path_and_revoke_definer.sql`（`supabase_schema.sql` 末尾にも同内容）。

1. **リポジトリで定義している関数 20 本に `SET search_path = public, pg_temp` を付ける。** 本体が参照するのは public のテーブルと pg_catalog の組み込み（`now()` / `jsonb_build_object` 等）だけなので解決先は変わらない。存在確認は `to_regprocedure`。対象: トリガ関数 19 本（`contract_*` / 案件収支の `sync_*`・`delete_*` / `notify_ball_returned` / `update_*_count` / `*_updated_at` 系）と `validate_filename_template_tokens(jsonb)`。
2. **5 本の SECURITY DEFINER 関数は、PUBLIC / anon / authenticated から EXECUTE を外し、service_role だけに残す。** あわせて search_path も固定する。5 本はダッシュボードで作られたものでリポジトリに定義が無く、引数型が分からないため `pg_proc` から名前で全オーバーロードを拾う。
   - **Realtime 対象テーブル（`supabase_realtime` publication）のポリシーが呼んでいる関数は外さない。** Realtime は購読者のロール（anon）でポリシーを評価するので、外すと購読がエラーになる。リポジトリ上の `notification_logs` / `tweets` 系のポリシーは `auth.uid()` 比較だけで 5 本を呼んでいないが、ダッシュボードで足されたポリシーがあり得るので migration 側で検査して NOTICE で知らせる。
   - 本体が `auth.` を付けずに `uid()` を呼んでいる場合は、search_path を固定すると解決できなくなるので固定しない（NOTICE）。
3. HFS は service_role だけで DB を使い、Supabase Auth を使っていない（`auth.uid()` は常に NULL）ため、5 本はアプリからは使われていない。外してもアプリの動作は変わらない。
4. **今後の関数は、作る migration で `SET search_path = public, pg_temp` を付け、アプリ専用なら `REVOKE ALL ... FROM PUBLIC, anon, authenticated` ＋ `GRANT EXECUTE ... TO service_role` まで書く**（2026-11 の請求書エディタ系関数が先例）。

戻し方: `ALTER FUNCTION <関数> RESET search_path;` / `GRANT EXECUTE ON FUNCTION <関数> TO PUBLIC, anon, authenticated;`
