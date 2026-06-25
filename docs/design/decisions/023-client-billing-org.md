---
adr: 023
status: Accepted
date: 2026-06-25
tags: [clients, billing, master-data, classification]
related_tables: [clients]
supersedes: null
superseded_by: null
related_adrs: [004]
---

# 023. クライアントマスターに請求区分（billing_org）を持たせる

- **Status**: Accepted
- **Date**: 2026-06-25
- **Decided by**: ユーザー（hiikun.ascs@gmail.com）

## Context

案件の請求元を「自社（HARUKA FILM）」と「広告代理店経由」で区別したい、という要望。
現状クライアント単位で代理店が決まっており（GND = GOOD NEW Design が現状唯一の代理店）、
請求・売上の集計や費用台帳で自社案件と代理店経由案件を分けて見たい。

代理店は今後 GND 以外にも増える見込み。一方で、現時点では数が少なく、追加頻度も高くない。

## Decision

`clients` に **TEXT 列 `billing_org`** を追加する（NULL 可・未設定許容）。

- 値は **コード値** で保存する: `haruka`（自社 HARUKA FILM） / `gnd`（GOOD NEW Design）。
- ラベル・選択肢・自社判定（`isSelf`）は **フロントの定数 `CLIENT_BILLING_ORG_LABELS`**
  （[public/haruka.html](../../../public/haruka.html)）で一元管理する。
  **代理店追加 = この定数に1行追記するだけ**で、全画面のセレクトに反映される（DB スキーマ変更・サーバー改修不要）。
- DB に CHECK 制約は設けない。`status` / `pricing_type` 等と同じく **アプリ層で値を管理**し、拡張容易性を優先する。
- API（`routes/haruka.js` の POST/PUT `/clients`）は `billing_org` を受け取り保存。
  列未適用環境でも 500 にならないよう、`invoice_registration_number` と同様の
  **グレースフルフォールバック**（エラーが指す列を落として再試行）を共通化して適用する。

### Alternatives considered

1. **請求元マスタ表（`billing_parties`）+ FK** — 管理画面から非開発者が代理店を追加できる。
   正規化としては綺麗だが、現状代理店が極小数で追加頻度も低く、テーブル・CRUD・UI の新設は過剰。
   → 将来代理店管理が本格化したら本 ADR を superseded して移行する余地を残す。
2. **enum / CHECK 制約** — 値の安全性は上がるが、代理店追加のたびに migration が必要になり拡張容易性を損なう。却下。
3. **boolean（自社か否か）のみ** — どの代理店経由かを記録できず、要望（GND を明示）を満たさない。却下。

## Consequences

- 既存行は `billing_org = NULL`（未設定）。後方互換あり。
  migration 内で、費用台帳の請求区分に基づき既知クライアントへ初期値をバックフィルする
  （記載の無いクライアントは NULL のまま、UI から個別設定）。
- 自社/代理店の判定は `CLIENT_BILLING_ORG_LABELS[billing_org]?.isSelf` で行う。
  集計・台帳・請求側で参照する場合はこの定数を正とする。
- 将来代理店が多数化し UI からの追加管理が必要になった場合は、Alternative 1（マスタ表 + FK）へ移行する。
