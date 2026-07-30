---
adr: 017
status: Accepted
date: 2026-05-14
tags: [resource, availability, google-calendar, oauth, capacity, scheduling, dashboard]
related_tables: [users, team_members, member_working_hours_profile, member_working_hours_daily, project_estimate_template, project_workload, project_workload_assignment, project_workload_daily]
supersedes: null
superseded_by: null
related_adrs: [008-team-leader-vs-role, 010-project-schedule-tasks, 015-view-as-development-checklist, 016-project-work-type-and-ball-state]
---

# 017. メンバーリソース可視化（GCal連携・受注余力ダッシュボード）

- **Status**: Accepted
- **Date**: 2026-05-14
- **Decided by**: ユーザー（hiikun.ascs@gmail.com）

## Context

現状、各チームの稼働可能時間（平日 / 休日 × 日次）は **手動更新の Google スプレッドシート**で管理されている（添付の「動画編集チーム」タブ等）。問題は以下：

- メンバー本人と表計算の二重管理。Google Calendar に予定があってもスプレッドシートに反映されない
- チームリーダーが「来月どれくらい仕事を受けられるか」を判断する材料が散在
- 大型案件の受注可否（例：2〜3ヶ月先の納期で工数 100h 規模）を**事前に試算するシミュレーション基盤がない**
- 結果として「営業判断 → 受注 → 受け皿不足が発覚 → メンバー過負荷」のパターンが起きやすい

本来の目的は **「予期される仕事量とチーム内リソースが足りているか」** を、現在〜2ヶ月先まで一望できるようにすること。

## Decision

メンバーリソース管理を以下の三層構造で実装する。

1. **供給側（個人プロフィール + Google Calendar 連携）** — メンバー本人が自分の基本稼働時間を設定し、GCal の予定を差し引いて日次の対応可能時間を自動算出する
2. **需要側（案件テンプレートに基づく超ざっくりシミュレーション）** — チームリーダーが「LP 案件 1 件」「動画編集 中サイズ」など粗粒度で工数を入力し、担当者ごとに日次配分する
3. **突合ビュー（チームリーダー向け受注余力ダッシュボード）** — 供給と需要を週単位 / 日単位で並べ、空き工数を可視化する

開発フェーズの方針：

- **Phase 0**: Google Calendar 連携の**基盤のみ**を先に作る（OAuth・トークン保管・予定取得 API・最低限の動作確認画面）。これが MVP の前提インフラ
- **Phase 1（MVP）**: **既存スプレッドシートをシステム側で完全に再現する**ことをゴールに据える。供給側 UI（個人ページ + 集約ページ）を完成させ、運用がスプレッドシートから移行できる状態にする
- **Phase 1.5**: 需要側のシミュレーション
- **Phase 2**: 高度化

> Phase 0 を独立させる理由：GCal OAuth は OAuth 同意画面の Google 側審査・本番ドメイン登録・トークン暗号化保管など、UI 実装と独立したインフラ作業を含むため、先に基盤だけ通しておくと Phase 1 の UI 実装が止まらない。

---

## 1. 供給側：稼働時間プロフィール + GCal 連携（Phase 1）

### 1.1 基本稼働時間プロフィール

各メンバーが自分のマイページで以下を設定する。

- **平日デフォルト時間帯**: 例 `[{ start: "19:00", end: "21:30" }]`
  - 1 日に複数枠も可（例：昼 1h ＋ 夜 2h）
- **休日デフォルト時間帯**: 例 `[{ start: "13:00", end: "16:00" }]`
- **平日 / 休日の判定**:
  - 初期実装: 土日 + **国民の祝日カレンダー**（日本）で自動判定
  - 将来: **会社カレンダーマスター**（独自の休業日設定）で上書き可能とする。Phase 2 で実装するが、判定ロジックは Phase 1 から「会社カレンダー > 祝日カレンダー > 曜日判定」の優先順で書いておく

### 1.2 Google Calendar 連携

- **OAuth スコープ**: `https://www.googleapis.com/auth/calendar.events.readonly`（書き込み不要）
- **接続単位**: メンバー個人のアカウント（既存の Drive 認証とは別トークンで保管）
- **取得対象カレンダー**: 初期は `primary` のみ。将来複数カレンダー対応は Phase 2
- **取得タイミング**:
  - 個人ページ / 集約ページのロード時に lazy fetch
  - 画面上に手動「再計算」ボタンを設置
  - 定期バッチは Phase 2（初期実装では入れない）
