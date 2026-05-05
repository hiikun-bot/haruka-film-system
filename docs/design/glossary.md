# 用語集（Domain Glossary）

このシステムで使う用語の正準形。長期で人や Claude が増えても用語がズレないように、ここを単一の正とする。

新しい用語が出てきたらここに追記。既存用語の意味が揺れたら ADR で再定義する。

## ドメイン基本概念

### 案件 (project)
クライアントから受注した一塊の制作プロジェクト。1案件は1人のディレクター・1人のプロデューサーを主担当に持ち、複数の見積明細（estimate_line）を含む。

### 見積明細 (estimate_line, project_estimate_lines)
案件の見積もりを構成する1行。「ショート動画 5本 ¥30k」のような単位。**deliverable と同義**として扱う（見積もり段階と納品段階で同じレコードを使う）。

- 1見積明細 = 1カテゴリ × 本数 × クライアント単価
- 1見積明細にロール別の支払単価（line_costs）が紐づく
- 1見積明細に複数の creative がぶら下がる
- 詳細: [decisions/002](decisions/002-estimate-lines-unify-deliverable-rates.md)

### 成果物グループ / deliverable
見積明細と同義。実装上は `project_estimate_lines` を指す。UI で何と呼ぶかは未確定（候補: 「見積明細」「成果物グループ」「制作枠」）。

### クリエイティブ (creative, creatives)
個別の動画・静止画など、最終成果物の1つの単位。バージョン管理の対象。
- 1 creative = 1見積明細にぶら下がる（line_id を持つ）
- 1 creative は1つの商品（product_id）と1つの訴求軸（appeal_type_id）を持つ → ファイル名生成に使われる
- 詳細: [decisions/001](decisions/001-creative-first-product-appeal.md)

### バージョン (creative_versions / creative_version_history)
1つの creative の修正履歴。提出 → 添削 → 再提出のサイクル。

### ボール保持者 (ball_holder)
あるクリエイティブの「次に動くべき人」。現在は `creatives.ball_holder_id` に冗長カラムで保存されているが、`creative_assignments` + `creative_status_audit` から導出可能であり、設計上の歪みとして認識されている。
- 詳細: [open-questions.md Q1](open-questions.md)

## 単価・金銭

### クライアント単価 (client_unit_price)
見積明細1本あたり、クライアントに請求する金額。売上の単位。

### ロール別支払単価 (line_costs.unit_price)
見積明細1本あたり、特定ロール（producer / director / editor 等）に支払う金額。原価の単位。

### 1本あたり利益
`client_unit_price - SUM(line_costs.unit_price)`

### 案件粗利
`SUM((client_unit_price - SUM(line_costs)) * planned_count)` を案件全体で集計。

## 商品・訴求軸

### 商品 (product, client_products)
クライアントが扱う商材。ファイル名生成と訴求の文脈分類に使われる。

### 訴求軸 (appeal_axis, client_appeal_axes)
クリエイティブの訴求方針（「価格訴求」「機能訴求」「ブランド訴求」等）。クライアント単位で定義。

### appeal_types（旧）
旧設計の訴求軸テーブル。`client_appeal_axes`（新）と二重実装されている状態で、整理対象。
- 詳細: [open-questions.md Q4](open-questions.md)

### ファイル名テンプレート
creative の提出時に自動生成されるファイル名の雛形。`{client_code}_{project_name}_{product_name}_{appeal_axis}_v{version}.mp4` のようなトークン展開で命名。
- 実装はまだ無い、設計のみ
- 詳細: [decisions/001](decisions/001-creative-first-product-appeal.md)

## ロール

### ロール (role)
案件における役割。`producer / director / sub_director / sub_producer / editor / designer / secretary / admin` 等。
- 現状: `users.role` の単一 enum + ロール別単価テーブル群で管理
- 課題: 合成値 `producer_director` がある（[open-questions.md Q2](open-questions.md)）
- 設計方針: 将来 `roles` マスタ + `user_roles` M:N に分離

## マスタ

### creative_categories
クリエイティブのカテゴリマスタ（ショート/ロング/静止画/サムネ等）。Stage A で導入された新マスタ。見積明細の category_id が参照する。

### master_categories / master_items
汎用マスタ。役割が `creative_categories` と被っており、整理が必要（[open-questions.md Q4](open-questions.md)）。

## 状態管理

### Phase（注意: 用語衝突あり）
**「Stage A/B/C」は段階リリース計画の意味で使う**。Phase 1 / Phase 4 は通知機能の段階を指す独立した用語（migration ファイル名に登場）。混同しない。

### Stage 分割（migration 戦略）
新DB列を追加するリファクタは Stage 分割で進める運用。
- 詳細: memory `feedback_db_migration_staging.md`

## ファイル・通知系（並走中）

### tweets
社内SNS。リベシティ風タイムライン。
### announcements
全体連絡（旧版）。既読確認つき。
### notification_logs
通知 Phase 1 の現役テーブル。
### posts
死蔵テーブル（未使用、削除候補）。

## 用語追加時の手順
1. このファイルにエントリを追加
2. 既存用語と意味が衝突しないか確認
3. 関連する ADR や open-questions に相互リンク
