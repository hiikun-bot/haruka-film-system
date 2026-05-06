---
adr: 002
status: Accepted
date: 2026-05-06
tags: [deliverable, rates, estimate, billing, profit, line-items, invoice]
related_tables: [projects, project_estimate_lines, project_estimate_line_costs, creatives, invoice_items, project_rates, project_category_rates, project_director_rates, project_producer_rates, project_sub_directors, project_sub_producers, project_rate_extras]
supersedes: null
superseded_by: null
---

# 002. 見積明細を deliverable と rates の統合単位にする

- **Status**: Accepted
- **Date**: 2026-05-06
- **Decided by**: ユーザー（hiikun.ascs@gmail.com）

## Context

設計上の歪みが2つあった：

### 歪み1: deliverable 中間層が無い
`projects → creatives` の2層しかなく、案件直下に「商品・訴求軸・本数・単価」が直付けされていた。
1案件で「ショート動画 5本／ロング動画 2本」のような複数の成果物グループを扱う運用がある。

### 歪み2: rates が散在
ロール別単価がテーブル単位で増殖：
- `project_rates` / `project_category_rates` / `project_director_rates` / `project_producer_rates` / `project_sub_directors` / `project_sub_producers` / `project_rate_extras` / `project_client_fees`
- 新ロール追加のたびにテーブルが増える運用

ユーザーの観察：「各見積もり明細に対して『製作者への支払い』『ディレクターへの支払い』『プロデューサーへの支払い』という単価がある粒度が一番合う」

→ **deliverable と rates は同じ概念に収束する**。「見積明細 = 成果物グループ = 単価セットの保持単位」。

## Decision

**3層構造に再編 + 単価をロール別の子テーブルに集約。**

```
projects
  └─ project_estimate_lines (見積明細 = deliverable)
       ├─ project_estimate_line_costs (ロール別支払単価 = 旧 rates 系の統合先)
       ├─ creatives (line_id 追加)
       └─ invoice_items (line_id 追加)
```

### スキーマ案

```sql
CREATE TABLE project_estimate_lines (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  category_id UUID REFERENCES creative_categories(id),  -- ショート/ロング/静止画
  name TEXT,                          -- 任意ラベル「フェーズ1ショート」等
  planned_count INTEGER NOT NULL,
  client_unit_price INTEGER NOT NULL, -- クライアント請求単価（売上）
  sort_order INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE project_estimate_line_costs (
  id UUID PRIMARY KEY,
  line_id UUID NOT NULL REFERENCES project_estimate_lines(id) ON DELETE CASCADE,
  role TEXT NOT NULL,            -- 'producer' | 'director' | 'sub_director' | 'editor' | 'designer' ...
  user_id UUID REFERENCES users(id),  -- 特定担当者宛なら指定（NULLならロール固定額）
  unit_price INTEGER NOT NULL,
  UNIQUE(line_id, role, user_id)
);

ALTER TABLE creatives ADD COLUMN line_id UUID REFERENCES project_estimate_lines(id);
ALTER TABLE invoice_items ADD COLUMN line_id UUID REFERENCES project_estimate_lines(id);
```

### 利益計算
```
1本あたり利益 = client_unit_price - SUM(line_costs.unit_price)
明細あたり利益 = 1本あたり利益 × planned_count
案件粗利 = SUM(明細あたり利益)
```

## Consequences

### 解決すること
- 1案件で複数の成果物グループを扱える（ショート 5本 ¥30k／ロング 2本 ¥80k）
- 新ロール追加でテーブルが増えない（`role` カラムに値追加するだけ）
- 進捗表示が自然（「ショート 5本中3本完成」= `creatives WHERE line_id = X AND status = 'delivered'`）
- 請求項目が deliverable 単位で組める（[2026-04-28_invoice_items_step1.sql](../../../migrations/2026-04-28_invoice_items_step1.sql) の方向性と一致）

### 廃止/統合される既存テーブル
- `project_rates` → lines に吸収
- `project_category_rates` → lines に吸収（カテゴリ別単価は `line.category_id + client_unit_price`）
- `project_director_rates` → `line_costs(role='director')`
- `project_producer_rates` → `line_costs(role='producer')`
- `project_sub_directors` / `project_sub_producers` → `line_costs(role='sub_director' / 'sub_producer')`
- `project_rate_extras` → 要検討（明細紐づくなら line_costs で吸収可）