- **取得範囲**: 今日 - 7 日 〜 今日 + 60 日（2 ヶ月ビューを賄う）

#### 🔒 プライバシー原則（全フェーズ共通・厳守）

Google Calendar から取得するのは **時間情報のみ**。予定の内容に関わる情報は**API リクエストの段階で取得しない**（Google の `fields` パラメータで送信フィールドを制限）。

| 取得する項目 | 取得しない項目（取得・保存・ログ出力すべて禁止） |
|---|---|
| `id`（同期判定用） | `summary`（件名） |
| `start` / `end`（時刻） | `description`（説明） |
| `status`（`cancelled` 除外用） | `location`（場所） |
| `transparency`（`transparent` 除外用） | `attendees`（参加者） |
| | `creator` / `organizer` |
| | `conferenceData`（会議URL）|
| | `attachments`（添付） |
| | 内容に関わるその他全フィールド |

実装上の遵守ポイント:

- `events.list` 呼び出しでは必ず `fields` パラメータで送信項目を制限（例: `items(id,status,transparency,start(dateTime,date,timeZone),end(dateTime,date,timeZone))`）
- DB 保存項目（`member_working_hours_daily.gcal_raw_slots` 等）にも**時間情報のみ**を保存。`summary` 等の列は作らない
- `console.log` 等のログ出力でもイベントオブジェクト全体をダンプしない
- UI 表示でも件名・場所等を出さない。ユーザー透明性のため「予定の内容は取得していません（時間情報のみ）」と明示する
- `fetchAccountEmail`（接続済みアカウントの email 確認）は**アカウント識別情報**であって予定内容ではないため、本原則の対象外（接続管理 UI で必要）

### 1.3 日次稼働可能時間の算出ロジック

```
日次の基本枠（平日/休日 × プロフィール）
   ─ GCal 予定（その日に重なる時間帯）
   ─ 30 分未満の隙間（実稼働として現実的でないためカット）
   = 自動算出 computed_slots
```

例：

```
基本枠 19:00-21:30 (2.5h)
GCal: 20:00-20:15 MTG
 ↓
slots = [19:00-20:00, 20:15-21:30]
 ↓ 15 分の隙間は無視されず保持（30 分未満カットは枠全体に対する閾値ではなく "GCal 引き算で残った微小スロット" にも適用、初期は両方ハードコード閾値 30 分）
hours = 2.25h
```

> **詳細閾値（30 分未満カット）の挙動** は実装時に微調整余地あり。Phase 1 ではシンプルに `合計値の表示は分単位を四捨五入せず保持`、`30 分未満のスロットは集計の hours から除外` で始める。

### 1.4 手動オーバーライドの優先順位

最重要ルール：

```
高 ┌─────────────────────────┐
   │ ① 手動オーバーライド    │ ← 本人/リーダーが画面で触った値
   ├─────────────────────────┤
   │ ② Google Calendar 算出  │ ← 連携中の自動値
   ├─────────────────────────┤
   │ ③ 基本プロフィール      │ ← 平日/休日のデフォルト
低 └─────────────────────────┘
```

- 同期処理は手動オーバーライド済みのセルを**スキップ**する（②が③を絶対に上書きしない）
- 手動オーバーライドされたセルは画面上で **常時マーキング**（マーク `●`）
- 手動値が GCal 算出値と乖離している場合は **背景色で警告**（差分が一目でわかる）
- ホバー時のツールチップで **手動値 / GCal 算出値の両方** と「GCal 算出に戻す」リンクを表示

### 1.5 特殊記号（× / △ / AM）の扱い

- 既存スプレッドシートの慣習を踏襲。値として `'×'` `'△'` `'AM'` を持てるようにする
- これらは **手動オーバーライド扱い**（GCal の終日予定からの自動判定は Phase 2 検討）
- 集計時の扱い:
  - `×`: 0h
  - `△`: 0h（不確定として集計から除外、別レーンで「不確定 N 人」表示）
  - `AM` / `PM`: 基本枠の午前 / 午後分のみ算入

