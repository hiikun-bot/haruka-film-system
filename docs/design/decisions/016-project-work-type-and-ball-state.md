---
adr: 016
status: Proposed
date: 2026-05-10
tags: [projects, schedule, work-type, ball-state, lp, hp, maintenance, meetings, phases]
related_tables: [projects, project_tasks, project_phase_templates, project_phase_template_items, maintenance_tickets, project_events]
supersedes: null
superseded_by: null
extends: 010
---

# 016. 案件業務管理：業務種別（制作 / 保守）とボール状態モデル

- **Status**: Proposed
- **Date**: 2026-05-10
- **Decided by**: ユーザー（hiikun.ascs@gmail.com）

## Context

ADR 010 で「案件単位のスケジュール・タスク管理」（`project_tasks` /
`project_phase_templates` 系）の骨格は決まったが、運用してみるとさらに2つの
要件が浮上した。

### 浮上した要件

1. **LP / HP のフロー特性は「制作」一発ものとは別の構造を持つ**
   - 各フェーズ内で「社内作業 → 社内チェック → 先方確認 → 修正対応 → FIX」
     のサイクルが回る（＝**ボール（責任主体）の移動**）
   - ステップ画像（添付）の `★ヒアリング → ★デザイン → ★ワイヤー・デザイン →
     ★先方デザイン確認 → ★デザインFIX → ★コーディング → ★納品` のように、
     現状は **フェーズ** と **承認ゲート（先方確認・FIX）** が並列に並んで
     しまっている。これは構造の表現を取り違えており、フェーズ内の状態として
     吸収すべき
   - 一方、動画 / 静止画 / LINE初期制作は既存の
     `creative_status_template_items` フラットリストで運用が回っており、
     無理に同じモデルに統一する必要はない

2. **「制作」だけでは案件全体を表現できない（保守業務の存在）**
   - HP・LP・LINE の多くは納品後に **保守フェーズ** に移行し、修正依頼や
     改善提案、定例MTG、不定期の打合せが継続発生する
   - 現状 `creatives` テーブルに「保守チケット」「定例MTG」を押し込もうと
     すると、status_code の意味がカテゴリで全然違ってしまう
   - **保守は「制作」と並ぶもう1つの業務種別**として独立に扱う必要がある
   - 保守の中身としては「保守チケット（修正依頼）」「定例MTG・会議」が含まれる

### ADR 010 との関係

ADR 010 で定義された
`project_tasks` / `project_phase_templates` / `project_phase_template_items`
は **「制作系業務のフェーズ・タスク管理」** に位置付け直し、本ADRで業務種別の
全体像と、保守系業務のテーブル群を追加する。

## Decision

案件における **業務（work）** を 2 種別に分類し、それぞれに専用の進捗モデルを
持たせる。さらに「制作」業務には**フェーズ × ボール状態**の二軸モデルを導入する。

### 業務種別の分類

```
業務（work）
├─ ① 制作（production）
│   特性: 開始 → 納品で完了する一発もの
│   対象: LP / HP / LINE初期制作 / 動画 / 静止画
│   進捗モデル:
│    - LP / HP: ADR 010 の project_tasks にボール状態モデルを追加
│    - 動画 / 静止画 / LINE初期: 既存 creative_status_templates を維持（無理に移行しない）
│
└─ ② 保守（maintenance）
    特性: 終わりがない継続関係。チケット + 予定が混在
    対象: HP保守 / LP改修 / LINE運用保守
    内訳:
     ├─ 保守チケット（修正・改善依頼） → maintenance_tickets
     └─ 定例MTG・会議・打合せ          → project_events
    進捗モデル: チケット型 (Open → In Progress → Review → Done) +
                予定カレンダー
```

### ボール状態モデル（制作系・LP/HP用）

各フェーズ内に共通の5段階ボール状態を持つ（カテゴリ単位で定義可能・行追加で拡張可）。

```sql
CREATE TABLE project_ball_state_definitions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id     UUID NOT NULL REFERENCES creative_categories(id) ON DELETE CASCADE,
  code            TEXT NOT NULL,           -- 'in_progress' | 'internal_review' | 'client_review' | 'revising' | 'fixed'
  label           TEXT NOT NULL,           -- '社内作業' '社内チェック' '先方確認' '修正対応' 'FIX'
  holder_type     TEXT NOT NULL CHECK (holder_type IN ('internal','client','done')),
  sort_order      INT NOT NULL DEFAULT 0,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (category_id, code)
);
```

LP の初期 seed:

