# ADR ライフサイクル運用

長期運用で「過去の判断がなぜ存在するか」を失わないためのルール。

## ADR Status の意味と遷移

```
   ┌──────────┐
   │ Proposed │  下書き・議論中
   └────┬─────┘
        │ ユーザーが Decided by で承認
        ▼
   ┌──────────┐
   │ Accepted │  確定済み・実装の根拠
   └────┬─────┘
        │
        │ 別の ADR が方針を上書き
        ▼
   ┌────────────┐
   │ Superseded │  過去の判断、削除しない
   │   by NNN   │
   └────────────┘

   ┌────────────┐
   │ Deprecated │  廃止された方針（後継 ADR 無し）
   └────────────┘
```

## 重要な原則

### ❌ 古い ADR を削除しない
「もうこの判断は古い」と思っても **削除せず Status を更新するだけ**。
- 5年後に「なぜこのテーブルがあるのか」を追えるのは古い ADR があるおかげ
- git history では追えるが、検索性が大幅に落ちる

### ✅ 上書きする ADR は明示的にリンク

新 ADR を書くとき：
```yaml
---
adr: 015
status: Accepted
supersedes: 002    # 旧 ADR を上書きすることを明示
---
```

旧 ADR の frontmatter を更新：
```yaml
---
adr: 002
status: Superseded by 015
superseded_by: 015
---
```

両方向リンクが揃って初めて履歴が辿れる。

### ✅ 部分上書きは慎重に

「ADR 002 のうちロール定義の部分だけ ADR 003 で上書き」のような部分上書きは：
- ADR 003 の Context に「ADR 002 の何を上書きするか」を明記
- ADR 002 は Status を変えない（全体としてはまだ有効）が、該当セクションに「※ロール定義は ADR 003 で更新」と注釈

## レビュー期限

ADR は時間が経つと前提条件が変わる。**3年経った Accepted ADR は自動レビュー対象**。

### 仕組み（将来実装案）
```
GitHub Actions で月次実行:
  decisions/*.md の date を見て3年以上前のものに対して
  「ADR-NNN の現状有効性レビュー」issue を起票
```

## migration との連携

スキーマを変更する migration は対応する ADR を必ず参照する。

### migration 側
ファイル冒頭コメントに記載：
```sql
-- ADR-002: 見積明細を deliverable と rates の統合単位にする
-- このマイグレーションは ADR-002 の Stage 1 を実装する
```

### ADR 側
Consequences 末尾に実装履歴を追記：
```markdown
## 実装履歴
- 2026-05-15: Stage 1 適用 — `migrations/2026-05-15_estimate_lines.sql`
- 2026-05-22: Stage 2 適用 — `migrations/2026-05-22_estimate_lines_costs.sql`
```

## CI ガード（将来実装案）

スキーマ変更 PR には対応する ADR が無いとマージできない仕組み：
- `migrations/**` または `supabase_schema.sql` 変更を検知
- 同 PR 内に `docs/design/decisions/` の追加 or 既存 ADR の Consequences 末尾追記が無ければ警告
- migration-reminder.yml と同じパターンで実装可能

## ADR を書く前のチェックリスト

新 ADR を起こす前に確認：
- [ ] 既存 ADR で扱われていないか（[README.md](README.md) のインデックス）
- [ ] 既存 ADR の更新で済まないか（小さい変更なら追記）
- [ ] [philosophy.md](philosophy.md) と整合するか
- [ ] [glossary.md](glossary.md) に新用語があれば先に追加
- [ ] 影響範囲（DB, UI, API, 他 worker chat）を明示できるか
