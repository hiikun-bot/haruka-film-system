---
adr: 035
status: Accepted
date: 2026-09-07
tags: [contracts, consent, legal-entity, incorporation, onboarding, audit, members, billing-parties, permissions]
related_tables: [billing_parties, contract_documents, contract_document_versions, contract_requests, member_contracts, contract_consents, contract_events, users, projects, role_permissions]
supersedes: null
superseded_by: null
related_adrs: [003, 015, 023]
---

# 035. 契約管理 — 業務委託契約の依頼URL発行・閲覧・同意・版管理・期限監視

- **Status**: Accepted
- **Date**: 2026-09-07
- **Decided by**: ユーザー（2026-09-07「すごいよさそう。それで一旦お願いします」— 調査報告書＋画面モックを承認）

## Context

- 2026-09-22 に個人事業主 髙橋聖の事業を **株式会社HARUKA FILM** として法人化する。約50名の業務委託メンバーとの基本契約を、**個人事業主との契約**と**法人との契約**の別主体として管理する必要がある。
- 業務前提（2026-09-07 ユーザー指示）:
  - 2026-09-21 までに個人として発注した案件 → 個人事業主 髙橋聖との契約
  - 2026-09-22 以降に法人名義で発注した案件 → 株式会社HARUKA FILM との契約
  - 進行中・保留中の既存案件は、**明確な切替合意がない限り個人契約のまま**。既存契約を自動承継扱いにしない
- 現状の HFS には契約書の締結・同意・版管理の機能が無い（`utils/onboarding.js:35` の `hf_contract` チェック項目のみ）。請求書の請求先は `public/haruka.html:32180` に「HARUKA FILM／高橋聖 様」が直書きで、**自社情報を持つテーブルも無い**。
- ユーザーの要望（2026-09-07 追加）: CloudSign のように「誓約書の登録お願いします」という **URL を発行**して送り、システム内で **誰がいつ閲覧・同意したか**を管理し、**期限切れをアナウンス**し、**新メンバーのオンボーディングの一環**として扱いたい。
- 法的有効性（HFS 内同意が電子署名法上どう評価されるか、第30条2項の承継の効力等）は本 ADR で断定しない。弁護士確認事項は `docs/design/open-questions.md` ではなく、調査報告書（2026-09-07）の第Ⅰ部 §4 / 第Ⅱ部 §20 に列挙済み。締結方法を区分（`execution_method`）で持ち、基本契約だけ外部電子契約へ切り替えられる構造にしておく。

## Decision

**契約主体マスタ（billing_parties）を新設し、文書（版付き・公開後 immutable）→ 依頼（URLトークン）→ メンバー契約（状態機械）→ 同意証跡（append-only・ハッシュチェーン）→ 操作履歴 の5層で契約手続きを HFS 内に持つ。** PDF 原本は Drive、DB には file_id と SHA-256。同意は「本人認証済みセッション＋署名者名入力＋IP/UA＋文書ハッシュ」を記録し、管理者の承認で「締結済み」にする。期限・催促・再同意はワーカーが Chatwork/Slack DM で案内する。

### スキーマ（Stage 1 = `migrations/2026-09-07_contracts.sql`）

migration 本文が正。要点:

| テーブル | 役割 | 要点 |
|---|---|---|
| `billing_parties` | 契約主体マスタ（自社情報） | `individual_takahashi` / `haruka_film_inc` の2行を seed。本店所在地・法人番号・登録番号・管轄は **未確定のため NULL**。管理画面（Stage 2 以降）から編集。将来は請求書テンプレの請求先もここを参照する（ADR 023 Alternative 1 への移行） |
| `contract_documents` | 文書マスタ | `doc_type`: basic_agreement / rules_confirmation / client_pledge / succession_notice / amendment_memo / individual_contract / termination_notice。`party_code` NULL=主体を問わない。`client_id` は client_pledge 用 |
| `contract_document_versions` | 文書バージョン | `UNIQUE(document_id, version_no)`。`status` draft→published→superseded/retired。**published 以降は本文・PDF・ハッシュ・適用日をトリガーで変更不可**。`requires_reconsent` true なら公開時に旧版の有効契約を `reconsent_required` にする |
| `contract_requests` | 依頼（URL 単位） | `token` UNIQUE（32バイト乱数 base64url）。1依頼＝1メンバー×複数文書。`draft_state` に途中保存。`due_date` 回答期限。`onboarding_record_id` で連携 |
| `member_contracts` | メンバー契約 | メンバー×文書×主体。`status` は下記状態機械。`execution_method` hfs / external_esign / paper / email / chat / other。旧契約は `predecessor_contract_id` で連結。**同一文書で `active` はメンバーごとに1件**（部分ユニーク） |
| `contract_consents` | 同意・閲覧証跡 | append-only（UPDATE/DELETE をトリガーで拒否）。`consent_kind` viewed / agreed / acknowledged。`record_hash` = SHA-256(主要列 + prev_record_hash) のチェーン |
| `contract_events` | 操作履歴 | append-only。承認・修正依頼・催促・口座全桁表示・PDF DL などすべて |
| `users` 追加列 | 本人入力 | `business_type` / `trade_name` / `representative_name` / `name_kana` / `invoice_name` / `profile_confirmed_at`。既存の住所・電話・口座・登録番号列をそのまま使う |
| `projects` 追加列 | 案件の契約主体 | `contracting_party`（NULL=未設定。自動確定しない）/ `party_switch_agreed_at` |

