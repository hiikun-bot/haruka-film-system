---
adr: 014
status: Accepted
date: 2026-05-10
tags: [ui, shared-component, member-picker, master-picker, ux-consistency]
related_tables: [users, clients, products]
supersedes: null
superseded_by: null
related_adrs: [003]
---

# 014. マスター系選択 UI の共通化（MemberPicker / MasterPicker）

- **Status**: Accepted
- **Date**: 2026-05-10
- **Decided by**: ユーザー（hiikun.ascs@gmail.com）

## Context

メンバー（`users`）を選ばせる UI が画面ごとにバラバラに育ってしまった。棚卸しの結果、少なくとも 6 種類の実装パターンが並走している：

| 機能 | ロール別フィルタ | 名前検索 | nickname 表示 | 実装場所 |
|---|:-:|:-:|:-:|---|
| クリエイティブ担当者フィルタ | ❌ | ✅ | ✅ | `public/haruka.html` 内 `renderAssigneeMultiList()` |
| バルク担当者割当 | ✅ | ❌ | ❌ | `updateBulkAssigneeSelect()` |
| タスク作成 P/D | ✅ | ❌ | ❌ | `<select id="t-producer">` 等 |
| 案件新規 P/D | ✅ | ❌ | ❌ | `<select id="p-producer-id">` 等 |
| Verup 報告者フィルタ | ✅ | ❌ | ✅ | `_verupPopulateReporterEditor()` |
| バグ報告 対応者 | ❌ | ✅ | ❌ | `<select id="br-assignee">` |

問題:
- 検索したい画面で検索できない／ロール別に絞りたい画面で絞れない
- nickname 表示の有無がバラバラ → 同一ユーザーが画面ごとに違う名前で表示される
- フィルタロジックが似た形で 4 箇所に重複している
- 一画面だけ挙動が違う UI が混ざる事故が今後も無限に起き続ける

ユーザーから「**マスター系（メンバー・クライアント・商材など）の選択 UI は完全に統一したい。画面ごとに動作が違うと運用が大変**」という強い要請。

## Decision

### 共通部品 `MemberPicker` を導入し、メンバー選択は全画面でこれを使う

実装ファイル: `public/js/member-picker.js`

```js
window.MemberPicker = {
  // 単一選択（select 代替）
  bindSelect(selectEl, options),

  // 任意のトリガー要素から開く（多目的）
  open(triggerEl, options),
};
```

**画面ごとに変えてよい引数（外側から差し込む）**
- `mode`: `'single' | 'multi'`
- `value`: 初期値（id または id[]）
- `allowedRoles`: `['producer', 'producer_director', ...]`（省略時は全ロール表示）
- `showInactive`: 退職者を出すか（既定 false、出す場合は区切り線の下にまとめる）
- `emptyLabel`: null 許容オプションの行ラベル（例: `'匿名で報告'` `'未割当'`）
- `onChange(value)`: 値変更時のコールバック

**画面ごとに変えない仕様（共通部品が固定）**
- 検索は `full_name` + `nickname` 両方を対象（部分一致・大文字小文字無視）
- ロールフィルタ chip の並び順・配色・ラベル表記
- 表示は `full_name（nickname）` 形式（nickname が無ければ `full_name` のみ）。本名を主、ニックネームを補助とする
- 非アクティブメンバーは区切り線の下にまとめる（`showInactive: true` のときのみ）
- キーボード操作（↑↓ で移動、Enter で確定、Escape で閉じる）
- ロード状態・空状態のメッセージ文言

### UI 仕様（絵コンテ）

**単一選択モード**

```
┌─ 対応者 ─────────────────────────────────────────┐
│ ┌──────────────────────────────────────────────┐ │
│ │ ひーくん（髙橋聖）                       ▼ │ │
│ └──────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────┘
   ↓ クリックで開く
┌─ メンバーを選択 ─────────────────────────────────┐
│ 🔍 [名前・ニックネームで検索...            ]    │
│                                                  │
│ ロール: [全て ▼] [P] [D] [P/D] [編集] [デザイン]│
│                                                  │
│ ┌──────────────────────────────────────────────┐ │
│ │ ⚪ ひーくん（髙橋聖）        管理者          │ │
│ │ ⚪ ハル（春日太郎）          P/D             │ │
│ │ ⚪ ゆうき                    Director        │ │
│ │ ⚪ さとし（佐藤聡）          Editor          │ │
│ └──────────────────────────────────────────────┘ │
│                          [キャンセル] [選択]    │
└──────────────────────────────────────────────────┘
```

