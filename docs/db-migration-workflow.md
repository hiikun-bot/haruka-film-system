# DB Migration ワークフロー

Railway は `main` のコードを自動デプロイしますが、**Supabase の DB migration は自動適用されません**。
過去に `estimate_number` / `project_type` / `client_deletion_logs` などで本番エラーが連発したため、
PR ベースで「適用したか？」を強制するフローを整備しています。

## 全体像

```
migration を含む PR を open
        │
        ▼
.github/workflows/migration-reminder.yml が走る
  - migrations/** または supabase_schema.sql の変更を検知
  - PR に警告コメントを投稿（marker で重複防止）
  - needs-db-migration ラベルを自動付与
        │
        ▼
.github/workflows/migration-merge-guard.yml が走る
  - needs-db-migration あり & db-migration-applied なし → fail
  - これが required check に入っていれば auto-merge は止まる
        │
        ▼
人間: Supabase SQL Editor で migration を実行
        │
        ▼
人間: PR に db-migration-applied ラベルを付与
        │
        ▼
migration-merge-guard が pass → auto-merge / 通常マージOK
```

## migration を追加する側の手順（PR 作成者）

1. `migrations/YYYY-MM-DD_<topic>.sql` を作成
2. **同じ定義を `supabase_schema.sql` にも追記**（完成形を維持するため）
3. PR を作成 → CI が `needs-db-migration` ラベルを自動付与してくれる
4. （任意）`auto-merge` ラベルも付ける
5. Supabase SQL Editor で migration を流す
6. 流し終わったら **`db-migration-applied` ラベルを手動付与**
7. CI の `migration-applied` チェックが pass → マージされる

> `auto-merge` だけ付けて `db-migration-applied` を付け忘れても、
> `migration-applied` が fail するのでマージは進みません（安全装置）。

## レビュー側の手順

- `needs-db-migration` ラベルが付いている PR は **必ず Supabase で実行してから** ラベルを切り替える
- マージ後でもよいが、**マージ即デプロイなので未適用のままマージしないこと**

## 緊急ロールバック

- 適用後に問題があった場合は、`migrations/<同名>_down.sql` があればそれを実行
- 無い場合は手動で `ALTER TABLE ... DROP COLUMN` 等で戻す

## Phase 2 (将来検討)

- Railway の release command で `supabase migration up` を走らせて自動適用する案あり
- ただし migration の冪等性担保や Service Role key の運用設計が必要なため、現状は人間運用

## 関連ファイル

- `.github/workflows/migration-reminder.yml` — PR にコメント＆ラベル付与
- `.github/workflows/migration-merge-guard.yml` — `migration-applied` チェック
- `scripts/check-schema-sync.sh` — `migrations/` と `supabase_schema.sql` の整合チェック（参考情報）
- `migrations/` — 差分 SQL の置き場
- `supabase_schema.sql` — 完成形のスキーマ
