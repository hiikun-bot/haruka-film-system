---
adr: 037
status: Accepted
date: 2026-09-03
tags: [pricing, estimate, line_costs, permissions, approval, director, invoices]
related_tables: [project_estimate_lines, project_estimate_line_costs, role_permissions, notification_logs]
supersedes: null
superseded_by: null
related_adrs: [002, 003, 015, 022, 027, 030, 031]
---

# ADR 037: ディレクターも成果物グループ・単価を設定できるようにし、承認権限を持たない人の単価変更は「有効なまま admin 承認待ち」にする

- Status: Accepted
- Date: 2026-09-03
- Decided by: ユーザー（hiikun.ascs@gmail.com）／本スレッド（8月請求書差分の原因分析）
- Related: ADR 002/022（成果物グループ＝単価の器）, ADR 003（roles マスタ・role_permissions）, ADR 015（VIEW AS チェックリスト）, ADR 027（line カテゴリ＝案件主カテゴリ）, ADR 030/031（単価解決のフォールバック）

## Context

2026年8月分の請求突合で「HFS 上の単価が ¥0 のまま納品された案件」が多数出た（ライフネット生命 バナー 18件 / 日清 静止画 7件 / Airbnb 動画 5件 / 東大松尾研究所 10件 / hertech ディスプレイカード 3件）。これらは**すべてディレクターが作成した案件**である。

原因は運用の怠慢ではなく権限構造にある。#1093（`project.create`）でディレクターは案件・クライアントを**作成**できるようになったが、成果物グループ（`project_estimate_lines`）と単価（`project_estimate_line_costs` / `client_unit_price` / D費）の作成・編集は `project.create_edit`（admin / secretary / producer / producer_director）のままなので、**ディレクターは「単価の無い案件」しか作れない**。単価はその後 admin かプロデューサーが手で入れる「人待ち」工程になっており、2026-09 時点で秘書が不在になったため受け皿はさらに薄い。

一方で、単価の金額そのものをディレクターの裁量に完全に委ねることはしたくない（クライアント請求額・支払額の両方に直結する）。ユーザーの要望は「ディレクターも単価を設定できる。ただしディレクターが作った単価は自分（admin）が承認する形にしたい」。

「承認されるまで単価を無効（¥0 扱い）にする」案は、admin 不在時に人待ちが再発し、今回の問題（¥0 納品）が形を変えて残るので採らない。

## Decision

### 1. 権限キーを 2 つ新設する（ADR 003 / 015 準拠）

| permission_key | 意味 | admin | secretary | producer | producer_director | director | editor / designer / external_director |
|---|---|---|---|---|---|---|---|
| `project.pricing_edit` | 成果物グループ・単価（line_costs）・D費バー・プリセット一括生成の作成/編集/削除/並び替え | ✔ | ✔ | ✔ | ✔ | **✔** | ✘ |
| `project.pricing_approve` | 承認待ちの単価を承認 / 差し戻しできる。**この権限を持つ人の単価書き込みは承認を経ずに確定する** | ✔ | ✘ | ✘ | ✘ | ✘ | ✘ |

- lines 系 API（`POST/PUT/DELETE /projects/:id/lines*`、`/lines/:id/costs*`、`/lines/generate-preset`、`/lines/reorder`、`/lines/:id/duplicate`、`PUT /projects/:id/director-fee`）は `requireAnyPermission('project.create_edit', 'project.pricing_edit')` にする。`project.create_edit` 保持者の挙動は従来どおり。
- `project.client_price`（クライアント単価の閲覧・編集可否）は本 ADR で変更しない。ディレクターが `client_price` を持たない場合、従来どおり `client_unit_price` は 0 に潰され、レスポンスからも落ちる。
- ランク単価プリセット（`/rank-price-presets`、`category_rank_rates`）は全社マスタなので開放しない（`PRESET_ROLES` のまま）。
- 固定項目（`project_fixed_items`）は本 ADR の対象外（従来どおり `project.create_edit`）。LP 一式の扱いは「後でやる一覧 #5」と合わせて別 ADR で決める。

### 2. 承認状態は成果物グループ（line）単位に持つ

`project_estimate_lines` に以下を追加する。

| 列 | 型 | 意味 |
|---|---|---|
| `pricing_approval` | TEXT NOT NULL DEFAULT 'approved' CHECK IN ('approved','pending') | 承認状態。既存行は全件 approved |
| `pricing_requested_by` / `pricing_requested_at` | UUID / TIMESTAMPTZ | pending にした人と時刻（最初に pending へ落とした操作） |
| `pricing_prev_snapshot` | JSONB | pending へ落ちる直前の**承認済み値**（`{ client_unit_price, costs:[{role_id,user_id,unit_price,pricing_type,percentage,actual_hours}] }`）。ディレクターが新規作成した line は NULL |
| `pricing_approved_by` / `pricing_approved_at` | UUID / TIMESTAMPTZ | 最後に承認した人と時刻 |