### 1.6 集約ページ（添付スプレッドシートのリプレース）

- 添付スプレッドシートと同等のレイアウト（メンバー × 日付）を Web 画面に再現
- GCal 連動メンバーはスプレッドシート入力**不要**
- **未連動メンバー**は Phase 3 で別途スプレッドシート → DB 反映の経路を作る（Phase 1 では未連動メンバーの行は手動オーバーライドのみで埋める）
- セル表示パターン:

```
┌────────┐   ┌────────┐   ┌────────┐
│  2.5   │   │ 2.5 ●  │   │  ×  ●  │
└────────┘   └────────┘   └────────┘
 GCal自動    手動(GCal一致) 手動(GCal不一致=警告色)
```

- セルクリックで時間帯詳細を展開
- 集約ページの編集権限は ADR 015 のチェックリストに従う（後述 §4）

---

## 2. 需要側：案件シミュレーション（Phase 1.5）

### 2.1 案件テンプレート（マスター）

カテゴリごとに **大 / 中 / 小** のサイズプリセットを持つ。最終値は経営側で確定。Phase 1.5 開始時の仮値：

| カテゴリ | モード | 小 | 中 | 大 |
|---|---|---|---|---|
| 動画編集（単発） | fixed | 1 日 / 8h | 2-3 日 / 20h | 5 日〜 / 40h |
| LP 制作 | fixed | 3 日 / 24h | 5 日 / 40h | 10 日 / 80h |
| SNS 運用代行 | recurring | 週 3 本 × 2h = 6h/週 | 週 5 本 × 2h = 10h/週 | 週 10 本 × 2h = 20h/週 |
| その他 | free | 自由入力 | 自由入力 | 自由入力 |

- **fixed モード**: 開始日 + サイズで終了日と総工数が自動入力
- **recurring モード**: 契約期間 + 週次頻度で月次総工数を自動算出
- **free モード**: 全項目を自由入力（テンプレート未登録カテゴリ用の逃げ道）

### 2.2 役割配分

案件テンプレートに **デフォルト役割比率** を持たせる：

- 動画編集（単発）: ディレクター 20% / 作業者 80%
- LP 制作: ディレクター 15% / デザイナー 85%
- SNS 運用代行: 主担当 100%

「ディレクター」の定義：

- **第一優先**: その案件に明示的にアサインされた `team_members.role = 'director'` のメンバー
- **不在時**: チームの `team_members.leader_rank` が最上位のメンバー（ADR 008 で定義）
- これにより「ディレクター不在チーム」でもリーダーが自動的に配分対象になる

### 2.3 個人 × 日次への展開

- **fixed モード**: 担当者ごとの総工数を期間内の稼働可能日に均等割（=「日数で割る」初期実装）
- **recurring モード**: 週次工数を期間内の全週に展開し、各週は月〜金で均等割
- **集配分の詳細ロジック**（重み付け、納期に近いほど厚くする等）は別途検討（open-questions Q3 として記録）
- 表示単位は **日単位**。クリックで **時間単位 → 分単位** まで掘り下げて手動調整可能
- 手動調整したセルは `is_customized = true` のマーカーを付け、再シミュレーション時に**上書きしない**

### 2.4 見込み確度

- 各案件に `confidence_pct` を持たせる（100% 確定 / 70% 見込み / 30% 打診中 など 3 段階）
- 集計時は確度別にレーン分けして表示（確定のみ / 確定 + 見込み / 全部 の 3 表示モード）

### 2.5 チーム範囲

- **Phase 1.5**: 各チームは**自チームの案件のみ**を扱う。動画編集チームとデザイナーチームは独立して可視化される
- **Phase 2**: 案件カテゴリ × チームの紐付け（例：LP 案件はデザイナーチームへ自動振り分け）と、複数チーム横断のリソース融通を実装

---

## 3. 突合ビュー：チームリーダー向け受注余力ダッシュボード

### 3.1 表示範囲とレイアウト

- **デフォルト表示期間**: 今月 + 来月（最低 2 ヶ月、推奨 8〜9 週間）
- **表示単位**: 週単位を主軸 / 月サマリ併記。週セルをクリックで日次内訳を展開

