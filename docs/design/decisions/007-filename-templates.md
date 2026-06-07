---
adr: 007
status: Accepted
date: 2026-05-07
tags: [filename, templates, projects, settings]
related_tables: [filename_templates, filename_template_tokens, projects, creatives]
supersedes: null
superseded_by: null
---

# 007. ファイル名テンプレート（案件別命名規約）

- **Status**: Accepted
- **Date**: 2026-05-07
- **Decided by**: ユーザー（hiikun.ascs@gmail.com）

## Context

現状、提出用ファイル名は `routes/haruka.js` の `creatives/bulk-preview` / `creatives/bulk` 内で
`YYMMDD_商材_媒体_FMT_訴求軸_サイズ_連番` というフォーマットがハードコードされている
（[routes/haruka.js:2519-2554](../../../routes/haruka.js)）。

しかし実運用では案件ごとに命名規約が異なる:
- 例) あるる案件: `007_あるる_1:1_ドラム_上地無_v` （連番_案件名_サイズ_商品_芸能人有無_バージョン）
- 「芸能人」は案件によって表示文字列が変わる（"上地" / "孫正義" など）
- 連番・案件名・バージョンは必須要素として固定したい

ADR 001 でも `filename_templates` テーブルと命名トークン解決関数が「要実装」として宣言されていた。

## Decision

**ファイル名生成をテンプレート駆動に置き換える。テンプレートは設定タブの専用画面で
ドラッグ&ドロップで作成し、案件側で選択 + 案件固有のトークン値で上書きする。**

### スキーマ

```
filename_templates                テンプレート本体（設定タブで管理）
  id                uuid PK
  name              text          表示名（"標準（YYMMDD系）" / "あるる系" 等）
  separator         text          区切り文字（既定: "_"）
  tokens            jsonb         順序付きトークン配列（後述）
  is_default        bool          新規案件のデフォルト
  created_at        timestamptz
  updated_at        timestamptz

projects.filename_template_id     uuid FK → filename_templates.id (NULL 可)
projects.filename_token_overrides jsonb
  例: { "celebrity": { "label": "芸能人", "value": "上地無" },
        "size":      { "value": "1:1" } }
```

### tokens (JSONB) のスキーマ

各要素は `{ kind, key?, label?, default?, on_value?, off_value?, source? }` の形:

```json
[
  { "kind": "system", "key": "serial",        "label": "連番" },
  { "kind": "system", "key": "project_name",  "label": "案件名" },
  { "kind": "system", "key": "size",          "label": "サイズ" },
  { "kind": "system", "key": "product",       "label": "商品" },
  { "kind": "custom", "key": "c_1",           "label": "ハッシュタグ", "default": "" },
  { "kind": "flag",   "key": "f_1",           "label": "芸能人有無",
    "source": "talent_flag", "on_value": "上地有", "off_value": "上地無" },
  { "kind": "system", "key": "version",       "label": "バージョン" }
]
```

### トークン種別（kind）

| kind     | 意味                                        | 値の解決                                                |
|----------|---------------------------------------------|---------------------------------------------------------|
| `system` | システム既定の組み込みトークン              | 後述の値マップ                                          |
| `custom` | 案件ごとに値を上書きするテキストトークン    | `overrides[key].value ?? token.default ?? ""`           |
| `flag`   | creative の boolean 列を 2値で表現          | source 列が true なら `on_value`、false なら `off_value`|

`flag` の `source` は **creatives テーブルの boolean 列名** を指す（v1 では `talent_flag` のみサポート）。
将来的に他のフラグ列を追加する場合はサーバー側のホワイトリストを更新する。

### システム標準トークン（`kind: "system"`）

| key            | 意味              | 由来                                  |
|----------------|-------------------|---------------------------------------|
| `serial`       | 連番（必須・先頭）| `creatives.internal_code` の数字部    |
| `project_name` | 案件名（必須）    | `projects.name`                       |
| `version`      | バージョン（任意）| `creatives.version_number` 等         |
| `date_yymmdd`  | 制作日 (YYMMDD)   | `creatives.production_date`           |
| `client_code`  | クライアントコード| `clients.client_code`                 |
| `product`      | 商品名/コード     | `products.name` または `products.code`|
| `appeal_axis`  | 訴求軸            | `client_appeal_axes.code` or `name`   |
| `size`         | サイズ            | `creatives.creative_size`             |
| `format`       | フォーマット      | `creatives.creative_fmt`              |
| `media`        | 媒体              | `creatives.media_code`                |

### カスタムトークン（`kind: "custom"`）

- テンプレート定義時に任意の `key`（自動採番 `c_1`/`c_2` …）と `label`、`default` を設定
- 案件側で `projects.filename_token_overrides[key].value` で値を上書き
- `label` も上書き可

### フラグトークン（`kind: "flag"`）