- `project.pricing_approve` を持たない実行者が **line の作成 / `client_unit_price` 変更 / line_costs の作成・変更・削除 / D費バー保存 / プリセット一括生成 / 複製** を行うと、対象 line は `pending` になる。すでに `pending` の line への追加変更はスナップショットを上書きしない（差し戻しは常に「最後に承認された値」へ戻る）。
- 単価に影響しない操作（`name` / `sort_order` / `planned_count` / `is_active` / `status` の変更、並び替え）は承認状態を変えない。
- `project.pricing_approve` 保持者（admin）の書き込みは即 `approved`（承認待ち line を admin が編集した場合も、その保存で承認扱いにする）。

### 3. 承認待ちの単価は**即座に有効**

- `resolveCreativeRoleCost` / `buildCreativeLineCandidates` は `pricing_approval` で候補を絞らない。集計・請求プレビュー・振込差分チェック・クリエイティブ登録時の単価表示は承認待ちの値をそのまま使い、「🕓 承認待ち」と注記する。
- 例外は **請求書生成（`POST /invoices/generate`）だけ**。承認待ち line を単価根拠に含む明細があれば 400 で止め、対象 line（案件名・グループ名・申請者）を返す。`GET /invoices/preview-items` は止めず `pending_lines` を添えて警告する。
- 理由: 金額が外部に出るのは請求書発行の瞬間だけであり、それ以前の工程で止めると ¥0 納品（今回の問題）が再発するため。

### 4. 承認・差し戻し

- `POST /projects/:project_id/lines/:line_id/pricing/approve` — `requirePermission('project.pricing_approve')`。`approved` にし `pricing_approved_by/at` を記録、スナップショットは消す。
- `POST /projects/:project_id/lines/:line_id/pricing/reject`（`reason` 必須）:
  - スナップショットあり → `client_unit_price` と line_costs をスナップショットの値に戻し `approved` にする。
  - スナップショット無し（ディレクターが新規作成した line）→ 紐づくクリエイティブが無ければ line を削除。あれば line_costs を全削除・`client_unit_price=0` にして `approved`（=「単価未設定」に戻す。admin が正しい単価を入れ直す）。
- `GET /pricing-approvals/pending` — `project.pricing_approve` 保持者向け。全案件横断の承認待ち一覧（案件・クライアント・グループ・現在の単価・変更前の単価・申請者・申請日時）。
- `POST /pricing-approvals/approve-all`（任意の line_id 配列）— 一括承認。

### 5. 通知

- pending が発生した API 呼び出しごとに 1 回、`is_active` な admin 全員へアプリ内通知（`createBulkNotifications`、`notification_type='pricing_approval'`。`notification_settings` の列は持たず常時 ON）＋ Slack DM（`users.slack_dm_id` があれば best-effort）。本文は「◯◯さんが【クライアント / 案件】の単価を設定しました（N グループ）承認待ち」＋案件の見積タブへのリンク。
- 承認 / 差し戻し時は申請者（`pricing_requested_by`）へアプリ内通知（差し戻しは理由を含める）。
- admin のホーム（`renderAdminDash`）に「💴 単価の承認待ち N 件」カードを出し、そこから承認・差し戻し・案件を開く、ができる。

## Consequences

- ディレクターは案件作成→成果物グループ→単価まで自分で完結でき、admin/P の人待ちが無くなる。8月型の「¥0 納品」は、ディレクターが単価を入れ忘れた場合にしか起きなくなる（入れ忘れ検知は別 ADR：登録時の単価表示・納品時警告）。
- admin は金額の最終決定権を保つ。承認待ちが溜まっても集計・支払プレビューは動き、請求書発行の直前で必ず目に入る。
- 既存データは全件 `approved` で移行するため、挙動は変わらない。`project.create_edit` 保持者（producer / PD）の書き込みは `pricing_approve` を持たないので**プロデューサーの単価変更も承認待ちになる**。これは意図した挙動（金額の確定者を admin に一本化）。運用上プロデューサーを信頼して即確定にしたい場合は権限マトリクスで `project.pricing_approve` を producer に ON にすればよい（そのために permission key にしてある）。
- 差し戻しは「最後に承認された値へ戻す」のみで、変更履歴の閲覧 UI は持たない（必要になったら `creative_edit_logs` と同型のログテーブルを足す）。
- `pricing_prev_snapshot` は line_costs の `id` を含めない（差し戻し時は delete → insert で作り直す）。line_costs の id を外部参照している箇所は無い（`invoice_items` は単価スナップショットを自前で持つ）。
- 固定項目・ランク単価プリセットは開放していない。ディレクターが LP 一式や新カテゴリの単価を入れたい場合は従来どおり admin/P に依頼する。

## Alternatives considered

- **承認されるまで単価を無効（¥0）にする** — admin 不在で ¥0 納品が再発する。却下。
- **ディレクターに `project.create_edit` をそのまま付与** — 案件編集・固定費・分割請求・シート同期まで開き過剰。承認も付けられない。却下（#1093 と同じ判断）。
- **承認を line_costs（単価行）単位に持つ** — 1 グループに editor/director/producer の 3 行があり、承認 UI が細かくなり過ぎる。差し戻しの単位も「グループの単価一式」が自然。line 単位に決定。
- **承認テーブルを別建て（申請→承認の履歴を全部持つ）** — 現時点で履歴閲覧の要件が無く、line 列＋スナップショットで足りる。必要になったら追加。
- **プロデューサーを最初から即確定にする** — ユーザー要望は「自分が承認」。permission key にしておき、運用で切り替え可能にする。
