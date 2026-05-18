# 大容量 D&D（Resumable Upload）の OAuth セットアップ手順

素材スクエア（素材広場）の大容量（>=500MB）D&D アップロードは、
ブラウザから Google Drive へ **直接** Resumable Upload する経路を使う。
そのために **ユーザーOAuth** トークン（`drive.file` スコープ）が必要。

サーバーサイドの Drive 操作（プレビュー / register / analyze 等）は引き続きサービスアカウントを使う。
このユーザーOAuthは「ブラウザ→Drive 直送」専用。

## 全体像

```
[ ブラウザ ]                                  [ サーバー ]              [ Google Drive ]
   │                                             │                          │
   │ 1. /oauth/google/start                      │                          │
   │────────────────────────────────────────────▶│                          │
   │   ←── 302 → Google 同意画面                 │                          │
   │ 2. ユーザー「許可」                          │                          │
   │   ←── 302 → /oauth/google/callback?code=…  │                          │
   │                                             │ 3. code → tokens         │
   │                                             │──────────────────────────▶
   │                                             │ refresh_token 保存       │
   │                                             │                          │
   │ 4. D&D 開始 / >=500MB なら                   │                          │
   │   POST /upload-session/init                 │                          │
   │────────────────────────────────────────────▶│                          │
   │                                             │ access_token で          │
   │                                             │ Resumable セッション発行 │
   │                                             │──────────────────────────▶
   │                                             │  ←── Location: …         │
   │   ←── { driveSessionUrl }                   │                          │
   │                                             │                          │
   │ 5. driveSessionUrl に 256MB チャンクを PUT  │                          │
   │   ────────────────────────────────────────────────────────────────────▶│
   │                                             │                          │
   │ 6. 最終チャンク 200 → fileId 取得           │                          │
   │ POST /upload-session/:id/complete           │                          │
   │────────────────────────────────────────────▶│                          │
   │                                             │ DB INSERT (waiting_…)   │
   │   ←── { item: ... }                         │                          │
```

## 前提

- 株式会社HARUKAFILMの Google Workspace を運用中（`@haruka-film.com` 等）
- OAuth 同意画面の User Type を **Internal** に設定するため、審査・検証は不要
- スコープは `drive.file` のみ（非機密スコープ）

## セットアップ手順

### 1. Google Cloud Console でプロジェクトを準備

既存の HARUKA 用 GCP プロジェクト（Vertex AI / Drive サービスアカウントを使っている所）と
共用して構わない。新規プロジェクトを作る場合は以下:

1. https://console.cloud.google.com にログイン（HARUKAFILM Workspace アカウントで）
2. 上部のプロジェクトセレクタ → 「新しいプロジェクト」
3. プロジェクト名: `haruka-resumable-upload`（任意）
4. 組織: `haruka-film.com`（または既存のWorkspace組織）

### 2. Drive API を有効化

1. 左メニュー「APIとサービス」→「ライブラリ」
2. 「Google Drive API」を検索 → 有効化
   - サービスアカウントの利用と同様だが、念のため必ず有効か確認

### 3. OAuth 同意画面の設定

1. 左メニュー「APIとサービス」→「OAuth 同意画面」
2. **User Type = Internal** を選択（重要・これにより審査不要）
   - Internal にすると、`@haruka-film.com` ドメインの社内ユーザーのみが同意できる
3. 必須項目を埋める:
   - アプリ名: `HARUKA FILM SYSTEM`
   - ユーザーサポートメール: `hiikun.ascs@gmail.com` 等
   - デベロッパー連絡先情報: 同上
4. スコープ追加:
   - 「スコープを追加または削除」
   - フィルタで `drive.file` を検索
   - `.../auth/drive.file`（"See, edit, create, and delete only the specific Google Drive files you use with this app"）を選択
   - 保存
5. テストユーザーは Internal なら追加不要

### 4. OAuth 2.0 クライアントID を発行

