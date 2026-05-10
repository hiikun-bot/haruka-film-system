---
adr: 018
status: Proposed
date: 2026-05-11
tags: [assets, library, ai, gemini, drive, search, tags, cost-control]
related_tables: [media_assets, media_asset_links, media_asset_tags, projects, creatives]
supersedes: null
superseded_by: null
related_adrs: [001, 007, 012, 015]
---

# 018. 素材ライブラリ：Gemini 無料枠で AI 解析・タグ検索する案件横断プール

- **Status**: Proposed
- **Date**: 2026-05-11
- **Decided by**: ユーザー（hiikun.ascs@gmail.com）

## Context

### 経緯

旧 video-ops プロトタイプ（`editor.html`）には「動画素材を Anthropic Claude のマルチモーダルで解析し、title / summary / scene_description / suggested_use / quality_notes / tags を自動生成する」機能があった。これは費用懸念から **PR #571 で全削除済**（`main` にマージ完了）。

しかしユーザーは **「動画素材の AI 解析・検索」機能だけは haruka 本体に復活させたい** と表明している。

### ユーザーが描いているユースケース

> 使えそうな素材があったらどんどん入れていただいて構いません。
> 入れた素材の内容をある程度判断して、フォルダ分けを自動的に行うものとします。
> 「動作で机を引く」や「考えている」など、様々な検索用途でタグ付けして検索可能としたい。
> クイックに検索したいですし、どの案件で過去使ったのかといったものも一発でわかるようにしたい。

つまり以下4つが核要件:

1. **AI による自動タグ付け・自動分類**（フォルダ分けは人間がやらない）
2. **動作・感情・状況などの自由文タグで全文検索**できる
3. **案件横断**で「あの素材を別案件でも使い回す」ができる
4. **過去どの案件で使ったか**が1クリックで分かる

### 制約

| 制約 | 内容 |
|---|---|
| 課金禁止 | Anthropic API は使わない（PR #571 で削除済）。Gemini 1.5 Flash の **無料枠**（15 RPM / 100 万トークン/日）でやる。課金有効化しない |
| 専用フラグガード | `if (!apiKey)` ではなく `ENABLE_ASSET_AI=true` 専用フラグで起動制御。memory: `feedback_cost_approval_required.md` |
| 既存資産流用 | Drive サービスアカウント認証・ffmpeg（`lib/faststart.js`）は既存稼働中、流用する |
| 旧テーブル無し | 旧 `assets` テーブルは削除済。Supabase 上に新規設計 |

### philosophy 整合

- 原則 **2「ロール・カテゴリの追加でテーブルを増やさない」**: タグ・カテゴリはマスタ参照で吸収（`media_asset_tags`）
- 原則 **3「UI の置き場所と DB の責務を一致」**: 「素材ライブラリ」という独立画面 = `media_assets` を主たる帰属とし、案件・クリエイティブとは N:M で繋ぐ
- 原則 **5「マスタは workspace/client スコープを明示」**: タグは workspace スコープ（初期）

## Decision

### A) コンセプト：「タグ駆動の仮想フォルダ」

物理 Drive フォルダで分類するのではなく、**AI が付けたタグで仮想ビューを動的生成**する方針を取る。
これにより「動作」「感情」「シチュエーション」「被写体」など複数軸で同じ素材が同時に出てくる。

```
従来の発想（却下）              本 ADR の発想（採用）
┌─ 物理フォルダ ────────┐    ┌─ タグ駆動の仮想ビュー ─────────────┐
│ /素材/動作/机を引く/  │    │ #机を引く → 12素材                  │
│ /素材/動作/考えている/│    │ #考えている → 8素材                 │
│ /素材/被写体/男性/    │    │ #男性 ∩ #考えている → 3素材         │
│ /素材/案件/あるる/    │    │ #案件:あるる → 24素材               │
└──────────────────────┘    │ #未使用 → 56素材                    │
1素材が複数フォルダに         │ AND/OR/NOT で自由に絞り込み         │
コピーされる → 重複・矛盾    │ Drive 上は1ファイルのまま           │
                              └──────────────────────────────────┘
```

Drive 上の物理配置はシンプルに保ち、**検索・分類は haruka 側の DB で完結**させる（後述 D 項）。

### B) DB スキーマ

