# HARUKA FILM SYSTEM - メイン（統合・リリース用）

## このフォルダの役割
- **branch**: `main`
- **用途**: 指示・相談・マージ専用
- コードの直接編集はここでは行わない

## 並行開発の構成
| フォルダ | branch | 担当機能 |
|---|---|---|
| `haruka_film_system/` | main | 統合・リリース（このフォルダ） |
| `haruka-projects/` | feature/projects | 案件画面 |
| `haruka-clients/` | feature/clients | クライアント画面 |
| `haruka-teams/` | feature/teams | チーム・メンバー画面 |
| `haruka-creatives/` | feature/creatives | クリエイティブ画面 |
| `haruka-invoices/` | feature/invoices | 請求画面 |

## 開発の進め方ルール（必ず守ること）

### 原則
- ユーザーから開発依頼が来たら、**機能単位に分解してサブエージェントに並行で振る**
- 各エージェントは対応する worktree フォルダで作業させる
- 複数機能にまたがる場合は **複数エージェントを同時起動**（`run_in_background: true`）
- 全エージェント完了後、mainにまとめてマージする

### タスク振り分けの基準
| 依頼内容 | 担当branch |
|---|---|
| 案件・レギュレーション関連 | feature/projects |
| クライアント関連 | feature/clients |
| チーム・メンバー・Slack関連 | feature/teams |
| クリエイティブ・バージョン管理 | feature/creatives |
| 請求・インボイス関連 | feature/invoices |

### エージェント起動テンプレート
```
作業ディレクトリ: /Users/takahashi_satoru/Documents/40.プログラミング/haruka-{機能名}/
run_in_background: true
完了後: git commit
```

### マージ手順（全エージェント完了後）
```bash
git merge feature/creatives
git merge feature/projects
git merge feature/teams
```

## 新しい機能単位を追加するとき
```bash
git worktree add ../haruka-{機能名} -b feature/{機能名}
```
→ 新フォルダに CLAUDE.md を作成して担当機能を明記する
