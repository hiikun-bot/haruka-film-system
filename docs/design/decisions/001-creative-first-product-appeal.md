---
adr: 001
status: Accepted
date: 2026-05-06
tags: [products, appeal_axes, creative, filename, master-data]
related_tables: [client_products, client_appeal_axes, project_products, project_appeal_axes, creatives, appeal_types]
supersedes: null
superseded_by: null
---

# 001. 商品・訴求軸は creative-first 設計で残す

- **Status**: Accepted
- **Date**: 2026-05-06
- **Decided by**: ユーザー（hiikun.ascs@gmail.com）

## Context

過去の方針では「Stage C で `products` / `appeal_axes` / `project_products` / `project_appeal_axes` 系を完全削除」予定だった（CLAUDE.md 記載）。

しかし実運用では：
- ファイル名自動生成（提出時に `{client}_{project}_{product}_{appeal}_v{version}.mp4` 等で命名）に商品・訴求軸が必須
- 1つの案件で複数の商品・訴求軸を扱うケースがある
- 1つの creative は1つの商品・1つの訴求軸を持つ

## Decision

**商品・訴求軸テーブルを削除しない。creative-first 設計で残す。**

```
client_products / client_appeal_axes    マスタ（クライアント単位の候補）
project_products / project_appeal_axes  案件で使う候補の絞り込み（M:N）
creatives.product_id / appeal_type_id   ★成果物が実際に使う1つ（ファイル名生成元）
```

DB は既にこの形になっている（`migrations/2026-05-02_creatives_appeal_product_optional.sql` で creatives 側を NULL 許容化済み）。

### UI の修正方針
案件モーダルから商品・訴求軸選択を **creative モーダルに移す**。案件モーダルは「案件で使う候補リストの管理」だけに格下げ。

### 周辺対応（要実装）
- `filename_templates` テーブル または `client_configs` の JSON 拡張
- 命名トークン解決関数（`{client_code}_{project_name}_{product_name}_{appeal_axis}_v{version}` 等）
- `clients.code` / `client_products.short_name` 等のショートコード列
- `appeal_types`（旧）と `client_appeal_axes`（新）の二重実装は `client_appeal_axes` に統一

## Consequences

- ✅ 削除作業（Stage C）は撤回。データ移行不要
- ✅ ファイル名自動生成という具体目的にスキーマがそのまま使える
- ⚠️ CLAUDE.md の「主要既存機能の地図」に書かれた「Stage C 完全削除予定」は古い記述 → 次回 CLAUDE.md 編集時に削除
- ⚠️ `appeal_types` / `client_appeal_axes` の二重実装が残存 → 別 ADR で整理

## Alternatives considered

- **(却下) Stage C で削除し、ファイル名生成は別の仕組みで** — 削除の利得が小さく、ファイル名仕様の表現力が落ちる
- **(却下) products / appeal を案件直下に統合** — 「1案件で複数商品」のとき破綻
