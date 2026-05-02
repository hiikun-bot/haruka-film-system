# エラー報告機能

利用者が画面右下の 🐛 ボタンを押すと、現在画面のスクリーンショットと直近のエラー / 失敗API、ユーザーコメントが Slack の専用チャンネルに送信される機能。

## 仕組み（概要）

```
[ユーザー] 🐛ボタン
   │
   ▼
[ブラウザ] html2canvas で画面キャプチャ
           + window.__errorBuffer / __apiFailBuffer
           + URL / UserAgent / 画面サイズ / current user
   │  multipart/form-data
   ▼
[POST /api/haruka/error-report] (requireAuth, 10秒レート制限)
   │
   ▼
[notifications.sendSlackChannelWithFile]
   1) files.getUploadURLExternal
   2) upload_url へ raw POST
   3) files.completeUploadExternal (initial_comment にメタ情報)
   │
   ▼
[Slack 専用チャンネル] へ画像付き投稿
```

## Slack チャンネル作成手順

1. Slack で専用チャンネルを作る（例: `#haruka-error-reports`、プライベート推奨）
2. 既存の HARUKA Slack 連携で使っている bot をそのチャンネルに招待する
3. ブラウザで対象チャンネルを開き、URL（`https://app.slack.com/client/Txxx/Cxxx`）をコピー

## Railway 環境変数

```
ERROR_REPORT_SLACK_CHANNEL_URL=https://app.slack.com/client/Txxx/Cxxx
```

未設定の場合、`POST /api/haruka/error-report` は 503 を返す（フロントはトーストで表示）。

## Bot スコープ要件

Slack files V2 API（2025-03 以降の新方式）を使うため、bot に下記スコープが必要:

- `files:write` ← ファイルアップロード必須
- `chat:write` ← `initial_comment` 付き投稿に必要

`slack_workspaces.bot_token` から bot トークンを引いて使うため、既存の HARUKA Slack 連携 bot のスコープを確認・追加してください。スコープ追加後は再 install が必要。

## 動作仕様

- 認証必須（匿名は 401）
- 同一ユーザーから 10 秒以内の連投は 429（メモリ上の Map で抑制）
- 画像は 8MB まで（multer memoryStorage）
- `initial_comment` は 3500 字で truncate
- スクリーンショット取得失敗時はテキストのみで送信
- ログイン画面（login.html）には 🐛 ボタンは出ない（haruka.html 認証後のみ表示）

---

# 自動エラー通知（auto-error）

ユーザー操作不要で「サーバ側 5xx / uncaughtException / unhandledRejection / フロント
window.onerror / unhandledrejection / fetch 5xx」を Slack に自動投稿する仕組み。
手動の 🐛FAB と並行して動く（無効化したい場合は環境変数を未設定にする）。

## 仕組み

```
[サーバ]
  Express middleware (5xx)         ─┐
  process.uncaughtException        ─┼─▶ notifications.notifyAutoError ─▶ Slack
  process.unhandledRejection       ─┘                ▲
                                                     │ (HTTP)
[ブラウザ haruka.html]                               │
  window.onerror / unhandledrejection ─┐             │
  apiFetch の res.status >= 500       ─┼─▶ POST /api/haruka/auto-error
                                       └─ keepalive: true で fire&forget
```

- 送信先は **手動エラー報告と同じ** `ERROR_REPORT_SLACK_CHANNEL_URL`
- メモリ内 Map で signature（kind+message先頭200字+url）を **5 分** dedupe
- フロント側でも同 signature を **30 秒** dedupe（無限ループ・暴走防止）
- 環境変数未設定なら完全 no-op（CI / 開発で誤発火しない）
- フロントは `localhost` / `127.0.0.1` / `0.0.0.0` でも自動的に無効化

## エンドポイント

`POST /api/haruka/auto-error`

- 認証不要（未ログイン時のエラーも拾うため）
- 同一 IP 10 秒で 5 回までのレート制限
- body 例:
  ```json
  {
    "source": "client",
    "kind": "window.onerror",
    "message": "Cannot read properties of undefined ...",
    "stack": "TypeError: ...",
    "url": "https://example.com/haruka.html",
    "userAgent": "Mozilla/5.0 ...",
    "statusCode": null,
    "apiPath": null,
    "userEmail": "user@example.com"
  }
  ```
- レスポンス:
  - `{ ok: true }` 送信成功
  - `{ ok: true, skipped: 'no-channel' }` ENV 未設定（**503 ではなく 200**＝フロント再送防止）
  - `{ ok: true, skipped: 'rate-limited' }` 5 分 dedupe に該当
  - `{ ok: true, skipped: 'rate-limited-ip' }` IP レート制限

## 手動 🐛FAB との違い

| 観点 | 手動 (🐛FAB) | 自動 (auto-error) |
|---|---|---|
| 起動 | ユーザー操作 | エラー発生時に勝手に飛ぶ |
| 認証 | 必須 | 不要（IP レート制限あり） |
| エンドポイント | `/api/haruka/error-report` | `/api/haruka/auto-error` |
| スクショ | あり（multipart） | なし（JSON のみ） |
| ユーザーコメント | あり | なし |
| dedupe | 同一ユーザー 10 秒 | signature 5 分（サーバ）+ 30 秒（フロント）|
| 用途 | 「変な動きをしたので報告したい」 | 例外の即時検知 |

## 無効化方法

`ERROR_REPORT_SLACK_CHANNEL_URL` を環境変数から削除（または未設定にする）。
手動・自動どちらも完全に no-op になる。

## デバッグ手順

### 1. 環境変数の確認
```
echo $ERROR_REPORT_SLACK_CHANNEL_URL
```
未設定なら `{ skipped: 'no-channel' }` が返る。

### 2. ヘルパ単体テスト（ローカル）
```bash
node -e "require('./notifications').notifyAutoError({ source:'server', kind:'manual-test', message:'test from CLI', url:'http://test' }).then(console.log)"
```

### 3. サーバ 500 のテスト
一時的に下記を `server.js` に追加して挙動確認後、必ず削除する:
```js
app.get('/__test_500', () => { throw new Error('intentional test 500'); });
```
GET でアクセスすると Slack に `🚨 サーバーエラー（自動）` が飛ぶ。

### 4. フロント例外のテスト
ブラウザの DevTools コンソールで:
```js
setTimeout(() => { throw new Error('frontend auto-error test'); }, 100);
```
`⚠️ フロントエラー（自動）` が Slack に届く。

### 5. ログ
- サーバ: `[notif/auto-error] slack send failed: ...` を `console.warn` で出力
- フロント: `fetch('/api/haruka/auto-error')` 失敗は黙殺（DevTools Network で確認）

## 注意点

- **ログ汚染防止**: dedupe を入れているが、同じバグが連発する場合 5 分待ち
  → 直すまで Slack に来ないので、解消後はチャンネルを確認してから ENV を入れ直し
- **PII**: スタックや URL に個人情報が混じる可能性あり。チャンネルは関係者のみに
- **無限ループ防止**: `/api/haruka/auto-error` 自身が出すエラーは fetch 失敗を黙殺＋
  `apiPath` フィルタで再帰送信を抑止
