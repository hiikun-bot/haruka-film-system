---
adr: 010
status: Proposed
date: 2026-05-09
tags: [projects, schedule, tasks, gantt, lp, hp, phases, milestones]
related_tables: [projects, creative_categories, project_tasks, project_phase_templates, project_phase_template_items]
supersedes: null
superseded_by: null
---

# 010. 案件スケジュール / フェーズ・タスク管理（LP・HP 等カテゴリ横断）

- **Status**: Proposed
- **Date**: 2026-05-09
- **Decided by**: ユーザー（hiikun.ascs@gmail.com）

## Context

LP（ランディングページ）案件は「ヒアリング → ワイヤー → デザイン → コーディング → QA・納品」
のような明確なフェーズと、フェーズ内の細かいタスク（20〜30個）、およびマイルストーン
（M1〜M6 等の絶対に守る日）を持つ。同様に HP（コーポレートサイト）案件は
50〜100 タスクを 3〜4 フェーズで管理する。

サンプル調査の結果、**LP / HP に共通する構造**は以下：

1. **2階層構造**：フェーズ見出し（`【ヒアリング】`等）の下にタスクが連なる。
   ただし全タスクが必ずフェーズ配下とは限らず、フラットな単独タスクも混在。
2. **タスクには担当・期日・完了状態**：担当アイコン4種（自社 ● / クライアント ★ /
   打ち合わせ ◆ / マイルストーン ■）、開始・終了日、`is_done` チェック。
3. **元日程 / 新日程**：当初予定と現在予定の両方を保持し、遅延・変更履歴を可視化。
4. **マイルストーン**：◆や赤背景で「絶対に守る日」を視認可能に。FIX 系タスクが該当。
5. **備考列**：自由記述メモ。

LP と HP の本質的な違いは「**カテゴリ別に異なるタスク雛形**」だけであり、
データ構造・UI・ロジックは共通化できる。将来「動画」「撮影」「SNS運用」等の
カテゴリが増えても、マスター追加だけで対応可能。

### 既存資産

- `creative_categories`（LP / HP / 動画 等のカテゴリマスタ、`code` で識別）
- `projects.primary_category_id`（案件のカテゴリ紐付け、FK to creative_categories）
- `creative_status_templates` / `creative_status_template_items`
  （**クリエイティブ単位**の工程テンプレ。LP標準工程6段階が既登録）
