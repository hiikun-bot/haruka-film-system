# 案件収支設計（Project Accounting Design）

> **目的**: 案件ごとに「見積 / 実績売上 / 外注費 / 粗利」を一元管理し、過去案件比較で差額理由を説明できるようにする。
>
> **対象範囲**: HP / LP / 動画編集など、すべての案件タイプ。
>
> **本ドキュメントは Step A〜D の段階的実装計画である。本PRは Step A（DB migration）のみ。**

---

## 1. 解きたい課題

| # | 課題 | 現状 |
|---|---|---|
| 1 | 案件単位で「いくら売れて、いくらかかって、いくら残ったか」が見えない | invoice / invoice_items はあるが、案件視点で集計されない |
| 2 | 過去の類似案件（例: LP 30万 vs 25万）と比較して差額理由が説明できない | 見積データそのものが構造化されていない |
| 3 | HP / LP / 動画で**入力すべき項目が違う**（HP はページ数、動画は本数）が、比較軸は揃えたい | 項目テンプレが固定（ABC × 単価 のみ） |
| 4 | 「契約100万 → 手付金50万 + 完了金50万」のような分割請求運用ができない | 1案件 = 1請求の前提が強い |

## 2. 設計方針

1. **既存テーブルは壊さない（後方互換優先）**
2. **invoice / invoice_items は単一の真実とし、accounting 側はそこから派生集計する**
3. **案件タイプごとに可変の入力項目を持てる（JSONB）が、比較軸は正規化メトリクスで統一する**
4. **段階導入（A: DB / B: API / C: UI / D: テスト）してロールバック可能にする**

## 3. データモデル

```
projects
   │
   ├─ project_finance_books   1:1   案件収支台帳（合計値の置き場）
   ├─ project_input_profiles  1:1   案件タイプ別入力 + 正規化メトリクス
   ├─ project_estimates       1:N   見積（バージョン別）
   │     └─ project_estimate_items  1:N  見積明細
   ├─ project_cost_entries    1:N   外注費・原価エントリ（invoice_items から自動連携 + 手入力可）
   └─ project_revenue_entries 1:N   売上エントリ（client invoice から自動連携 + 手入力可）
```

### 3.1 project_finance_books（案件収支台帳）

| 列 | 型 | 説明 |
|---|---|---|
| id | UUID | PK |
| project_id | UUID | FK projects（UNIQUE） |
| contract_total | INT | 契約総額（手入力） |
| estimated_revenue | INT | 見積売上合計（採用見積から） |
| estimated_cost | INT | 見積原価合計 |
| actual_revenue | INT | 実績売上合計（project_revenue_entries 集計） |
| actual_cost | INT | 実績原価合計（project_cost_entries 集計） |
| status | TEXT | open / closed |
| closed_at | TIMESTAMPTZ | 決算済 |
| note | TEXT | 備考 |

> **粗利 = actual_revenue - actual_cost** はビュー側で計算（GENERATED 列にしない＝後で計算式変更しやすく）

### 3.2 project_input_profiles（入力プロファイル）

| 列 | 型 | 説明 |
|---|---|---|
| project_id | UUID | FK（UNIQUE） |
| project_type | TEXT | 'video' / 'hp' / 'lp' / 'other' |
| input_payload | JSONB | 案件タイプ固有の入力（HP: {pages, has_cms, design_complexity, ...}） |
| normalized_metrics | JSONB | 比較軸統一: {complexity_score, delivery_days, estimated_person_hours, outsource_ratio} |
| raw_request_text | TEXT | ラフ依頼文の原文（後でAI再解釈に使う） |

> **比較軸**: HP/LP/動画で違う入力でも `complexity_score` `delivery_days` `estimated_person_hours` `outsource_ratio` の4軸に正規化することで、横並び比較を可能にする。

### 3.3 project_estimates / project_estimate_items（見積 + 明細）

- `project_estimates`: project_id + version、status (draft/sent/accepted/rejected)、総額
- `project_estimate_items`: estimate_id + category (video/design/direction/fixed/other) + label + qty × unit_price = amount

### 3.4 project_cost_entries（原価エントリ）

