# HARUKA FILM SYSTEM - メイン（統合・リリース用）

## このフォルダの役割
- **branch**: `main`
- **用途**: 指示・相談・マージ専用
- コードの直接編集はここでは行わない

## 並行開発の構成
| フォルダ | branch | 担当機能 | 責任範囲 |
|---|---|---|---|
| `haruka_film_system/` | main | 統合・リリース（このフォルダ） | マージ・リリース |
| `haruka-projects/` | feature/projects | 案件画面 | 案件ロジック全般（DB含む） |
| `haruka-clients/` | feature/clients | クライアント画面 | クライアントロジック |
| `haruka-teams/` | feature/teams | チーム・メンバー画面 | チーム・メンバー |
| `haruka-creatives/` | feature/creatives | クリエイティブ画面 | クリエイティブ |
| `haruka-invoices/` | feature/invoices | 請求画面 | 請求 |
| `haruka-pc/` | feature/pc | PC版共有ロジック | 共有JS/HTML/サーバー |
| `haruka-mobile/` | feature/mobile または claude/mobile-* | スマホ版UI | `@media` CSS + スマホ専用HTML |

## 開発の進め方ルール（必ず守ること）

### 原則
- ユーザーから開発依頼が来たら、**機能単位に分解してサブエージェントに並行で振る**
- 各エージェントは対応する worktree フォルダで作業させる
- 複数機能にまたがる場合は **複数エージェントを同時起動**（`run_in_background: true`）
- 全エージェント完了後、**PRを作成してレビュー → squash merge**（main直pushは禁止）

### タスク振り分けの基準
| 依頼内容 | 担当branch |
|---|---|
| 案件・レギュレーション関連 | feature/projects |
| クライアント関連 | feature/clients |
| チーム・メンバー・Slack関連 | feature/teams |
| クリエイティブ・バージョン管理 | feature/creatives |
| 請求・インボイス関連 | feature/invoices |
| スマホUI（レスポンシブ） | feature/mobile |
| PC版共有ロジック・サーバー | feature/pc |

## スマホチャット（mobile）の実装範囲（厳密）

### ✅ 触ってOK
- `@media (max-width:768px)` 配下のCSS
- スマホ専用ドロワー内のHTML（`.nav-drawer-*`）
- スマホ専用ページ（`login.html`, `invite.html`等のモバイル用CSSブロック）
- PWA関連（`manifest.json`, `service-worker.js`, `apple-touch-*`メタタグ）

### ❌ 触らない（＝PCチャット・機能chat管轄）
- 共有JS関数（`render*`, `load*`, API呼び出し等）
- 共有HTML構造（ページ本体、モーダル本体）
- サーバー（`server.js`, `routes/`, `auth.js`等）
- DB（`supabase_schema.sql`, migration）
- 依存関係（`package.json`）

### 範囲外の要望が来たら（mobileチャットの手順）
1. **実装しない**
2. **GitHub Issue を作成**（タイトル・本文・ラベル・影響範囲を明記）
3. 担当チャットを指定（scope ラベルで示唆）
4. ユーザーに「Issue #N を〇〇チャットに渡してください」と伝える

## GitHub ラベル体系

| ラベル | 意味 | 担当 |
|---|---|---|
| `scope:mobile-only` | @media CSS + スマホ専用HTMLのみ | mobileチャット |
| `scope:shared-ui` | 共有JS/HTML | PCチャット |
| `scope:backend` | サーバー/DB | PCチャット or 機能chat |
| `scope:feature-projects` | 案件機能 | projectsチャット |
| `scope:feature-clients` | クライアント機能 | clientsチャット |
| `scope:feature-teams` | チーム機能 | teamsチャット |
| `scope:feature-creatives` | クリエイティブ機能 | creativesチャット |
| `scope:feature-invoices` | 請求機能 | invoicesチャット |
| `type:bug` | バグ修正 | 発見者→担当 |
| `type:feature` | 新機能 | ユーザー判断 |
| `type:improvement` | 既存改善 | ユーザー判断 |
| `type:refactor` | リファクタ | 担当chat |
| `needs-spec` | 仕様未確定（議論が必要） | ユーザー |
| `needs-review` | レビュー待ち | 関係chat |
| `blocked` | 他Issueに依存 | - |

## ブランチ命名規約
```
claude/mobile-<短い説明>    = mobileチャット作業用
claude/pc-<短い説明>        = PCチャット作業用
claude/shared-<短い説明>    = 両方に影響（両chatレビュー必須）
claude/feat-<機能>-<説明>  = 機能別chat作業用（例: claude/feat-projects-regulation）
```

## PR ルール
- **mainへの直pushは禁止**（ブランチ保護設定を推奨）
- すべて PR 経由でマージ
- **Squash and merge** を標準とする（履歴がキレイになる）
- PR テンプレート（`.github/pull_request_template.md`）に従って記述
- **影響範囲（mobile/PC/両方）を必ず記載**
- 両方に影響する PR は関連chatのレビューを受ける

## マージ手順（旧・参考）
```bash
# 全エージェント完了後、PR経由でマージするのが原則
# 緊急時のローカルマージ手順（非推奨）:
git merge feature/creatives
git merge feature/projects
git merge feature/teams
```

## 新しい機能単位を追加するとき
```bash
git worktree add ../haruka-{機能名} -b feature/{機能名}
```
→ 新フォルダに CLAUDE.md を作成して担当機能を明記する

## リリース・デプロイ
- Railway が `main` ブランチを自動デプロイ
- PR マージ = 本番デプロイ（数分後に反映）
- 本番反映前に確認したい場合は Railway PR Preview を有効化
