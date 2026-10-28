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

## 追補（2026-10-28）承認待ちは管理者の Chatwork マイチャットへ必ず一報

- 承認待ちのまま放置すると請求書の発行が止まり相手を待たせる（シビアな運用）ため、ベル通知・Slack DM に加えて、承認待ちが新たに発生するたびに**管理者の Chatwork マイチャット**へ毎回送る（`notifications.js` の `notifyPricingPendingMyChat`）。
- 送信先は `resolveAdminMyChatRoomId`（env `ADMIN_MYCHAT_CHATWORK_ROOM_ID` → `BUG_REPORT_NOTIFY_CHATWORK_ROOM_ID` → `CHATWORK_API_TOKEN` 名義人のマイチャット自動検出）。admin ユーザーの有無・Slack DM の宛先の有無とは無関係に送る。
- 送れなかった場合は Slack のエラーチャンネル（`notifyAutoError`）へ回し、無言で消えないようにする。
- 通知ベルのリンク `?project=<id>&tab=estimate` は案件編集モーダルの「💰 見積・費用」タブを開く（#1261）。マイチャットのリンクも同じ。

## 追補（2026-10-28 その2）管理者専用メニュー「💴 単価承認」と毎朝のまとめリマインド

- 承認待ちが溜まっても管理者が気づけていなかった（ホームのカードは開かないと見えない）。
- **ナビ「💴 単価承認」**（permission `project.pricing_approve`・既定 admin のみ）を追加し、承認待ちの件数を赤バッジで常時表示する（`GET /api/pricing-approvals/count`・10 分ごと＋タブ復帰時）。ページ `#page-pricing-approvals` の一覧はホームカードと同じ `renderPricingApprovalsCard()` で描画（承認・差し戻し・案件を開く・すべて承認）。
- **毎朝のまとめリマインド**（`workers/pricing-pending-reminder.js`）: 承認待ちが 1 件でも残っていれば、平日 JST 10 時台に管理者の Chatwork マイチャットへ案件ごとにまとめて 1 通（待ち日数つき・リンク `?page=pricing-approvals`）。二重送信ガードは `system_settings.pricing_pending_reminder_last_date`。無効化は env `PRICING_PENDING_REMINDER_ENABLED=false`。

## 追補（2026-10-28 その3）単価の変更は「今月の納品分から」— 先月以前の納品があるグループは自動で月の境目で分ける

- **きっかけ**: さとるさんの認識は「単価の見直しは月単位。10月中に変えても、まだ請求していない9月納品分は9月の単価」。しかし実装は、同じ成果物グループの単価を書き換えると（承認の有無に関係なく）そのグループに紐づく**請求書未発行の全クリエイティブ**が新単価で計算されていた。ADR 030 の「締め月末時点で有効なグループ」は適用期間（`applies_from`/`applies_to`）でしか月を区別できず、「旧グループ停止＋新グループ作成」を人が手でやらない限り効かなかった。また単価はクリエイティブ側に保存されず、固定されるのは請求書発行時（`invoice_items`）だけ。
- **決定**: 単価に効く書き込み（`PUT /projects/:id/lines/:line_id` の client/制作者単価、`POST/PUT/DELETE /lines/:line_id/costs`、`PUT /projects/:id/director-fee` の 1本あたり）の**直前**に `splitLineForMonthlyPricing()` を通し、次の条件をすべて満たすグループは分割してから書き込み先を新グループに切り替える。
  - 停止中でない（`applies_to IS NULL`）／今月から適用のグループでない（`applies_from < 今月1日`）
  - 単価が何か入っている（`client_unit_price > 0` または line_costs に金額・％あり）。**¥0 の入れ忘れ補完は従来どおり遡って効かせる**（8月の ¥0 納品の是正経路を塞がない）
  - **先月以前（JST 今月1日 0:00 より前）に納品したクリエイティブ**が紐づいている
  - 月額定額（ADR 053）・分割支払（ADR 029 の `line_payment_installments`）が無い
