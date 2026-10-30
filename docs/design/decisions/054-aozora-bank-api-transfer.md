---
adr: 054
status: Proposed
date: 2026-10-29
tags: [payout, bank-api, security, withholding, invoices]
related_tables: [bank_api_connections, payout_transfer_batches, payout_transfer_items, bank_api_audit_logs, payout_records, users, invoices, role_permissions]
supersedes: null
superseded_by: null
related_adrs: [015, 017, 035, 046, 047]
---

# 054. GMOあおぞらネット銀行 API による総合振込と源泉徴収台帳

- **Status**: Proposed
- **Date**: 2026-10-29
- **Decided by**: ユーザー（hiikun.ascs@gmail.com）

## Context

法人化（2026-09-22 設立・GMOあおぞらネット銀行 法人口座）後も、メンバーへの月次報酬は
振込管理画面（`payout_records`）で消し込みしつつ、銀行画面で1件ずつ手で振り込んでいる。
あおぞらの法人向けオープン API（REST/JSON・OAuth2・利用料無料、振込手数料は通常どおり）で
総合振込を HFS から依頼できるようにしたい（2026-10-29 さとるさん依頼）。

同時に、法人として毎月の源泉所得税の納付・年末の支払調書が必要になる。振込を API 経由にすると
「誰に・いつ・いくら支払い・源泉をいくら預かったか」が機械的に残るので、税理士に渡せる台帳も同じ設計で持つ。

仕様の根拠は「オープンAPI仕様書 法人口座編 1.21.0（2026-09-14）」と「認可仕様（OpenID Connect編）」。
要点:

- 総合振込依頼 `POST /bulktransfer/request` は **依頼を受け付けるだけ**（resultCode=2:未完了）。
  本人が銀行のメール → 銀行画面でトークン認証（依頼承認）して初めて送金が確定する。承認しないまま期限が切れると 8:期限切
- 承認不要で完了になるのは (1) 全件が自社口座間の振替 (2) **ビジネスID管理で API 利用者に自動承認権限がある** (3) リスクベース認証（新規受付停止）。
  → (2) を付けなければ、HFS が何をしても本人の承認なしに送金されない
- `Idempotency-Key` ヘッダで二重依頼を防げる（同一キーは24時間、受付1回）
- 認可は Authorization Code フロー。`scope` に `offline_access` を含めるとリフレッシュトークンが出る。アクセストークンは `expires_in`（例 2,592,000 秒）
- 明細: 銀行コード4桁・支店3桁・科目コード（1:普通 2:当座）・口座番号7桁（前ゼロ）・受取人名は半角カナ30字まで。1依頼 9,999 件まで

## Decision

**あおぞら API の総合振込依頼を振込管理画面から出せるようにする。ただし「送金の確定（依頼承認）は必ず本人が銀行側で行う」設計を崩さない。**
あわせて、支払の実績から源泉徴収台帳を作り、納付・支払調書用の集計を Google スプレッドシートに出せるようにする。

### 1. 守るべきセキュリティ条件（実装の前提・すべて必須）

1. **銀行側**: API 利用申込時に「自動承認権限なし」で設定し、以後も付けない。スコープは
   `private:bulk-transfer`（依頼・手数料事前照会・取消）＋ `corp:bulk-transfer`（結果照会・状況照会）の最小限。
   残高・入出金明細（`*:account`）は要求しない
2. **依頼できる人**: 新権限 `payout.transfer`（admin のみ true）**かつ** `requireSuperAdmin`（`SUPER_ADMIN_EMAILS`）。
   VIEW AS（X-View-As）での昇格は効かない（ADR 015）。`payout.page` を持つだけでは依頼できない
3. **依頼直前の再認証**: 依頼 API は、セッションに「10分以内の再認証」が無ければ 401 `reauth_required` を返す。
   再認証は Google ログイン（`/auth/google/reauth`）。Google ログイン無効時はパスワード再入力（bcrypt 照合）
4. **口座変更ガード**: `users` の口座列（bank_code / branch_code / account_type / account_number / account_holder_kana）が変わったら
   `users.bank_info_updated_at` を更新（DB トリガ）。変更から **7日間** はその人を依頼対象に含めない（画面に ⚠ と残日数）。
   変更時は本人のマイチャットと管理者マイチャットへ即通知（`notifyMember(..., { privateOnly: true })`）