```sql
-- 素材本体（1 Drive ファイル = 1 行）
CREATE TABLE media_assets (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  drive_file_id         text NOT NULL UNIQUE,         -- Drive 上の正本
  uploaded_by           uuid REFERENCES users(id),
  file_name             text NOT NULL,
  mime_type             text,
  file_size             bigint,
  duration_seconds      numeric,                       -- 動画/音声のみ
  width                 int,
  height                int,
  fps                   numeric,
  thumbnail_drive_id    text,                          -- ffmpeg で抽出した静止画 (3秒地点)
  ai_title              text,
  ai_summary            text,                          -- 1〜2文の要約
  ai_scene_description  text,                          -- 詳細なシーン描写
  ai_suggested_use      text,                          -- 「導入のつかみに」など
  ai_quality_notes      text,                          -- 「ピント甘い」など
  ai_analyzed_at        timestamptz,
  ai_model_version      text,                          -- 'gemini-1.5-flash@2026-05'
  ai_status             text NOT NULL DEFAULT 'pending', -- pending|analyzing|done|failed|skipped
  ai_error              text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

-- 案件・クリエイティブとの M:N 紐付け（1素材を複数案件で再利用可）
CREATE TABLE media_asset_links (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id              uuid NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
  project_id            uuid REFERENCES projects(id) ON DELETE SET NULL,
  creative_id           uuid REFERENCES creatives(id) ON DELETE SET NULL,
  linked_by             uuid REFERENCES users(id),
  linked_at             timestamptz NOT NULL DEFAULT now(),
  note                  text,
  CHECK (project_id IS NOT NULL OR creative_id IS NOT NULL),
  UNIQUE (asset_id, project_id, creative_id)
);

-- タグマスタ（workspace スコープ。AI が自動 INSERT する）
CREATE TABLE media_asset_tags (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label                 text NOT NULL UNIQUE,          -- '机を引く' '考えている' '男性' '屋外'
  category              text NOT NULL,                 -- 'action' | 'emotion' | 'subject' | 'scene' | 'other'
  usage_count           int NOT NULL DEFAULT 0,        -- 集計キャッシュ（バッチ更新可）
  created_at            timestamptz NOT NULL DEFAULT now()
);

-- 素材 × タグ（AI が付ける + 人間が追加修正可能）
CREATE TABLE media_asset_tag_links (
  asset_id              uuid NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
  tag_id                uuid NOT NULL REFERENCES media_asset_tags(id) ON DELETE CASCADE,
  source                text NOT NULL DEFAULT 'ai',    -- 'ai' | 'human'
  confidence            numeric,                       -- AI 信頼度 0.0-1.0
  created_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (asset_id, tag_id)
);

-- インデックス
CREATE INDEX idx_media_assets_ai_status   ON media_assets(ai_status);
CREATE INDEX idx_media_assets_created_at  ON media_assets(created_at DESC);
CREATE INDEX idx_media_asset_links_proj   ON media_asset_links(project_id);
CREATE INDEX idx_media_asset_links_crv    ON media_asset_links(creative_id);
CREATE INDEX idx_tag_links_tag            ON media_asset_tag_links(tag_id);

-- 全文検索（pg_trgm を想定。Supabase は標準で利用可）
CREATE INDEX idx_media_assets_summary_trgm ON media_assets
  USING gin (ai_summary gin_trgm_ops, ai_scene_description gin_trgm_ops, file_name gin_trgm_ops);
```

migration ファイル: `migrations/2026-05-XX_create_media_assets.sql`（実装 PR で作成）。

#### 紐付けモデルを M:N にする理由

ユーザー要望「1素材を複数案件で使い回したい」「過去どの案件で使ったかが1クリックで分かる」を満たすには、`media_assets.project_id` 直接列では足りない（1対多になり、別案件で再利用するとレコード複製が必要）。`media_asset_links` で N:M とすれば:

- `SELECT * FROM media_asset_links WHERE asset_id = $1` → 「この素材が使われた全案件」
- `SELECT a.* FROM media_assets a LEFT JOIN media_asset_links l ON a.id = l.asset_id WHERE l.id IS NULL` → 「まだ未使用の素材」

### C) AI 解析パイプライン