```
週ビュー（チームリーダー画面）
              W19  W20  W21  W22  W23  W24  W25  W26
 供給(h)      86   108  120  120  115  120  120  120
 需要(h)      60   75   90   140  130  100  80   95
 差分         +26  +33  +30  -20  -15  +20  +40  +25
 信号         🟢   🟢   🟢   🔴   🟡   🟢   🟢   🟢
```

- 信号閾値（初期値、調整可）:
  - 🟢 余裕 +10h 以上
  - 🟡 -10h 〜 +10h
  - 🔴 -10h 未満

### 3.2 シミュレーションモード

- ダッシュボード上で「**仮案件をここに置いたら？**」を試算できる
- 仮案件は `status = 'simulation'` で保存され、確定 / 削除ボタンで永続化 or 破棄
- 仮案件は他のリーダーにも見えるが、確度フィルタで「シミュレーション表示 ON/OFF」を切替可能

### 3.3 アラート

- **Phase 1.5 時点**: ダッシュボード上の信号表示のみ
- **Phase 2**: 「3 週以内に🔴が発生」など条件で Slack / メール通知（経営ダッシュボード roadmap と連動）

---

## 4. 権限（VIEW AS チェックリスト準拠）

ADR 015 に従い、以下の `permission_keys` を新規登録する。VIEW AS で全ロール動作確認を行う。

| permission_key | 用途 | デフォルト ロール |
|---|---|---|
| `availability:view-own` | 自分の稼働時間ページ閲覧・編集 | 全メンバー |
| `availability:view-team` | 自チーム集約ページ閲覧 | director, producer, admin |
| `availability:edit-team` | 自チームメンバーの稼働時間を手動オーバーライド | director（リーダー判定込み）, producer, admin |
| `workload:view-team` | 自チーム需要ダッシュボード閲覧 | director, producer, admin |
| `workload:edit-team` | 案件シミュレーション作成・編集 | director（リーダー判定込み）, producer, admin |
| `workload:view-all` | 全チーム横断閲覧 | admin, producer（Phase 2 想定） |

**個人セルの編集ルール**:

- **本人**: 自分の稼働時間セルを編集可
- **チームリーダー**（director または `leader_rank` 最上位）: 自チームメンバーのセルを編集可
- それ以外: 閲覧のみ

フロントエンドは `currentUser.role` を直書きせず、`effectiveRole()` / `hasPermission(key)` を使うこと（ADR 015）。

---

## 5. データモデル

### 5.1 供給側

```sql
-- 基本プロフィール（マイページで編集）
CREATE TABLE member_working_hours_profile (
  user_id           uuid PRIMARY KEY REFERENCES users(id),
  weekday_slots     jsonb NOT NULL DEFAULT '[]',  -- [{start:"19:00",end:"21:30"}]
  holiday_slots     jsonb NOT NULL DEFAULT '[]',
  gcal_connected    boolean NOT NULL DEFAULT false,
  gcal_account_id   text,
  gcal_calendar_id  text DEFAULT 'primary',
  gcal_refresh_token_encrypted text,   -- KMS 等で暗号化
  gcal_last_synced_at timestamptz,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- 日次の実値（キャッシュ + 手動上書き）
CREATE TABLE member_working_hours_daily (
  user_id            uuid REFERENCES users(id),
  date               date,
  -- 自動算出
  computed_slots     jsonb,           -- GCal 引き算後
  computed_hours     numeric(5,2),
  gcal_raw_slots     jsonb,           -- GCal 生イベント（差分表示用）
  gcal_synced_at     timestamptz,
  -- 手動オーバーライド
  manual_override    boolean NOT NULL DEFAULT false,
  manual_slots       jsonb,
  manual_symbol      text,            -- '×' '△' 'AM' 'PM' null
  manual_set_at      timestamptz,
  manual_set_by      uuid REFERENCES users(id),
  -- 警告フラグ
  diverges_from_gcal boolean NOT NULL DEFAULT false,
  PRIMARY KEY (user_id, date)
);
CREATE INDEX idx_mwh_daily_date ON member_working_hours_daily(date);
```

### 5.2 需要側