- creative ごとに boolean を切り替え、ファイル名の該当部分が ON値/OFF値で自動切替されるトークン
- v1 でサポートする `source`: **`talent_flag`** のみ（`creatives.talent_flag` の boolean 列。creative モーダル「🎬 芸能人」チェックボックスと同一）
- テンプレ定義時: `on_value` / `off_value` を入力（例: ON値 = `上地有` / OFF値 = `上地無`）
- 案件側 override: `projects.filename_token_overrides[key]` で `on_value` / `off_value` / `label` を上書き可
  - 例) あるる案件: `{ "f_1": { "on_value": "上地有", "off_value": "上地無" } }`
  - 例) 別案件: `{ "f_1": { "on_value": "孫正義有", "off_value": "孫正義無" } }`
- 値解決: `creatives.talent_flag === true` なら `on_value`、それ以外なら `off_value`
- 1テンプレ内の **同一 source の flag トークンは1個まで**（v1 制約。複数 boolean 列を扱う必要が出たら拡張）

### 必須トークン制約

`serial` / `project_name` のいずれかが欠けたテンプレートは保存不可。
さらに `serial` は配列の先頭でなければならない（DB 側の CHECK 制約 + サーバー側でバリデーション）。

> **追補（2026-06-08・バグ報告 #271af257）**: 当初は `version` も必須としていたが、
> クライアント提出時にファイル名から Ver を削除する運用があるため `version` を**任意**に変更した。
> Ver なしのテンプレ（例: `連番_案件名` / `連番_案件名_サイズ`）を保存・展開できる。
> migration: `migrations/2026-06-08_filename_template_version_optional.sql`
> （`validate_filename_template_tokens()` を version 不要版に再定義）。

### UI

#### 設定タブ「📁 ファイル名テンプレート」（新セクション）

```
[テンプレート一覧]                  [編集パネル]
- 標準（YYMMDD系）★default       名前: [____________]
- あるる系                         セパレータ: [_ / - / なし]
+ 新規作成                         
                                   ┌─────────────────────┐
                                   │ パレット（ドラッグ元）│
                                   │ [連番*] [案件名*]    │
                                   │ [バージョン*] [サイズ]│
                                   │ [商品] [訴求軸] [日付]│
                                   │ [媒体] [+カスタム]   │
                                   └─────────────────────┘
                                   ┌─────────────────────┐
                                   │ ビルダー（D&D 並べ替え）│
                                   │ [連番][案件名][サイズ]│
                                   │ [商品][芸能人][バージョン]│
                                   └─────────────────────┘
                                   プレビュー:
                                   007_あるる_1:1_ドラム_上地無_v1
```

#### 案件モーダル

- 「ファイル名テンプレート」プルダウン（filename_templates から選択）
- 選択中テンプレに含まれる `kind: "custom"` トークンの **値・ラベル上書き入力欄** を動的表示
- 直下にライブプレビュー

### 後方互換

- 既存案件には migration で **デフォルトテンプレ "標準（YYMMDD系）" を seed し、`projects.filename_template_id` を埋める**
- 標準テンプレの tokens は `[date_yymmdd, product, media, format, appeal_axis, size, serial]`
- 既存ファイル名はリネームしない（過去データは触らない）

### ファイル名生成関数

`utils/filename.js` を新設し、以下を export:

```js
function renderFilename(template, tokens, overrides = {}) {
  // template.tokens を順に評価
  //   - kind: "system"  → tokens[key] を取り出す
  //   - kind: "custom"  → overrides[key]?.value ?? token.default
  // 空欄は詰める（既存挙動と同じ）
  // template.separator で join
}
```

`routes/haruka.js` の bulk-preview / bulk / 個別作成は全て `renderFilename` を呼ぶよう統一する。

## Consequences

- ✅ 案件ごとに自由なファイル名フォーマットが組める
- ✅ "芸能人有無" のような案件固有概念が、テンプレ拡張なしで案件モーダル側の override だけで表現できる
- ✅ ADR 001 の「filename_templates / トークン解決関数」要件が満たされる
- ⚠️ 既存ハードコード箇所を全て関数経由に書き換える必要がある（routes/haruka.js 3箇所 + フロントの `generateFileName()`）
- ⚠️ 並列マージの事故を避けるため、**Stage 1 (migration + 設定タブ UI) → 適用 → Stage 2 (案件モーダル + 関数置き換え)** で 2PR に分割

## Alternatives considered

- **(却下) 案件モーダル内に直接トークン配列を持たせる（テンプレマスタなし）** — クライアント横断の使い回しができず、命名のばらつきが残る
- **(却下) 案件ごとにフリーテキストで命名する** — トークンが何由来か不明になり、再生成・リネーム機能が作れない
- **(却下) creative ごとに celebrity 値を入力させる** — 入力負荷が大きく、案件全体で固定の概念を毎回打たされる
