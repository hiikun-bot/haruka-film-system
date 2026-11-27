# 開発用DBを本番と分ける（セットアップと運用）

手元の Mac（`_main/.env`）が本番 Supabase に service_role キーで直結していると、開発中の試し操作やスクリプトが本番データを書き換えてしまう。
そこで **開発用の Supabase プロジェクト（無料組織・ダミーデータ）** を別に作り、普段の開発はそちらへつなぐ。
請求突合などの **調査で本番を読むとき** だけ、別ファイルで一時的に本番へ切り替える。

```
            普段の開発                               調査（本番を読む）
 ┌──────────────────────────────┐     ┌───────────────────────────────────────────────┐
 │ .env（開発用）                │     │ node --env-file=.env.production-readonly ...  │
 │  SUPABASE_URL = 開発ref       │     │  SUPABASE_URL = 本番ref                        │
 │  DATABASE_URL = 開発DB        │     │  DATABASE_URL = 空（schema-sync を流さない）   │
 │  PROD_SUPABASE_PROJECT_REF    │     │  ALLOW_PROD_DB_FROM_LOCAL=1                    │
 │      = 本番ref（判定用）       │     │                                               │
 └──────────────┬───────────────┘     └──────────────────────┬────────────────────────┘
                ▼                                            ▼
     開発用 Supabase（ダミー）                       本番 Supabase（読むだけ）
```

## 仕組み（このリポジトリに入っているもの）

| もの | 役割 |
|---|---|
| `utils/prod-db-guard.js` | 本番かどうかの判定。本番の Supabase プロジェクトID（ref）は環境変数 `PROD_SUPABASE_PROJECT_REF` で受ける（公開リポジトリなのでコードに書かない） |
| `server.js` 起動時 | `NODE_ENV≠production` なのに `SUPABASE_URL` / `DATABASE_URL` が本番を向いていたら**大きな警告**をログに出す（止めない）。`ALLOW_PROD_DB_FROM_LOCAL=1` のときだけ黙る |
| `scripts/dev-db/dump-prod-schema.sh` | 本番から **表の形だけ**（`pg_dump --schema-only`）を書き出す。データは含めない。混ざっていたら消して中止 |
| `scripts/dev-db/apply-schema.js` | 開発DBに表の形を作る。本番向きなら即中止 |
| `scripts/dev-db/seed.js` | 開発DBにダミーデータを入れる。本番向きなら即中止 |
| `.env.production-readonly.example` | 調査で本番を読むときの設定のひな形（実ファイルは git 管理外） |

`scripts/dev-db/*` は `PROD_SUPABASE_PROJECT_REF` が**未設定だと動かない**（本番かどうか判定できないので止める）。

### スキーマ複製の方式

| 方式 | 中身 | 向き不向き |
|---|---|---|
| **`--from-dump`（既定・推奨）** | 本番の `pg_dump --schema-only --schema=public` を流し、続けて `supabase_schema.sql`（起動時 schema-sync と同じ。roles などの初期マスタ行が入る） | 本番と同じ形になる。本番で手作業で作られた表（例: `team_members`）・関数・トリガー・RLS ポリシーまで揃う。本番に「定義を読む」接続が 1 回だけ要る |
| `--from-repo` | `supabase_schema.sql` → `migrations/*.sql`（日付順）→ `supabase_schema.sql` | 本番に一切触れない。ただしリポジトリに定義の無い表は作られない（2026-11 時点で `team_members` / `bug_reports` / `bug_report_comments` などが欠ける＝`scripts/check-schema-sync.sh` の警告 30 件と同じ根っこ） |

どちらも最後に public の全テーブルで RLS を有効化（ADR 048）し、PostgREST のスキーマを再読込する。

## 1. 開発用 Supabase プロジェクトを作る（初回だけ・手作業）

1. https://supabase.com/dashboard → 左上の組織切替 → **New organization**（Plan: **Free**）。本番と同じ組織に作ると課金・権限が混ざるので、無料の別組織にする
2. その組織で **New project**
   - Name: `hfs-dev` など
   - Database Password: 新しく生成して控える（本番と同じにしない）
   - Region: 本番と同じ（Northeast Asia (Tokyo)）
3. 作成後、次の値を控える
   - Project Settings → **API**: Project URL（`https://<開発ref>.supabase.co`）・`anon` キー・`service_role` キー
   - 右上 **Connect** → Session pooler（ポート 5432）の接続文字列 → `DATABASE_URL`