```sql
-- 案件テンプレート（マスター）
CREATE TABLE project_estimate_template (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  category        text NOT NULL,   -- 'video' | 'lp' | 'sns_ops' | 'other'
  team_type       text,            -- 'video' | 'design'（Phase 2 で活用）
  mode            text NOT NULL,   -- 'fixed' | 'recurring' | 'free'
  size_presets    jsonb NOT NULL,  -- {S:{days,hours}, M:{...}, L:{...}}
  default_role_split jsonb,        -- {director:0.2, worker:0.8}
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- シミュレーション / 実案件
CREATE TABLE project_workload (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id       uuid REFERENCES project_estimate_template(id),
  name              text NOT NULL,
  size              text,                  -- 'S'|'M'|'L'（fixed のみ）
  start_date        date NOT NULL,
  end_date          date NOT NULL,
  total_hours       numeric(7,2) NOT NULL,
  recurring_config  jsonb,                 -- {per_week_count, hours_per_unit}
  confidence_pct    int NOT NULL DEFAULT 100 CHECK (confidence_pct BETWEEN 0 AND 100),
  status            text NOT NULL DEFAULT 'simulation',
                    -- 'simulation' | 'pending' | 'confirmed' | 'in_progress' | 'done' | 'cancelled'
  team_id           uuid REFERENCES teams(id),
  created_by        uuid REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_pwl_team_dates ON project_workload(team_id, start_date, end_date);

-- 担当配分
CREATE TABLE project_workload_assignment (
  workload_id     uuid REFERENCES project_workload(id) ON DELETE CASCADE,
  user_id         uuid REFERENCES users(id),
  role            text NOT NULL,           -- 'director' | 'worker' | 'sub'
  total_hours     numeric(7,2) NOT NULL,
  PRIMARY KEY (workload_id, user_id)
);

-- 日次展開（キャッシュ + 手動微調整）
CREATE TABLE project_workload_daily (
  workload_id      uuid REFERENCES project_workload(id) ON DELETE CASCADE,
  user_id          uuid REFERENCES users(id),
  date             date,
  estimated_hours  numeric(5,2) NOT NULL,
  custom_slots     jsonb,        -- 時/分単位の調整時のみ
  is_customized    boolean NOT NULL DEFAULT false,
  PRIMARY KEY (workload_id, user_id, date)
);
CREATE INDEX idx_pwd_user_date ON project_workload_daily(user_id, date);
```

### 5.3 過去日のスナップショット運用

- `member_working_hours_daily` レコードは **その日が終わった時点で固定** とする
- GCal の予定が後から編集されても、過去日の `computed_slots` / `computed_hours` は再計算しない（勤怠記録の改ざんを防ぐ）
- 実装上は、日次バッチで「昨日以前のレコードは `gcal_synced_at` を更新しない」を強制

---

## 6. フェーズ計画

> **ゴール再確認**: Phase 1（MVP）の完了 = **添付の「動画編集チーム」スプレッドシートが、システム側の集約ページで完全に再現されている状態**。スプレッドシートを閉じても運用が回る。

### Phase 0 — GCal 連携の基盤（最初に着手）

UI を作る前のインフラ整備フェーズ。

- [ ] Google Cloud プロジェクト作成 / Calendar API 有効化
- [ ] OAuth 同意画面の設定（スコープ: `calendar.events.readonly`）
- [ ] サーバー側 OAuth 認可フロー（`/api/auth/google-calendar/start` `/callback`）
- [ ] リフレッシュトークンの暗号化保管（既存 KMS 流用 or env-key 方式）
- [ ] GCal イベント取得ユーティリティ（`lib/google-calendar.js#fetchEventsForRange(userId, from, to)`）
- [ ] 動作確認用の最小画面（「自分の GCal を繋ぐ」ボタン + 翌日の予定一覧表示）
- [ ] エラーハンドリング（トークン失効・スコープ不足・429）

→ **完了条件**: 開発者が自分のアカウントを繋ぎ、明日の予定を JSON で取得できる。

### Phase 1（MVP）— スプレッドシートをシステムで再現

添付スプレッドシートの全列を Web 画面に再現するフェーズ。

- [ ] `member_working_hours_profile` / `_daily` テーブル作成（migration）
- [ ] マイページ：基本稼働時間プロフィール編集 UI
  - 平日 / 休日デフォルト時間帯（複数枠可）
  - GCal 連携 ON/OFF
