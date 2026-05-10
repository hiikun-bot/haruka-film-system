---
adr: 003
status: Accepted
date: 2026-05-06
tags: [roles, master-data, permissions, line-costs, user-roles]
related_tables: [roles, users, user_roles, role_permissions, project_estimate_line_costs]
supersedes: null
superseded_by: null
related_adrs: [002]
---

# 003. ロールはマスタテーブルで管理する

- **Status**: Accepted
- **Date**: 2026-05-06
- **Decided by**: ユーザー（hiikun.ascs@gmail.com）

## Context

[ADR 002](002-estimate-lines-unify-deliverable-rates.md) で `line_costs.role TEXT` としたが、これだと長期で破綻する：

- 新ロール追加（例: アシスタントプロデューサー）のたびに、コード側の enum 定義・UI ドロップダウン・権限チェック・ラベル文言が**散らばった場所で更新**される
- 結果、追加忘れ・タイポによる silent skip が起きやすい
- philosophy.md 原則 #2「ロール追加でテーブル増やすな」を表面的には守れているが、実質的に「コード変更でロール追加」になっており本質的な解決になっていない

加えて [users.role](../../../supabase_schema.sql) の単一 enum 問題（[open-questions.md Q2](../open-questions.md)）も同じ根を持つ：合成値 `producer_director` の存在は「ロールが第一級概念になっていない」サイン。

## Decision

**ロールをマスタテーブル化し、参照箇所はすべて `role_id UUID REFERENCES roles(id)` に統一する。**

```sql
CREATE TABLE roles (
  id UUID PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,        -- 'producer' | 'director' | 'sub_director' | 'editor' | 'designer' | 'admin' | 'secretary' ...
  label TEXT NOT NULL,              -- UI 表示名「プロデューサー」「ディレクター」
  category TEXT,                    -- 'staff' | 'creator' | 'admin' など分類
  sort_order INTEGER,
  is_creator BOOLEAN DEFAULT FALSE, -- 制作者ロール（line_costs に登場しうるか）
  is_internal BOOLEAN DEFAULT TRUE, -- 社内ロールか外注も含むか
  created_at TIMESTAMPTZ DEFAULT NOW(),
  archived_at TIMESTAMPTZ           -- 廃止する場合は NULL から日付に
);

-- ユーザーのロール（M:N で兼任可、合成 enum 廃止）
CREATE TABLE user_roles (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id UUID NOT NULL REFERENCES roles(id),
  scope_type TEXT,    -- 'global' | 'workspace' | 'project' (任意)
  scope_id UUID,
  granted_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, role_id, scope_type, scope_id)
);

-- 既存 line_costs の role TEXT を role_id に変更
ALTER TABLE project_estimate_line_costs
  ADD COLUMN role_id UUID REFERENCES roles(id);
-- (移行後 role TEXT を DROP)
```

### 既存 `users.role` enum との関係
- 段階移行: `users.role` を残しつつ `user_roles` を並走させる期間を設ける
- 最終的に `users.role` は削除、参照コードはすべて `user_roles` 経由に書き換え
- 合成値 `producer_director` のユーザーは `user_roles` に producer + director の2行を作成して移行

### `role_permissions` との統合
[role_permissions](../../../supabase_schema.sql) は既存テーブル。`role_permissions.role TEXT` も同じく `role_id` に統一する。

## Consequences

### 解決すること
- 新ロール追加が `INSERT INTO roles ...` だけで完結（UI・権限・単価すべてマスタ参照）
- 1人が複数ロールを持てる（合成 enum 廃止）
- ロールの廃止（`archived_at`）が安全にできる
- `line_costs.role_id` で集計・JOIN が正規化される

### 廃止
- `users.role` enum カラム（最終的に）
- `role_permissions.role TEXT` → `role_id` に置換

### 移行コスト
- `users.role` を参照しているコードが多数（要 grep 調査）
- 段階移行を Stage 分割で慎重に進める必要あり

## Alternatives considered

- **(却下) ロールを enum のまま、新値追加だけで運用** — 過去にこれで `producer_director` が生まれた実績がある、繰り返しを防げない
- **(却下) 文字列コードのみで運用（マスタ無し）** — UI ラベル・並び順・分類が持てない、廃止運用ができない

## 実装履歴

- **2026-05-06**: Stage 0 Step 1 — migration `migrations/2026-05-06_roles_master.sql` 追加。
  - `roles` テーブル新設 + 初期 8 件投入（admin / secretary / producer / director / sub_producer / sub_director / editor / designer）
  - `user_roles` テーブル新設 + 既存 `users.role` からデータ移行（合成値 `producer_director` は producer + director の 2 行に分解）
  - `role_permissions.role_id` 列追加 + バックフィル（合成値 `producer_director` の権限行は role_id NULL のまま残し、Step 3 のコード側で和集合解釈）
  - **このPRはコード変更なし**。dual-read 期間として `users.role` / `role_permissions.role` TEXT は維持。
  - 続き: Step 2（コードを `user_roles` 経由に切替）→ Step 3（`role_permissions.role_id` 参照に切替）→ Step 4（旧列 DROP）