5. **金額・口座はサーバーで組み立てる**: 画面から受け取るのは `payout_record_id` の配列と振込指定日だけ。
   金額は請求書（`invoices` 提出済/承認済・同 issuer_id/year/month）の `payout_amount`（exclusive）/ `total_amount`（inclusive）。
   請求書が無いときだけ `payout_records.invoice_amount` を使い、明細に「請求書なし（PDF抽出額）」の警告を付ける。
   口座は `users` の列から変換（下記 §4）。総合振込手数料事前照会 API を通し、件数・合計が一致したときだけ依頼する
6. **承認時の突き合わせ**: 依頼を受け付けた瞬間、管理者マイチャットへ「受付番号・件数・合計・各人の氏名＋口座下4桁＋金額」を送る。
   銀行画面での承認はこれと照合してから行う（メールのリンクは踏まず、アプリ／ブックマークから入る運用）
7. **トークン**: `utils/crypto-aes.js`（AES-256-GCM）で暗号化して DB 保管。鍵は `AOZORA_TOKEN_ENCRYPTION_KEY`（Railway 環境変数）。
   ログにトークン・口座番号を出さない。依頼・取消・接続・切断・失敗・トークン更新は `bank_api_audit_logs` に残す
8. **機能フラグ**: `ENABLE_AOZORA_TRANSFER=true` のときだけ接続・依頼ルートを登録する（既定 OFF）。`AOZORA_ENV=staging|production` で
   `stg-api.gmo-aozora.com` / `api.gmo-aozora.com` を切り替える

HFS 側の既知の弱点（パスワードログインに総当たり対策なし・管理者セッション7日）は、本 ADR と別 PR で
「失敗5回で15分ロック」「管理者ロール保有者のセッション 24 時間」を入れる（§7 Stage E）。

### 2. データモデル（Stage A: migration）

```
bank_api_connections            … 1 provider につき有効1件
  id, provider ('gmo_aozora'), environment ('staging'|'production'),
  account_id (口座ID・12-29桁), account_label, scopes,
  access_token_enc/iv/tag, refresh_token_enc/iv/tag, access_token_expires_at,
  connected_by → users, connected_at, revoked_at, last_used_at, updated_at

payout_transfer_batches         … 総合振込依頼 1回 = 1行
  id, connection_id, year, month, idempotency_key (uuid, UNIQUE),
  transfer_designated_date (date), transfer_data_name,
  total_count, total_amount, fee_precheck (jsonb), request_summary (jsonb: 各明細の氏名・下4桁・金額),
  apply_no (16桁), result_code ('1'|'2'|'8'),
  status ('requested'|'awaiting_approval'|'approved'|'processing'|'completed'|'expired'|'cancelled'|'failed'),
  requested_by → users, requested_at, approved_at, completed_at, last_polled_at, last_error,
  created_at, updated_at

payout_transfer_items           … 明細（依頼時点の口座・金額のスナップショット）
  id, batch_id → batches, payout_record_id → payout_records, user_id → users, item_id (1〜),
  bank_code, branch_code, account_type_code, account_number (7桁), beneficiary_name (半角カナ),
  amount, invoice_id → invoices (null可), amount_source ('invoice'|'pdf'),
  gross_amount, tax_amount, withholding_amount (請求書から転記・台帳用),
  status ('pending'|'completed'|'returned'|'failed'), error_detail (jsonb),
  UNIQUE (batch_id, item_id)

bank_api_audit_logs
  id, actor_user_id, action ('connect'|'disconnect'|'token_refresh'|'precheck'|'request'|'poll'|'cancel'|'complete'|'error'),
  connection_id, batch_id, detail (jsonb・秘密情報なし), ip_address, user_agent, created_at

users
  + bank_info_updated_at TIMESTAMPTZ  （トリガ: 口座列が IS DISTINCT FROM のとき now()）
payout_records
  + paid_via TEXT ('manual'|'aozora_api')・transfer_item_id → payout_transfer_items
role_permissions
  + 'payout.transfer'（admin true・他 false）
```

RLS は全テーブル ENABLE（ADR 048・service_role のみアクセス）。

### 3. API（Stage B）— すべて `/api/haruka/admin/...`・`requireAuth` + `requirePermission('payout.transfer')` + `requireSuperAdmin`