- [ ] 日次算出ロジック
  - 平日 / 休日判定（祝日カレンダー込み）
  - GCal 予定の引き算
  - 30 分未満の隙間カット
- [ ] 個人ページの日次表示（セル ＝ 時間数、ホバー / クリックで時間帯展開）
- [ ] 手動オーバーライド
  - 数値 / `×` / `△` / `AM` / `PM` の入力
  - `●` マーカー表示
  - GCal 算出値との差分背景色
  - ツールチップで「GCal 算出に戻す」リンク
- [ ] **集約ページ**（添付スプレッドシート相当）
  - メンバー × 日付の二次元グリッド
  - 平日 / 休日デフォルト列（B / C 列相当）
  - 週合計列・チーム合計行
  - 2 ヶ月分のスクロール表示
- [ ] 権限（ADR 015 チェックリスト準拠）
  - `availability:view-own` / `view-team` / `edit-team` 新規登録
  - 本人 + リーダーの編集権制御
- [ ] スプレッドシートからの初期データ移行
  - 既存メンバー全員分の「平日 / 休日」基本値を取り込み
  - 移行スクリプト or 一括入力 UI

→ **完了条件**: 添付スプレッドシートを閉じても、システム上で同じ情報が見える。チームリーダーは Web 画面だけで稼働状況を把握できる。

### Phase 1.5 — 需要側シミュレーション

- [ ] `project_estimate_template` / `project_workload` 系テーブル
- [ ] 案件シミュレーション入力 UI（大中小プリセット）
- [ ] 個人 × 日次展開
- [ ] 受注余力ダッシュボード（週ビュー、信号表示、シミュレーションモード）
- [ ] 見込み確度別レーン

### Phase 2 — 高度化

- 会社カレンダーマスター
- GCal 終日予定からの記号自動判定（`×` = 「休み」など。Q6）
- 案件カテゴリ × チームの紐付け / 複数チーム横断
- 過去実績との突合（予測精度向上）
- Slack / メールアラート
- 定期バッチ同期
- 複数 GCal 取得

### Phase 3 — スプレッドシート派の取り込み

- GCal 連携できないメンバー向けに「スプレッドシート → DB 反映」の経路を提供
- ただし Phase 1 の時点で**全メンバーが GCal 連携完了**していれば、この Phase は不要になる可能性が高い

---

## Consequences

### 良い影響

- メンバーの稼働時間が**本人 1 箇所**で管理される（プロフィール + GCal）
- チームリーダーは表計算手動更新から解放される
- 受注判断時に**2 ヶ月先までの余力**を定量的に見られる
- 大型案件のシミュレーションが UI 上で完結する
- VIEW AS チェックリスト準拠で権限事故を防ぐ

### 注意点・トレードオフ

- GCal 連携できないメンバー（プライベートカレンダー混在等）が出る可能性 → Phase 3 でスプレッドシート経路を残す
- 案件テンプレートの「大中小」の精度が低いと需要側の数字が信用できない → 経営側でテンプレ値を継続調整する運用が必要
- 過去日スナップショットの実装を怠ると勤怠改ざんリスクがある
- recurring モードの「月〜金均等割」は実務とズレる可能性あり（クリエイティブ業務は曜日傾向あり）→ 集配分ロジックは open-questions Q3 で継続検討

### 影響範囲

- 既存スプレッドシートはしばらく**並行運用**（Phase 1 完了 → Phase 1.5 着手 → 全員 GCal 連携完了で廃止）
- 既存の `team_members.leader_rank`（ADR 008）と密に連動する
- 経営ダッシュボード roadmap と最終的にマージされる（売上 / 粗利 / 納期リスク / 採算ランキング + **受注余力**）

---

## 関連 ADR

- [008. チームリーダー vs ロール](008-team-leader-vs-role.md) — ディレクター不在時のリーダー判定で参照
- [010. プロジェクトスケジュール / タスク](010-project-schedule-tasks.md) — 案件納期との接続
- [015. VIEW AS チェックリスト](015-view-as-development-checklist.md) — 権限実装の必読
- [016. 業務種別とボール状態](016-project-work-type-and-ball-state.md) — 業務種別（制作 / 保守）との対応関係（recurring モードが保守系に対応）
