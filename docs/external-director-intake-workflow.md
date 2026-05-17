# 外部ディレクター案件 受付フロー仕様

> **関連ADR**: [ADR 017: 外部ディレクター案件の表現と運用フロー](design/decisions/017-external-director-projects.md)
>
> **目的**: ADR 017 が定める「秘書チーム集約による案件起票」を実際に動かすための
> オペレーション仕様。Slack ワークフロー版（即運用可）と HFS 内フォーム版（恒久版）の
> 2段構成で立ち上げる。

## 全体フロー

```
[GND/代理店]              [HARUKAメンバー]              [秘書チーム]                  [HFS]
  Slack/CW       ─依頼─▶   窓口担当(例:池田)  ─転送─▶  #案件登録-受付  ─起票─▶  projects 行
   または                                              (Slackワークフロー
  メール/電話                                           or HFS内フォーム)
                                                            │
                                                            ↓
                                                       24h 以内に
                                                       projects 作成
                                                       (外部D擬似ユーザー
                                                        + liaison_user_id)
                                                            │
                                                            ↓
                                                       依頼者へ完了通知
                                                       (Slack thread reply)
```

## 受付項目（共通テンプレ）

Slack ワークフロー版 / HFS 内フォーム版どちらも、以下の同一項目を取得する。

| # | 項目 | 必須 | 例 | 備考 |
|---|---|---|---|---|
| 1 | クライアント名 | 必須 | `GND` / `代理店A` | 既存 `clients` に無ければ秘書側で先に作成 |
| 2 | 案件名 | 必須 | `サンスター 緑でサラナ` | |
| 3 | 外部ディレクター氏名 | 必須 | `中島` | |
| 4 | 外部D所属（external_company） | 必須 | `GND` | クライアントと同じケースが多いが別の場合もある |
| 5 | 外部D連絡先（任意） | 任意 | Slack ID / メール | 通知は飛ばさないが、秘書が手動連絡する時用 |
| 6 | 担当本数 / 種類 | 必須 | `5本制作のうちパンセ1本` | |
| 7 | HARUKA側 窓口担当 | 必須 | `池田恭子` | `projects.liaison_user_id` に入る |
| 8 | HARUKA側 担当メンバー | 任意 | `池田恭子（パンセ担当）` | サブD扱いの可能性 |
| 9 | 初稿日 | 任意 | `2026-05-17` | |
| 10 | 納品予定日 | 任意 | `2026-05-30` | |
| 11 | 元依頼の Slack/CW URL | 必須 | リンク | 監査ログ・後追い用 |
| 12 | 補足 | 任意 | フリーテキスト | |

## Phase A: Slack ワークフロー版（即運用 / コード変更なし）

ADR 017 を運用に乗せるまでのつなぎ。最短で動かす。

### セットアップ手順（秘書チーム管理者）

1. Slack で `#案件登録-受付` チャンネルを新規作成（プライベート / 秘書チーム + 必要なPM）
2. ワークフロービルダー → 新規ワークフロー → 「ショートカット」起動
3. ステップ1: フォーム（上記12項目をすべてフィールドに）
4. ステップ2: メッセージ送信先 = `#案件登録-受付`
5. メッセージ本文テンプレート：
   ```
   📥 案件登録依頼
   ─────────────
   クライアント: {{1.クライアント名}}
   案件名:        {{2.案件名}}
   外部D:         {{3.外部ディレクター氏名}}（{{4.所属}}）
   担当本数:      {{6.担当本数 / 種類}}
   窓口担当:      {{7.HARUKA側 窓口担当}}
   担当メンバー:  {{8.担当メンバー}}
   初稿日:        {{9.初稿日}}
   納品予定日:    {{10.納品予定日}}
   元依頼:        {{11.元依頼URL}}
   補足:          {{12.補足}}
   ─────────────
   依頼者: <@{{user}}>
   起票ステータス: ⏳ 24h以内に処理
   ```
6. ステップ3（任意）: 起票担当（秘書チーム代表）にメンション

### 運用ルール（メンバー向け）