```
┌─ ① アップロード ───┐  ┌─ ② Drive 保存 ──┐  ┌─ ③ サムネ抽出 ─┐
│ haruka 画面で      │→│ 素材ライブラリ／  │→│ ffmpeg で 3 秒  │
│ <input type=file>  │  │ YYYY-MM/ 配下に   │  │ 地点を JPEG 化  │
└────────────────────┘  └───────────────────┘  └─────────────────┘
                                                        ↓
┌─ ⑥ DB 反映 ────────┐  ┌─ ⑤ 結果パース ──┐  ┌─ ④ Gemini 解析 ─┐
│ ai_* 列 + タグ link│←│ JSON.parse →     │←│ サムネ + ファイル│
│ ai_status='done'   │  │ tags upsert       │  │ 名 + duration を│
└────────────────────┘  └───────────────────┘  │ Gemini に投げる │
                                                └─────────────────┘
```

| 工程 | 実装メモ |
|---|---|
| ① | アップロードは複数同時可。Drive resumable upload。サイズ上限 v1=2GB |
| ② | 物理 Drive パス: `GOOGLE_DRIVE_ROOT/素材ライブラリ/YYYY-MM/<asset_id>.<ext>` |
| ③ | `lib/faststart.js` の ffmpeg 呼び出しを流用。サムネは同じ Drive フォルダに `<asset_id>_thumb.jpg` で保存 |
| ④ | npm: `@google/generative-ai`。モデル: `gemini-1.5-flash`（無料枠 15 RPM, 100万トークン/日）。サムネ画像 1 枚（〜300KB）+ メタ情報 + プロンプトテンプレ |
| ⑤ | Gemini に「JSON 形式で返答」を強制。後述 D 項のプロンプトテンプレ |
| ⑥ | タグは `label` で upsert（同じタグ名なら既存行を使い回す）→ `media_asset_tag_links` を INSERT |

### D) Gemini プロンプトテンプレ（v1）

```
あなたは映像素材データベースの司書です。以下のサムネと情報から、検索用メタデータを JSON で返してください。

ファイル名: {{file_name}}
長さ: {{duration_seconds}} 秒
解像度: {{width}}x{{height}}

返答は以下のスキーマに従い、必ず JSON のみで返してください（前後に説明文を付けない）:
{
  "title":             "30文字以内の簡潔なタイトル",
  "summary":           "1〜2文の要約",
  "scene_description": "シーン詳細（何が・誰が・どこで・どんな動作か）",
  "suggested_use":     "編集者への提案。1〜2文",
  "quality_notes":     "画質・音質・撮影上の留意点。なければ空文字",
  "tags": [
    {"label": "机を引く",     "category": "action"},
    {"label": "考えている",   "category": "emotion"},
    {"label": "男性",         "category": "subject"},
    {"label": "屋内",         "category": "scene"}
  ]
}

tags は 4〜10 個。category は action | emotion | subject | scene | other のいずれか。
動作・感情・被写体・シチュエーションを満遍なく含めること。
```

### E) コスト制御（最重要 — ユーザー懸念に応える）

> 「お金のかからない方法をいろいろ提示してほしい」

#### E-1) 起動ガード（二重）

```js
// 環境変数2つが揃って初めて起動。キー存在だけでは絶対に起動しない
const AI_ENABLED = process.env.ENABLE_ASSET_AI === 'true'
                && !!process.env.GEMINI_API_KEY;

if (!AI_ENABLED) {
  // ai_status='skipped' で DB だけ作る。素材ライブラリは検索なしで使える
  return await saveAssetWithoutAI(file);
}
```

`ENABLE_ASSET_AI=true` を **明示的に環境変数に入れない限り**、たとえ `GEMINI_API_KEY` がうっかり残っていても解析は走らない（memory: `feedback_cost_approval_required.md` の方針に準拠）。

#### E-2) 無料枠の壁を実装で再現

Gemini 1.5 Flash 無料枠 = **15 RPM / 1500 RPD / 100 万トークン/日**。
これを超えたら自動で `ai_status='skipped'` に倒し、**429 を受け取る前に止める**。

```js
// utils/ai-rate-limiter.js（実装 PR で作成）
const limiter = {
  perMinute: 15,
  perDay:    1500,
  windowMin: [],   // この1分間に呼んだ時刻
  todayCount: 0,
  resetAt:    midnightUtc(),
};
```

キューは Redis 等を入れず、**メモリ内 + DB の `ai_status` で十分**（Railway 単 process 想定）。並列も無し（1件ずつ直列で安全側）。