| メソッド/パス | 役割 |
|---|---|
| `GET  /bank/connection` | 接続状態（provider・environment・account_label・scopes・expires・connected_by）。トークンは返さない |
| `GET  /bank/connect` | 認可 URL へリダイレクト（state = HMAC＋10分期限＋セッション nonce、`utils/google-login.js` と同方式） |
| `GET  /bank/callback` | code → token。口座一覧照会で account_id を取り、暗号化保存 |
| `POST /bank/disconnect` | revoked_at を立てる（トークン列は NULL に） |
| `POST /payouts/transfer/preview` | body `{year, month, payout_record_ids[], transfer_designated_date}` → サーバーで明細を組み立て、検証（§4）→ 手数料事前照会 → `{preview_token, items[], warnings[], excluded[], total_count, total_amount, fee}`。preview_token は HMAC 署名付き・10分期限・明細ハッシュを含む |
| `POST /payouts/transfer/request` | body `{preview_token}`。再認証チェック（§1-3）→ 同じ明細を再構築してハッシュ一致を確認 → `Idempotency-Key` 付きで依頼 → batches/items 保存 → 管理者マイチャットへ要約 → `{batch_id, apply_no, result_code}` |
| `GET  /payouts/transfer/batches?year&month` / `GET .../batches/:id` | 一覧・詳細（明細の口座は下4桁のみ） |
| `POST /payouts/transfer/batches/:id/poll` | 手動で結果照会→状況照会を実行 |
| `POST /payouts/transfer/batches/:id/cancel` | 総合振込取消依頼（これも銀行側承認が要る） |
| `GET  /auth/google/reauth?next=` | 再認証。成功で `req.session.reauth_at = now` |

ワーカ `workers/bank-transfer-poller.js`（10分ごと・JST）: `awaiting_approval`/`approved`/`processing` の batch を
結果照会 → 1:完了なら状況照会 → 明細ごとに `completed`/`returned`。全件 completed で batch を `completed` にし、
各 `payout_records` を `status='paid', paid_via='aozora_api', paid_at=振込日` に更新して、既存の `buildPayoutMessage` で本人へ通知
（現在の「振込完了→送信」と同じ文面・同じ経路）。`expired` になったら管理者マイチャットへ知らせる。

### 4. 口座情報の変換と検証（`utils/zengin-format.js`・純関数）

- 銀行コード: 数字4桁に前ゼロ／支店コード: 数字3桁に前ゼロ／口座番号: 数字7桁に前ゼロ（8桁以上はエラー）
- 科目: `普通`→1、`当座`→2、`貯蓄`→4。未設定はエラー
- 受取人名: `account_holder_kana`（全角カナ）→ 半角カナへ変換、許容文字（半角カナ・英大文字・数字・` ( ) - . / \ ｰ`等）以外は除去し、
  除去があれば警告。30字で切る（銀行側も31字以降は切り捨て）。空ならエラー
- 以下は依頼対象から **除外**して `excluded[]` で理由を返す: 口座列に不備・`bank_info_updated_at` が7日以内・`status='paid'` 済み・
  `is_active=false`・金額が 0 以下・同月に `completed`/`awaiting_approval` の明細がすでにある人（二重振込防止）

### 5. 源泉徴収台帳と出力（Stage D）

対象は「支払日ベース」で集計する（源泉所得税は支払った月で納付する）。

- データ源: `payout_transfer_items`（completed・`completed_at`）＋ 手動振込の `payout_records`（paid・`paid_at`）を
  `invoices`（同 issuer_id/year/month・提出済/承認済）に結合。exclusive の請求書は `subtotal_amount / tax_amount / withholding_amount / payout_amount`、
  inclusive（旧方式・源泉なし）は `total_amount` のみで源泉 0。請求書が無い支払は「要確認」行として出す
- `GET /admin/withholding/summary?year&month` … 支払月ごとの 人数・支払金額（税込）・源泉徴収税額・差引支払額・要確認件数
- `POST /admin/withholding/export-sheet` `{year, month}` または `{year}` … `createSheetWithData()` で
  (a) **月次 納付用**（支払年月・区分「報酬・料金等（所得税法204条1項）」・人数・支払金額・税額）
  (b) **年次 支払調書用**（氏名・住所・区分・細目・年間支払金額・年間源泉徴収税額・法人/個人・インボイス番号）
  (c) **支払台帳**（支払日・氏名・請求書番号・税抜・消費税・源泉・差引・経路 manual/aozora_api・受付番号）
- **マイナンバーは HFS に持たない**（支払調書の提出時に税理士側で別管理）。住所・氏名は既存の `users` 列を使う
- 毎月1日 10:00 JST に、前月分の集計（人数・税額）を管理者マイチャットへ送る（納付期限は翌月10日）。
  ※ 納期の特例（半年ごと）は給与・税理士報酬等が対象で、デザイン・制作報酬は対象外の見込み。**税理士と確認してから運用を決める**
- 源泉の対象かどうか（個人／法人・業務の種類）は既存の `invoices.withholding_enabled`（ADR 046・`business_type` 由来）に従う。判定の変更は本 ADR の範囲外