- **分割のしかた**: 新グループ（同じ案件・カテゴリ・ランク・名前、`applies_from = 今月1日`）を作って line_costs を写し、**今月納品分と未納品**のクリエイティブを新グループへ付け替え、旧グループは `applies_to = 先月末日` で停止。新グループは一覧で旧グループの直前に並べる。以後の書き込みは新グループに向く（PUT/DELETE `/costs/:cost_id` は旧→新 cost id を付け替える）。
  - 請求書（`resolveCreativeRoleCost` は `creative.line_id` 直参照）も、作成本数集計（ADR 030 の月末解決）も、先月以前の納品分は旧グループ＝旧単価、今月分は新グループ＝新単価で一致する。
  - `syncCreativeLineId`（担当者変更・案件付け替え時の自動付け替え）は、納品済みなら**納品月の月末**時点で有効なグループを選ぶように変更（先月納品分が担当者の付け替えで新単価に動かないように）。
  - 停止中のグループを直接編集した場合は分けない（過去月の単価の訂正として扱う）。ディレクター費の「全グループに反映」は停止中グループを書き換えない。費用台帳同期は、同じ案件×区分×ランクに現役グループがある停止中グループを台帳に出さない・反映しない。
- **承認との関係**: 承認権限のない人が分割を伴う変更をすると、新グループが承認待ちになり、スナップショットに `split_from_line_id` / `split_applies_from` を持つ（変更前の値は旧グループの値＝旧グループが承認待ちならその「最後に承認された値」）。承認一覧には「📅 N月納品分から」と出る。**差し戻しは分ける前の 1 グループに戻す**（クリエイティブを旧グループへ戻し・新グループ削除・旧グループの停止解除、`action: 'merged'`）。新グループを消せない場合は通常の復元（単価だけ戻す）。承認権限者（admin）の変更も同じく分割される（月単位の見直しは全員共通のルール）。
- **対象外 / 宿題**: 参加申請の承認（ADR 051・新メンバーの支払先登録）は単価の見直しではないので分けない。費用台帳のインポート（admin のシート一括反映）・ランク単価プリセット・案件の LP 一式など固定項目は分割を通らない（admin 操作なので現状維持）。分割前にすでに同じグループを書き換えてしまった過去分（例: 2026-09-27 の hertech【リサイズ】動画編集コースの ¥3,000→¥1,500）は自動では直さない。
- **安全側への修正（2026-10-29・#1269 のレビュー指摘）**: 分割は `utils/pricing-month-split.js` に移し（jest で偽 DB を差して検証）、次のとおり「失敗したら分けない・書かない」に倒した。
  - 旧グループの停止を**最初に条件付き更新**（`applies_to IS NULL` のときだけ）で行い、取れなければ 409。同時保存で二重に分けない。画面では現役だと思って編集したのに停止済みなら（`?expect_active=1`）409 にして、先月分の単価を書き換えさせない（停止中と分かっていて直す＝過去月の訂正は通す）。
  - 新グループは**旧グループの承認状態を引き継いで作る**（旧が承認待ちなら作成時点で承認待ち）。既定値の承認済みで作って後から承認待ちにする順序だと、書き込み失敗時に承認前の値が承認済みとして残り、請求書を発行できてしまった。
  - 分割の途中（読み取り・作成・単価行の複製・クリエイティブの付け替え）で失敗したら元に戻して保存を止める（以前は分けずに旧グループへ書き続けていた）。分割後の書き込みが失敗したら `undoMonthlySplit` で 1 グループへ戻す。取り消しにも失敗したら自動エラー通知（Slack）へ。
  - **予定本数（planned_count）は旧（先月以前の納品数）と新（残り）で分け合う**。写すと `client_unit_price × planned_count` の売上見込みが二重になっていた。差し戻しで 1 グループへ戻すときは足し戻す。
  - 一式（fixed_total）・時給（hourly）の単価行を持つグループは分けない（予定本数で按分するため）。
  - ディレクター費「全グループに反映」は途中で失敗しても、書き終えたグループの承認状態を確定させてから返す。制作者単価の保存失敗を握りつぶさない。
