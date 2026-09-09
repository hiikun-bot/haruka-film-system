---
adr: 038
status: Accepted
date: 2026-09-08
tags: [filename, serial, templates, sheets, projects, creatives]
related_tables: [filename_templates, projects, creatives]
supersedes: null
superseded_by: null
related_adrs: [007, 008]
---

# 038. ファイル名連番のスプレッドシート連動・テンプレ既定桁数・固定文字トークン

- **Status**: Accepted
- **Date**: 2026-09-08
- **Decided by**: ユーザー（hiikun.ascs@gmail.com）

## Context

ネコスエール／イヌスエール案件（静止画バナー）の命名規約（2026-09-08 みこさん ⇄ 髙橋聖）:

```
3桁の管理シート番号 ＋ ネコ・イヌスエール（固定） ＋ サイズ ＋ タイトルや内容 ＋ 拡張子
例) 010_ネコ・イヌスエール_1080_1080_大好きなペットとの毎日に.png
```

ADR 007 のテンプレ機構で不足していたもの:

1. **連番の桁数がテンプレ側で決められない**。桁数は ADR 008 Phase 4 で `projects.serial_digits`
   （案件モーダル「上級設定」）にだけ存在し、テンプレ画面から設定できなかった。
2. **固定文字が分かりにくい**。`kind: "custom"` の default 値で表現できるが、UI 上の名称が「テキスト（案件側で上書き可）」で
   「固定でこの文字を入れたい」用途に見えなかった。
3. **連番が別の管理スプレッドシートで先行採番されている**。HFS のカウンタ（`next_filename_serial`）は
   シートと無関係に進むため、「シートの最終番号 010 → 次は 011」という採番ができず、手で起点を合わせる運用だった。
4. 番号は後から変わることがあるので、**メンバーが連番（ファイル名）を修正できる**必要がある
   （こちらは ADR 008 Phase 4 のクリエイティブ詳細インライン編集で既に可能。本 ADR では変更しない）。

## Decision

### 1. 連番桁数の解決順を「案件 → テンプレ → 3」にする

```
filename_templates.serial_digits   INT NULL   (1〜10。NULL = 既定 3)
projects.serial_digits             INT NULL   (NULL = テンプレ既定に従う)  ※ NOT NULL / DEFAULT 3 を撤廃
```

- 桁数 = `projects.serial_digits ?? filename_templates.serial_digits ?? 3`
- 既存案件の `3`（旧 DEFAULT）は migration で NULL に寄せる（テンプレ既定 3 と同義なので挙動不変）
- テンプレ画面: ビルダーの「連番」行に桁数セレクト（既定 3 / 1〜10）を置き、プレビューの連番サンプルに反映
- 案件モーダル「上級設定」の桁数セレクトに **「テンプレ既定」** を先頭選択肢として追加（= NULL）

### 2. 固定文字トークン

- 既存の `kind: "custom"` をそのまま使う（スキーマ変更なし）。UI 名称を **「固定文字」** に改め、
  パレットに「＋ 固定文字」ショートカットを置く。default 値がそのまま固定文字になる。
- 案件側 `filename_token_overrides[key].value` で上書きできる性質は維持する
  （「ネコ・イヌスエール」を別案件で「ネコスエール」に変えたいケースがあるため）。

### 3. 連番の採番元（counter / sheet）

```
projects.serial_source        TEXT NOT NULL DEFAULT 'counter'   CHECK IN ('counter','sheet')
projects.serial_sheet_url     TEXT        連動する管理スプレッドシート URL
projects.serial_sheet_tab     TEXT        タブ名（NULL = 1 枚目）
projects.serial_sheet_column  TEXT NOT NULL DEFAULT 'A'   CHECK ^[A-Z]{1,3}$
```

採番ロジック（`bulk-preview` / `bulk` / `generate-filename` 共通）:

| serial_source | 起点の決め方 |
|---|---|
| `counter`（既定） | 従来どおり `projects.next_filename_serial`（bulk モーダルの「連番起点」で上書き可） |
| `sheet` | SA でシートの `{tab}!{col}:{col}` を読み、**各セルの先頭の数字列**（`^\d+`）の最大値 + 1。<br>見出し行や「No.」など数字で始まらないセルは無視。数値セルが 0 個なら 1。 |

- シート読み取りは Google Sheets API（既存 `sheets.js` の SA 認証、読み取りのみ・追加課金なし）。
  ユーザーは対象シートを SA のメールアドレスに **閲覧者** で共有する（案件モーダルに SA メールと「接続確認」ボタンを置く）。
- **読み取り失敗時はフォールバックせず 400 を返す**（権限なし／URL 誤り／タブ名誤り）。
  黙ってカウンタ方式に落ちると、ユーザーが最も避けたい「シートとのズレ」を再発させるため。
  bulk モーダルの「連番起点」を明示入力すればシートを読まずに進められる（緊急回避）。
- `sheet` 方式でも bulk 完了後の `next_filename_serial` 更新は従来どおり行う（counter に戻したとき自然に続くように）。
- 桁数はシートから推定しない（テンプレ／案件の設定を正とする）。「接続確認」でシート側の桁数ヒントは表示する。

> **追補（2026-09-08・使用中判定の列）**: 実際の管理シート（ネコ・イヌスエール）は A 列「No」に 1〜304 が
> 事前採番されており、「番号列の最大値 + 1」では 305 になってしまう。そのため
> `projects.serial_sheet_used_column`（例: `B` = CR名）を追加し、**その列が空でない行だけを使用中**として
> 番号の最大値 + 1 を採る。NULL のときは従来どおり番号列だけで判定する。
> 桁数ヒントは、シート側の番号が `010` のようにゼロ埋めされているときだけ出す（`13` のような素の数字からは推定しない）。
> migration: `migrations/2026-09-08b_serial_sheet_used_column.sql`

### 4. 連番（ファイル名）のメンバー修正

- 新規作成モーダル: 「提出用ファイル名」は手動編集可（既存）。
- クリエイティブ詳細: ファイル名はインライン編集で PUT される（ADR 008 Phase 4・既存）。
- 本 ADR では新しい列（例: `creatives.serial_no`）は**作らない**。連番はファイル名の先頭数字列が正、という現行モデルを維持する。
  （`internal_code` の先頭 3 桁は旧命名規約の名残で、テンプレ駆動のファイル名とは独立）

## Consequences

- ✅ テンプレを作った時点で桁数が決まり、案件側は「テンプレ既定」のままで運用できる
- ✅ 管理シートで先に番号を振る運用のまま、HFS の一括登録／個別登録が「最終番号 + 1」から始まる
- ✅ 固定文字がパレットから 1 クリックで置ける
- ⚠️ シート連動案件は SA への共有が必須。未共有だと登録時に 400（案内文つき）
- ⚠️ シート側で番号が飛んでいる（欠番）場合も「最大値 + 1」を採る（欠番再利用はしない。ADR 008 Phase 4 と同じ方針）
- ⚠️ 桁数を案件で明示していた案件（3 以外）はそのまま。3 は NULL に寄るため、テンプレ側で 3 以外を設定した場合はその案件も追従する

## Alternatives considered

- **（却下）シート側の最終行を HFS が書き換える双方向同期** — ADR 008 Phase 2 の領域。今回は「読むだけ」で要件を満たす
- **（却下）`creatives.serial_no` 列を新設して連番を構造化** — ファイル名を正とする現行モデルと二重管理になる。必要になったら別 ADR
- **（却下）読み取り失敗時にカウンタへ silent fallback** — ズレを再発させる。明示エラー＋手動起点の方が安全