**複数選択モード**

```
┌─ 担当者で絞り込み ──────────────────────────────┐
│ 🔍 [検索...                                  ]   │
│ ロール: [全て] [P] [D ●] [編集 ●] [デザイン]   │
│                                                  │
│ ☑ ハル（春日太郎）          P/D                  │
│ ☑ ゆうき                    Director             │
│ ☐ さとし（佐藤聡）          Editor               │
│                                                  │
│ 選択中: 2名  [全解除] [絞り込みを適用]          │
└──────────────────────────────────────────────────┘
```

### データソース

サーバー API は変更しない（`GET /members` がすでに `nickname` も含めて全メンバーを返却する）。共通部品が初回だけ取得してメモリにキャッシュし、複数画面で共有する。

ロールフィルタは [ADR 003](003-roles-as-master-data.md) の `users.role` 値を使う：
`admin / secretary / producer / producer_director / director / editor / designer`

表示用の chip は短縮形（P / D / P/D / 編集 / デザイン / 管理 / 事務）。

### 段階的ロールアウト

| Stage | 対象 | 範囲 |
|---|---|---|
| 1 | 共通部品実装 + ADR | `member-picker.js` 新規 / `haruka.html` に DOM・CSS・script 追加 |
| 2 | バグ報告画面の対応者・対応者フィルタを置換 | `<select id="br-assignee">` `<select id="bug-report-filter-assignee">` |
| 3 | 案件 P/D・タスク P/D・バルク担当者割当を置換 | `p-producer-id` / `p-director-id` / `t-producer` / `t-director` / `bulk-assignee-id` |
| 4 | クリエイティブ編集の担当者・チェックリスト担当者を置換 | `ce-assignee-id` / `cd-assignee-id` |
| 5 | クリエイティブ担当者フィルタ・Verup 報告者フィルタを置換 | `assignee-multi` / `verup-filter-reporter` |
| 6（将来） | クライアント・商材も同思想で `MasterPicker` に拡張 | 別 ADR |

### 既存 UI の互換性

旧 `<select>` は HTML 上は残し、JS で `MemberPicker.bindSelect(el, ...)` を呼んだ瞬間に DOM を入れ替える方針。これにより：
- form submit / FormData の挙動が変わらない（hidden input で代替）
- 段階的ロールアウト中に「半分だけ MemberPicker・残りは旧 select」が共存できる
- 旧コードを一気に削除しなくてよい

## Consequences

### 良い面
- 同じユーザーが全画面で同じ表記（`full_name（nickname）`）になる
- 「検索したい」「ロールで絞りたい」が全画面で同じ操作で実現
- 6 種類のロジック重複が 1 箇所に集約 → バグ修正も 1 箇所
- 将来 `MasterPicker<Client>` `MasterPicker<Product>` への展開も同じ思想で揃う

### 悪い面・コスト
- Stage 2〜5 の置換 PR が複数発生する（一気にやるとリグレッション範囲が広い）
- 旧 `<select>` の HTML をすぐに消せない（互換性維持期間が必要）
- 共通部品が壊れると全画面が同時に壊れる（テストの重要性が増す）

### 切り戻し
共通部品が問題を起こした場合、`MemberPicker.bindSelect` の呼び出しをコメントアウトすれば旧 `<select>` の挙動に戻る（HTML を残しているため）。

## Alternatives

### A. 各画面で個別に検索 + ロール絞り込みを実装する
- 棚卸しで判明した「6 種類の実装」をさらに増やす方向。今のバラバラ問題が固定化する → 却下

### B. ライブラリ（Choices.js / Select2 等）を導入する
- 検索は手に入るがロール chip / nickname 表示形式は結局カスタムが必要
- 既存 vanilla JS 構成に外部ライブラリを足すコストが見合わない → 却下

### C. サーバー側で `GET /members?role=...&q=...` を実装してインクリメンタルサーチ
- メンバー総数が数十人規模なので、初回一括取得 + クライアント側絞り込みで十分高速
- ネットワーク往復が増えるだけで体感が悪い → 却下（数百人規模になったら再検討）

## Open Questions / Future Work

- スマホ UI でのモーダル表示は本 ADR 範囲外（スマホチャット側で `@media` 対応）
- Stage 6 で `MasterPicker<T>` に汎化するとき、ロールに相当する分類軸（例: クライアントの業種、商材のカテゴリ）をどう扱うかは別 ADR で決める
- キーボード操作の詳細（Tab トラップ / aria-* 属性）はアクセシビリティ Pass で別途見直す
