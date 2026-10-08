# ADR 049: 提出遅れは担当ディレクター／プロデューサーへ平日朝に自動で知らせ、「日付を直す・ステータスを進める・SOS で報告」のどれかで解消してもらう

- Status: Accepted
- Date: 2026-10-08
- Related: ADR 016（ボール所在）, ADR 035（契約管理ワーカの型 `workers/contract-reminder.js`）, ADR 043（通知の既定値と受信設定）, ADR 015（VIEW AS チェックリスト）, 進行ボードの提出遅れアラート（`public/haruka.html` `renderAlerts` / PR #1209）, 予定日一括変更（`openBulkDeadlineModal`）

## Context

進行ボード上部の「提出遅れ ◯件」は **最終納品日（`final_deadline`）を過ぎていて、ステータスが「納品」でも「クライアントチェック中」でもない** クリエイティブを数えている（ボールが制作側にある遅延）。2026-10-08 時点で 28 件あったが、ファイル名の日付を見ると 5 月・7 月の案件が混じっており、実態は次の 3 種類が混在していた。

1. **日程が変わっただけ**で最終納品日が旧日付のまま
2. **実務は進んでいる／終わっている**のにステータスが更新されていない
3. **本当に問題があって止まっている**

どれも「誰かが見て直す」以外に解消手段が無く、アラートは画面を開いた人にしか見えない。管理しているディレクター（D）／プロデューサー（P）が気づかないまま件数が積み上がる。さとるさんの指示（2026-10-08）: 「遅れている場合、管理している P/D に通知を。日付が変わったなら日付変更を、問題があれば報告を、ステータス未更新ならステータス変更を」。

## Decision

### 1. 判定は進行ボードの「提出遅れ」と同じ条件を使い、別の定義を作らない

`utils/overdue-notify.js` `selectOverdue()`: `final_deadline < 今日(JST)` かつ `status != 納品` かつ `force_delivered` でない かつ `status != クライアントチェック中`（ボールが先方）かつ 取引終了クライアントでない。画面と通知で件数が食い違うと信用されないので、定義は 1 つに保つ。初稿締切（`draft_deadline`）は見ない（画面と同じ）。

### 2. 受信者は「そのクリエイティブを管理している D / P」。`getBallHolder` と同じ優先順で解決する

- director: `creative_assignments(role=director)` → `projects.director_id` → 制作担当（editor/designer）のチーム代表ディレクター（`teams.director_id`）
- producer: `creative_assignments(role=producer)` → `projects.producer_id`

制作担当本人には送らない（遅延の是正は管理側の判断を要するため）。D と P が同一人物なら 1 通。誰も解決できないクリエイティブは件数だけログに残す（担当未設定の洗い出し用）。

### 3. 平日の朝、1 人 1 日 1 通のまとめ。提出遅れが残っている間だけ届く

- `workers/overdue-notifier.js`: 30 分ごとに tick し、**土日・祝日以外**の JST 10 時台（`OVERDUE_NOTIFY_HOUR` で変更可）に 1 回だけ実行（`contract-reminder.js` の型）。
- 通知ベル（種別 `deadline`、既存列 `deadline_enabled`・migration 不要）＋ Chatwork / Slack DM（`utils/member-notify.js`、振込管理・契約管理と同じ送信チェーン）。
- 再送ガードはメモリの `lastRunDay` に加えて `notification_logs.meta.digest_date` を見る（再デプロイで当日 2 通にならない）。
- 1 通に載せるのは最大 15 件、残りは「ほか N 件」。本文には各クリエイティブの **クライアント／ファイル名／最終納品日と超過日数／ステータス／制作担当／詳細リンク** と、進行ボードを「遅延のみ」で開くリンク（`?delayed=1`）。
- `OVERDUE_NOTIFY_ENABLED=false` で止められる（既定 ON）。

### 4. 文面は「3 つの対応のどれか」を明示する

① 日程が変わっただけ → 最終納品日を直す（「📅 予定日をまとめて変更」へ誘導）
② 実際は進んでいる・納品済み → ステータスを進める
③ 問題があって進められない → クリエイティブの 🆘SOS を立ててコメントに状況を書く

