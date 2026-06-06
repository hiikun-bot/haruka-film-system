# 設計ドキュメント・ハブ

このディレクトリは **haruka_film_system のドメイン設計思想・意思決定の単一の正** です。

## なぜこのフォルダがあるか

複数のスレッド（Claude Code の会話セッション）や複数の worker chat で並行開発しているため、**設計レベルの判断が場所ごとにバラつく** 問題が頻発していた。

- A スレッドで「商品テーブルは削除予定」と決めた
- B スレッドで「商品テーブルはファイル名生成に必須なので残す」と決めた
- 両方が PR を出して矛盾する

→ これを防ぐため、**設計レベルの決定は必ずこのフォルダに書く**。

## 運用ルール（全 worker chat 必読）

### 1. 実装前に読むもの

機能実装に入る前、以下の順で確認：

1. [philosophy.md](philosophy.md) — 共通の設計原則
2. [decisions/](decisions/) — 確定済みの設計判断（ADR）
3. [open-questions.md](open-questions.md) — 進行中・未決の議題
4. プロジェクトルートの [CLAUDE.md](../../CLAUDE.md) — 主要既存機能の地図

### 2. 設計議論の結果は必ずここに残す

スレッドで設計レベルの判断をしたら、**memory には書かず docs/design/ に追記する**。
- 確定: `decisions/NNN-<topic>.md` を新規作成（ADR 形式）
- 進行中: `open-questions.md` に追記
- 撤回・更新: 該当ファイルを編集（履歴は git に任せる）

memory はあくまで「Claude 個人の作業メモ」、docs は「プロジェクトの公式記録」。

### 3. 矛盾を発見したら止める

実装中に「設計ドキュメントと CLAUDE.md が矛盾」「2つの decision が矛盾」を見つけたら、**実装を止めてユーザーに報告**。勝手に解釈で進めない。

### 4. ADR の書き方

`decisions/NNN-<short-name>.md` の形式：

```markdown
# NNN. <タイトル>

- **Status**: Accepted | Superseded by NNN | Deprecated
- **Date**: YYYY-MM-DD
- **Decided by**: ユーザー / 関連スレッド要約

## Context（なぜこの判断が必要だったか）
## Decision（何を決めたか）
## Consequences（何が解決し／何が残るか）
## Alternatives considered（他に検討した案）
```

NNN は連番（`001`, `002`, ...）。

## インデックス

### 確定済み判断（decisions/）
| ADR | タイトル | tags |
|---|---|---|
| [001](decisions/001-creative-first-product-appeal.md) | 商品・訴求軸は creative-first 設計で残す | products, appeal_axes, creative, filename |
| [002](decisions/002-estimate-lines-unify-deliverable-rates.md) | 見積明細を deliverable と rates の統合単位にする | deliverable, rates, estimate, billing, profit |
| [003](decisions/003-roles-as-master-data.md) | ロールはマスタテーブルで管理する | roles, master-data, permissions, user-roles |
| [004](decisions/004-pricing-extensibility.md) | 単価の拡張性（通貨・課金タイプ）を最初から確保する | pricing, currency, billing, extensibility |
| [005](decisions/005-estimate-deliverable-lifecycle.md) | 見積もりと deliverable のライフサイクル分離 | estimate, lifecycle, status, contract |
| [006](decisions/006-project-fixed-costs.md) | 案件レベルの固定費・固定収入を別表現で持つ | fixed-cost, expense, billing, project |
| [010](decisions/010-project-schedule-tasks.md) | 案件スケジュール / フェーズ・タスク管理（LP・HP 等カテゴリ横断） | projects, schedule, tasks, gantt, lp, hp |
| [016](decisions/016-project-work-type-and-ball-state.md) | 案件業務管理：業務種別（制作/保守）とボール状態モデル | projects, schedule, work-type, ball-state, lp, hp, maintenance |
| [022](decisions/022-estimate-line-rank.md) | 成果物グループ（見積明細）にランクを第一級の列として持たせる | pricing, rank, estimate, payout, editor |

### 共通参照
- [philosophy.md](philosophy.md) — 共通設計原則
- [glossary.md](glossary.md) — 用語集
- [lifecycle.md](lifecycle.md) — ADR の Status 遷移・migration 連携・レビュー期限ルール
- [open-questions.md](open-questions.md) — 進行中・未決の議題

## ADR の検索

特定の領域に関する ADR を pinpoint で見つけるには frontmatter tags を grep：
```bash
grep -l "tags:.*rates" docs/design/decisions/
grep -l "related_tables:.*creatives" docs/design/decisions/
```
