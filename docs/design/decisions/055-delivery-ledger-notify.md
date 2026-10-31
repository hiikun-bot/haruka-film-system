---
adr: 055
status: Accepted
date: 2026-10-30
tags: [notifications, creatives, delivery, slack, chatwork, audit]
related_tables: [creatives, projects, clients]
supersedes: null
superseded_by: null
related_adrs: [026, 034, 049]
---

# 055. 納品完了メッセージに「当月の案件内 納品カウント」を積み上げる（AI 突合用の台帳）

- **Status**: Accepted
- **Date**: 2026-10-30
- **Decided by**: ユーザー（hiikun.ascs@gmail.com）

## Context

月末に「この案件で今月は何本対応したか」を確かめるとき、ユーザーは Slack / Chatwork の
案件チャンネルの URL を AI に渡し、やり取りの文章から本数を読み取らせ、HFS の DB とも
突き合わせたい（2026-10-30 依頼）。しかし既存の納品完了通知（`notifications.js` の
「クライアントOK！納品完了」）は 1 件ずつ独立した文面で、件数の積み上げが無く、
宛先も編集者・デザイナーだけでディレクターには届いていなかった。
文章だけを読む AI には「何件目か」「当月の一覧」が無いと数えられず、DB 側と照合する
手がかり（案件 ID・月・creative ID）も無かった。

## Decision

**納品完了になるたびに、その案件の当月（JST）の納品済み一覧と件数を「積み上げ台帳」として
通知本文に載せ、末尾に機械可読タグ `[HFS-LEDGER] ...` を 1 行添える。
同じ数字を DB から返す API とスクリプトを用意し、メッセージ側と DB 側でダブルチェックする。**

### 本文の形（Slack の例。Chatwork は装飾なしで同文）

```
@編集者 @ディレクター

━━━━━━━━━━━━━━━
🎉 *クライアントOK！納品完了*
━━━━━━━━━━━━━━━

案件: 【東京ガス】LP制作
ファイル: <url|TG_15s_A.mp4>
担当者: 伊東
ディレクター: 片山 紗季
プロデューサー: 川崎 かおり
ダブルチェック: 奥田   ← W チェック担当がいるときだけ
コメント: （コメントなし）
URL: https://…/haruka.html?creative=…

*📊 納品カウント（2026年10月）: 5件目 ／ 当月 5件 ／ 案件累計 23件*
　①10/2 TG_15s_A.mp4
　②10/5 TG_15s_B.mp4
　③10/9 TG_30s_A.mp4
　④10/20 TG_30s_B.mp4
　⑤10/30 TG_6s_A.mp4 ⬅ 今回
`[HFS-LEDGER] project=<uuid> month=2026-10 seq=5 month_total=5 project_total=23 creative=<uuid>`
```

### ルール

- **当月の定義**: `creatives.status='納品' ∧ delivered_at ∈ JST 月`（ADR 026 の支払い本数と同じ判定）。
  月は今回の `delivered_at` の JST 月。手動補正で過去月に入れた場合はその月の台帳が出る
- **並び**: `delivered_at` 昇順（同時刻は id）。今回の納品が途中に入ったときは、その位置の seq を「◯件目」にする
- **一覧の上限**: 15 行。超えたら先頭側を「…ほか N件（先行分）」に畳み、最新側を残す
- **案件累計**: その案件の全期間の納品済み件数（`status='納品' ∧ delivered_at IS NOT NULL`）を併記する
- **役割の明示（2026-10-31 追補）**: 「担当者: A → B」ではなく 担当者／ディレクター／プロデューサー／ダブルチェック（担当がいるときだけ）を 1 行ずつ出す
- **宛先**: 従来の編集者・デザイナーに加えて、案件ディレクター（projects.director_id）と
  creative_assignments の director も同じ 1 通でメンションする
- **必ずチャンネルに残す**: DM ID が誰にも無いプラットフォームでも、台帳付き本文をメンション無しで投稿する
  （AI が後からログだけで数えられることが目的のため）
- **一括納品完了（月次消込・`POST /creatives/bulk-deliver`）**: 件数分の通知は出さず、
  案件ごとに 1 通「📦 一括納品完了（月次消込）」を案件チャンネル／ルームに投稿し、
  台帳は `今回 N件 → 当月 M件`・今回分に 🆕 印・タグは `added=N`。
  全体連絡チャンネルのダイジェストにも「（当月累計 M件）」を併記する
- **機械可読タグ**: `[HFS-LEDGER] project=<uuid> month=YYYY-MM seq=<n> month_total=<m> project_total=<t> creative=<uuid>`
  （一括は `seq`/`creative` の代わりに `added=<n>`）。Slack はコードスパンで囲む。
  解析は `utils/delivery-ledger.js` の `parseLedgerTags()`（`*` `>` 引用・コードスパン混じりでも拾う）
