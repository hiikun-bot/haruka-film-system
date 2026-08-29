---
adr: 034
status: Accepted
date: 2026-07-31
tags: [billing, invoices, revenue, creatives, projects, delivered-at, first-draft]
related_tables: [projects, creatives, creative_status_transitions, project_estimate_lines, line_payment_installments]
supersedes: null
superseded_by: null
related_adrs: [026, 029, 030]
---

# 034. 案件単位で計上タイミングを「納品時」/「初稿提出時」に切り替える

- **Status**: Accepted
- **Date**: 2026-07-31
- **Decided by**: ユーザー（hiikun.ascs@gmail.com）

## Context

ADR 026 で、本数系（動画/静止画）の計上月は「納品完了日（`delivered_at`）が属する JST 月」に固定した。
しかし実運用には **案件ごとに請求条件が異なる** 事情がある。

ユーザー要件（2026-07-31）:
- 案件によって **「初稿を提出した時点で費用請求できる」** ものと、**「納品完了後に費用請求できる」** ものが存在する。
- 「初稿提出済み」の判定は、クリエイティブのステータスが **「クライアントチェック中」以降** に入ったことをもって行う（＝先方チェックにボールが渡った時点）。
- 切り替えは **全案件タイプ共通** で持てるようにする。
- 動かしたいのは **メンバーへの支払い計上月・クライアントへの請求（売上）計上月の両方**。

現状、計上月は `delivered_at` 固定であり、初稿提出という契機は計上に一切関与していない。
初稿提出日時を保持する専用カラムも存在しない（`creative_status_transitions` からの復元は可能）。

## Decision

**案件（`projects`）に計上タイミング区分 `billing_timing` を持たせ、
`on_first_draft` の案件では、本数系 creative の計上月を
「初稿提出日時（`first_draft_submitted_at`）が属する JST 月」に寄せる。
対象は支払い集計・売上集計の両方。デフォルトは従来どおり `on_delivery`。**

### スキーマ（Stage 1 = migrations/2026-08-29c_billing_timing.sql）

```sql
-- 案件ごとの計上タイミング区分
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS billing_timing TEXT NOT NULL DEFAULT 'on_delivery'
  CHECK (billing_timing IN ('on_delivery', 'on_first_draft'));

-- 初稿提出日時（「クライアントチェック中」へ初到達した時刻）
ALTER TABLE creatives
  ADD COLUMN IF NOT EXISTS first_draft_submitted_at TIMESTAMPTZ;
```

### 計上月の解決ルール（共通ヘルパー resolveBillingMonth）

creative 1 本の計上月を、所属案件の `billing_timing` で決める:

| billing_timing | 計上月の基準 | 未確定時のフォールバック |
|---|---|---|
| `on_delivery`（既定） | `delivered_at` の JST 月 | `final_deadline`（従来どおり ADR 026） |
| `on_first_draft` | `first_draft_submitted_at` の JST 月 | `draft_deadline`（初稿締切） |

- この分岐は **支払い集計（クリエイター報酬）と売上集計（クライアント請求）の両方**に適用する。
- 単価解決（ADR 030 `resolveEffectiveLineId` の締め月末基準）に渡す「締め月」も、
  `on_first_draft` 案件では初稿提出月ベースの月末を渡す（計上月と単価適用月を一致させる）。

### 初稿提出日時の記録（自動）

- クリエイティブ更新 API で `status` が **「クライアントチェック中」** へ遷移した瞬間、
  `first_draft_submitted_at` が未設定なら `now()` を記録する（`delivered_at` の記録ロジックに相乗り）。
- **一度記録したら保持する**（クライアントチェック後修正などで手前のステータスへ戻っても NULL に戻さない）。
  ＝「初稿提出済み＝クライアントチェック中に一度でも到達した」という不可逆イベントとして扱う。
- 過去分の backfill: `creative_status_transitions` から
  `to_status = 'クライアントチェック中'` の最初の `changed_at` を復元して埋める。

### 一式（HP/LP 等）との関係 — ADR 029 と衝突させない

- ADR 029 のルール1「一式カテゴリは集計ロジックが常に `line_payment_installments` のみを見る（分岐を作らない）」を維持する。
- したがって **`billing_timing` は installments を持つ line（＝一式）には作用させない**。
  一式の計上月は従来どおり `target_month` で明示指定する。
- `billing_timing = 'on_first_draft'` が実際に効くのは **installments を持たない本数系 line** に紐づく creative。
- UI 上はどの案件タイプでも `billing_timing` を設定できるが、一式 line は installments が優先される旨をヘルプに明記する。

### Stage 2（コード）

- クリエイティブ更新（PUT）: 「クライアントチェック中」遷移時に `first_draft_submitted_at` を記録。
- 共通ヘルパー `resolveBillingMonth(creative, project)`（確定イベント用の `billingEventInRange` を含む）を新設し、以下の計上月判定を置換:
  - 支払い側: `aggregateCreativeByAssignee` / `/invoices/preview-items`（`MONTH_RANGE_OR`）/ `computeCreatorCreativeBreakdown`
    （月判定は共有元の `aggregateCreatorSummary` / `aggregateCreatorDetail` 側で実施。breakdown 自体は月非依存の純関数のまま）
  - 売上側: `aggregateMonthlyRevenue`
- 案件編集モーダルに「請求タイミング（納品時 / 初稿提出時）」選択を追加。

## Consequences

- 「初稿提出で請求できる案件」の支払い・売上が、納品を待たず初稿提出月に正しく載る。
- 既存案件はすべて `on_delivery` で移行するため、**移行時点の計上結果は不変**。
- 計上月が「案件の設定 × creative のイベント」で決まるため、集計は単一ヘルパー `resolveBillingMonth` に必ず通す（直接 `delivered_at` を見る箇所を残さない）。
- 一式は ADR 029 のまま。本 ADR は本数系の計上契機のみを拡張する。
- 突合スキル（gnd-monthly-meisai / invoice-actual-recon）は計上月前提が案件別になるため、`billing_timing` を考慮する必要がある（別途対応）。

## Alternatives

- **A. line 単位に billing_timing を持たせる**: 「案件ごと」という要件に対し粒度が細かすぎ、
  UI が複雑化。まず案件単位で導入し、必要になれば line 上書きを追加する余地を残す。
- **B. 専用カラムを設けず transitions から都度算出**: 集計クエリが重くなり、
  `delivered_at`（ADR 026）が専用カラムを持つ設計と非対称になるため却下。
- **C. 手入力の「初稿提出日」列**: ステータス運用が既に「クライアントチェック中」で先方チェックを表現しており、
  自動記録で二度手間を避けられるため却下（将来 admin 手動補正は追加余地あり、`force_delivered_at` と同様）。
