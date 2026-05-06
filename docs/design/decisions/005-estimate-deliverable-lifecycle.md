---
adr: 005
status: Accepted
date: 2026-05-06
tags: [estimate, deliverable, lifecycle, status, contract]
related_tables: [project_estimate_lines, project_estimate_versions]
supersedes: null
superseded_by: null
related_adrs: [002]
---

# 005. 見積もりと deliverable のライフサイクル分離

- **Status**: Accepted
- **Date**: 2026-05-06
- **Decided by**: ユーザー（hiikun.ascs@gmail.com）

## Context

[ADR 002](002-estimate-lines-unify-deliverable-rates.md) では「見積明細 = deliverable」として同じテーブル（`project_estimate_lines`）で扱う設計とした。

しかし以下のライフサイクル違いがある：

| 段階 | 性質 |
|---|---|
| 見積もり提出前（draft） | 数値が動く、複数案ありえる |
| 見積もり提出（estimated） | クライアントに提示済み、数値固定 |
| 契約成立（contracted） | 受注確定、deliverable として進行管理対象 |
| 進行中（in_progress） | creative がぶら下がり始める |
| 納品済み（delivered） | 請求対象 |
| 却下（rejected）／キャンセル（cancelled） | 死蔵レコード |

`project_estimate_lines` を単一ステータス前提で扱うと：
- 「却下された見積もり」と「進行中の deliverable」が同じ集計に混じる
- 「複数案を出してどれが採用された」の履歴が消える
- 見積書PDFを再発行したいときに、当時の数値が取り出せない

## Decision

**`project_estimate_lines` に `status` カラムを追加し、ライフサイクルを表現する。さらに「見積もりバージョン」概念を別テーブルで導入する。**

### Step 1: status カラム追加

```sql
ALTER TABLE project_estimate_lines
  ADD COLUMN status TEXT NOT NULL DEFAULT 'draft';
  -- 'draft' | 'estimated' | 'contracted' | 'in_progress' | 'delivered' | 'cancelled' | 'rejected'

ALTER TABLE project_estimate_lines
  ADD COLUMN status_changed_at TIMESTAMPTZ;
```

集計時のルール：
- **粗利・売上集計**: `status IN ('contracted', 'in_progress', 'delivered')` のみ含める
- **進行管理**: `status IN ('in_progress')` のみ
- **請求対象**: `status = 'delivered'` のみ

### Step 2: 見積もりバージョン管理（必要になったら）

「複数案を出して比較」「過去版の見積書再発行」が要求されたら：

```sql
CREATE TABLE project_estimate_versions (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id),
  version_number INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',  -- 'draft' | 'submitted' | 'accepted' | 'rejected'
  submitted_at TIMESTAMPTZ,
  decided_at TIMESTAMPTZ,
  notes TEXT,
  UNIQUE(project_id, version_number)
);

ALTER TABLE project_estimate_lines
  ADD COLUMN estimate_version_id UUID REFERENCES project_estimate_versions(id);
```

採用された version の lines だけが `status='contracted'` 以降に進む。
**Step 2 は当面実装しない**。Step 1 で十分なはず。

## Consequences

### 解決すること
- 集計クエリが「何を含めるか」の意図を明示できる
- 却下・キャンセル案件が誤って粗利に混入しない
- ライフサイクル変化のタイミング（status_changed_at）が監査可能

### 当面の運用
- 既存データは `status='in_progress'` で初期化（既存 project_category_rates から移行する場合）
- 新規 line 作成時はデフォルト `draft`、UI で「確定」操作したら `contracted` に
- creative が紐づいたら自動的に `in_progress`

### 影響範囲
- 売上・粗利を集計しているクエリすべてに `WHERE status IN (...)` を追加する必要

## Alternatives considered

- **(却下) ライフサイクル管理しない** — ADR 002 の穴のまま。集計に死蔵レコードが混入
- **(却下) 削除フラグだけ持つ（soft delete）** — 「draft」「estimated」の中間状態を表現できない
- **(却下) 別テーブルに分離（project_estimates と project_deliverables）** — JOIN コストと二重管理。同じレコードが状態遷移する方が単純

## 実装履歴

- 2026-05-06: Stage 1 (migration のみ) — `migrations/2026-05-06_estimate_lines_and_fixed_items.sql`
  - `project_estimate_lines.status` (`draft|estimated|contracted|in_progress|delivered|cancelled|rejected`)
    と `status_changed_at` を新設
  - status 単独 INDEX `idx_pel_status` 付与
  - 状態遷移制御・UI 反映は Stage 3〜4 で実施