- **DB 側の出口**:
  - `GET /api/haruka/projects/:id/delivery-ledger?month=YYYY-MM`（認証済みなら誰でも。件数・ファイル名のみ、金額なし）
  - `node scripts/delivery-ledger-check.js --project <uuid> --month 2026-10 [--log chat.txt]`
    ログのタグ（最後の month_total・creative 集合）と DB を突き合わせ `✅ 一致 / ❌ 不一致` を出す
- 台帳の取得に失敗しても納品通知本体は従来どおり送る（台帳ブロックだけ省略）。DB 書き込み・migration なし

## Consequences

- 月末の確認は「案件チャンネルの URL を AI に渡す → `[HFS-LEDGER]` の最後の `month_total` と
  一覧を読む → `delivery-ledger-check.js` で DB と突合」の 2 本立てになる
- ディレクターにも納品完了が届くようになり、通知は 1 通増えない（同じ 1 通にメンションを足すだけ）
- 一括納品を使う月は、案件チャンネルに案件数ぶんの投稿が増える（1 案件 1 通・月 1 回想定）
- `delivered_at` を手動補正して月をまたいだ場合、Slack 側の古い台帳は訂正されない。
  DB 側（API / スクリプト）が正で、ログ側は「投稿時点の記録」として扱う

## Alternatives considered

- **通知ベル（アプリ内）に件数を出す**: AI が Slack / Chatwork のログだけで数えたいという要件を満たさない
- **月末に 1 通だけ集計を投稿する**: 途中の納品メッセージと対応付けられず、ログを読む AI が
  「どの投稿がどの 1 件か」を追えない。積み上げ方式なら各投稿が自己完結する
- **Slack スレッドに返信で積む**: Chatwork にスレッドが無く、2 媒体で挙動が割れるため不採用

## 追補（2026-10-31）: 人が URL を渡さない全自動の突合

**HFS は案件ごとの Slack チャンネル／Chatwork ルームを既に持っている**（projects → clients のフォールバック）ので、
突合も HFS 自身が行う。人が URL やログを AI に渡す工程は無くす。

- **投稿記録** `delivery_ledger_posts`（migration `2026-10-31_delivery_ledger_posts.sql`）:
  台帳を投稿するたびに platform / channel_ref / message_id（Slack は ts・Chatwork は message_id）/ 投稿時点の件数 / タグ を 1 行残す。
  Chatwork の一覧 API は最新 100 件しか返さないため、古い投稿は message_id で 1 件ずつ読み直す
- **自動突合** `utils/delivery-ledger-recon.js`:
  案件×月ごとに (1) DB の納品数 (2) 投稿記録 (3) チャンネルの本文（Slack `conversations.history` ／ Chatwork `rooms/{id}/messages`）の
  `[HFS-LEDGER]` を読み比べ、`match / mismatch / no_posts / fetch_error / no_channel` を判定する。
  不一致の理由（最後の投稿の件数と DB の件数、投稿にあって DB に無い creative、DB にあって投稿に無い creative、
  投稿記録があるのにチャンネルに無い message_id）を付ける
- **月初ワーカー** `workers/delivery-ledger-recon.js`: 毎月 1〜3 日の JST 10 時台に前月分を突合し、
  管理者の Chatwork マイチャットへ 1 通（不一致を先頭に）。二重送信ガード `system_settings.delivery_ledger_recon_last_ym`、
  無効化 `DELIVERY_LEDGER_RECON_ENABLED=false`
- **手動** `GET /api/haruka/admin/delivery-ledger/recon?month=YYYY-MM[&project_id=]`（結果 JSON）、
  `POST /api/haruka/admin/delivery-ledger/recon/notify { month }`（今すぐマイチャットへ）、
  `node scripts/delivery-ledger-check.js --fetch --month YYYY-MM`
- **Slack の権限**: bot に `channels:history`（非公開は `groups:history`）が必要。無ければ `missing_scope` を
  `fetch_error` の理由として報告し、ダイジェストにスコープ追加の案内を出す（Chatwork は投稿用トークンで読める）
- **AI による会話文の読み取り**（「今月は 5 本お願いします」のような人の文章との照合）は LLM 呼び出し＝課金が要るため本追補では自動化しない。
  必要なら `include_messages` を API に足して本文を渡す設計にできる（課金は事前承諾）
- 不一致のときは DB（HFS）が正。納品完了日の手動補正で月をまたいだ案件は投稿側が古いままになる