### 5. SOS を「報告」の受け皿にする。SOS が立った瞬間に管理者と担当 D/P へ通知する

これまで `help_flag` はボード上のフラグだけで誰にも通知されなかった。③ の受け皿として、`PUT /creatives/:id` で `help_flag` が **false → true** になったときだけ、admin ロール全員＋そのクリエイティブの D/P（§2 と同じ解決）へ通知ベル（種別 `sos`・既存列 `sos_enabled`）と Chatwork / Slack DM を送る。立てた本人には送らない。「SOS のまま別項目を保存」で再送しないよう、更新前の値を見る。

### 6. 本人の受信設定では止めない

`deadline` / `sos` は `notification_settings` に列はあるが UI（`utils/notification-settings.js` の CATALOG）には出さない（ADR 043 §3「本人が止めた結果、業務が止まる種別は本人の裁量に委ねない」と同じ扱い）。

### 7. 追補（2026-10-08）: 共有ルームへは絶対に流さない。届かなければ管理者のマイチャットへ

マージ後のレビューで、`notifyMember()` の既定チェーンが「Chatwork 個別チャットに送れない → `[To:]` 付きで全体チャット（契約・振込の既定ルーム）」に落ちることが分かった。提出遅れ・SOS の本文には案件名・担当者・遅延状況が入るので、この経路は使わない。

- `notifyMember(user, msg, { privateOnly: true })` を追加。送信順は **本人がトークン名義人（管理者）→ マイチャット** → Chatwork 個別チャット → Slack DM → どれも届かなければ **管理者のマイチャットへ「【転送依頼】◯◯さんへ届けられませんでした」として全文**。共有ルームには出さない。契約・振込の既定挙動は変えない。
- 管理者本人の判定は `GET /v2/me` の account_id と `users.chatwork_dm_id` の一致（キャッシュ）。マイチャットは `ADMIN_MYCHAT_CHATWORK_ROOM_ID` → `BUG_REPORT_NOTIFY_CHATWORK_ROOM_ID` → 自動検出（type='my'）。
- 日次ワーカは **DM を先に送ってからベルを作る**（ベルの meta に `dm_channel` / `dm_ok` を残す）。`lastRunDay` は **成功したときだけ**立てる。途中で失敗したら 30 分後の tick で再試行し、送信済みの受信者は `meta.digest_date` で守る。
- SOS 通知は、リクエストにコメントが無ければ保存済みの `editor_comment` → `note` を状況として載せる（SOS ボタンは `{ help_flag: true }` しか送らないため）。チーム代表 D のフォールバックは `users.team_id` に加えて `team_members(user_id)` 経由も見る（`getBallHolder` と同じ 2 経路）。

## Consequences

- 提出遅れが D/P の手元（Chatwork / Slack）に毎朝届くので、画面を開かなくても気づける。28 件の棚卸しは「日付を直す／ステータスを進める／SOS」のどれかで減っていく。
- 件数が減らない人には毎朝同じ内容が届く。これは仕様（残っている間だけ鳴る）。うるさくなりすぎる場合は「N 日ごと」に間引く設定を足す（未実装）。
- 「提出遅れ」の名前は画面のまま。Dチェック／Pチェック中（制作担当は提出済み）も含まれる点は変えていない。チップにステータスを添える・社内チェック滞留を分ける案は別 PR の候補。
- 個別通知の送信先決定は `tests/utils/member-notify.test.js` で検証（共有ルームへ落ちないこと・マイチャット転送）。
- 通知の文面・判定・受信者解決は純関数（`utils/overdue-notify.js`）に置き、jest で UTC / JST 両方で検証している（`tests/utils/overdue-notify.test.js` / `tests/overdue-notifier.test.js`）。

## Alternatives

- **画面のアラートを強化するだけ**: 開かない人には届かない。却下。
- **制作担当本人にも送る**: 日付変更・ステータス判断は管理側の仕事で、担当には creative_status 通知（チェック依頼・修正依頼）が既にある。重複を避けて却下。
- **初稿締切超過も対象にする**: 画面の「提出遅れ」と定義がずれる。まず最終納品日で運用し、必要なら ADR 追補。
- **N 日以上の長期超過だけ管理者へ別サマリ**: 今回は 1 段で始める。必要になったら追加。