#### E-3) サムネ 1 枚送信に固定（v1）

動画本体は **Gemini に送らない**。送るのは ffmpeg で抽出した 3 秒地点の **静止画 1 枚**（〜300KB に WebP 圧縮）。これにより 1 リクエストあたりのトークン消費を **約 1,500 トークン以内** に固定できる。
→ 100万トークン/日 ÷ 1,500 = **約 660 素材/日まで無料**。日次 600 本未満なら永久無料。

#### E-4) 段階的精度向上の余地（v1 では実装しない）

v2 以降の選択肢として ADR に明記:
- 3 秒地点 + 中盤 + 終盤の **3 枚 multi-frame** にすると精度↑だがトークン 3 倍
- Gemini 2.0 Flash（無料枠が条件次第で違う）への乗り換え検討は v2
- 完全に費用ゼロを諦めて月額数百円〜数千円の Pay-as-you-go へ移行 → ユーザー再承認必須

### F) Drive フォルダ構成

タグ駆動の仮想フォルダが核なので、**Drive 上の物理階層はミニマム**にする:

```
GOOGLE_DRIVE_ROOT_FOLDER_ID/
├── 素材ライブラリ/              ← 新設（実装 PR で gdrive_*_or_create）
│   ├── 2026-05/
│   │   ├── <asset_id>.mp4       ← オリジナル
│   │   ├── <asset_id>_thumb.jpg ← ffmpeg 抽出サムネ
│   │   └── <asset_id>_proxy.mp4 ← (v2 で追加予定。低画質プレビュー)
│   └── 2026-06/
└── 案件/<案件名>/
    └── 素材/                    ← 案件紐付け時のショートカット先（後述 G）
```

**案件への紐付け = Drive ショートカット作成**（`drive.files.create({ mimeType: 'application/vnd.google-apps.shortcut', shortcutDetails: { targetId } })`）。
コピーではないので **容量は増えない**。素材本体は素材ライブラリに1個だけ存在し続ける。

### G) 権限（ADR 015 準拠）

| 操作 | 必要ロール |
|---|---|
| 閲覧（一覧・検索・詳細） | 全ロール（editor / designer 含む） |
| アップロード | editor 以上（editor / designer / director / producer / admin） |
| タグ追加・編集 | editor 以上 |
| 案件・クリエイティブ紐付け | director 以上（責任範囲が広いため） |
| 削除（Drive ファイルごと） | admin のみ |
| AI 再解析トリガ | admin のみ（Gemini クォータ保護） |

ADR 015 のチェックリスト（`currentUser.role` 直書き禁止 / `requirePermission` 経由 / 最低 3 ロールで動作確認）を実装 PR で必ず通す。

### H) UI（haruka.html `#page-asset-library` 新タブ）

CLAUDE.md ルールに従い、ASCII 絵コンテで完成形を提示する。3 パターン: 一覧 / 詳細 / アップロード中。

#### H-1) 一覧画面（ヒーロー）

```
┌─ 🎬 素材ライブラリ ──────────────────────────────────────────────┐
│  [+ アップロード]  [🔍 ____________________]  [⚙ AI再解析] [削除]  │
├─────────────┬────────────────────────────────────────┬──────────┤
│ フィルタ     │  サムネグリッド (3〜5列、レスポンシブ)   │  詳細    │
│             │                                         │  パネル  │
│ ▼ 動作       │  ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐    │          │
│  ☑ 机を引く  │  │🖼️   │ │🖼️   │ │🖼️   │ │🖼️   │    │ (未選択) │
│  ☐ 考えている│  │ 12s │ │ 8s  │ │ 30s │ │ 45s │    │  ↓       │
│  ☐ 歩く      │  │#机引く│ │#男性 │ │#屋外 │ │#屋内 │    │ クリック │
│             │  │ ⚪AI │ │ ⚪AI │ │ ⚪AI │ │ 🔵未 │    │ で詳細表示│
│ ▼ 感情       │  └─────┘ └─────┘ └─────┘ └─────┘    │          │
│  ☐ 考えている│  ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐    │          │
│  ☐ 笑顔      │  │🖼️   │ │🖼️   │ │🖼️   │ │🖼️   │    │          │
│  ☐ 真剣      │  │     │ │     │ │     │ │     │    │          │
│             │  └─────┘ └─────┘ └─────┘ └─────┘    │          │
│ ▼ 被写体     │                                         │          │
│ ▼ シーン     │  [もっと読み込む]                       │          │
│             │                                         │          │
│ ▼ 解析       │  全 1,247 件 / 検索中: #机を引く        │          │
│  ⚪ 解析済   │                                         │          │
│  ⚪ 未解析   │                                         │          │
│  ⚪ 失敗     │                                         │          │
│             │                                         │          │
│ ▼ 案件       │                                         │          │
│  ☐ あるる    │                                         │          │
│  ☐ ヒルナンデ│                                         │          │
│  ☐ 未使用    │                                         │          │
│             │                                         │          │
│ ▼ 期間       │                                         │          │
│  ⚪ 全期間   │                                         │          │
│  ⚪ 今月     │                                         │          │
│  ⚪ 過去7日  │                                         │          │
└─────────────┴────────────────────────────────────────┴──────────┘
凡例: ⚪AI = 解析済 / 🔵未 = 未解析 / 🔴失敗 = 解析失敗
```