| sort | code | label | holder_type |
|---|---|---|---|
| 1 | in_progress | 社内作業 | internal |
| 2 | internal_review | 社内チェック | internal |
| 3 | client_review | 先方確認 | client |
| 4 | revising | 修正対応 | internal |
| 5 | fixed | FIX | done |

### project_tasks への列追加

ADR 010 で定義した `project_tasks` に以下を追加：

```sql
ALTER TABLE project_tasks
  ADD COLUMN ball_state_code TEXT,         -- 現在のボール状態（NULL=未開始 / fixed=完了）
  ADD COLUMN ball_holder_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN ball_moved_at TIMESTAMPTZ;    -- 最後にボール状態が変わった時刻
```

`ball_state_code` は `project_ball_state_definitions.code` と同じ値域だが
カテゴリを跨ぐ正規化はしない（カテゴリ別に意味が違うため）。

### フェーズ別オプション（柔軟性の担保）

`project_phase_template_items` に以下を追加し、案件ごとに上書き可能：

```sql
ALTER TABLE project_phase_template_items
  ADD COLUMN requires_internal_review BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN requires_client_review   BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE project_tasks
  ADD COLUMN skip_internal_review BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN skip_client_review   BOOLEAN NOT NULL DEFAULT false;
```

### 保守業務（maintenance）のスキーマ

```sql
-- 保守チケット
CREATE TABLE maintenance_tickets (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id         UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  ticket_number      INT NOT NULL,                    -- 案件内連番 #142 等
  title              TEXT NOT NULL,
  description        TEXT,
  status             TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','in_progress','review','done','cancelled')),
  priority           TEXT NOT NULL DEFAULT 'normal'
    CHECK (priority IN ('low','normal','high','urgent')),
  assignee_user_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  reporter_user_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  due_date           DATE,
  done_at            TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, ticket_number)
);

CREATE INDEX idx_maintenance_tickets_project ON maintenance_tickets(project_id, status);
CREATE INDEX idx_maintenance_tickets_assignee ON maintenance_tickets(assignee_user_id)
  WHERE status NOT IN ('done','cancelled');

-- 案件予定（定例MTG・会議・打合せ）
CREATE TABLE project_events (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id         UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title              TEXT NOT NULL,
  event_type         TEXT NOT NULL DEFAULT 'meeting'
    CHECK (event_type IN ('regular','meeting','review','other')),
  scheduled_at       TIMESTAMPTZ NOT NULL,
  duration_minutes   INT DEFAULT 60,
  location           TEXT,
  description        TEXT,
  attendees          JSONB DEFAULT '[]'::jsonb,        -- [{user_id, role}, ...]
  is_recurring       BOOLEAN NOT NULL DEFAULT false,
  recurrence_rule    TEXT,                             -- RRULE 互換 (例 'FREQ=MONTHLY;BYDAY=2MO')
  google_calendar_id TEXT,                             -- 将来連携用
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_project_events_project_date ON project_events(project_id, scheduled_at);
```

### projects への列追加

```sql
ALTER TABLE projects
  ADD COLUMN work_modes TEXT[] NOT NULL DEFAULT ARRAY['production']::TEXT[],
  -- 'production' | 'maintenance' （複数指定可）
  ADD COLUMN maintenance_started_at DATE;
```

### 案件画面のレイアウト（最終形）

```
┌─ ABC社 / Webマーケティング案件 ───────────────────────────────────────┐
│                                                                      │
│  📌 制作タスク（一発もの）                                             │
│   ✅ LPリニューアル制作    [納品済] 4/15                              │
│   ▶ HPトップリデザイン    [ヒアリング>ワイヤー>...]  📤先方確認中     │
│       ボール: 田中社長 (5/6 〜)                                       │
│                                                                      │
│  🔧 保守チケット（継続）                                               │
│   🟡 #142 トップ画像差し替え    [対応中] 担当: 山田                   │
│   🔴 #143 フォーム不具合        [緊急]   担当: 佐藤                   │
│   ⚪ #144 SEO月次レポート       [未着手] 期限: 5/末                   │
│                                                                      │
│  📅 予定                                                              │
│   5/15  月次定例MTG（ABC社）  オンライン 60分                          │
│   5/22  LP振り返り会         社内 30分                                │
└──────────────────────────────────────────────────────────────────────┘
```

## Consequences

### Positive

- **LP/HP の「フェーズ × 承認ゲート並列」問題が解消**：承認はボール状態に
  畳まれ、フェーズ列が本来の意味（大工程）を取り戻す