### 6. 画面（Stage C・振込管理 `#page-payout`）

```
💸 振込管理（2026年10月分）                 🏦 あおぞら: 接続中（本店 普通 ****8906） [切断]
┌──┬──────────┬──────────┬────────┬──────────┐
│☑ │メンバー   │請求書    │振込額    │口座       │
├──┼──────────┼──────────┼────────┼──────────┤
│☑ │山田 花子  │INV-2610-03│  98,977 │✅         │
│☑ │佐藤 太郎  │INV-2610-07│ 152,340 │✅         │
│☐ │鈴木 一郎  │なし(PDF)  │  45,000 │⚠ 口座変更から3日│
└──┴──────────┴──────────┴────────┴──────────┘
[🏦 あおぞらに総合振込を依頼（2件・251,317円）]
   ↓ 確認モーダル: 明細・合計・振込指定日・手数料(事前照会)・警告 → [Google で再認証して依頼する]
   ↓ 受付後: 「受付番号 2026…。銀行アプリで内容を確認して承認してください」＋マイチャット要約
📋 依頼履歴（この月）: 受付番号 / 件数 / 合計 / 状態（承認待ち→手続中→完了）/ [最新の状態を取得] [取消依頼]
```

- 既存の「振込完了→送信」「消し込み」は残す（API を使わない手動振込の経路）
- 「振込額」列は §1-5 の規則で表示。手動で変えられない（請求書側を直す）
- 「源泉徴収」タブ（または経営分析の一角）に §5 の月次集計と出力ボタン

### 7. 段階と PR

| Stage | 内容 | ラベル |
|---|---|---|
| A | migration（§2）＋ pending-migrations へコピー | needs-db-migration |
| B | `utils/aozora-api.js`（OAuth・トークン更新・各 API・冪等キー）／`utils/zengin-format.js`／ルート／ワーカ／再認証 | draft → A 適用後 Ready |
| C | 振込管理画面の選択・確認モーダル・履歴・接続状態 | draft → B 後 |
| D | 源泉徴収台帳の集計 API・シート出力・月初リマインド | draft → A 後 |
| E | ログイン強化（失敗5回で15分ロック・管理者セッション24時間）※本 ADR と独立 | — |

環境変数: `ENABLE_AOZORA_TRANSFER`, `AOZORA_ENV`, `AOZORA_CLIENT_ID`, `AOZORA_CLIENT_SECRET`,
`AOZORA_TOKEN_ENCRYPTION_KEY`（`openssl rand -base64 32`）, `AOZORA_CALLBACK_HOST`（任意・既定は Google ログインと同じ許可ホスト）。
さとるさん側の手続き: あおぞら法人ネットバンキングから API 利用申込（client_id / secret・接続通知書）、リダイレクト URI
`https://<host>/api/haruka/admin/bank/callback` の登録、**自動承認権限なし**の確認。申込前は `AOZORA_ENV=staging`（sunabar）で検証する。

## Consequences

- 月末の振込が「HFS で選んで依頼 → 銀行アプリで承認」の2操作になる。HFS が乗っ取られても承認は本人の手に残る
- 口座のすり替え（メンバー乗っ取り→口座変更）は 7日ガードと即時通知で検知できる。これは手動振込でも効く
- 支払日ベースの台帳が自動で残り、源泉所得税の納付と支払調書の準備が集計ボタンで済む（マイナンバーは別管理）
- トークン漏えい時の被害は「依頼・取消依頼を出せる」「依頼の状況を読める」まで（残高・明細スコープを持たないため）。
  依頼は承認がなければ送金されない
- 残るリスク: 承認メールのフィッシング（運用で防ぐ）、Railway/Supabase/Google アカウントの乗っ取り（各サービスの2段階認証）

## Alternatives

- **A. 全銀フォーマットの総合振込ファイルを出力して銀行画面で取り込む**: トークンを持たず最も安全だが、
  毎月「DL→取込→承認」の手間が残り、振込済みの自動消し込みができない。さとるさんの選択で API 方式（2026-10-29）
- **B. 単発の振込依頼 API（`/transfer/request`）を人数分**: 承認が人数分必要になり、承認疲れで照合が雑になる。総合振込1回に集約
- **C. 自動承認権限を付けて完全自動化**: HFS の侵害＝送金になる。採らない
- **D. 振込額を画面で編集可能にする**: 改ざん経路になる。請求書側を直す運用にする
- **E. マイナンバーを HFS で管理して支払調書を完成まで出す**: 特定個人情報の保管義務（安全管理措置・アクセスログ・廃棄）が重く、現状の運用に見合わない。税理士側で管理