- 外部から案件依頼を受けたら **自分で HFS 起票しない**
- Slack の `+` → ワークフロー → 「案件登録依頼」を起動 → フォーム送信
- 秘書チームが HFS に起票完了したらスレッドに 🟢 と起票後の案件URLが返る

### 秘書チーム側オペレーション

- 受付メッセージを受けたら即「⏳→👀」リアクションで「対応中」マーク
- HFS で起票完了したらスレッドに `案件URL: https://.../projects/<id>` 返信 + 🟢 リアクション
- 24h SLA を超えたら自動リマインダー（Slack の `/remind` で運用、ワークフロー外で簡易対応）
- 既存外部D（中島さんが過去にも登録済）を使い回す場合は擬似ユーザー新規追加は不要

### 限界（Slack 版）

- データが構造化されず Slack に散る（DB に残らない）
- HFS 側との二重入力（受付→起票で同じデータを入れ直し）
- 重複依頼の検出が手動

## Phase B: HFS 内フォーム版（恒久 / コード変更あり）

ADR 017 の Phase 3 と一緒に実装する想定。HFS 内に「外部依頼受付」専用画面を持たせ、
受付データをそのまま draft 案件として登録できる流れにする。

### URL / 画面

- `/intake` または案件タブに「📥 受付一覧」サブタブを追加
- 全メンバーがフォーム投稿可能 / 秘書チームのみが受付一覧を処理可能（権限分離）

### データモデル

```sql
-- 受付テーブル（draft案件の元）
CREATE TABLE external_project_intakes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  submitted_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  submitted_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  client_name_raw         TEXT NOT NULL,    -- 既存clientsに無いことが多いので raw 入力
  client_id               UUID REFERENCES clients(id) ON DELETE SET NULL, -- 紐付け後に埋まる

  project_name            TEXT NOT NULL,
  external_director_name  TEXT NOT NULL,
  external_company        TEXT NOT NULL,
  external_director_contact TEXT,           -- 任意（Slack ID / メール / 電話）

  scope_description       TEXT NOT NULL,    -- 「5本制作のうちパンセ1本」等
  liaison_user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
  assigned_member_ids     UUID[] DEFAULT '{}',

  first_draft_date        DATE,
  delivery_date           DATE,
  origin_url              TEXT NOT NULL,    -- 元依頼のSlack/CW URL
  note                    TEXT,

  -- 処理状態
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','processing','project_created','rejected')),
  processed_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  processed_at  TIMESTAMPTZ,
  project_id    UUID REFERENCES projects(id) ON DELETE SET NULL, -- 起票後に紐付け
  reject_reason TEXT
);

CREATE INDEX idx_intakes_status ON external_project_intakes(status, submitted_at DESC);
```

### 画面遷移 / 絵コンテ

#### (1) 受付フォーム（全メンバー）

```
┌─ 📥 外部案件 登録依頼 ─────────────────────────────┐
│                                                    │
│  クライアント名 *  [GND                         ]  │
│   ※既存にあれば候補表示 / なければそのまま入力     │
│                                                    │
│  案件名 *         [サンスター 緑でサラナ        ]  │
│                                                    │
│  外部ディレクター名 * [中島                     ]  │
│  外部D所属 *      [GND                          ]  │
│  外部D連絡先      [                             ]  │
│                                                    │
│  担当本数・内容 *                                  │
│  ┌────────────────────────────────────────────┐  │
│  │ 5本制作のうちパンセ1本                       │  │
│  └────────────────────────────────────────────┘  │
│                                                    │
│  HARUKA側 窓口担当 * [池田 恭子 ▼]                 │
│  HARUKA側 担当メンバー [池田 恭子 ▼] [＋追加]      │
│                                                    │
│  初稿日       [2026-05-17 📅]                      │
│  納品予定日   [2026-05-30 📅]                      │
│                                                    │
│  元依頼URL *  [https://goodnew-design...        ]  │
│                                                    │
│  補足                                              │
│  ┌────────────────────────────────────────────┐  │
│  │                                              │  │
│  └────────────────────────────────────────────┘  │
│                                                    │
│              [キャンセル]  [📤 受付に送信]         │
└────────────────────────────────────────────────────┘
```

