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
