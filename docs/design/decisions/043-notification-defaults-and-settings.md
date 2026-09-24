# ADR 043: 件数の多い通知は既定オフにし、通知ベルの受信設定は本人がメンバー編集モーダルで変える

- Status: Accepted
- Date: 2026-09-24
- Related: 通知 Phase 1（`migrations/2026-05-03_notification_phase1.sql` / `utils/notification.js` / `routes/notifications.js`）, creative_registered 通知（`migrations/2026-05-08_creative_registered_notification.sql`）, ADR 041（つぶやきの気づき）, ADR 042（作品への 👏 / 💬）, ADR 015（VIEW AS チェックリスト）

## Context

通知ベル（`notification_logs`）は Phase 1 で「受信設定テーブル `notification_settings` は作るが UI は Phase 2 で」として始まり、そのまま 4 か月半が経った。種別は増え続け（creative_status / creative_registered / portfolio_* など）、本人が止める手段が無いまま件数だけ増えている。

2026-09-24 に本番の直近 90 日分（11,786 件）を種別ごとに集計した。

| 種別 | 90 日 | 受信者 | 1 人 1 日平均 | 既読率 | 中身 |
|---|---|---|---|---|---|
| creative_status | 3,984 | 36 | 4.0 | 67% | Dチェック依頼 / Wチェック依頼 / 修正依頼 / クラチェック進行 |
| ball_returned | 3,436 | 35 | 3.8 | **0%** | DB トリガー。creative_status と同じ遷移で二重に鳴る |
| creative_registered | 2,114 | **4** | **10.5** | 35% | 誰かがクリエイティブを登録するたび admin / 秘書へ |
| post_comment | 1,848 | 33 | 5.2 | 58% | うち 1,815 件はクリエイティブへのコメント（つぶやき返信は 31 件） |
| post_reaction | 242 | 13 | 2.6 | 77% | つぶやきのリアクション（UI で 24h 集約済み） |
| global / portfolio_* / mention / bulk_delivered | 計 162 | – | ≤ 2.5 | 45〜86% | – |

分かったこと。

1. **creative_registered は 4 人に集中して 1 日 10 件超**、既読率も低い。「誰が何を登録したか」は一覧で見れば足りるので、ベルで鳴らし続ける必要がない。
2. **ball_returned は事実上届いていなかった**。予約配信対応（`2026-05-05_notification_scheduled_send.sql`）で受信箱が `delivered_at IS NOT NULL` を条件にした一方、DB トリガー `notify_ball_returned` は `delivered_at` を入れていない。90 日で 3,436 行が書かれ、1 件も表示されていない（既読率 0%）。しかも同じステータス遷移で creative_status（Dチェック依頼など）が明示 INSERT されるので、直しても二重に鳴るだけ。
3. **クリエイティブへのコメントとつぶやきへの返信が同じ種別 `post_comment`** で発火していて、片方だけ止められない。
4. `createBulkNotifications()` は設定を見ていない（Phase 1 の「UI は後で」のまま）。creative_status / creative_registered はすべてこの経路なので、設定 UI を作っても効かない。

## Decision

### 1. 既定オフにするのは `creative_registered` と `ball_returned` の 2 種別だけ

- 「多すぎる」の判断基準は **1 人 1 日平均が突出している（10 件超）か、実質重複か**。creative_status は最多だが 36 人に分散した業務連絡（1 日 4 件・既読 67%）なので既定オンのまま。post_comment 系・反応系も既読率が高いので既定オン。
- 既存行も OFF に揃える（`UPDATE ... WHERE ... = true`）。これまで ON/OFF する UI が無かったので「本人が ON にした行」は存在せず、意思を上書きすることにはならない。
- ball_returned のトリガーは **設定を見る＋配信済みで INSERT する** 形に直す。既定 OFF なので通常は鳴らないが、本人が ON にすれば今度こそ届く。トリガー削除はしない（ボール遷移の記録を DB 側で持てる価値は残す）。

### 2. 種別・既定値・列名・UI ラベルは `utils/notification-settings.js` の 1 箇所で持つ

- サーバー（発火時のフィルタ・設定 API）とフロント（メンバー編集モーダル）が同じ定義を見る。フロントは `GET /api/notifications/settings` が返す `catalog` から描画し、種別一覧を HTML に直書きしない。
- 設定行が無い・列が無い（migration 未適用）ときは **既定値で判定**する。`createNotification` の旧実装は「行が無ければ送る」だったが、既定 OFF の種別が増えるとそれでは意味が無い。
- `createBulkNotifications()` も受信者の設定を 1 クエリで引いて間引く。

### 3. 設定で止められない種別を明示する

pricing_approval（単価承認）・leader_remind / leader_remind_escalation（リーダー宛リマインド）・announcement_remind・bulk_delivered・global（全体のお知らせ、バグ報告の進捗もこの種別）は **列を持たせず常時 ON**。「本人が止めた結果、業務や承認が止まる」種別は本人の裁量に委ねない。global は列（`global_enabled`）が存在するが UI には出さない。

### 4. クリエイティブへのコメントは `creative_comment` 種別に分ける

- 発火元（`routes/haruka.js` のクリエイティブファイルコメント API）だけ種別を変え、つぶやき返信は `post_comment` のまま。表示（アイコン 💬）と既定値は同じ。
- 過去行は `post_comment` のまま残す（表示は変わらないので書き換えない）。

### 5. 設定 UI はメンバー編集モーダルの「🔔 通知」タブ

- 稼働時間・休日などと同じ「自分のプロフィール」の場所に置く。通知ベルのドロップダウンに歯車を足す案は、既存のモーダルに乗る方が導線・権限ともに一貫するので採らない。
- 自分の設定は誰でも変えられる。他メンバーの設定は `member.edit_password`（`PUT /members/:id` の admin 判定と同じ）を持つ人だけ。サーバーが同じ判定で 403 を返す。
- 保存は「保存する」ボタンでメンバー本体と一緒（変更があるときだけ `PUT /api/notifications/settings`）。通知設定の保存失敗は本体保存を失敗にしない（トーストで知らせる）。
- VIEW AS（ADR 015）: 設定は常に実ユーザー（`req.user`）のもの。ロールプレビューで他ロールの設定が見えることはない。

## Consequences

- admin / 秘書は登録通知が止まり、ベルが「返事が要るもの」中心になる。登録の把握はクリエイティブ一覧か、本人が通知タブで ON に戻す。
- ball_returned は 90 日 3,436 行の無駄な INSERT が止まる（既定 OFF で INSERT 自体が走らない）。
- 新しい通知種別を足すときは migration（列）＋ `CATALOG`（1 行）＋アイコンの 3 点。常時 ON にしたい種別は CATALOG に載せない。
- 未使用列（sos / deadline / assignment / invoice / browser_notification）は残す。UI には出さず、使うときに CATALOG へ昇格する。

## Alternatives

- **creative_status を「依頼系」と「進行の連絡（クラチェックに進みました）」に分ける** — 後者は 740 件・既読 52% で、分ければ止めたい人はいそう。ただし同じ関数内の 5 系統を種別分けするのは今回の範囲を超えるので見送り。次に「多い」と言われたらここ。
- **ball_returned トリガーを DROP する** — 最も簡単だが、本人が「ボールだけ知りたい」と ON にする余地を残す方が設定画面の説明と整合する。
- **通知ベルのドロップダウンに設定画面を持つ** — 上記 5 のとおり不採用。
