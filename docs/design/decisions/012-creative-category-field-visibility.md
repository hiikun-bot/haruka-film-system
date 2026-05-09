---
adr: 012
status: Accepted
date: 2026-05-10
tags: [creatives, ui, category, master-data, fields, visibility]
related_tables: [creative_categories, creative_category_fields, creative_custom_field_values, creatives]
supersedes: null
superseded_by: null
related_adr: [010]
---

# 012. クリエイティブ詳細モーダルのフィールド可視性をカテゴリ別に管理する

- **Status**: Accepted
- **Date**: 2026-05-10
- **Decided by**: ユーザー（hiikun.ascs@gmail.com）

## Context

クリエイティブ詳細モーダル（`#modal-creative-detail`）は **全カテゴリ共通レイアウト** で描画されており、動画クリエイティブで必須の「台本URL」「タレント」「媒体・尺・サイズ」のような項目が、デザイン / LP / HP / LINE のクリエイティブを開いたときも常に表示されてしまう。

### 主な不都合

1. デザイン・LP・HP では台本URLは存在しないので、毎回空欄のまま放置されて視認ノイズになる
2. LP / HP では「公開URL」「サーバー情報」のような独自項目を **どこに書くか** が決まっておらず、メモ欄に流れてしまう
3. カテゴリを増やす（Stage A の `creative_categories` マスタ駆動）たびに、UI 全体に影響が出る

ADR 010（カテゴリ＝マスタ駆動）の延長として、**カテゴリごとに「どのフィールドを見せるか / 並び順 / ラベル / 必須」をマスタで持つ** 仕組みが必要。

## Decision

### A) カテゴリ × フィールドの可視性を `creative_category_fields` テーブルで管理する

```
creative_category_fields
  - category_id        → creative_categories.id
  - field_key          ('script_url', 'product', 'public_url', ...)
  - field_kind         'builtin' | 'custom'
  - custom_type        'text' | 'textarea' | 'url' | 'select'   (custom のみ)
  - custom_options     JSONB                                   (custom select 用)
  - visible            BOOLEAN
  - sort_order         INT
  - label              TEXT (NULL なら builtin のデフォルトラベル)
  - required           BOOLEAN
  UNIQUE(category_id, field_key)
```

- **builtin フィールド**: 既に詳細モーダル内に DOM が存在する固定項目。`field_key` で参照する。Stage 1 では下記 7 種類:
  - `product`              … 商材
  - `appeal_axis`          … 訴求軸
  - `media_format_size`    … 媒体・尺・サイズ
  - `talent`               … タレント
  - `script_url`           … 台本URL（既存 `cd-script-url`）
  - `regulation_url`       … レギュレーションシート（既存 `cd-regulation-cell`）
  - `client_review_url`    … クライアント確認URL（既存 `cd-client-review-group`）

  builtin の `field_key` は `utils/category-fields.js` の `BUILTIN_FIELDS` で一元管理する。

- **custom フィールド**: マスタ管理画面の「+ カスタム項目を追加」から追加。値は別テーブル `creative_custom_field_values` (creative_id, field_key, value) に分離保管する。

  - `creatives` テーブル本体は汚さない（列追加せず）
  - 1 クリエイティブ × 1 field_key につき 1 行（PK は `(creative_id, field_key)`）
  - 削除時は ON DELETE CASCADE で自動消去

### B) 詳細モーダルへの適用

`openCreativeDetail()` で:

1. クリエイティブの `category_id` から `creative_category_fields` を引く（`_categoryFieldsCache[category_id]` で 1 度だけ）
2. builtin の DOM ラッパに `data-field-key` を持たせ、`visible=false` のものは `display:none`、`label` 上書きがあれば `<label>` テキストを差し替える
3. カスタムフィールドは `#cd-custom-fields` セクションに `<input>` / `<textarea>` / `<select>` を動的生成し、既存値を `creative_custom_field_values` から populate する
4. 保存時にカスタム値も `/api/creatives/:id/custom-fields` PUT で送信

これにより **「デザイン / LP / HP / LINE では台本URLとタレントが消える」** という今回の元依頼が達成される。

### C) Stage 1 の seed 内容