| 列 | 型 | 説明 |
|---|---|---|
| project_id | UUID | FK |
| source | TEXT | 'manual' / 'invoice_item' |
| source_invoice_item_id | UUID | invoice_items から派生時 |
| source_invoice_id | UUID | 上記の親 invoice |
| cost_type | TEXT | base_fee / script_fee / ai_fee / direction / other |
| label | TEXT | 表示名 |
| amount | INT | 金額 |
| occurred_on | DATE | 発生日 |
| user_id | UUID | 支払先メンバー |

> **invoice_items → project_cost_entries の自動連携**: トリガで投入。`source_invoice_item_id` UNIQUE で重複防止。
> staff invoice (invoice_type IS NULL or != 'client') の items のみ対象。

### 3.5 project_revenue_entries（売上エントリ）

| 列 | 型 | 説明 |
|---|---|---|
| project_id | UUID | FK |
| source | TEXT | 'manual' / 'client_invoice' |
| source_invoice_id | UUID | client invoice から派生時 |
| revenue_type | TEXT | deposit（手付金）/ final（完了金）/ monthly / lump_sum / other |
| label | TEXT | |
| amount | INT | |
| occurred_on | DATE | |
| client_id | UUID | |

> **invoices(invoice_type='client') → project_revenue_entries の自動連携**: トリガで投入。`source_invoice_id` UNIQUE。

## 4. 自動連携ロジック（トリガ）

| トリガ | 対象 | 動作 |
|---|---|---|
| `tr_invoice_items_to_cost` | invoice_items INSERT/UPDATE | 親 invoice が staff 請求なら、project_cost_entries に upsert |
| `tr_invoice_items_to_cost_del` | invoice_items DELETE | source_invoice_item_id 一致行を削除 |
| `tr_invoices_to_revenue` | invoices INSERT/UPDATE | invoice_type='client' なら、project_revenue_entries に upsert |
| `tr_invoices_to_revenue_del` | invoices DELETE | source_invoice_id 一致行を削除 |

**安全策**: トリガ内は EXCEPTION ハンドラで囲み、accounting 同期失敗が請求書本体の更新を巻き戻さないようにする。WARNING ログのみ出して RETURN。

## 5. ロールバック計画

- `migrations/2026-05-02_project_accounting_step_a.sql`（up）と
- `migrations/2026-05-02_project_accounting_step_a_down.sql`（down）をペアで提供
- down はトリガ削除 → 関数削除 → CASCADE で6テーブル削除
- 既存テーブル（invoices, invoice_items, projects 等）には**カラム追加・制約追加を一切行わない**ため、down で既存機能が壊れない

## 6. 段階実装

| Step | 内容 | 状態 |
|---|---|---|
| **A** | DB migration（本PR） | このPR |
| B | API 実装（収支一覧、案件詳細、見積比較） | 次PR |
| C | UI 実装（収支タブ、見積比較パネル） | |
| D | テスト + 既存影響確認 | |

## 7. 既存機能への影響

- **読み取り専用追加**: 既存テーブルは無変更
- **書き込み追加**: invoice_items / invoices への INSERT/UPDATE/DELETE で**追加で**accounting テーブルに行が入る
- **トリガ失敗時**: WARNING ログのみで本体トランザクションは継続（請求書ワークフローは無影響）
- **無効化方法**: `DROP TRIGGER ... ON invoice_items;` `DROP TRIGGER ... ON invoices;` で即時停止可能（テーブルは残置でOK）

## 8. 比較軸の正規化（補足）

| 比較軸 | 単位 | 算出例 |
|---|---|---|
| complexity_score | 0〜100 | HP: pages × 10 + (has_cms ? 20 : 0) + design_complexity × 5 |
| delivery_days | 日 | end_date - start_date |
| estimated_person_hours | 時間 | 入力 or タイプ別係数 |
| outsource_ratio | 0〜1 | 外注費 / 総原価 |

→ 「LP 30万 vs 25万」の差額が、`complexity_score` 差なのか `outsource_ratio` 差なのかを後段の比較APIで切り分ける。

## 9. 想定UI（Step C 予告）

- **案件収支一覧**: project × (見積 / 売上 / 原価 / 粗利 / 粗利率 / 状態) のテーブル
- **案件詳細タブ「収支」**: タブ内に見積バージョン切替 + 売上/原価エントリの一覧 + 粗利KPI
- **見積比較パネル**: 類似案件（同 project_type で metrics が近い順）を3件並べて差分ハイライト
