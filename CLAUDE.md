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

## 主要既存機能の地図（実装前の必読チェック）

新機能依頼が来たら、設計書を読む**前に**この表で「同名/類似機能の既存実装」を確認する。
重複・競合があれば「設計書通りの新規実装」「既存拡張」「設計書修正」のどれで進めるかをまずユーザーに提示する。

| 領域 | 主要テーブル | バックエンド | フロント | 補足 |
|---|---|---|---|---|
| 社内SNS（つぶやき） | `tweets` / `tweet_likes` / `tweet_reactions` / `tweet_comments` | `routes/haruka.js` の `/api/tweets/*` | `public/haruka.html` の **独立タブ `#page-tweets`** + `loadTweetsPage()` + 投稿モーダル `modal-tweet-compose` | リベシティ風タイムライン（PR #209）。ダッシュボード内 `dash-tweets` は廃止 |
| 全体連絡（旧版） | `announcements` / `announcement_acks` | `routes/haruka.js` | `public/haruka.html` の `modal-announcement-status` | 既読確認つきの全体周知。新通知系（`notification_logs`）と並走 |
| 通知（Phase 1） | `notification_logs` / `notification_settings` | `routes/notifications.js` + `utils/notification.js` | `public/js/notification-bell.js` / `notification-panel.js` / `notification-realtime.js` / `notification-card.js` | リベシティ風 5エンドポイント。Realtime購読あり |
| 通知（旧設計の遺物） | `posts` / `post_reactions` / `post_comments` | なし | なし | migration `2026-05-03_notification_phase1.sql` で作成されたが**未使用**。Phase 1 段階4 で `tweets` 拡張に方針変更したため塩漬け |
| クリエイティブ | `creatives` / `creative_assignments` / `creative_versions` | `routes/haruka.js` の `/api/creatives/*` | `public/haruka.html` クリエイティブタブ | `ball_holder_id` がボール保持者キャッシュ |
| 案件 | `projects` / `project_director_rates` / `project_producer_rates` / `project_deletion_logs` | `routes/haruka.js` | `public/haruka.html` 案件タブ | 単価モーダルにディレクター/プロデューサー費セクションあり |
| クライアント・商材 | `clients` / `products` / `appeal_axes` | `routes/haruka.js` | `public/haruka.html` クライアントタブ・商材マスター画面 | |
| メンバー | `users` / `user_stats` / `teams` / `team_members` | `routes/haruka.js` | `public/haruka.html` メンバータブ | `users.role` で admin/secretary/producer/producer_director/director/editor/designer |
| 請求 | `invoices` / `client_invoices` | `routes/haruka.js` の `/api/invoices/*` `/api/client-invoice/*` | `public/haruka.html` 請求タブ | `migrations/2026-04-28_invoice_items_step1.sql` 進行中 |
| 自動エラー通知 | - | `routes/haruka.js` の `/api/error-report` | `public/js/auto-error-report.js` | 500/uncaught/window.onerror を Slack 投稿（PR #197）|

**運用ルール**
- 「○○機能を追加して」と言われた瞬間、まず上表とコードベースを `grep` で確認する
- 設計書（`docs/notification/*.md` 等）を全文読み込むのは、既存重複が無いと確認できてから
- 上表に新領域を追加した PR を作るときは、この表も同 PR で更新する

---

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

### 自動マージ（auto-merge ラベル）
- PR に `auto-merge` ラベルを付与すると、CI 通過後に **自動で squash merge + ブランチ削除** されます（`.github/workflows/auto-merge.yml`）
- 仕組み: GitHub の Auto-merge 機能（`gh pr merge --squash --auto --delete-branch`）を有効化するだけで、即マージではない（CI が通るまで待つ）
- ブランチ保護でCI通過必須にしている場合、CIが通った瞬間にマージされる
- 解除したいときは `auto-merge` ラベルを外す、または `gh pr merge <PR> --disable-auto` で解除

### DB migration を含む PR（必読）
- `migrations/**` または `supabase_schema.sql` を変更する PR は、CI が **`needs-db-migration` ラベルを自動付与** します（`.github/workflows/migration-reminder.yml`）
- このラベルが付いている PR は、**本番Supabaseで適用 → `db-migration-applied` ラベルを手動付与** して初めて `migration-applied` チェックが pass します
- `auto-merge` を併用しても、`db-migration-applied` が無い限り auto-merge は止まります（安全装置）
- 適用手順・全体像: [`docs/db-migration-workflow.md`](docs/db-migration-workflow.md)

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
