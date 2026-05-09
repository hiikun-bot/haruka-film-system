---
adr: 008
status: Proposed
date: 2026-05-09
tags: [sheets, sync, creatives, mapping, export]
related_tables: [creatives, creative_versions, projects, clients]
supersedes: null
superseded_by: null
---

# 008. システムを master とするクリエイティブ管理シート同期

- **Status**: Proposed
- **Date**: 2026-05-09
- **Decided by**: ユーザー（hiikun.ascs@gmail.com）

## Context

現状、案件管理用の Google Sheets（クリエイティブ管理シート）とシステムの `creatives` テーブルが**並走**しており、
連番ズレ・記載差分・「どっちが正？」問題が発生している。

元のコンセプトは **「システムが master、Google Sheets はエクスポート先」** だったが、
- シート側で先に編集 → システムに反映されない
- システム側で生成 → シートに連番が手入力で入る → ズレる
- 案件によって列構成・修正サイクル数（Rev1〜Rev5 等）・タブ構成（動画 / 静止画別）が異なる

という運用実態に対応できておらず、コンセプトが空洞化していた。

今回、以下を満たす同期設計を整理する：
- **双方向同期**（列単位で sync 方向を `to_sheet` / `from_sheet` / `two_way` から選べる）
- **動画 / 静止画タブ分離**（タブ名 → `creative_type` マップ）
- **修正サイクル可変**（最大 5 回まで動的に列を伸ばす。今後 6 回以上に拡張余地）
- **クライアント別マッピング**（マスタ JSON にクライアント単位の部分上書きを乗せる）

## Decision

**システムが master、Google Sheets は同期先（双方向対応）。
マッピング定義 JSON で「列の対応 / 同期方向 / タブ振り分け / 修正サイクル列展開」を制御する。**

### マッピング定義の構造（JSON）

```json
{
  "fixed_columns": [
    { "header": "連番",       "system_field": "internal_code",    "sync": "to_sheet" },
    { "header": "案件名",     "system_field": "project_name",     "sync": "to_sheet" },
    { "header": "商品",       "system_field": "product_name",     "sync": "to_sheet" },
    { "header": "訴求軸",     "system_field": "appeal_axis_name", "sync": "to_sheet" },
    { "header": "ファイル名", "system_field": "filename",         "sync": "two_way" },
    { "header": "備考",       "system_field": "memo",             "sync": "from_sheet" }
  ],
  "version_block": {
    "max_versions": 5,
    "columns_per_version": [
      { "header_tpl": "Rev{n} URL",    "system_field": "version_url",     "sync": "two_way" },
      { "header_tpl": "Rev{n} ステータス", "system_field": "version_status", "sync": "two_way" },
      { "header_tpl": "Rev{n} コメント",  "system_field": "version_memo",   "sync": "from_sheet" }
    ]
  },
  "tabs": {
    "動画管理":   "動画",
    "静止画管理": "静止画"
  }
}
```

#### 各キーの意味

| キー | 意味 |
|---|---|
| `fixed_columns[]` | 固定列の配列。各要素 `{ header, system_field, sync }` |
| `fixed_columns[].header` | シート側の列ヘッダ文字列 |
| `fixed_columns[].system_field` | システム側のフィールド名（`creatives` / `projects` / `clients` / `products` 経由で解決） |
| `fixed_columns[].sync` | 同期方向: `to_sheet` / `from_sheet` / `two_way` |
| `version_block.max_versions` | 最大修正サイクル数（デフォルト 5）。実際に展開される列数は **その案件の `creative_versions` 最大バージョン番号** に従う |
| `version_block.columns_per_version[]` | バージョンごとの列雛形。`{n}` プレースホルダで何回目かを挿入 |
| `tabs` | シートタブ名 → `creative_type` マップ。タブ単位で creative を振り分ける |

### 設置場所

| レイヤ | 設置場所 | 編集権限 |
|---|---|---|
| マスター（共通） | 設定タブで JSON 編集 | admin のみ |
| クライアント別上書き | `clients` モーダル内で部分上書き JSON を編集 | admin / secretary |

クライアント別上書きはマスターに **deep merge** され、未指定キーはマスターの値が使われる。

### 双方向同期の競合ルール（v1）

- システム側 `updated_at` とシート側最終編集時刻を比較
- 値が両方変わっていたら **競合検出 → ユーザーに選択ダイアログ** を出す
  - シート優先 / システム優先 / 両方残す（システム値を残し、シート値を別列にメモ）
- v2 以降で「直近編集者ベース」「列ごとのデフォルト優先側」等の自動解決を検討

### 修正サイクルの動的展開

- 出力時、その案件の `creative_versions` 最大バージョン番号 `N` を見て、`N` 個分だけ列を展開する
- `N <= max_versions` の制約。超過時はエラー
- 各 `creative` 行は、その creative 自身のバージョン数までを埋め、残りは空欄