FK 方針: `member_contracts.user_id` / `contract_requests.user_id` は `ON DELETE RESTRICT`（契約記録を持つメンバーは物理削除不可。退会は deactivate）。`contract_consents.user_id` / `contract_events.*_user_id` は FK なし（証跡を永続化）。

### 権限（ADR 003 / 015 準拠）

| key | 既定ロール | 意味 |
|---|---|---|
| `contract.page` | admin | 契約管理ページの全操作（文書公開・依頼・承認・修正依頼・外部締結登録・設定） |
| `contract.view` | producer / producer_director（兼任者のみ）| 契約管理ページの**参照のみ**。返す列は状態・主体・文書/版・日付だけ。住所・口座・同意記録本文・IP は返さない |
| `contract.bank_reveal` | admin | 口座番号の全桁表示。表示操作は `contract_events(action='bank_revealed')` に記録 |
| （本人） | 全ロール `requireAuth` | 自分の依頼・契約・同意記録・PDF のみ。`user_id = req.user.id` を必ず条件に入れる。admin バイパスなし |

`routes/haruka.js` の `VALID_PERMISSION_KEYS` に3キーを追記する（漏れると権限マトリクスで 400）。ナビ表示・VIEW AS 再描画リストの更新は ADR 015 チェックリストを通す。

### 状態機械（member_contracts.status・アプリ層で遷移をガード。CHECK は付けない）

```
                 依頼発行              本人が送信            管理者承認
  (new) ──────▶ requested ───────▶ submitted ───────▶ active ──▶ ending ──▶ ended
                   │  ▲               │                 ▲   │(終了日設定/退会)   ▲
                   │  │ 本人再送信      │ 管理者「修正依頼」 │   └─ 後継契約が active になった時に自動で ended
                   │  └───────── revision_requested     │
                   │                                    │ 新版公開(requires_reconsent) で
                   └─ 管理者取消 → cancelled             └── reconsent_required ──(新版に同意→新 member_contract が submitted)
```

| 状態 | 制作者向け表示 | 遷移させる操作 |
|---|---|---|
| `requested` | 未着手（依頼あり）／入力中（`draft_state` あり） | 管理者「依頼を発行」 |
| `submitted` | 確認待ち | 本人が署名者名を入力して送信 |
| `revision_requested` | 修正依頼あり | 管理者「修正依頼」（理由必須）→ 本人再送信で submitted |
| `active` | 契約手続き完了 | 管理者「承認」。`contract_date`=承認日（外部締結は入力値） |
| `ending` | 契約手続き完了（終了予定） | 管理者が終了日を設定／退会処理 |
| `ended` | （履歴） | 終了日到来（ワーカー）／管理者「終了」／後継契約の active 化 |
| `reconsent_required` | 再同意が必要 | 新版公開時に自動。旧契約は本人が新版に同意→承認されるまで **有効扱い** |
| `cancelled` | — | 管理者が依頼を取り消し |

「未閲覧／閲覧済み」は状態ではなく `first_viewed_at` / `viewed_completed_at` と `contract_consents(consent_kind='viewed')` で表現する。

### 同意証跡の記録内容（contract_consents）

送信時に文書ごとに1行 `agreed`（確認書は `acknowledged`）。記録: `user_id` / `user_email` / `signer_name_typed` / `signer_name_registered`（当時の `users.full_name`）/ `party_code` / `document_version_id` / `consented_at` / `ip_address`（`server.js:191` の `getClientIP` と同等の正規化）/ `user_agent` / `pdf_sha256` / `body_sha256` / `fill_snapshot`（差し込み値）/ `prev_record_hash` / `record_hash`。

