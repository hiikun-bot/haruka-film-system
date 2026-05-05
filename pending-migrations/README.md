# pending-migrations

PR でまだ merge されていない migration SQL を、本番 Supabase へ手動適用するために一時保管する場所。

## ファイル命名規約

```
pr-<PR番号>_<branchHead短縮SHA>_<内容>.sql
```

例: `pr-287_5754d04_milestone_templates.sql`

- 短縮SHA があるので、PR ブランチが更新されたら一目で古いと判別できる
- 古い SHA を見つけたら最新版に取り直す

## 運用フロー

1. PR がopenされたら、Claude が最新ブランチの SQL をここに置く
2. ユーザーが Supabase SQL Editor で実行
3. PR に `db-migration-applied` ラベルを付与
4. PR が merge されたら、対応ファイルを `pending-migrations/` から削除

## 注意

- このフォルダ配下のSQLファイルは `.gitignore` で除外済み（誤コミット防止）
- README.md だけは git 管理対象
- `migrations/` （本物）と混同しないこと
- PR ブランチが force-push されると SQL 内容が変わる可能性 → 適用直前に SHA 確認すること