#### H-2) 詳細パネル（サムネクリック後）

```
┌─ 詳細パネル (右側) ─────────────────────────────────┐
│                                                       │
│  ┌────────────────────────────┐                       │
│  │                            │                       │
│  │    🖼️ サムネ静止画 (大)     │  ← クリックで再生開始 │
│  │      ▶                     │     (この時点で初めて │
│  │                            │      Drive 配信 URL を│
│  └────────────────────────────┘      <video> に差し替)│
│                                                       │
│  📌 AI解析結果                                        │
│  タイトル: 男性が机に向かって考える                   │
│  要約: スーツの男性がデスクで顎に手を当て考え込む     │
│  シーン: オフィス・自然光・引きカット                 │
│  おすすめ: インタビュー導入、悩みの提示シーン         │
│  品質メモ: 音声ややノイズあり                         │
│                                                       │
│  🏷️ タグ                                              │
│  [動作:机を引く] [感情:考えている] [被写体:男性]      │
│  [シーン:屋内] [+ タグを追加]                         │
│                                                       │
│  📁 紐付け                                            │
│  • 案件「あるる 2026春」(2026-04-12 紐付け) [解除]   │
│  • クリエイティブ「あるる_v3」(2026-04-15) [解除]    │
│  [+ 案件に紐付け]  [+ クリエイティブに紐付け]         │
│                                                       │
│  📊 メタ                                              │
│  ファイル: KSE_0231.mp4 (240 MB, 12.5s, 1920x1080)    │
│  アップ: 山田太郎 / 2026-05-08 14:32                  │
│  解析: gemini-1.5-flash / 2026-05-08 14:33            │
│                                                       │
│  [Drive で開く 🔗]  [🗑 削除 (admin)]                 │
└───────────────────────────────────────────────────────┘
```

#### H-3) アップロード進行中

```
┌─ 📤 アップロード中 ──────────────────────────────────┐
│                                                       │
│  KSE_0231.mp4   ████████████░░░░  68%  Drive保存中   │
│  KSE_0232.mp4   ████████████████  100% AI解析中... ⏳ │
│  KSE_0233.mp4   ████████████████  100% ✅ 完了        │
│  KSE_0234.mp4   ████████████████  100% ⚠ 解析スキップ │
│                  ↑                       (無料枠到達)  │
│  3/4 完了                                             │
│                                                       │
│  💡 ENABLE_ASSET_AI=true でないと「解析スキップ」表示 │
│  💡 解析失敗しても素材は登録される（後で再解析可）    │
└───────────────────────────────────────────────────────┘
```

#### H-4) 案件画面・クリエイティブ画面からの「素材を引用」

案件モーダル・クリエイティブ詳細モーダルに **「📎 素材ライブラリから引用」** ボタンを追加（実装 PR で）。クリックで素材ライブラリのモーダルが開き、選択した素材を `media_asset_links` に INSERT する。これによりユーザー要望「過去どの案件で使ったかが1クリックで分かる」（逆方向: 素材詳細 → 紐付け案件一覧）と対になる双方向リンクが成立。

### I) API 設計