1. 左メニュー「APIとサービス」→「認証情報」
2. 「認証情報を作成」→「OAuth クライアント ID」
3. アプリケーションの種類: **ウェブアプリケーション**
4. 名前: `HARUKA FILM SYSTEM (production)` 等
5. 承認済みの JavaScript 生成元:
   - `https://haruka-film-system-production.up.railway.app`
   - （ローカル動作確認するなら `http://localhost:3000` も追加）
6. 承認済みのリダイレクト URI:
   - `https://haruka-film-system-production.up.railway.app/oauth/google/callback`
   - （ローカルなら `http://localhost:3000/oauth/google/callback` も追加）
7. 作成 → クライアントID と クライアントシークレットが表示される

### 5. Railway 環境変数の設定

Railway プロジェクト → Variables に以下を追加:

```
GOOGLE_OAUTH_CLIENT_ID=<取得したクライアントID>
GOOGLE_OAUTH_CLIENT_SECRET=<取得したクライアントシークレット>
GOOGLE_OAUTH_REDIRECT_URI=https://haruka-film-system-production.up.railway.app/oauth/google/callback
```

機能の最終有効化フラグ:

```
ENABLE_RESUMABLE_UPLOAD=true
```

> ⚠️ `ENABLE_RESUMABLE_UPLOAD` は **検証完了まで false（既定）のまま**。
> 切替えは別ターンで明示的に実行する。

### 6. （重要）アップロード先 Drive フォルダ

`drive.file` スコープでブラウザがアップロードしたファイルは **ユーザー本人が所有者** になる。
サーバーサイド（サービスアカウント）はそのままでは見えない。

**推奨**: アップロード先（`VIDEO_ORG_UPLOAD_FOLDER_ID`）を **共有ドライブ** にして、

- サービスアカウントを共有ドライブのメンバーに追加（「投稿者」以上）
- 社内ユーザーも共有ドライブのメンバー（最低「投稿者」）にする

ことで、ユーザーOAuthでアップロードしたファイルが共有ドライブ上にあるため、サービスアカウントもそのまま参照できる。

すでに `VIDEO_ORG_UPLOAD_FOLDER_ID` がマイドライブ上のフォルダの場合は、共有ドライブに移行する必要がある。

### 7. 動作確認手順

1. Railway 環境変数を保存 → 自動再デプロイを待つ
2. https://haruka-film-system-production.up.railway.app/haruka.html にログイン（admin）
3. 「素材広場」→「新規追加」を開く
4. 500MB 未満のファイルを D&D：従来通り `/upload` 経路（変化なし）で完了することを確認
5. 500MB 以上のファイルを D&D：
   - 初回は「Drive と連携しますか？」のダイアログ → 同意画面 → 戻る
   - 再度 D&D → 進捗バーが少しずつ伸び、完了
6. 一覧に登録され、プレビューが再生されること（faststart 生成済みまで待つ）

トラブルシュート:

- 同意画面で `アプリは確認されていません` と出る → User Type が Internal になっていない可能性。再確認
- 連携後も 401 が出る → `GOOGLE_OAUTH_REDIRECT_URI` の値が GCP コンソールの登録値と完全一致しているか
- complete 後に Drive メタ取得が失敗する → アップロード先がマイドライブで SA から見えていない可能性。共有ドライブに変更

### 8. 連携解除（テスト用）

ユーザー個人のセッションから連携を切りたいとき:

```bash
curl -X POST https://haruka-film-system-production.up.railway.app/oauth/google/disconnect \
  -H "Cookie: <session cookie>"
```

または Google アカウント側で「サードパーティアプリ」から HARUKA FILM SYSTEM を削除。

## 関連ファイル

- 実装: `routes/oauth.js`, `lib/google-oauth.js`
- 大容量アップロード: `routes/video-organization-test.js` `/upload-session/*`
- フロント: `public/haruka.html` の `msUploadResumable()`
- DB: `migrations/2026-05-18b_user_oauth_tokens.sql`, `migrations/2026-05-18_msquare_preview_and_upload_sessions.sql`