`record_hash` = SHA-256 of JSON `[member_contract_id, user_id, document_version_id, consent_kind, signer_name_typed, consented_at(ISO), ip_address, user_agent, pdf_sha256, body_sha256, JSON.stringify(fill_snapshot), prev_record_hash]`（`utils/contract-hash.js` の純関数）。`prev_record_hash` は同一 `member_contract_id` の直前レコード（無ければ null）。

署名者名は `users.full_name` とスペース・全角半角を正規化して一致必須（`utils/contract-state.js: normalizeName`）。不一致は 400「登録氏名と同じ表記で入力してください」。

### 依頼URLとディープリンク

- URL: `/haruka.html?contract_req=<token>`。未ログインなら既存の `requireAuth` が `/login.html?next=` で戻す（`auth.js:84-99`）。
- フロントは起動時に `contract_req` を読んで `showPage('contract')` → `GET /api/haruka/contracts/req/:token`。**トークンが他人のものなら 403**（本人の依頼一覧を表示）。
- トークンは `crypto.randomBytes(32).toString('base64url')`。`token_expires_at` 既定 90 日（期限切れでも本人はメニューから同じ依頼に入れる。URL だけ無効）。

### API（Stage 2 = `routes/contracts.js`、`server.js` で `app.use('/api/haruka/contracts', …)` を `harukaRouter` より前に mount）

共通: すべて JSON。エラーは `{ error: '日本語メッセージ' }`。テーブル未作成時は 503 `{ error: '契約管理テーブルが未作成です。migrations/2026-09-07_contracts.sql を適用してください' }`（`routes/haruka.js:23055` の onboarding パターン）。日時は UTC ISO で返し、表示は JST。

**本人（requireAuth・`req.user.id` 固定）**

| M | path | 内容 |
|---|---|---|
| GET | `/me` | 自分の依頼一覧＋契約一覧＋手続き状態サマリ `{ requests:[…], contracts:[…], pending_count, banner:{kind:'requested'|'revision'|'reconsent'|null, request_id} }` |
| GET | `/req/:token` | 依頼詳細 `{ request, party, documents:[{member_contract_id, document, version:{id,version_no,version_label,effective_from,pdf_sha256,fill_fields}, status, viewed_completed_at}], profile:{…users 本人列。口座は masked と full 両方（本人）…}, fill_values:{…} }`。初回アクセスで `first_viewed_at` を記録し `contract_events(viewed)` |
| PUT | `/req/:token/draft` | `{ draft_state, profile:{full_name,name_kana,email,phone,postal_code,address,business_type,trade_name,representative_name,invoice_name,invoice_registration_number,bank_name,bank_code,branch_name,branch_code,account_type,account_number,account_holder_kana} }`。profile は `PUT /members/:id` と同じ検証（登録番号 `^T\d{13}$`、Google 以外メール拒否 #1128）で users を更新し `profile_confirmed_at=now()`。draft は `contract_requests.draft_state` |
| POST | `/req/:token/viewed` | `{ member_contract_id, completed:true }` → `viewed_completed_at`、`contract_consents(viewed)`、events |
| POST | `/req/:token/submit` | `{ signer_name, agreed_member_contract_ids:[…] }`。全文書が `viewed_completed_at` 済み・署名者名一致を検証 → consents(agreed/acknowledged) INSERT（チェーン）→ member_contracts `submitted`、`fill_snapshot` 確定 → request `submitted` → 管理者へ通知。返り値に `receipt`（控え用データ） |
| GET | `/member-contracts/:id/receipt` | 同意記録の控え（本人 or contract.page）。JSON。フロントが印刷CSSで PDF 保存 |
| GET | `/versions/:id/pdf` | PDF ストリーム（本人にその版の member_contract がある or contract.page）。`Content-Disposition: inline`。events(pdf_downloaded) |

**管理者（`requirePermission('contract.page')`。`contract.view` は GET 一覧・詳細の限定列のみ）**

