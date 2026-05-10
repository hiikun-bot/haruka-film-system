---
adr: 004
status: Accepted
date: 2026-05-06
tags: [pricing, currency, billing, line-costs, extensibility]
related_tables: [project_estimate_lines, project_estimate_line_costs]
supersedes: null
superseded_by: null
related_adrs: [002]
---

# 004. 単価の拡張性（通貨・課金タイプ）を最初から確保する

- **Status**: Accepted
- **Date**: 2026-05-06
- **Decided by**: ユーザー（hiikun.ascs@gmail.com）

## Context

[ADR 002](002-estimate-lines-unify-deliverable-rates.md) では `unit_price INTEGER` の固定単価モデルを採用した。現状の運用（円建て・本数×固定単価）には十分。

しかし長期で起こりうる拡張：
- **外貨建て案件**: 海外クライアント向けでドル/ユーロ
- **%歩合**: 「クライアント請求額の30%をディレクターに」
- **時間単価**: 「ディレクター ¥5,000/時 × 実働時間」
- **税抜/税込混在**: クライアント請求は税込、内部計算は税抜
- **後から拡張すると料金計算ロジックの全面改修**になり、コストが膨らむ

ADR 002 をそのまま実装すると、これら拡張要求が来たときに `line_costs` テーブルを根本から作り直す羽目になる。**最初からフックを入れておくのが長期コスト最小**。

## Decision

**`project_estimate_lines` と `project_estimate_line_costs` に拡張用カラムを最初から含める。**

```sql
ALTER TABLE project_estimate_lines
  ADD COLUMN currency CHAR(3) NOT NULL DEFAULT 'JPY',
  ADD COLUMN tax_included BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE project_estimate_line_costs
  ADD COLUMN currency CHAR(3) NOT NULL DEFAULT 'JPY',
  ADD COLUMN pricing_type TEXT NOT NULL DEFAULT 'fixed_per_unit',
  -- 'fixed_per_unit' : unit_price * planned_count
  -- 'percentage'     : client_unit_price * percentage / 100
  -- 'hourly'         : unit_price * actual_hours
  -- 'fixed_total'    : 本数に依存しない固定額
  ADD COLUMN percentage NUMERIC(5,2),  -- pricing_type='percentage' のとき使用
  ADD COLUMN actual_hours NUMERIC(8,2); -- pricing_type='hourly' のとき使用
```

### 計算ロジックの集約
利益計算は SQL に直接書かず、**1関数に集約**する：

```js
// utils/pricing.js
function calculateLineCost(lineCost, line) {
  switch (lineCost.pricing_type) {
    case 'fixed_per_unit': return lineCost.unit_price * line.planned_count;
    case 'percentage':     return line.client_unit_price * line.planned_count * lineCost.percentage / 100;
    case 'hourly':         return lineCost.unit_price * (lineCost.actual_hours ?? 0);
    case 'fixed_total':    return lineCost.unit_price;
  }
}
```

新しい課金タイプは関数に case を増やすだけで全画面に反映。

### 通貨混在の扱い
- フェーズ1（初期実装）では同一案件内での通貨混在を**禁止**（バリデーション）。すべて JPY を強制
- 外貨対応が要求された時点で「案件単位で1通貨」のまま multi-currency 対応する（ADR 別途）

## Consequences

### 解決すること
- 将来の外貨・%歩合・時間単価が**カラム追加なし**で扱える
- 課金ロジックが1関数に集約され、新タイプ追加コストが線形

### 当面の運用負担
- カラムは増えるが、`pricing_type='fixed_per_unit'` がデフォルトなので運用上の意識は不要
- DB 定義のみのコストで、UI・コード側は当面 fixed_per_unit のまま実装可

### 廃止/影響なし
- 既存テーブルへの影響は無い

## Alternatives considered

- **(却下) 必要になった時点で拡張する** — 「料金計算ロジックの全面改修」リスクが大きく、長期では必ずコストが発生する
- **(却下) JSONB で課金ロジックを保持** — 集計クエリで死ぬ、UI 連携が困難
- **(却下) 通貨対応も最初から完璧に** — オーバーエンジニアリング、当面は JPY 固定で十分

## 実装履歴

- 2026-05-06: Stage 1 (migration のみ) — `migrations/2026-05-06_estimate_lines_and_fixed_items.sql`
  - `project_estimate_lines` に `currency` / `tax_included` 列を新設
  - `project_estimate_line_costs` に `currency` / `pricing_type` / `percentage` / `actual_hours` 列を新設
  - `project_fixed_items` に `currency` 列を新設
  - 計算ロジック側の対応は Stage 3 で実施
