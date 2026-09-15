---
adr: 040
status: Accepted
date: 2026-09-15
tags: [session, auth, railway, volume, deploy, zero-downtime, infra]
related_tables: [http_sessions]
supersedes: null
superseded_by: null
related_adrs: []
---

# 040. HTTP セッションストアを Supabase に移し、Railway Volume を外してゼロダウンタイムデプロイにする

- **Status**: Accepted（2026-09-15 ユーザー承諾「推奨のやり方で大丈夫です」）
- **Date**: 2026-09-15
- **Proposed by**: Claude（きっかけ: 2026-09-15 12:36 JST の自動フロントエラー通知）

## Context

### 事象
デプロイ直後に Railway エッジが 502 `Application failed to respond` を返す。
- 2026-09-15 12:36:41 JST `/api/haruka/onboarding`（PR #1169 マージ 12:35:47 の 54 秒後）
- 2026-08-22 08:35:15 JST `/creatives/:id` + `/rounds`（PR #1069 マージの 35 秒後）

フロント `apiFetch` には 502 の自動リトライ（GET は 700ms → 2000ms の 2 段）が入っているが、
無応答は約 13 秒続くため届かない。

### Railway ログ（2026-09-15, UTC）
| 時刻 | 出来事 |
|---|---|
| 03:35:49 | 新デプロイ作成（ビルド開始） |
| 03:36:36.5 | **旧コンテナ SIGTERM**（graceful shutdown → 新規接続受付停止） |
| 03:36:41 | 502 発生 |
| 03:36:46.9 | **新コンテナ Starting Container** |
| 03:36:49.7 | 新コンテナ listen 開始 |

旧の停止と新の起動が重なっていない。`railway.toml` の `healthcheckPath` はゼロダウンタイム切替用だが、
**Volume 付きサービスは Volume を同時に 1 コンテナしかマウントできない**ため、Railway は旧を止めてから
新を起動する（順次切替）。healthcheck はこの順序を変えない。

### Volume の中身
`/app/data`（5GB）に入っているのは `sessions.db`（120KB, connect-sqlite3）と 4 月以降更新のない `videoops.db`
だけ。つまり Volume の存在理由は express-session の SQLite ストア 1 点。
（Railway ダッシュボードの「3.4GB 使用」は既知のメトリクス誤表示。実使用 0.5MB）

## Decision

1. express-session のストアを **Supabase テーブル `http_sessions`** に移す（`lib/supabase-session-store.js`、supabase-js 経由）。
   - Postgres 直結は Railway から IPv6 `ENETUNREACH` で落ちる既知問題があるため、connect-pg-simple は使わない。
   - 既存の `supabase.js` クライアント（service_role・タイムアウト／サーキットブレーカー付き）を共用する。
2. `connect-sqlite3` と `DATA_DIR` / `./data` 依存を server.js から削除する。
3. コード PR がデプロイされてログインが確認できたら、Railway の Volume を切り離す（`DATA_DIR` 系の環境変数も不要）。
   以後は healthcheck 経由で旧新コンテナが重なる切替になり、デプロイ時の 502 が消える。

### ストアの実装方針（性能・整合）
- `get` は毎リクエスト呼ばれるため **プロセス内キャッシュ（TTL 60 秒）** を持つ。`set`/`destroy` は write-through で
  キャッシュも更新／削除する。キャッシュにはシリアライズ済み JSON を置き、返すときに parse する（参照共有による意図しない変更を防ぐ）。
- express-session は `resave:false` でも変更なしのリクエストごとに `touch` を呼ぶ。毎回 UPDATE すると
  1 画面で数十回の書込になるため、**sid ごとに 10 分に 1 回**だけ `expired_at` を書き戻す
  （Cookie maxAge 7 日に対し誤差 10 分は無視できる）。
- 失効行は 15 分周期のスイープで削除する（`idx_http_sessions_expired_at`）。
- Supabase 到達不能時は `get` がエラーになりリクエストは 500 になる。アプリのデータ自体が Supabase なので
  この状況では元々サービス不能であり、フォールバック（SQLite 併用）は持たない。

### 切替時の影響
- 既存の SQLite セッションは移行しない → **切替デプロイの直後に全員 1 回再ログイン**が必要（ユーザー承諾済み）。
- 切替中はコンテナが 1 台（Volume が残っている間は順次切替のまま）。Volume を外した次のデプロイから重なり切替になる。

## Alternatives considered
- **フロントのリトライ窓を 15 秒に広げる**: モーダルが 10 秒以上待たされる。根本は残る。
- **SIGTERM 後も数秒受付を続ける**: 旧コンテナが生きている約 9 秒分しか縮まらず、新起動までの隙間は残る。
- **connect-pg-simple（Postgres 直結）**: schema-sync と同じ IPv6 ENETUNREACH で不安定。
- **Cookie セッション（cookie-session）**: 署名付き Cookie に載せれば DB 不要だが、サーバー側で即時失効できず、
  passport との組合せも変わるため今回は見送り。

## Consequences
- Railway Volume（月額課金対象）が不要になる。
- セッションが DB に載るため、複数コンテナ／将来のスケールアウトにもそのまま対応。
- 監視: `http_sessions` の行数が増え続ける場合はスイープの失敗を疑う（起動ログ `[session-store]`）。

## Migration
- Stage 1: `migrations/2026-09-15_http_sessions.sql`（テーブル・索引・RLS）— この PR
- Stage 2: コード PR（`lib/supabase-session-store.js`、server.js、connect-sqlite3 削除）— Stage 1 適用後にマージ
- Stage 3: Railway Volume 切り離し（手動、Stage 2 のログイン確認後）
