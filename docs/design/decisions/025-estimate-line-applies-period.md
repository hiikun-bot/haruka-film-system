---
adr: 025
status: Accepted
date: 2026-06-27
tags: [pricing, estimate, deliverable, lifecycle, history]
related_tables: [project_estimate_lines, creatives]
supersedes: null
superseded_by: null
related_adrs: [002, 005, 022]
---

# 025. 成果物グループ（見積明細）に「適用期間」を持たせ、削除せず停止できるようにする

- **Status**: Accepted
- **Date**: 2026-06-27
- **Decided by**: ユーザー（hiikun.ascs@gmail.com）

## Context

成果物グループ（`project_estimate_lines`）は「カテゴリ/ランク別の1本あたり単価（クライアント請求・制作者支払）」を表す。クリエイティブ（`creatives.line_id`）は 1 本につきいずれか 1 グループに紐づく（**1 本 = 1 価格**）。

運用上、**同じ内容のグループが単価違いで複数残る**ことがある。例（HerTech 案件）:

- 【踏襲】静止画 … クライアント ¥5,000 ／ 制作者 ¥3,500（現役）
- 【踏襲】静止画 … クライアント ¥5,000 ／ 制作者 ¥3,000（過去・旧単価）

過去（¥3,000）のグループには納品済みクリエイティブが紐づいているため、[DELETE エンドポイント](../../../routes/haruka.js)は 409 で削除を拒否する。これは**履歴保護として正しい**。

しかし削除できないまま放置すると、**一覧上でどちらが現役か判別できない**。「今は適用していない」ことを明示する手段が無い。

## Decision

成果物グループに **適用期間（開始日・終了日）** を第一級の列として持たせ、**削除の代わりに「停止」** できるようにする。

### スキーマ

`project_estimate_lines` に 2 列を追加する。

| 列 | 型 | 意味 |
|---|---|---|
| `applies_from` | `DATE`（DEFAULT = JST 当日） | 適用開始日 |
| `applies_to`   | `DATE`（NULL 可）            | 適用終了日。NULL=現役 / 日付=停止 |

- **有効（現役） ⇔ `applies_to IS NULL`**
- **停止 ⇔ `applies_to` に日付**

`is_active` のような boolean は**持たない**。停止状態は `applies_to` から導出する（単一の真実源）。

### UI とトグルの連動

UI 上の操作は「**停止 / 再開**」トグル一本に集約する。トグルがフックとなって内部の適用期間を自動セットする:

- **停止** → `applies_to = 当日(JST)`
- **再開** → `applies_to = NULL`（`applies_from` が空なら当日をセット）

ユーザーが日付を直接編集する UI は設けない（内部管理）。API は `PUT /api/projects/:project_id/lines/:line_id` の body に `is_active`（boolean）を受け取り、上記のルールで `applies_to` を更新する。

### 既存データの扱い

本機能リリース時点（2026-06-27 JST）の既存グループは、**適用開始日を一律 `2026-06-27` に統一**する（正確な過去の開始日は遡及しない）。`applies_to` は NULL のまま＝すべて現役として開始する。

### 表示

見積・費用タブの成果物グループ一覧で、停止中のグループは:

- カードをグレーアウト
- 「⛔ 停止中」バッジを表示
- 適用期間（`applies_from 〜 applies_to`）を小さく表示
- アクションボタンが「停止」→「再開」に切り替わる

削除ボタンは従来どおり残す（紐付くクリエイティブが無ければ物理削除も可能）。

## Consequences

- 過去の単価グループを履歴として残したまま「現役でない」ことを明示できる。
- `applies_to` で停止が表現されるため、将来「特定期間だけ有効な単価」へ自然に拡張できる。
- **本 ADR では価格計算ロジック（`utils/pricing.js` の代表 line 救済など）は変更しない**。停止はあくまで表示・運用上の区別。`line_id` が NULL のクリエイティブを代表 line で救済する既存挙動はそのまま（停止 line の除外は将来の課題）。
- DB 列追加のため、リリースは Stage 分割（migration 適用 → コード）で行う（memory: DB列追加リファクタは Stage 分割＋逐次マージ）。