- クリエイティブ用ガントチャート [haruka.js:9218-9606](../../../public/js/haruka.js#L9218-L9606)
  （Timeline 型実装、`is_milestone` 対応済み。レイヤー2で流用可能）
- 通知パネル [public/js/notification-panel.js](../../../public/js/notification-panel.js)
  （ヘッダーアイコン → スライドパネル UX。レイヤー4 マイタスクで流用可能）

## Decision

**「案件単位のスケジュール」と「クリエイティブ単位の進捗」は別概念として分離する。**
案件単位の工程管理用に `project_tasks` / `project_phase_templates` /
`project_phase_template_items` の3テーブルを新設し、`creative_status_templates`
には手を入れない（クリエイティブ単位の進捗管理として残す）。

### スキーマ

#### マスターテーブル（カテゴリ別タスク雛形）

```sql
CREATE TABLE project_phase_templates (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id     UUID NOT NULL REFERENCES creative_categories(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,                -- '標準LP工程' '標準HP工程' 等
  description     TEXT,
  is_default      BOOLEAN NOT NULL DEFAULT false,  -- 案件作成時の初期適用フラグ
  is_active       BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_project_phase_templates_category
  ON project_phase_templates(category_id) WHERE is_active;

CREATE TABLE project_phase_template_items (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id        UUID NOT NULL REFERENCES project_phase_templates(id) ON DELETE CASCADE,
  parent_item_id     UUID REFERENCES project_phase_template_items(id) ON DELETE CASCADE,
  is_phase_header    BOOLEAN NOT NULL DEFAULT false,  -- 【ヒアリング】等の見出し行
  title              TEXT NOT NULL,
  default_offset_days_from_start  INT,   -- 案件開始日から何日後に開始
  default_duration_days           INT,   -- タスク所要日数
  default_assignee_type           TEXT NOT NULL DEFAULT 'us'
    CHECK (default_assignee_type IN ('us','client','meeting','milestone')),
  is_milestone       BOOLEAN NOT NULL DEFAULT false,
  default_priority   TEXT NOT NULL DEFAULT 'normal'
    CHECK (default_priority IN ('low','normal','high')),
  default_note       TEXT,
  sort_order         INT NOT NULL DEFAULT 0,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_project_phase_template_items_template
  ON project_phase_template_items(template_id, sort_order);
```

#### 案件側タスクテーブル

```sql
CREATE TABLE project_tasks (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id         UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_task_id     UUID REFERENCES project_tasks(id) ON DELETE CASCADE,
  is_phase_header    BOOLEAN NOT NULL DEFAULT false,
  title              TEXT NOT NULL,
  start_date         DATE,
  original_end_date  DATE,        -- 元日程（変更前）
  current_end_date   DATE,        -- 新日程（現在予定）
  assignee_type      TEXT NOT NULL DEFAULT 'us'
    CHECK (assignee_type IN ('us','client','meeting','milestone')),
  assignee_user_id   UUID REFERENCES users(id) ON DELETE SET NULL,  -- 自社担当者（任意）
  is_milestone       BOOLEAN NOT NULL DEFAULT false,
  is_done            BOOLEAN NOT NULL DEFAULT false,
  done_at            TIMESTAMPTZ,
  priority           TEXT NOT NULL DEFAULT 'normal'
    CHECK (priority IN ('low','normal','high')),
  note               TEXT,
  sort_order         INT NOT NULL DEFAULT 0,
  template_item_id   UUID REFERENCES project_phase_template_items(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_project_tasks_project ON project_tasks(project_id, sort_order);
CREATE INDEX idx_project_tasks_assignee ON project_tasks(assignee_user_id)
  WHERE assignee_user_id IS NOT NULL AND NOT is_done;
CREATE INDEX idx_project_tasks_milestone ON project_tasks(current_end_date)
  WHERE is_milestone AND NOT is_done;
```

#### projects への列追加

```sql
ALTER TABLE projects
  ADD COLUMN scheduled_start_date DATE,           -- 工程表の起点
  ADD COLUMN active_phase_template_id UUID
    REFERENCES project_phase_templates(id) ON DELETE SET NULL;
```

### 自動生成ロジック

案件作成時：

1. `projects.primary_category_id` から該当カテゴリの
   `is_default = true` のテンプレを取得（なければスキップ）
2. `scheduled_start_date` がセットされていれば、テンプレ各行の
   `default_offset_days_from_start` を加算して `start_date` /
   `current_end_date` を自動算出（`scheduled_start_date` 未設定なら日付NULL）
3. `project_tasks` に全行コピー（`template_item_id` で出自を保持）
4. 以降は案件側で自由編集（テンプレ更新は遡及しない）

### UI 配置（4レイヤー）

| Layer | 配置 | 役割 |
|---|---|---|
| L1 詳細工程表 | モーダルポップアップ | 1案件のタスクを表形式で全編集 |
| L2 全案件マイルストーンガント | **案件タブ上部**（折りたたみ可） | 横断俯瞰。**ベースビュー** |
| L3 今週の山場 | ダッシュボード | 直近マイルストーン + 遅延アラート |
| L4 マイタスク | **ヘッダーアイコン✅** + ダッシュボードウィジェット | 個人タスク |

L2 の案件行クリック → L1 がモーダルで開く（メイン導線）。

### 担当タイプの色分け（UI 共通仕様）

| assignee_type | アイコン | 色 |
|---|---|---|
| `us` | ● | グレー |
| `client` | ★ | 赤 |
| `meeting` | ◆ | 青 |
| `milestone` | ■ | 黒（FIX 系は赤背景） |

## Consequences

### Positive

- **カテゴリ横展開が容易**：LP/HP/動画/撮影/SNS運用、新カテゴリはマスター追加のみ
- **既存資産との分離**：`creative_status_templates`（クリエイティブ単位）はそのまま残るので破壊的変更なし
- **段階リリース可能**：L1 単独でも価値があり、L2-L4 は並列で追加できる
- **遅延の可視化**：`original_end_date` vs `current_end_date` で「いつ・どれだけずれたか」が即座に分かる
- **個人タスク導線**：`assignee_user_id` インデックスにより L4 マイタスクが軽量

### Negative / Trade-offs

- **二重に似た構造**：`creative_status_template_items` と `project_phase_template_items`
  が並走する。将来「クリエイティブ進捗も案件タスクで吸収すべきか」を再検討する余地は残る
- **マスター編集 UI が必要**：「設定タブ → カテゴリ管理」配下に
  「フェーズテンプレ管理」を新設する必要がある
- **テンプレ未設定カテゴリ**は空の工程表で開始することになる（許容）

### 既存集計ロジックへの影響

なし。`project_tasks` は新規テーブルで、`project_estimate_lines` /
`project_fixed_items` 等の既存集計（ADR 002・005・006）には触れない。

## Alternatives Considered

### 案A: `creative_status_templates` を拡張して案件単位も対応

- `scope_type` 列を追加して `'creative'` / `'project'` で区別
- **却下理由**: クリエイティブ単位（個別の進捗・ボール保持者管理）と
  案件単位（複数フェーズ・マイルストーン・元日程/新日程）は要件が異なる。
  共通化すると両方の制約が混ざり、どちらの UI も歪む。

### 案B: タスクをフラット構造のみで持つ（フェーズ見出しなし）

- `project_tasks` の `parent_task_id` を持たない
- **却下理由**: HP のように 50〜100 タスクある案件で、フェーズ見出しなしは
  運用に耐えない。サンプル全てがフェーズ見出しを使っていた。

### 案C: 元日程は履歴テーブルで管理

- `project_task_date_history` を別テーブルで、変更のたびに INSERT
- **却下理由**: 現時点では「元と新の2点」が見えれば十分。
  将来「いつ何回ずらしたか」分析が必要になったら、このテーブルに格上げする。

## Implementation Plan

### Phase 1（先行リリース・コア機能）

1. migration: `project_tasks` / `project_phase_templates` / `project_phase_template_items`
2. projects 列追加: `scheduled_start_date` / `active_phase_template_id`
3. 標準テンプレ seed: LP（27行・5フェーズ・M1-M6）/ HP（50行・3フェーズ）
4. backend: `/api/projects/:id/tasks` CRUD, `/api/phase-templates/*`
5. frontend L1: 案件編集モーダル「📋 工程表」セクション（表形式 + コンパクトガント）
6. frontend L2: 案件タブ上部の全案件マイルストーンガント

### Phase 2（並列で追加）

7. frontend L3: ダッシュボード「今週の山場」ウィジェット
8. frontend L4: ヘッダー ✅ アイコン + マイタスクパネル
9. 設定タブ「フェーズテンプレ管理」UI

### Phase 3（将来）

10. クライアント共有モード（公開ビュー）
11. ガント上でのドラッグ操作（期日変更）
12. 一括日程シフト（開始日変更時の全タスク連動）