| カテゴリ (code) | product | appeal_axis | media_format_size | talent | script_url | regulation_url | client_review_url |
|---|---|---|---|---|---|---|---|
| video  | ON  | ON  | ON  | ON  | ON  | ON | ON |
| image  | ON  | ON  | ON  | OFF | OFF | ON | ON |
| lp     | ON  | ON  | OFF | OFF | OFF | ON | ON |
| hp     | ON  | ON  | OFF | OFF | OFF | ON | ON |
| line   | ON  | ON  | OFF | OFF | OFF | ON | ON |

`label` 上書きの seed 例:
- image の `media_format_size` ラベルは「サイズ」
- video の同フィールドは「媒体・尺・サイズ」

## Consequences

### Pros

- 詳細モーダルの **カテゴリ別カスタマイズ** がノーコード（マスタ画面のみ）で完結する
- 「LP の公開URL」「HP の納品サーバー情報」など、案件ごとに散らばっていた独自項目を **規定の場所に書ける**
- builtin フィールドを残したまま段階的に増やせる（DOM を追加 → BUILTIN_FIELDS に登録 → 任意のカテゴリで visible=true にする）
- ADR 010（カテゴリ＝マスタ駆動）の流儀と整合する（レコード追加だけで挙動が変わる）

### Cons / 留意点

- カスタムフィールドの値は `creative_custom_field_values` に分離されるため、既存 SQL レポートで参照したいときは JOIN が要る
- builtin の DOM 追加には依然コードリリースが必要（フィールド種類そのものを増やすケース）
- `field_kind='custom'` のフィールドは、過去のクリエイティブにとっては「未入力」状態になる（意図的・破壊変更ではない）

### マイグレーション影響

- 既存の `creative_categories` 行（5件）に対して seed が走る。**コード・名前は既存のものを尊重し、上書きしない**（既に `code='image'`、`name='静止画'` 等が確定しているため）
- 新カテゴリを増やしたとき、`creative_category_fields` に行が無ければ「すべての builtin が visible=true」として扱う（フェイルセーフ）

## Alternatives

### 案 B: 案件単位のフィールドオーバーライド

案件ごとに `project_field_overrides` を持って、案件単位で「LP案件だけは公開URLを表示」するようにできる。

却下理由: 運用負荷が高い。実態として案件粒度のオーバーライドが要るケースは稀で、まずカテゴリ粒度で十分。
将来必要になったら、`creative_category_fields` を継承して `project_id IS NOT NULL` のオーバーライド行を許す形に拡張する。

### 案 C: カテゴリ + 案件のハイブリッド

A + B の合算。実装コストが Stage 1 の予算を超えるため、まずは A のみで進める。

### 案 D: フロント側ハードコード分岐（現状の `applyCreativeTypeVisibility` 拡張）

カテゴリコードで `if (code === 'lp') hide(...)` を増やす。Stage A の「マスタ駆動でレコード追加だけで増えるカテゴリ」と矛盾するため却下。

## Implementation notes (Stage 1)

- migration: `migrations/2026-05-10_creative_category_fields.sql`
- backend: `routes/haruka.js`
  - `GET    /api/categories/:id/fields`
  - `PUT    /api/categories/:id/fields`     (bulk upsert + delete)
  - `GET    /api/creatives/:id/custom-fields`
  - `PUT    /api/creatives/:id/custom-fields` (bulk upsert)
- helpers: `utils/category-fields.js` で `BUILTIN_FIELDS` 配列とデフォルトラベルを集中管理
- frontend: `public/haruka.html`
  - 詳細モーダルの DOM ラッパに `data-field-key` を付与
  - `applyCreativeDetailFieldVisibility(category_id)` を新設し、`openCreativeDetail()` 末尾で呼ぶ
  - マスタ画面のカテゴリ編集モーダルに「表示項目」セクションを追加

## Related ADRs

- ADR 010 — カテゴリをマスタ駆動にする基盤（Stage A）
- ADR 001 — 商品 / 訴求軸（creative-first 設計）。`product` / `appeal_axis` を builtin として残す根拠
- ADR 011 — 詳細モーダルのラウンド比較UI（同一モーダル内の別レイアウト変更）