| メソッド | パス | 用途 |
|---|---|---|
| POST   | `/api/assets/upload`                  | アップロード + Drive 保存 + キュー投入 |
| GET    | `/api/assets`                         | 一覧取得（タグ・案件・期間・全文検索フィルタ） |
| GET    | `/api/assets/:id`                     | 1件取得（タグ・紐付け含む） |
| PATCH  | `/api/assets/:id`                     | タイトル・タグ手動編集 |
| DELETE | `/api/assets/:id`                     | admin のみ。Drive ファイルも削除 |
| POST   | `/api/assets/:id/links`               | 案件・クリエイティブ紐付け追加 |
| DELETE | `/api/assets/:id/links/:link_id`      | 紐付け解除 |
| POST   | `/api/assets/:id/reanalyze`           | admin のみ。AI 再解析（キュー投入） |
| GET    | `/api/asset-tags`                     | タグ一覧（オートコンプリート用） |
| GET    | `/api/projects/:id/assets`            | 案件 → 紐付け済み素材一覧（既存案件画面から呼ぶ） |
| GET    | `/api/creatives/:id/assets`           | クリエイティブ → 紐付け済み素材一覧 |

### J) 担当 worktree 提案

新領域なので feature/projects や feature/creatives の責任を膨らませず、独立 worktree を切る:

```bash
git worktree add ../haruka-assets -b feature/assets
```

| フォルダ | branch | 担当 |
|---|---|---|
| `haruka-assets/` | `feature/assets` | 素材ライブラリ全般（DB / API / UI / AI 解析） |

CLAUDE.md の「並行開発の構成」表に `haruka-assets/` 行を追加する PR を **別途** 出す（本 ADR とは独立。実装 PR の前段として）。担当エージェントは `assets-worker`（新設・サブエージェント定義は別 PR）。

## Consequences

### Positive

- ユーザー要望（動作タグ検索・案件横断・自動分類・案件履歴1クリック）を全て満たす設計
- Gemini Flash 無料枠で **600 素材/日まで永続無料**。ENABLE_ASSET_AI フラグで誤発火防止
- タグ駆動の仮想フォルダにより、Drive 上の物理階層がシンプルに保たれ、Drive クォータ消費が最小
- M:N 紐付けにより、1素材の再利用と「過去使用案件」逆引きが SQL 1本で取れる
- 既存資産（ffmpeg / Drive サービスアカウント / haruka.html タブ構造）を流用、追加依存は `@google/generative-ai` のみ

### Negative

- 無料枠を超えた瞬間に解析が止まる（素材登録は続く）。ユーザーに残量可視化 UI が必要（v2 検討）
- AI が付けたタグが間違うことがある → 人間が修正できる UI（H-2）は v1 で必須
- Drive クォータ（API 呼び出し/日）の上限は別途存在。**1日数千アップロードを超えるとここがボトルネック**になる可能性
- pg_trgm のフルテキスト検索は日本語の単語境界が弱い → 「考えている」「考える」の揺らぎはタグ正規化で吸収（v2）
- 動画本体を Gemini に投げない → 「動作の遷移」（机を引く"前"と"後"）の区別が苦手。これは E-4 の multi-frame 拡張で改善可能

### マイグレーション影響

- 旧 video-ops 削除（PR #571）と独立。既存テーブルへの変更なし
- 新規 4 テーブル: `media_assets` / `media_asset_links` / `media_asset_tags` / `media_asset_tag_links`
- 既存案件・クリエイティブには影響なし。素材ライブラリは追加機能として完全独立で稼働
- Drive 上に「素材ライブラリ」フォルダが新設されるが、既存「案件」フォルダには手を入れない（紐付けはショートカットのみ）

### Rollout（実装 PR の Stage 分割）

| Stage | 内容 | DB 適用 |
|---|---|---|
| **Stage 0** | CLAUDE.md に `haruka-assets/` worktree 行追記（本 ADR とは別 PR） | 不要 |
| **Stage 1** | `media_assets` + `media_asset_links` + 一覧 UI（AI 無し、手動タグのみ）| 要 |
| **Stage 2** | `media_asset_tags` + `media_asset_tag_links` + フィルタサイドバー | 要 |
| **Stage 3** | Gemini 解析パイプライン + ENABLE_ASSET_AI フラグ + 自動タグ付け | 不要 |
| **Stage 4** | 案件画面・クリエイティブ画面からの「素材を引用」連携 | 不要 |
| **Stage 5** | 残量可視化 UI / AI 再解析 / multi-frame 等の精度向上 | 不要 |

各 Stage は `needs-db-migration` / `db-migration-applied` ラベル運用に従う（memory: `feedback_db_migration_staging.md`）。