**結果: rates 系 6+ テーブル → 2 テーブルに集約**

### 移行戦略（実装時）
Stage 分割で段階適用（[feedback_db_migration_staging.md](../../../.claude/projects/-Users-takahashi-satoru-Documents-40---------haruka-film-system/memory/feedback_db_migration_staging.md) の原則に従う）：
1. `project_estimate_lines` / `project_estimate_line_costs` 追加（既存と並走）
2. 既存 `project_category_rates` から lines への自動移行スクリプト
3. `creatives.line_id` を NULL 許容で追加、既存データを category_id ベースで紐付け
4. `invoice_items.line_id` 追加
5. UI を lines 単位に再構成（案件モーダル + 見積モーダル）
6. 旧テーブル参照箇所をコードから除去
7. 旧テーブル削除（最後）

## Alternatives considered

- **(却下) deliverable と rates を別テーブルで持つ** — 概念が収束しているのに分けるとカラム重複・JOIN 多発
- **(却下) line_costs を JSONB 列にする** — クエリ性能と整合性で劣る、ロール別集計がしづらい
- **(却下) 案件直下のまま、ロール追加時にテーブル追加で対応** — 直近4テーブル追加した実績があり破綻が確定

## Open Concerns（実装前に解決すべき穴）

実装に入る前に以下の点を別 ADR で詰める必要がある：

1. **ロール定義** — `line_costs.role TEXT` だと新ロール追加時にコード側の enum・UI ラベル・権限チェックが散る → **[ADR 003](003-roles-as-master-data.md)** で `roles` マスタ化
2. **通貨・単位・課金タイプ** — 現状の `unit_price INTEGER` は円固定。長期での外貨・%歩合・時間単価への拡張余地が無い → **[ADR 004](004-pricing-extensibility.md)** で拡張ポイントを設計
3. **見積もり vs deliverable のライフサイクル分離** — 「却下された見積もり」と「進行中の deliverable」を同テーブルで持つと混在する → **[ADR 005](005-estimate-deliverable-lifecycle.md)** で status 管理
4. **案件レベルの固定費** — スタジオレンタル等「本数依存しない案件固定費」は line_costs では表現できない → **[ADR 006](006-project-fixed-costs.md)** で別表現を定義

## 実装履歴

- 2026-05-06: Stage 1 (migration のみ) — `migrations/2026-05-06_estimate_lines_and_fixed_items.sql`
  - 新規: `project_estimate_lines` / `project_estimate_line_costs` / `project_fixed_items`
  - 既存テーブル列追加: `creatives.line_id` / `invoice_items.line_id`
  - データ移行・コード書き換えは Stage 2 以降で対応
- 2026-05-06: Stage 2 (data migration) — `migrations/2026-05-06_migrate_rates_to_lines.sql`
  - `project_rates` (rank A/B/C × video/design) → `project_estimate_lines` + `project_estimate_line_costs`(role=editor/designer)
  - `project_director_rates` / `project_producer_rates` → `project_estimate_line_costs`(role=director/producer)。rank 不在のため同 (project, category) の全 lines に同額をコピー
  - `project_rate_extras` → `project_fixed_items(item_type='expense', category='other')`
  - `project_client_fees.{video|design}_unit_price` → 既存 lines の `client_unit_price` を UPDATE（無ければ新規 line 作成）
  - `project_client_fees.fixed_budget` (use_fixed_budget=TRUE) → `project_fixed_items(item_type='revenue')`
  - `creatives.line_id` を (project_id, category_id) + 編集者の rank で best-effort バックフィル
  - 移行マーカは `name` の接尾辞 / `notes` のプレフィックスで識別（冪等性 & ロールバック用）
  - **NOT 移行**: `projects.sub_director_ids` / `projects.sub_producer_ids`（fee 列が無いためデータ無し。サブD/サブP単価は Stage 4 UI で入力する想定）
- 2026-05-06: data fix migration — `migrations/2026-05-06_finalize_migrated_lines.sql`
  - Stage 2 で `status='estimated'` / `planned_count=0` のまま挿入された移行 line を、
    Stage 3 の per-line 公式 (`client_unit_price × planned_count`) と
    ADR 005 集計フィルタに乗せられるよう実用値に整える
  - 移行 line の `status` を `in_progress` に進める（移行マーカ付きのみ）
  - 移行 line の `planned_count` を紐付いた `creatives` 件数で埋める
