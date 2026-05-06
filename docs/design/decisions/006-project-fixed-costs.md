---
adr: 006
status: Accepted
date: 2026-05-06
tags: [fixed-cost, project, billing, profit, expense]
related_tables: [project_fixed_items, project_estimate_lines]
supersedes: null
superseded_by: null
related_adrs: [002]
---

# 006. 案件レベルの固定費・固定収入を別表現で持つ

- **Status**: Accepted
- **Date**: 2026-05-06
- **Decided by**: ユーザー（hiikun.ascs@gmail.com）

## Context

[ADR 002](002-estimate-lines-unify-deliverable-rates.md) の `project_estimate_lines` は「カテゴリ × 本数 × 単価」の構造を持つ。これは creative 単位で按分できる費用（編集費・ディレクション費等）には合うが、以下のような**本数に依存しない案件固定費**は表現できない：

- スタジオレンタル ¥80,000（1案件1回）
- 機材費 ¥50,000（1案件1回）
- 出張費・交通費
- ロケ手配費
- 撮影日数ベースの追加料金

これらを `project_estimate_lines` の `planned_count=1, unit_price=80000` で擬似表現することは可能だが：
- 「カテゴリ」が必要だが creative_categories には合わない（スタジオは creative ではない）
- creative がぶら下がらない line が混在し、集計クエリが歪む
- UI で「成果物」と「経費」が混在表示される

## Decision

**案件固定費・固定収入を保持する `project_fixed_items` テーブルを別途持つ。**

```sql
CREATE TABLE project_fixed_items (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  item_type TEXT NOT NULL,
  -- 'expense'  : 経費（粗利からマイナス）
  -- 'revenue'  : 固定収入（粗利にプラス、本数依存しない売上）
  category TEXT,
  -- 'studio' | 'equipment' | 'travel' | 'location' | 'other' など分類
  name TEXT NOT NULL,                -- 「Studio A 2026/05/15」等
  amount INTEGER NOT NULL,
  currency CHAR(3) NOT NULL DEFAULT 'JPY',
  occurred_on DATE,                  -- 発生日（経費精算と紐付ける場合）
  paid_to TEXT,                      -- 支払先（外部業者名等）
  paid_to_user_id UUID REFERENCES users(id),  -- 内部メンバー宛なら指定
  status TEXT NOT NULL DEFAULT 'planned',
  -- 'planned' | 'committed' | 'incurred' | 'cancelled'
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  created_by UUID REFERENCES users(id)
);

CREATE INDEX idx_project_fixed_items_project ON project_fixed_items(project_id);
```

### 案件粗利計算の更新
ADR 002 の利益計算式を以下に拡張：

```
案件売上 = SUM(estimate_lines.client_unit_price * planned_count) WHERE status IN ('contracted','in_progress','delivered')
         + SUM(fixed_items.amount) WHERE item_type='revenue' AND status != 'cancelled'

案件原価 = SUM(line_costs costs)
         + SUM(fixed_items.amount) WHERE item_type='expense' AND status != 'cancelled'

案件粗利 = 案件売上 - 案件原価
```

### `project_client_fees` との関係
[既存テーブル `project_client_fees`](../../../supabase_schema.sql) は案件レベルの追加クライアント請求を保持している。これは `project_fixed_items.item_type='revenue'` に統合可能。
- 移行で `project_client_fees` を `project_fixed_items` に吸収
- `project_client_fees` テーブルは廃止

### `project_rate_extras` との関係
[既存テーブル `project_rate_extras`](../../../supabase_schema.sql) は要調査。明細レベル（line_costs）に紐づく追加費用なら ADR 002 の line_costs に吸収、案件レベル固定費なら本 ADR の fixed_items に吸収。

## Consequences

### 解決すること
- スタジオレンタル等の「成果物に按分できない費用」を自然に扱える
- estimate_lines はクリエイティブ生産に集中、fixed_items が周辺費用を吸収
- 粗利計算の網羅性が上がる

### 廃止/統合
- `project_client_fees` → `project_fixed_items(item_type='revenue')` に吸収
- `project_rate_extras` → 要調査（line_costs か fixed_items のどちらかに吸収）

### UI 影響
- 案件モーダルに「固定費・追加収入」セクションを追加
- 見積書表示で estimate_lines + fixed_items を統合した内訳を出す

## Alternatives considered

- **(却下) estimate_lines に擬似カテゴリで詰め込む** — 集計が歪む、UI 表現が混乱
- **(却下) JSONB で案件直下に保持** — 集計・経費精算連携で死ぬ
- **(却下) 経費は別システムで管理** — 案件粗利の正確性が失われる、二重入力

## 実装履歴

- 2026-05-06: Stage 1 (migration のみ) — `migrations/2026-05-06_estimate_lines_and_fixed_items.sql`
  - 新規テーブル `project_fixed_items` を追加（`item_type` / `category` / `amount` / `status` 等）
  - INDEX: `idx_pfi_project` / `idx_pfi_status`
  - 入力 UI・案件粗利集計への組み込みは Stage 3〜4 で実施
