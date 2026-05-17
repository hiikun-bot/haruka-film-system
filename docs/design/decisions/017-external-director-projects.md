---
adr: 017
status: Proposed
date: 2026-05-18
tags: [projects, external-director, agency, intake, ball-state, liaison, gnd]
related_tables: [users, projects, project_tasks]
supersedes: null
superseded_by: null
extends: 016
---

# 017. 外部ディレクター案件（代理店ディレクター案件）の表現と運用フロー

- **Status**: Proposed
- **Date**: 2026-05-18
- **Decided by**: ユーザー（hiikun.ascs@gmail.com）

## Context

### きっかけ

2026-05-17、GND（Good New Design）から池田恭子へスポット依頼が入った。

- 案件名：サンスター「緑でサラナ」広告
- 担当ディレクター：**中島さん（GND所属。HARUKAのメンバーではない）**
- 5本制作のうちパンセ1本を池田が担当
- 経緯：ChatWork【CrL】コアメンバーチャットでひろさんから依頼。GND側Slackで進行
- 初稿：5/17完了

このとき池田から「HFSに入れるべきか？外部ディレクターは追加するのか？」という質問が出た。
高橋の回答は「**GND案件はすべてHFSへ。ただし外部ディレクターは追加しない。
ただDチェックのボールラリーができなくなるので要検討**」。

### 現状ギャップ

HFSの現モデル（ADR 016 / `routes/haruka.js` の `normalizeSubDirectorIds`、
`projects.director_id` FK）は次の制約を持つ：

1. **`projects.director_id` は HFS の users テーブルに居るユーザーしか入らない**
   - 外部ディレクターは入らない → director_id を空にするしかない
2. **`project_tasks.ball_holder_user_id` も users への FK**
   - ADR 016 で定義したボールラリーで「外部D保持」を表現できない
3. **HFS外部の人物への通知手段がない**
   - 外部ディレクターには HFS の DM・督促が届かない
4. **案件の起票口がバラバラ**
   - 現状、外部からの依頼は Slack / ChatWork / 個別DM など各メンバーに散発的に届き、
     HFSへの登録手順が定まっていない
   - 「HFSに完全移行できていない」と高橋が認識している通り、運用面の問題が大きい

### 業務上の重要性

GND経由のスポット案件は今後継続的に発生する見込みであり、
**「外部D案件」は一過性ではなく恒常的な業務種別**として扱う必要がある。
ADR 016 で `work_type` を制作 / 保守の2軸に整理したが、本ADRは制作系のサブ分類と
して「内部D案件 / 外部D案件」を導入する。

## Decision

外部ディレクター案件を以下の3点セットで表現する：

1. **外部ディレクターを「ログイン不可の擬似ユーザー」として HFS の users 表に登録する**
2. **`projects.liaison_user_id`（窓口担当）列を新設し、外部Dへの督促・代理操作を HARUKA 側 1名に集約する**
3. **案件起票は秘書チームに一元化する**（運用ルール）

### 1. 擬似ユーザーモデル（外部Dの表現）

`users` テーブルに `is_external` フラグを追加し、外部関係者をログイン不可・通知対象外の
擬似ユーザーとして登録する。

```sql
ALTER TABLE users
  ADD COLUMN is_external BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN external_company TEXT;
-- external_company: 'GND' / '代理店名' などフリーテキスト。表示用ラベル。
```

擬似ユーザー登録時のルール：

| 項目 | 値 |
|---|---|
| `full_name` | `中島(GND)` のように外部であることを明示 |
| `is_external` | `true` |
| `external_company` | `GND` |
| `email` | 任意（空でも可。設定しても通知は飛ばさない） |
| ログイン | 不可（パスワード未設定。本人もそもそも HFS を使わない） |
| ロール | `external_director` を新設 |
| 採算・工数集計 | **除外**（`WHERE u.is_external = FALSE` でフィルタ） |
| MemberPicker（ADR 014） | デフォルト非表示。「外部Dを含む」トグルON時のみ表示 |

これにより `projects.director_id`、`ball_holder_user_id`、サブディレクター
（`sub_director_ids`）すべて既存スキーマのまま外部Dを保持者にできる。

### 2. 窓口担当（liaison）モデル

外部Dにはシステム内で督促が届かないため、**HARUKA側で1名「窓口担当」を必ず指定**する。

```sql
ALTER TABLE projects
  ADD COLUMN liaison_user_id UUID REFERENCES users(id) ON DELETE SET NULL;
-- 外部D案件では必須。内部D案件では NULL。
```