4. 無料プランは 1 週間アクセスが無いと一時停止する。止まったらダッシュボードの「Restore」で戻る（データは残る）

## 2. 手元の .env を開発用に切り替える

`_main/.env` は**消さない**。本番の値を別ファイルに退避してから、開発の値へ書き換える。

```bash
cd /Users/takahashi_satoru/Documents/40.プログラミング/HARUKA-FILM-SYSTEM/_main
cp .env .env.production-backup        # 本番の値の控え（.gitignore 済み・.env.* は全部除外）
cp .env.production-readonly.example .env.production-readonly   # 調査用（手順 7）。本番の値を入れる
```

`.env` の Supabase まわりを開発の値に（他の項目はそのまま）:

```dotenv
SUPABASE_URL=https://<開発ref>.supabase.co
SUPABASE_ANON_KEY=<開発の anon キー>
SUPABASE_SERVICE_ROLE_KEY=<開発の service_role キー>
DATABASE_URL=postgresql://postgres.<開発ref>:<開発DBパスワード>@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres
PROD_SUPABASE_PROJECT_REF=<本番ref>     # 判定用。キーではない
```

あわせて、開発中に本物の通知が飛ばないよう `.env` の `CHATWORK_API_TOKEN` / Slack の bot トークン / `ENABLE_AOZORA_TRANSFER` などは空 or false にしておく（ダミーデータには Chatwork ID を入れていないが、念のため）。

## 3. 本番から「表の形」だけを書き出す（`--from-dump` を使う場合）

本番に対しては**読むだけ**。行データは書き出さない。

```bash
brew install libpq && brew link --force libpq   # pg_dump（初回だけ）
pg_dump --version                               # 本番の Postgres と同じか新しいメジャー版であること

cd /Users/takahashi_satoru/Documents/40.プログラミング/HARUKA-FILM-SYSTEM/_main
bash scripts/dev-db/dump-prod-schema.sh
# → scripts/dev-db/.out/prod-schema.sql（.gitignore 済み）
```

`PROD_DATABASE_URL` は `.env.production-readonly` から読む（無ければ `PROD_DATABASE_URL='...' bash scripts/dev-db/dump-prod-schema.sh` で渡す）。
本番の Postgres のバージョンは Supabase ダッシュボードの Project Settings → Infrastructure で見られる。

## 4. 開発DBに表の形を作る

```bash
node scripts/dev-db/apply-schema.js            # 下見（接続先と流す順だけ表示。何もしない）
node scripts/dev-db/apply-schema.js --yes      # 実行（--from-dump が既定）
# 本番に触れずにやるなら:
node scripts/dev-db/apply-schema.js --from-repo --yes
# 開発DBを空にして作り直すなら（開発DB専用・中のデータも消える）:
node scripts/dev-db/apply-schema.js --reset --yes
```

最後に「public のテーブル: N 個 / RLS 無効: 0 個」と、失敗した文があれば件数と `scripts/dev-db/.out/apply-errors.json` が出る。

## 5. ダミーデータを入れる

```bash
node scripts/dev-db/seed.js          # 下見
node scripts/dev-db/seed.js --yes    # 投入（何度流しても増えない）
```

入るもの（すべて架空・メールは example.com）:

| 表 | 内容 |
|---|---|
| users / user_roles | 管理者・秘書・プロデューサー・ディレクター・兼任PD・編集者 2 人・デザイナー・外部ディレクター（`test-admin@example.com` など） |
| teams / team_members / client_teams | テスト ディレクターチーム（`team_members` は表がある場合だけ） |
| clients / projects | 「テスト株式会社（架空）」「サンプル商事（架空）」と案件 2 つ |
| project_estimate_lines / project_estimate_line_costs | 成果物グループ 3 つ（動画・静止画）と支払単価 |
| creatives / creative_assignments | 未着手・制作中・納品済み（先月・今週）を 6 本 |
| invoices / invoice_items | メンバー請求書（提出済み 1・下書き 1・先月分） |

ログインのパスワードは全員 `DEV_SEED_PASSWORD`（未設定なら `hfs-dev-pass`）。
安全装置として、example.com 以外のメールのユーザーが 5 人を超える DB には入れない（実データ入りの DB とみなす）。

## 6. 起動して確認

```bash
npm run dev
```