| M | path | 内容 |
|---|---|---|
| GET | `/parties` / PUT `/parties/:code` | 契約主体マスタ（PUT は contract.page） |
| GET | `/documents` | 文書＋版一覧 |
| POST | `/documents` | `{ doc_type, party_code, client_id, title, description }` |
| POST | `/documents/:id/versions` | multipart `pdf`（≤20MB・application/pdf のみ）＋ `version_label, effective_from, change_summary, requires_reconsent, body_html, fill_fields`。Drive「契約書/文書原本」へ upload（`system_settings.contract_root_folder_id`、無ければ `invoice_root_folder_id` と同じ親に `契約書` を作成）。SHA-256 をサーバーで計算。`version_no` は max+1。status draft |
| POST | `/versions/:id/publish` | draft→published。同 document の published を superseded に。`requires_reconsent` なら旧版の active/ending を `reconsent_required` に更新し events。**本人への再同意依頼は別途 `POST /requests` で発行**（自動送信しない） |
| GET | `/requests?status=&party=&q=&doc=` | 一覧（メンバー単位に集約: 最新の依頼／有効契約／期限／再同意フラグ）。contract.view は限定列 |
| POST | `/requests` | `{ user_ids:[…], party_code, version_ids:[…], due_date, start_date, auto_renew, renew_notice_days, message, send:true, onboarding_record_id }` → メンバーごとに request＋member_contracts を作成、送信（下記通知）。返り値 `[ {user_id, request_id, url, sent, channel} ]` |
| POST | `/requests/:id/remind` | 催促送信（events reminded, remind_count++） |
| POST | `/requests/:id/cancel` | 依頼取消（member_contracts→cancelled） |
| GET | `/member-contracts/:id` | 詳細（contracts, consents, events, profile。口座は `****下4桁`） |
| POST | `/member-contracts/:id/approve` | submitted→active。`approved_at/by`、`contract_date`=JST 今日（body で上書き可）。同 user・同 document の他 active/ending/reconsent_required を ended。オンボーディング連携: request.onboarding_record_id があれば `onboarding_tasks(task_key='hf_contract')` を done |
| POST | `/member-contracts/:id/revision` | `{ reason }` 必須 → revision_requested、本人へ通知 |
| POST | `/member-contracts/:id/end` | `{ end_date, reason }` → ending（end_date 未来）/ ended |
| POST | `/member-contracts/external` | 既存契約の登録: `{ user_id, party_code, document_id, version_id?, execution_method, contract_date, start_date, end_date, auto_renew, switch_method, switch_date, has_existing_projects, existing_projects_party, billing_party_code, storage_note, note }` ＋任意 multipart `pdf`（外部締結PDF）→ status active、events(external_registered) |
| POST | `/member-contracts/:id/bank-reveal` | `contract.bank_reveal`。`{ account_number }` を返し events(bank_revealed) |
| GET | `/events?member_contract_id=&user_id=&limit=` | 操作履歴 |
| GET/PUT | `/settings` | `system_settings` の `contract_remind_interval_days`(3) / `contract_due_notice_days`(3) / `contract_expiry_notice_days`('60,30') / `contract_renewal_notice_days`(30) / `contract_root_folder_id` / `contract_notify_chatwork_room_id` / `contract_admin_summary_slack_user_ids`。PUT は contract.page（`PUT /system-settings` は最高管理者限定なので別経路） |

### 通知（`utils/contract-messages.js` 純関数 ＋ 送信は振込管理の経路を共通化）

送信先の優先順（`routes/haruka.js:24662-24730` と同じ）: `users.chatwork_direct_room_id` → `system_settings.contract_notify_chatwork_room_id` に `[To:chatwork_dm_id]`（数字IDのみ）→ `users.slack_dm_id` に `sendSlackDm`（bot 名義。`payout_slack_user_token` があれば本人名義）。メールは送らない（基盤なし）。

文面（例。実装は純関数でテスト）:
- 依頼: 「◯◯さん、お疲れさまです。株式会社HARUKA FILMとしての『業務委託基本契約書』と『業務ルール確認書』のご確認・ご同意をお願いします。下記URLからHARUKA FILM SYSTEMにログインして進めてください（所要 約10分）。\n{url}\n回答期限：{due}」
- 催促: 「{date}にお送りした『{docs}』のご同意がまだ完了していません。回答期限は{due}です。」
- 修正依頼: 「ご入力内容について確認をお願いしたい点があります。\n{reason}\n{url}」
- 承認: 「『{docs}』の契約手続きが完了しました。契約書PDFと同意記録の控えはHARUKA FILM SYSTEMの「契約・登録手続き」からダウンロードできます。」
- 再同意: 「『{doc}』が{version}に改訂されました（変更点：{summary}）。新しい版へのご同意をお願いします。同意までは現在の版が有効のままです。\n{url}」
- 期限（本人）: 「『{doc}』（{party}・{contract_date}締結）の有効期限が{end}に来ます。特にお申し出がなければ同じ条件で1年間自動更新されます。更新を希望されない場合は{renew_deadline}までにご連絡ください。」
- 管理者日次サマリ（Slack DM）: 確認待ち／未対応（3日以上未閲覧）／期限切れ／30日以内／再同意必要 の件数と一覧URL

### ワーカー（`workers/contract-reminder.js`・毎日 10:00 JST・`onboarding-stall-reminder.js` の型）