例: max_versions=5、案件全体の最大が Rev3 なら、シートには Rev1 / Rev2 / Rev3 の 9 列（3 列 × 3 バージョン）だけが出る。
ある creative が Rev2 までしか無ければ、Rev3 列はその行だけ空欄。

### タブ振り分け

- `tabs` マップに従い、`creative_type === "動画"` の creative は「動画管理」タブへ、`"静止画"` は「静止画管理」タブへ書き込む
- 案件単位で 1 スプレッドシート、その中に複数タブ

### Schema (新規)

本番DBの調査結果、`creative_versions` テーブルは**存在しなかった**（CLAUDE.md の機能地図には記載があったが実体なし / silent skip パターン）。
Phase 0 で以下のテーブルを新設する：

```sql
CREATE TABLE creative_versions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  creative_id   uuid NOT NULL REFERENCES creatives(id) ON DELETE CASCADE,
  version_number int NOT NULL,           -- 0=初稿, 1=修正1回目, 2=修正2回目, ...
  preview_url   text,                    -- 該当バージョンのプレビュー URL
  editor_comment text,                   -- そのバージョンの編集者コメント
  director_comment text,                 -- そのバージョンのディレクター修正点
  client_comment text,                   -- そのバージョンのクライアント/あるる修正指示
  editor_comment_updated_at timestamptz, -- 双方向同期の競合検出
  director_comment_updated_at timestamptz,
  client_comment_updated_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(creative_id, version_number)
);
CREATE INDEX idx_creative_versions_creative_id ON creative_versions(creative_id);
```

#### 既存 `creatives` 列との関係

- 既存 `creatives.editor_comment` / `director_comment` / `client_comment` は **v0（初稿）の値**として残し、`creative_versions` の `version_number=0` 行と二重持ちしない
- 移行: 既存 `creatives` 行から `version_number=0` の `creative_versions` 行を seed する migration を1本含める（Phase 0 内）
- バージョン1以降の追加は新規 INSERT
- 既存 `creatives.*_comment_updated_at` 列は `creative_versions` 側にも同名で持つ（双方向同期の競合検出に必要）

## Consequences

- ✅ シート ⇔ システムの不整合・連番ズレが構造的に解消される
- ✅ クライアントごとの列ばらつき・命名ばらつきをマッピング上書きで吸収できる
- ✅ 修正サイクル数の上限を運用で柔軟に変えられる（max_versions の数値変更だけ）
- ✅ 動画 / 静止画の分離が明示的になる
- ✅ `creative_versions` を新設することで、修正履歴の正規化（v0 / v1 / v2 ... を行として持つ）が同期設計と同時に実現できる
- ⚠️ 双方向同期の実装が重い（競合検出 UI、シート側の変更検知、トランザクション）→ Phase 分けで段階的にリリース
- ⚠️ `creative_versions` テーブルは**本番DBに存在しない**ことが判明（CLAUDE.md の機能地図には記載があったが幻 / silent skip パターン）。Phase 0 の migration 適用が他全 Phase の前提。**最初に通す**
- ⚠️ クライアント別 JSON は GUI ではなくテキスト編集前提（v1）。誤編集対策として JSON Schema バリデーションを入れる

## Phase 分割

| Phase | 内容 | 備考 |
|---|---|---|
| Phase 0 | `creative_versions` テーブル新設 + 既存 `creatives` から v0 行を seed する migration | **他全 Phase の前提**。本番DB調査の結果、`creative_versions` テーブルは存在しなかったため新設が必要 |
| Phase 1 | マスタマッピング 1 本 + 片方向同期（→シート）+ 修正サイクル可変 + 動画/静止画タブ | まず「シートを綺麗に出せる」ところまで |
| Phase 2 | 双方向同期（シート → システム）+ 競合 UI | from_sheet / two_way 列を実際に取り込む |
| Phase 3 | クライアント別マッピング上書き | `clients` モーダルに JSON エディタ追加 |
| Phase 4 | ファイル名編集 UI + 連番カスタマイズ（`next_filename_serial` / `serial_digits`） | ADR 007 と連動。連番起点と桁数を案件側で指定可能にする |

## Alternatives considered

- **（却下）案件モーダルで人が連番起点を毎回入力する案** — ユーザーから「システムが master が元コンセプト」と指摘され、人手でズレを埋める運用は本末転倒
- **（却下）全クライアント 1 テンプレ統一** — 既存運用との断絶が大きすぎる。クライアント別の列ばらつきを吸収する設計が必須
- **（却下）シート master + システムは閲覧専用** — 連番採番・ファイル名生成・バージョン管理など、システム側にしか持てないロジックが多い。master 反転は不可能
