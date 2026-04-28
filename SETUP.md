# セットアップガイド

このシステムを自分のチームで使うための手順です。
**費用はすべて各チームで負担してください。**

---

## 必要なアカウント

- GitHub アカウント
- Supabase アカウント（https://supabase.com）
- Google Cloud アカウント（Google Drive連携用）
- Railway アカウント（https://railway.app）

---

## Step 1：リポジトリをFork（コードをコピー）

1. GitHubで元のリポジトリを開く
2. 右上の「Fork」ボタンをクリック
3. 自分のアカウントにコピーされる

---

## Step 2：Supabase プロジェクト作成

1. https://supabase.com でサインアップ
2. 「New Project」でプロジェクト作成
3. Project Settings → API から以下をメモ：
   - `Project URL`
   - `anon public` キー
   - `service_role` キー
4. Project Settings → Database → Connection string から **Transaction pooler** または **Session pooler** のURLをメモ
   - 例: `postgres://postgres.xxxxxxxx:[PASSWORD]@aws-0-ap-northeast-1.pooler.supabase.com:6543/postgres`
   - `[PASSWORD]` は実際のパスワードに置換しておく
   - 後述の `DATABASE_URL` に設定すると、初回起動時に `supabase_schema.sql` が自動適用されます
   - 手動で SQL Editor に貼り付ける作業は **不要** になりました
   - 自動同期を行わない場合のみ、`supabase_schema.sql` の内容を SQL Editor に貼り付けて実行してください

---

## Step 3：Google Drive セットアップ

1. https://console.cloud.google.com でプロジェクト作成
2. 「Google Drive API」を有効化
3. 「サービスアカウント」を作成 → JSONキーをダウンロード
4. Google Drive でフォルダを作成
5. そのフォルダをサービスアカウントのメールと共有（編集者権限）
6. フォルダのURLからIDをメモ：
   `https://drive.google.com/drive/folders/【このID部分】`

---

## Step 4：Railway にデプロイ

1. https://railway.app でサインアップ
2. 「New Project」→「Deploy from GitHub repo」
3. Forkしたリポジトリを選択
4. 「Variables」タブで環境変数を設定（`.env.example` 参照）：

```
WORKSPACE_NUMBER    = 1（あなたのチームの番号）
WORKSPACE_NAME      = YOUR TEAM NAME
WORKSPACE_SLUG      = your-team-name
WORKSPACE_OWNER_EMAIL = owner@example.com
PRIMARY_COLOR       = #3ECFCA（ブランドカラー）

SUPABASE_URL        = （Step2のURL）
SUPABASE_ANON_KEY   = （Step2のanon key）
SUPABASE_SERVICE_ROLE_KEY = （Step2のservice_role key）
DATABASE_URL        = （Step2のConnection string / Transaction or Session pooler）

GOOGLE_SERVICE_ACCOUNT_KEY = （Step3のJSONを1行に）
GOOGLE_DRIVE_ROOT_FOLDER_ID = （Step3のフォルダID）

SESSION_SECRET      = （任意のランダム文字列）
APP_URL             = （RailwayのデプロイURL）
```

> **自動スキーマ同期について**
> `DATABASE_URL` を設定すると、デプロイ・再起動のたびに `supabase_schema.sql` が自動適用されます。
> スキーマ変更を反映するための手動コピペ作業は不要です（idempotent なので何度実行してもOK）。
> 自動同期を停止したい場合は `SCHEMA_AUTO_SYNC=false` を環境変数に追加してください。

5. デプロイ完了 → 発行されたURLにアクセス

---

## Step 5：初期ユーザー作成

1. システムにアクセス → ログイン画面が表示される
2. Supabase の SQL Editor で管理者ユーザーを直接INSERT：

```sql
INSERT INTO users (email, full_name, role, password_hash, is_active)
VALUES (
  'admin@example.com',
  '管理者名',
  'admin',
  -- bcryptハッシュ（Node.jsで生成: bcrypt.hashSync('password', 10)）
  '$2a$10$xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
  true
);
```

---

## 費用目安（月額）

| サービス | 目安 |
|---|---|
| Railway | $5〜20/月 |
| Supabase | 無料〜$25/月 |
| Google Drive | 無料〜 |

---

## 注意事項

- このシステムは自己責任でご利用ください
- 元のリポジトリの更新は自動で届きません（手動でsyncが必要）
- サポートは保証されません