本番を向いていなければ警告は出ない。起動時の schema-sync は開発DBに流れる（`DATABASE_URL` が開発のため）。
Google ログイン・Drive・Slack などの外部連携は開発用の設定が無ければ動かない（画面の確認はメール＋パスワードでログイン）。

## 7. 本番を読む調査のとき（請求突合など）

`.env` は開発のまま。**その場だけ** `--env-file` で本番の値を上から載せる（Node の `--env-file` の値は、各スクリプトの `require('dotenv').config()` では上書きされない）。

```bash
node --env-file=.env.production-readonly scripts/delivery-ledger-check.js
```

- `.env.production-readonly` は `ALLOW_PROD_DB_FROM_LOCAL=1`（警告を黙らせる）・`DATABASE_URL=`（空）・`SCHEMA_AUTO_SYNC=false` にしてある
- **service_role キーは読み取り専用ではない**。このファイルで動かすのは「読むだけ」と分かっているスクリプトに限る
- **サーバー（`npm start` / `npm run dev`）をこのファイルで起動しない**（通知・振込ポーリングなどのワーカーが本番データで動く）
- 本当に読み取り専用にしたいなら、本番に SELECT だけの Postgres ロールを作る方法がある（本番の権限変更になるので別途相談）

### 本番に書き込む既存スクリプト（2026-11 時点・改修はしていない）

本番を向けて動かすと書き込みが起きるもの。開発DBで試す → 本番は `--dry-run` で確認してから、の順で使う。

| スクリプト | 書き込む先 | 本実行の条件 |
|---|---|---|
| `scripts/backfill_ball_holder_id.js` | `creatives.ball_holder_id` | 既定で書く（`--dry-run` で止まる） |
| `scripts/backfill_creative_line_id.js` | `creatives.line_id` | 既定で書く（`--dry-run` で止まる） |
| `scripts/backfill_msquare_project_id.js` | `video_file_organization_tests.project_id` | 既定で書く（`--dry-run` で止まる） |
| `scripts/create_invoice_folders.js` | Drive（フォルダ作成・権限）＋ `system_settings` | 既定で書く（`--dry-run` で止まる） |
| `scripts/delete_invoice_folders.js` | Drive（削除）＋ `member_invoice_folders` 削除・`invoice_folder_audit_log` | 既定で書く（`--dry-run` で止まる） |
| `scripts/migrate_invoice_folders_to_new_drive.js` | Drive（コピー）＋ `member_invoice_folders`・`system_settings`・`invoice_folder_audit_log` | `--force` が必要 |
| `scripts/migrate_preview_to_webp.js` | Drive（削除）＋ `video_file_organization_tests` | `--execute` が必要 |
| `scripts/rename_invoice_member_folders.js` | Drive（リネーム）＋ `member_invoice_folders` | 既定で書く（`--dry-run` で止まる） |
| `scripts/sync_invoice_folder_permissions.js` | Drive（権限の更新・削除） | 既定で書く（`--dry-run` で止まる） |

読むだけのもの: `scripts/delivery-ledger-check.js`・`scripts/check_google_auth.js`・`scripts/check-member-display.js`・`scripts/check-schema-sync.sh`。

## 8. migration は「開発DB → 本番」の順に当てる

[db-migration-workflow.md](db-migration-workflow.md) の流れの前に、開発DBで 1 回通す。

1. `migrations/YYYY-MM-DD_<topic>.sql` を書き、`supabase_schema.sql` にも同じ定義を足す（新テーブルは同じファイルで RLS 有効化・ADR 048）
2. **開発用** Supabase の SQL Editor で migration を流す（または開発の `.env` のまま `npm run dev` で起動 → schema-sync が `supabase_schema.sql` を開発DBへ流す）
3. 開発DBのダミーデータで画面・API を確認
4. PR を作る（`needs-db-migration` が付く）
5. **本番** Supabase の SQL Editor で同じ migration を流す → `db-migration-applied` ラベル → マージ

開発DBの形が本番とずれてきたら、手順 3〜5 をやり直す（`--reset` で作り直し → ダミー投入）。

## うっかり本番を向いたら

起動ログにこう出る（止まりはしない）:

```
!!  ⚠️  警告: ローカル（NODE_ENV≠production）なのに「本番DB」に接続しています
!!  本番を向いている変数: SUPABASE_URL, DATABASE_URL
```

`.env` を開発の値に戻して起動し直す。調査で本番を読むつもりなら手順 7 のやり方に切り替える。