送信後の挙動：
- Slack `#案件登録-受付` チャンネルに通知（Webhook経由・既存の error-report 通知の仕組み流用）
- 依頼者本人にも通知ベル（notification_logs に1件）

#### (2) 受付一覧（秘書チームのみ表示）

```
┌─ 📥 受付一覧（秘書チーム）  [全部:12] [⏳pending:3] [✅完了:9] ─┐
│                                                              │
│ ⏳ pending                                                   │
│ ┌──────────────────────────────────────────────────────┐ │
│ │ GND / サンスター 緑でサラナ                            │ │
│ │ 外部D: 中島(GND) / 担当: 5本中パンセ1本                │ │
│ │ 窓口: 池田恭子 / 依頼: 池田恭子 / 5/17 23:55           │ │
│ │ [📋 案件起票へ]  [❌ 却下]                              │ │
│ └──────────────────────────────────────────────────────┘ │
│                                                              │
│ ✅ 起票済                                                    │
│ ┌──────────────────────────────────────────────────────┐ │
│ │ 代理店A / ◯◯案件         → /projects/abc123          │ │
│ │ 起票: 秘書山田 / 5/16 10:22                            │ │
│ └──────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────┘
```

#### (3) 案件起票へボタン押下時

- 既存の案件編集モーダルが開き、受付データがプリフィルされる
- 「外部ディレクター案件」トグルが ON
- director_id 候補に「中島(GND) を新規作成」ボタン
  - 押すと擬似ユーザーを `users` に INSERT（`is_external=true`, `external_company='GND'`）
  - 既存擬似ユーザーがあれば候補に出る
- liaison_user_id = フォーム入力の窓口担当
- 保存 → `external_project_intakes` の `status='project_created'`, `project_id` 紐付け
- Slack スレッドに `案件URL: ...` 自動返信（依頼者にも通知）

### 権限

| 操作 | admin | secretary | producer | director | editor | designer |
|---|---|---|---|---|---|---|
| フォーム送信 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 受付一覧 閲覧 | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| 起票処理 | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| 却下 | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |

ADR 015（VIEW AS / 権限）に従い、`requirePermission('intake.process')` を新設。

### Phase B 実装ステップ

1. migration: `external_project_intakes` テーブル新設 + `intake.process` permission
2. POST `/api/intakes` (フォーム送信) / GET `/api/intakes?status=pending` (一覧)
3. POST `/api/intakes/:id/create-project` (受付 → 案件起票)
4. `public/haruka.html` に受付フォーム + 受付一覧サブタブ
5. Slack Webhook 通知（既存 utils 流用）

## ロールアウト計画

| 時期 | アクション |
|---|---|
| 2026-05-19 | Slack `#案件登録-受付` 作成 + ワークフロー設定（秘書チーム管理者作業） |
| 2026-05-19 | 全メンバーに Slack ワークフロー利用を周知（次回説明会） |
| 2026-05 末 | ADR 017 Phase 1 migration 適用後、サンスター案件を実データで一度通す（パイロット） |
| 2026-06 中旬 | HFS 内フォーム版（Phase B）実装着手 |
| 2026-06 末 | HFS 内フォーム版リリース、Slack ワークフロー版は予備運用に格下げ |

## メトリクス（運用後に確認）

- 受付〜起票の中央値 / P90（SLA 24h 達成率）
- 受付件数 / 月（外部D案件の比率トレンド）
- 「自分で起票してしまった」件数（受付フォーム迂回率 = 違反検出）

## Open Questions

- **過去の外部D案件の遡及登録**: どこまで遡るか・スコープ確定（ADR 017 Phase 6 と統合管理）
- **依頼自体が機密のケース**: NDA前の案件相談を Slack `#案件登録-受付` に投げて良いか？
  → プライベートチャンネル化 + メンバー絞り込みで対応想定
- **クライアント自身が窓口になるパターン**: 本仕様の対象外（ADR 017 Open Questions 参照）