挙動：

- **督促通知の宛先振替**：ball_holder が `is_external = true` の場合、督促タイマー
  （ADR 016 の `ball_holder_user_id` ベース）が発火したら、`liaison_user_id` に通知を飛ばす
- **代理操作の権限付与**：window担当者は「Dチェック完了」「ボール返却」など
  外部Dが本来押すべきボタンを **代理クリック** できる
- **完了ログ**：代理クリック時は `proxy_acted_by = liaison_user_id` を残し、
  監査ログとして「誰が誰の代わりに進めたか」を明示

### 3. 案件起票フロー（秘書チーム集約）

```
[GND/代理店]         [HARUKAメンバー]            [秘書チーム]              [HFS]
  Slack/CW   ─依頼─▶  窓口担当(例:池田) ─転送─▶ #案件登録-受付チャンネル
                                                 ↓
                                          24h以内に案件起票
                                          ・work_type=制作
                                          ・外部D案件トグルON
                                          ・擬似ユーザー(中島(GND))を
                                            director_id に設定
                                          ・liaison_user_id=池田 設定
                                                 ↓                       新規案件登録
                                                                         (担当者ピン留め)
```

ポイント：
- **HARUKAメンバーは自分でHFS起票しない** → 必ず秘書チームへ転送
- 秘書チームに `#案件登録-受付` 専用 Slack チャンネルを作り、依頼テンプレを固定
- 受付テンプレ項目：
  1. クライアント名（GND / 代理店名）
  2. 案件名（"サンスター 緑でサラナ"）
  3. 外部ディレクター名 & 所属
  4. 担当本数 / うち HARUKA 担当本数
  5. 窓口担当（HARUKA側）
  6. 初稿日 / 納品予定日
  7. 元依頼の Slack/CW URL
- 既存外部Dを再利用する場合（中島さんが過去案件で既登録）は新規ユーザー追加不要
- 新規外部Dなら秘書チームが擬似ユーザーを先に追加してから案件起票

### 案件編集モーダルの追加項目

```
┌────────────────────────────────────────────────────┐
│  案件編集                                          │
├────────────────────────────────────────────────────┤
│  クライアント:  [GND ▼]                            │
│  案件名:        [サンスター 緑でサラナ          ]  │
│                                                    │
│  ☑ 外部ディレクター案件                            │
│   └ ディレクター: [中島(GND) ▼]   ※外部Dも候補に  │
│     窓口担当:     [池田恭子 ▼]   ※必須            │
│                                                    │
│  ☐ 外部ディレクター案件 (OFFの場合)                │
│   └ ディレクター: [内部Dから選択 ▼]                │
│     窓口担当:     -                                │
└────────────────────────────────────────────────────┘
```

トグル ON で MemberPicker（ADR 014）の絞り込みが切り替わる：
- OFF：`is_external = FALSE` のみ表示（現状と同じ）
- ON：`is_external` フィルタ解除、外部Dも候補に出る

## Consequences

### Positive

- 既存スキーマ（`director_id` / `ball_holder_user_id` / `sub_director_ids`）を
  変えずに外部D案件を表現できる
- ボールラリーが外部D保持時も自然に回り、督促だけ窓口担当へ振替される
- 案件起票が秘書チームに一元化され、メンバーは「依頼転送」だけで済む
  → 高橋が課題視している「HFS完全移行」が進む
- 集計クエリに `WHERE u.is_external = FALSE` を1行足すだけで採算・工数の歪みを防げる
- 代理店経由案件（GND以外、今後増える代理店）にも同じモデルで対応可能

### Negative / Trade-offs

- `users` 表に「人ではない or ログインしない」行が混ざる
  - → `is_external` カラムで明示し、MemberPicker のデフォルト絞り込みで吸収
- 外部D本人が HFS を見られないため、Dチェック完了の操作は窓口担当の代理クリックに依存
  - → これは現状のSlack/CW運用と同等で、悪化はしない
  - → `proxy_acted_by` ログで監査性を担保
- 擬似ユーザーの命名規則と重複管理（中島さんが2回登録される等）が運用負荷になる
  - → 秘書チーム起票時に「外部D既存検索」を必ず行うルール化
  - → external_company + full_name で UNIQUE 制約は **付けない**（同姓同社の別人ケースを許容）

### 既存ロジックへの影響

- 採算集計（`director_rates` / `sub_director_rates` 等）：
  → 外部Dには支払いが発生しないため、`is_external` ユーザー分の rate 行は集計から除外
