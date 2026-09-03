# ADR 037: 作品への 👏 拍手と 💬 ひとことは tweets と分離した専用テーブルで持ち、制作担当にだけ通知する

- Status: Accepted
- Date: 2026-09-03
- Related: 作品ギャラリー（`migrations/2026-07-23_portfolio_gallery.sql` / `2026-07-23_portfolio_favorites.sql` / ADR 035）, つぶやきの 5 種リアクション（`tweet_reactions` / `tweet_comments`）, 通知 Phase 1（`notification_logs` / `utils/notification.js`）, ADR 033（チーム状況・メンバー間比較を避ける判断）, ADR 015（VIEW AS チェックリスト）, philosophy.md 4 項, open-questions Q3

## Context

🏆 作品ページは納品作品のギャラリーだが一方通行で、他のメンバーからの反応が付かなかった。作った本人にとって「見てもらえた」「良かったと言ってもらえた」が分かる仕組みが無く、ポートフォリオとして眺めるだけの場所になっていた。

一方、つぶやき（tweets）には 5 種リアクション（👍 ❤️ 👏 😊 😳）と短いコメント、それに伴うベル通知の配線が既にある。同じ体験を作品にも付けたい。

論点は 3 つ。

1. **テーブルをどう持つか** — `tweet_reactions` / `tweet_comments` を `target_type` 付きに拡張して共用するか、死蔵の `posts` 系を復活させるか、専用テーブルを作るか。
2. **誰に通知するか** — つぶやきは投稿者 1 人だが、作品は編集者・デザイナー・ディレクターと複数人で作る。
3. **数字の扱い** — 拍手の数が見えると「誰の作品が一番拍手を集めたか」という比較になり得る。

## Decision

### 1. 専用テーブル `portfolio_reactions` / `portfolio_comments` に分離する（tweets 系とは統合しない）

- philosophy.md 4 項「概念の統合より分離」・open-questions Q3 の判断（統合は急がない）を継続する。
- 見た目は同じ「リアクション」でも、対象（`tweet_id` vs `creative_id`）・ライフサイクル（つぶやきは期限切れで消える／作品はずっと残る）・通知の宛先（投稿者 1 人 vs 制作担当の複数人）が違う。`target_type` 列で共用すると、つぶやき側の期限切れ削除や集計トリガー（`reaction_count` の更新トリガー）が作品側に漏れる。
- `posts` / `post_reactions` は未使用のまま塩漬け（Q3 の (B) 案どおり別途削除）。今回の受け皿にはしない。
- `reaction_type` に CHECK は付けない。許可値は `utils/reactions.js` が正で、DB にも書くと二重管理になる（`tweet_reactions` と同じ流儀）。
- `portfolio_comments` は論理削除（`deleted_at`）。本文は 500 字まで（DB の CHECK とコード側 `PORTFOLIO_COMMENT_MAX` を揃える）。

### 2. リアクションの種類の定義は 1 箇所（`utils/reactions.js`）に集約する

- つぶやきのサーバー側 `TWEET_REACTION_TYPES` とフロント側 `TWEET_REACTIONS` が別々に書かれていたのを、UMD 形式の `utils/reactions.js` に集約し、`server.js` が `/js/reactions.js` で配信する（`utils/personal-goals.js` と同じ方式）。作品側もこの配列を使う。

### 3. 通知の宛先＝その作品の「制作担当」。アクター本人には送らない

- 宛先は `creative_assignments` のうち `editor` / `designer` / `director_as_editor` / `director` と、納品時スナップショット `creatives.delivered_director_ids`。`producer` / `wcheck` はチェック側なので含めない（「作った人に届く」通知にする）。
- **自分の作品にも押せる**（つぶやきと同じ）。ただし通知は自分には飛ばさない。
- リアクションの解除では通知しない。
- 連打・トグル往復対策として、同じ人 × 同じ作品 × 同じ通知種別（`portfolio_reaction` / `portfolio_comment`）は **24 時間に 1 回**に抑える（`notification_logs` の `sender_id` + `meta->>creative_id` + `created_at` で判定）。
- 通知種別は `portfolio_reaction`（👏）/ `portfolio_comment`（💬）。`notification_settings` に `*_enabled` 列を足し、`utils/notification.js` の対応表に登録する（`creative_registered` と同じ手順）。
- 通知のリンクは作品ページのディープリンク `/haruka.html?portfolio=<creative_id>`。ベルから開くと作品タブに切り替わり、該当作品のライトボックスが開く。既定の「自分の作品」フィルタに無ければ一度だけ「全員」に広げて探し直す。

### 4. 順位・ランキング化はしない

- カードとライトボックスに「種別ごとの件数」と「自分が押したか」だけを出す。作品を拍手数で並べ替える・メンバー別に拍手数を集計する・トップ N を出す、といった機能は付けない。
- ADR 033 で「メンバー間比較の材料を作らない」と決めた判断と整合させる。拍手は評価ではなく「見たよ」「良かったよ」の合図として扱う。

### 5. 認可は作品ページと同じ（全ロール）。削除だけ本人 or admin

- 作品ページは全ロール閲覧可なので、リアクション／ひとことの API も `requireAuth` のみ（一覧と同じ）。
- ひとことの削除は本人か admin。admin 判定は `getEffectiveRoleCodes(req)`（ADR 015・`req.user.role` 直書き禁止）。フロントの削除ボタンは API が返す `can_delete` で出し分ける。

## Consequences

- 作品ページで 👏＋ を押すとピッカーが開き、5 種から選べる。押した種別はカード下部にピルで並び、自分のものは強調。もう一度押すと外れる。
- 💬 N をクリックするとカード直下にひとこと欄が開く（ライトボックスでは常時表示）。
- 一覧 API（`GET /portfolio`）は creative ごとの `reactions` / `my_reactions` / `comment_count` を **1 往復で**載せて返す（表示中の creative 集合で `.in()` を 100 件ずつに分割し並列取得。N+1 無し）。migration 未適用の環境ではテーブル無しを検知して集計無しで表示する（作品ページを落とさない）。
- `notification_logs` の行数が増える。同一 (actor, creative, 種別) 24h 抑制で連打分は抑えている。

トレードオフ:
- つぶやきと作品でリアクション UI が 2 系統になる（テーブル分離の帰結）。定義（5 種）だけは共通化した。
- 拍手数が見えること自体は避けられない。ランキング化しないことで「比較の道具」にならないようにしている。

## Alternatives

1. **`tweet_reactions` に `target_type` / `target_id` を足して共用** — テーブル数は減るが、つぶやきの期限切れ削除・件数トリガー・通知の宛先ロジックが作品側に混ざる。philosophy 4 項の「安易な統合は危険」に該当するため見送り。
2. **死蔵の `posts` 系を作品用に転用** — 「統一 feed の試みが頓挫した跡」を別の意味で再利用すると、後で読む人が混乱する。見送り。
3. **通知の宛先を「案件の director_id / producer_id」まで広げる** — 案件のディレクターは複数の作品にまたがるため、作品ごとの拍手が全部届くと多すぎる。作品単位の担当（creative_assignments）と納品時スナップショットに限定。
4. **拍手ランキング / 月間ベスト** — モチベーション施策としては考えられるが、ADR 033 の判断（比較材料を作らない）を優先。必要になったら別 ADR で。