1. 未対応催促: `contract_requests.status='open'` かつ `last_reminded_at`（無ければ `sent_at`）から `contract_remind_interval_days` 経過 → 本人へ催促（1日1回・JST 10〜18時）
2. 回答期限: `due_date` の `contract_due_notice_days` 前と当日 → 本人
3. 有効期限: `member_contracts.status in ('active','ending')` の `end_date` の 60日前・30日前（`expiry_notice_stage` で二重送信防止）→ 本人＋管理者
4. 更新拒絶期限: `auto_renew` の `end_date - renew_notice_days` の 30日前 → 管理者
5. 終了日到来: `ending` → `ended`（自動更新契約は `end_date` を +1年して active のまま、events に `renewed`）
6. 管理者日次サマリ

### フロント（Stage 3・`public/haruka.html` ＋ `public/js/contract-wizard.js` ＋ `public/js/contract-admin.js` ＋ `public/css/contract.css`）

- ナビ: PC ヘッダー（`haruka.html:3992-4010`）とモバイルドロワー（`4121-4143`）の**両方**に追加。本人用「📝 契約・登録手続き」`data-page="contract"`（全ロール）／管理者用「📝 契約管理」`data-page="contract-admin"` `id="nav-contract-admin"`（`hasPermission('contract.page') || hasPermission('contract.view')`）。VIEW AS 再描画リストに両ページを追加。
- ページ: `#page-contract`（ウィザード 6 ステップ・途中保存・再開）、`#page-contract-admin`（一覧／詳細モーダル／文書バージョン／既存契約の登録／履歴／設定）。画面構成は 2026-09-07 の画面モック（7画面）に従う。
- ホームバナー: `GET /contracts/me` の `banner` が非 null のとき表示。
- 名前表示は `NameDisplay` 経由。ステータスは `statusClass()` に `契約:*` 系のクラス追加ではなく、`contract.css` の `.cchip.c-*` を使う（既存 `status-chip` を汚さない）。
- 口座番号は本人以外へは `****下4桁`。全桁は「全桁を表示（履歴に残ります）」ボタン → `bank-reveal`。
- ガイド: `public/guide-contract.html` 新規＋ `public/guide.html` Hub にリンク。トーンは `guide-member-register.html`。

### 既存メンバーの移行（運用）

1. 管理者が「文書バージョン」で個人版 v1（現行PDF）と法人版 v1 を登録・公開。
2. 「既存契約の登録」で各メンバーの旧契約を `external` 登録（締結方法・日付・保存場所）。
3. 法人版を「依頼を発行」で一括送信（案2: 新規締結）。承認時に旧契約は `ending`（終了日＝進行中案件の完了予定）。
4. 案件の `contracting_party` は自動確定しない。9/21 以前作成の案件を候補として一覧し管理者が確定する UI は将来 Stage。

## Consequences

- 解決: 契約主体の分離、依頼URL、閲覧・同意の証跡、版管理と再同意、期限・催促の自動化、オンボーディング連携（承認→`hf_contract` 自動チェック）、既存契約の登録。
- 残る: 請求書の請求先直書き（`haruka.html:32180`）の `billing_parties` 参照化、振込管理の主体別消し込み、案件の契約主体バックフィル UI、口座番号の列暗号化（`utils/crypto-aes.js` 流用）、サーバー側 PDF 結合（pdfkit 等はパッケージ追加＝要承諾）、外部電子契約 API、外部タイムスタンプ。
- 法的評価は未確定。弁護士確認の結果、基本契約を外部電子契約にする場合は `execution_method='external_esign'` で登録し、HFS 内同意は確認書・誓約書・通知に限定する運用に切り替えられる。
- `member_contracts.user_id` の RESTRICT により、契約記録のあるメンバーは `DELETE /members/:id` が失敗する（意図どおり。deactivate を使う）。

## Alternatives

1. **オンボーディングのチェック項目を拡張して PDF 添付だけ持つ** — 誰がいつ同意したかの証跡と版管理が持てず、再同意・期限監視ができないため不採用。
2. **最初から外部電子契約（クラウドサイン等）に全面依存** — 月額＋件数課金と二重管理が発生し、確認書・通知など軽い文書にも課金される。基本契約のみ外部に切り替えられる構造で十分と判断。
3. **ステータスを1テーブルの列ではなく `announcement_acks` 型の既読テーブルだけで表現** — 修正依頼・再同意・終了予定などの状態を持てないため不採用。証跡テーブルの設計は `announcement_acks` / `version_log_reads` を参考にした。
4. **`users` に契約日・契約主体の列を直接追加** — 版・履歴・複数文書に対応できないため不採用。