- **HP は LP の流用で済む**：データモデルが共通なので seed テンプレを足すだけ
- **保守業務が一級市民として表現できる**：チケット型・予定型のUIで自然に扱える
- **既存動画/静止画は無傷**：既存の `creative_status_templates` 流用で運用継続
- **将来カテゴリ追加が軽い**：制作系ならボール状態定義 + フェーズテンプレを
  カテゴリ単位で追加するだけ。保守系も同テーブルに乗る

### Negative / Trade-offs

- **テーブル数が増える**: `project_ball_state_definitions` /
  `maintenance_tickets` / `project_events` の3テーブル新設
- **進捗管理モデルが2系統並存**: 制作系（フェーズ × ボール）と
  クリエイティブ系（status_code フラット）。「LPの進捗は project_tasks、
  動画の進捗は creatives」という出し分けが必要
- **案件画面のレイアウトが複雑化**: 制作・保守チケット・予定の3セクションを
  併存表示する必要がある（折りたたみで対応）

### 既存ロジックへの影響

- **既存 creatives 系統は無変更**：動画/静止画/LINE初期制作はそのまま
- **ADR 010 の project_tasks に列追加**：`ball_state_code` 等の追加は破壊的でない
- **集計ロジック（ADR 002・005・006）には触れない**

## Alternatives Considered

### 案A: `creatives` に `work_type` 列を足してポリモーフィック化

- `creatives.work_type = 'production' | 'maintenance' | 'recurring' | 'meeting'`
- 1テーブルで全業務を扱う
- **却下理由**: status_code・ball_holder・必須項目が業務種別ごとに全く違う。
  1テーブルに4つの世界観を同居させると条件分岐が肥大化し、可読性も
  クエリも壊れる。テーブル分離の方が長期的に健全

### 案B: 全カテゴリ（動画・静止画含む）を二軸モデル（フェーズ × ボール状態）に統一

- 動画も「フェーズ=台本/編集/納品」「ボール=Dチェック/Pチェック/CL確認/...」
  に再表現
- **却下理由**: 動画はフラットなステップ列で運用が定着しており、二軸に
  押し込むと既存運用の UX が変わる。リスクに対するリターンが小さい。
  必要なときに移行する（"keep what works"）

### 案C: 保守業務もすべて `project_tasks` に押し込む

- `project_tasks.task_type = 'production' | 'ticket' | 'event'` で区別
- **却下理由**: 保守チケットは「期日・優先度・担当」が中心の世界観で、
  フェーズ・ボール状態の概念がそもそも存在しない。同テーブルに混ぜると
  カラムが歯抜けになり、インデックス・制約も曖昧に

### 案D: 定例MTG・会議は Google Calendar 連携だけで済ませる

- 自テーブルを持たず、外部カレンダーへのリンクで管理
- **却下理由**: 案件単位での予定一覧・参加者・議事録リンクの管理が
  必要。`google_calendar_id` カラムは持つが、自テーブルが正

## Implementation Plan

### Phase 1: LP制作のフェーズ × ボール状態モデル（最優先）

1. migration:
   - `project_ball_state_definitions` 新設 + LP用5段階 seed
   - `project_tasks` に ball_state_code / ball_holder_user_id /
     ball_moved_at を追加
   - `project_phase_template_items` に requires_internal_review /
     requires_client_review を追加
   - `projects` に work_modes / maintenance_started_at を追加
2. ADR 010 の Phase 1 実装と同時に進める（テーブル新設・テンプレ seed・
   case 編集モーダル「📋 工程表」）
3. UI: フェーズシェブロン + フェーズ詳細モーダルでボール状態の遷移
4. backend: `/api/projects/:id/tasks/:task_id/ball-state` エンドポイント

### Phase 2: HP制作（LP流用）

5. HP用の phase_template seed 追加（LP の構造を流用）
6. HP用の ball_state 定義（LP と同じでよければ流用、違うならカテゴリ別 seed）

### Phase 3: 保守業務

7. migration: `maintenance_tickets` 新設
8. UI: 案件画面に「🔧 保守チケット」セクション
9. backend: `/api/projects/:id/tickets` CRUD
10. 通知連携（チケット作成・期日近づく等）

### Phase 4: 定例MTG・予定

11. migration: `project_events` 新設
12. UI: 案件画面に「📅 予定」セクション
13. Google Calendar 連携（オプション、後追い）

### Phase 5: 旧 LP用 status_template_items の deprecation

14. migrations/2026-05-05_creative_categories.sql で seed された LP用
    `creative_status_template_items`（ヒアリング→ワイヤー・デザイン→...）は
    Phase 1 完了後に **非表示化**（is_active=false）
15. 既存の LP クリエイティブが status_code を持っていれば、移行スクリプトで
    project_tasks の ball_state_code に変換