- 通知（[notifications.js](_main/notifications.js)）：
  → 宛先解決時に `is_external` を見て、true なら `liaison_user_id` にリダイレクト
- VIEW AS（ADR 015）：
  → 外部Dロールはログインしないが、開発時には「外部Dとして見たら何が見えるか」確認可能にしておく
- MemberPicker（ADR 014）：
  → デフォルトは `is_external = FALSE` 絞り込み。「外部Dを含む」トグル追加

## Alternatives Considered

### 案A: `projects.external_director_name` フリーテキスト列のみ追加

擬似ユーザーは作らず、director_id は NULL、外部D名前だけテキストで保持。

- **却下理由**：ボール保持者になれない（`ball_holder_user_id` は FK）ため
  ボールラリーのモデルが破綻する。表示用ラベルとしては動くが、ADR 016 の進捗管理が回らない。

### 案B: HARUKA 代理ディレクター（窓口担当者）を `director_id` に入れる

director_id = 池田、中島さんは notes やフリーテキスト欄に記載。

- **却下理由**：採算集計・工数集計で池田が実際にはやっていない「ディレクター工数」を
  持ったことになり、Dレート集計が歪む。レポート品質が落ちる。

### 案C: 擬似ユーザーではなく `external_directors` 別テーブル

外部Dを users とは別テーブルに分け、`projects.external_director_id` を別 FK にする。

- **却下理由**：`projects.director_id` の置換ロジック・MemberPicker の二重実装・
  ボール保持者の二重表現が必要になり、複雑度が大きく上がる。
  `is_external` フラグ1つで吸収できるなら同じ users 表に統合した方が薄い。

### 案D: HFS には入れず、Slack/CW のみで進行管理

外部D案件は HFS 起票対象外とする。

- **却下理由**：高橋の方針「GND案件はすべてHFSへ」と真っ向から矛盾する。
  かつ採算管理・納期管理が HFS で一元化できなくなる。

## Implementation Plan

### Phase 1: スキーマ追加（migration のみ）

```sql
-- migrations/NNN_external_director.sql
ALTER TABLE users
  ADD COLUMN is_external BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN external_company TEXT;

ALTER TABLE projects
  ADD COLUMN liaison_user_id UUID REFERENCES users(id) ON DELETE SET NULL;

-- external_director ロールを user_roles マスターに追加（ADR 003 準拠）
-- 既存マスターのシード形式に合わせる
```

- `needs-db-migration` ラベル付きPRで適用
- migration 単独PRで先行マージし、後続コードPRから参照（ADR適用フロー）

### Phase 2: 起票運用ルールの整備（コード変更なし）

- 秘書チームに `#案件登録-受付` Slack チャンネル作成
- 受付テンプレ（前述7項目）を固定
- 説明会で全メンバーに「外部依頼は自分で起票しない」を周知

### Phase 3: 案件編集モーダル UI

- 「外部ディレクター案件」トグル追加
- MemberPicker に `includeExternal` オプション追加（デフォルト false）
- 窓口担当ピッカー追加（外部D案件時 required バリデーション）

### Phase 4: 通知ルーティングの宛先振替

- [notifications.js](_main/notifications.js) で `ball_holder_user_id` の
  is_external を判定 → true なら project.liaison_user_id にリダイレクト
- 監査ログに `proxy_acted_by` 追加

### Phase 5: 採算・工数集計から is_external を除外

- 関連クエリに `WHERE u.is_external = FALSE` を追加
- レポート画面の表示も同様にフィルタ

### Phase 6: 既存案件の遡及登録

- GND経由で過去に進んだ案件（並行運用で HFS 未登録のもの）を秘書チームが洗い出し
- 完了済み案件は最低限の項目（案件名・クライアント・担当本数・採算）だけ登録

## Open Questions

- 外部Dが**複数社**にまたがる案件（GND + 別代理店）の表現は？
  → サブディレクター（`sub_director_ids`）に外部Dを混在で入れる前提でPhase 3で UI 確認
- 擬似ユーザーの**廃止/退職**（代理店D交代）はどう扱うか？
  → 通常の users と同じ「無効化」フラグで吸収（既存の `is_active` を流用予定）
- **クライアント自身**がディレクター役を兼ねる案件（インハウス担当者がDっぽい動きをする）も
  同じ擬似ユーザー枠で扱うか？
  → 本ADRの対象外。クライアント担当者は `clients.primary_contact` 等で別管理。
  ただし「ボール保持者になる」要件が出てきたら別ADRで再検討する。