## Alternatives

### A案: Cloud Vision API

Google Cloud Vision の label detection でタグ付け。
**却下理由**: 既定の英語ラベル中心で、「机を引く」のような自由文タグが出ない。日本語要約 / scene_description / suggested_use は別途生成が必要で、結局 LLM が要る。

### B案: ffmpeg メタのみ（AI なし）

サムネ + ファイル名 + 解像度 + 長さで人間が手動タグ付け。
**却下理由**: ユーザーが明確に「内容判断による自動フォルダ分け」を要望している。手動タグはバックアップ手段として残すが（H-2 の「+タグを追加」）、メインの分類エンジンは AI とする。

### C案: ローカル LLM（Ollama + LLaVA）

Railway 本番から Ollama を呼び出す。
**却下理由**: Railway の Compute 上で LLaVA を回すと CPU/メモリ消費が現実的でない。GPU インスタンスは費用が Gemini 課金より高い。

### D案: Anthropic Claude Vision（PR #571 で削除済の方式）

旧 video-ops と同じ。
**却下理由**: ユーザー指示で明確に却下済。Anthropic API は本機能で再導入しない。

### E案: 動画本体を Gemini に渡す

Gemini Flash は動画入力（〜1時間）に対応している。
**却下理由**: トークン消費が静止画 1 枚比で 数十〜数百倍。100万トークン/日では数本〜数十本/日が上限になり、無料運用が破綻する。v2 で multi-frame（複数静止画）で代替する余地は残す（E-4）。

### F案: 案件直下に物理コピー（紐付け時）

Drive ショートカットでなく、案件フォルダに実体を copy。
**却下理由**: 容量 2 倍、変更追従が不可能、削除順序問題（素材ライブラリ側を消したら案件側のコピーが孤児化）。ショートカットなら参照透過。

### G案: 紐付けを 1:N（`media_assets.project_id` 直接列）

実装は最も簡単。
**却下理由**: 「1素材を複数案件で再利用」というユーザー要望と矛盾。再利用時に素材レコードを複製することになり、AI 解析も二重に走る。N:M で確定。

## Open Questions

1. **タグの workspace スコープ**: 現状 `media_asset_tags.label` を UNIQUE にしているが、将来マルチワークスペース化したときは `(workspace_id, label)` の複合 UNIQUE に拡張する必要がある。philosophy 原則 5 に従い、v1 から `workspace_id` 列を NULL 許容で持たせるか要判断
2. **タグ正規化**: 「考えている」「考える」「考え中」を同一タグに寄せる仕組みが必要か。v1 は素直に別タグで保存し、v2 で類義語辞書 or AI による canonical 化を検討
3. **解析失敗の再試行**: 429 でスキップした素材を翌日自動再開するバッチを v1 で入れるか、v3 まで保留か
4. **音声素材の扱い**: 当面動画前提だが、効果音・BGM の取り扱いをどこまで含めるか（Gemini Flash は音声理解可だがトークン消費別）
5. **無料枠超過時の UX**: 残量バーをタブ上部に常時表示するか、超過直前にトースト警告するか
6. **削除ポリシー**: admin が削除した素材を紐付け案件側からどう見せるか（"削除済" placeholder か、紐付け自体を消すか）
7. **Drive クォータ**: 1 日 1,000 件以上のアップロードがある場合、Drive API クォータ拡張申請が要るか

## References

- [ADR 001: 商品・訴求軸は creative-first 設計で残す](001-creative-first-product-appeal.md) — creative 起点設計の参照
- [ADR 007: ファイル名テンプレート](007-filename-templates.md) — Drive 保存時の命名規約と整合
- [ADR 012: クリエイティブ詳細モーダルのフィールド可視性](012-creative-category-field-visibility.md) — 詳細モーダルへの「素材引用」ボタン追加の参照先
- [ADR 015: VIEW AS 開発チェックリスト](015-view-as-development-checklist.md) — 権限実装の必須チェック
- [PR #571: 旧 video-ops プロトタイプ全削除](https://github.com/hiikun-bot/haruka_film_system/pull/571) — Anthropic 課金事故防止の経緯
- memory: `feedback_cost_approval_required.md` — 専用フラグガードの方針
- memory: `feedback_video_playback_architecture.md` — サムネ＋クリック再生方式
