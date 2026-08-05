---
adr: 024
status: Accepted
date: 2026-06-28
tags: [cost-ledger, spreadsheet, sync, export, import, billing, pricing]
related_tables: [project_estimate_lines, project_estimate_line_costs, clients, system_settings]
supersedes: null
superseded_by: null
related_adrs: [002, 004, 023]
---

# 024. 案件費用台帳 ⇄ スプレッドシート 双方向同期

- **Status**: Accepted
- **Date**: 2026-06-28
- **Decided by**: ユーザー（hiikun.ascs@gmail.com）

## Context

案件費用台帳を Google スプレッドシートで管理したい。「システムから書き出して資料を改訂」「シートを編集してシステムへ反映」の双方向同期がほしい（管理画面から操作）。金額・ランクも書き戻したい。反映前に差分プレビューで確認したい。

費用データは複数テーブルに分散している（[ADR 002](002-estimate-lines-unify-deliverable-rates.md) / [ADR 004](004-pricing-extensibility.md)）:
- `project_estimate_lines`（client_unit_price / rank / planned_count）
- `project_estimate_line_costs`（制作ロール・ディレクターの支払単価）
- `clients.billing_org`（請求区分、[ADR 023](023-client-billing-org.md)）

> ※ 2026-08-06 改訂前は、ディレクション費のみ旧 `project_director_rates`（案件×制作種別）を読み書きしていた。

> **改訂 (2026-08-06)**: 「ディレクション費」列の保存先を `project_director_rates`（案件×制作種別）から **`project_estimate_line_costs` の role=director 行（案件×区分の全グループ）** へ変更する。理由は下記「ディレクション費の保存先変更」を参照。
>
> **改訂 (2026-06-28)**: 当初は「1行=1見積行」の明細フォーマットで実装した（#907）が、ユーザーの実際の運用・編集モデルと合わなかった（旧 project_rates 移行で rank 列が NULL のため誤差分が大量発生し、ユーザーが編集する「ランクA/B/C＝価格列」を拾えなかった）。下記の通り **「1行=案件×区分、ランクA/B/Cは価格列」の友好フォーマット**へ変更する。

## Decision（改訂後）

**「1行 = 案件 × 区分(カテゴリ)」**の友好フォーマットで双方向同期する。ランクA/B/C は **各ランクの制作支払単価の列**として持つ（ユーザーの編集モデル：案件ごとに 動画ABC / 静止画ABC を持つ）。

- 同期先はスプレッドシートの **先頭シート**。URL は `system_settings.cost_ledger_sheet_url`（未設定時はデフォルト定数）。
- 列: `# / クライアント / 請求区分 / 案件名 / 案件区分 / クライアント請求 / ディレクション費 / ランクA / ランクB / ランクC` ＋ 非表示ID列 `project_id / client_id / category_id / creative_type`。
  - **案件区分（2026-07-01 追加、アイコン付き）**：その案件のカテゴリ（`projects.primary_category_id` の名称＝🎬動画/🖼️静止画/🌐HP/📄LP/💬LINE配信）。案件編集の「カテゴリ」に対応し、案件内の全行で同一。**エクスポート専用の参照列で、インポート（コンバート）では読み書きしない**（対象外）。
  - **旧「区分」列（各行の制作物カテゴリ）は廃止（2026-07-02）**：ADR 027 の本番コンバートで旧 project_rates 由来の重複行を掃除した結果、実質「1案件＝1区分」となり案件区分と一致したため。行の実カテゴリは非表示 `category_id` で解決する（インポートの名称フォールバックは案件区分名を使用）。
- ランク価格の保存先は、その案件×区分の rank=A/B/C 見積行の制作（editor/designer）支払単価 `project_estimate_line_costs.unit_price`。**該当ランクの見積行が無ければ、反映時に見積行＋コストを自動作成する。** ただし **rank無しの既存「汎用行」があれば、新規作成せずそれを当該ランクに昇格して再利用する**（「汎用行＋自動作成A/B/C」の二重化を防ぐ。2026-06-28 追補）。
- hidden ID 列が無い行は「クライアント名＋案件名」「区分名」で後方互換マッチする（既存シートからの初回取り込み用）。
- **エクスポート**（`POST /api/cost-ledger/export`）: DB→シート。意味のある見積行のみ（planned>0 / 請求>0 / 支払単価>0 のいずれか）。L列以降に `line_id / project_id / client_id / creative_type / creator_cost_id / creator_role_id` を**非表示ID列**として出力（突き合わせ用）。
- **インポート プレビュー**（`POST /api/cost-ledger/import/preview`）: シートを読み、DB と突き合わせて差分を返す（書き込みなし）。
- **インポート 反映**（`POST /api/cost-ledger/import/apply`）: **シートを読み直して再計算**してから反映（クライアントから送られた差分は信用しない）。
- 書き戻し対象と粒度:
  - 行単位（line_id で一意）: client_unit_price / planned_count / rank / 制作支払単価（line_costs。cost が無く値があれば creator ロールで insert）
  - クライアント単位: billing_org（行をまたぐため、値が食い違えば **conflict** として反映スキップ）
  - 案件×区分単位: ディレクション費（同上。その区分の**全グループ**の role=director / user_id なしの line_cost を 1本あたり単価で揃える）
- 操作 UI は管理画面（page-master）の「📊 費用台帳同期」。権限は **admin / secretary**（財務データの書き戻しを伴うため）。同期先URLの変更は最高管理者のみ。

### ディレクション費の保存先変更（2026-08-06 改訂）

**問題**: 「ディレクション費」列だけが旧 `project_director_rates(project_id, creative_type)` を読み書きしていた。この旧テーブルは [ADR 002](002-estimate-lines-unify-deliverable-rates.md) Stage 4d 以降**システム側の誰も読んでいない**（成果報酬 `/invoices/preview-items`・作成本数集計・案件編集モーダルは、いずれも `project_estimate_line_costs` の role=director を見る `resolveCreativeRoleCost` 経由）。結果:

- シートにディレクション費を入れてインポートしても、成果報酬は ¥0 のまま・「単価不明」バッジが付く（prima tokyo の 2 案件で発生）
- 案件編集モーダルの「🎬 ディレクター費」も「未設定」のまま
- **エクスポートも同じ旧テーブルから読み出すため、値が往復して一致し「差分0件・シートとシステムは一致しています」と表示される**（同期できているように見えて実体はどこにも効いていない）

**決定**: 読み書きとも `project_estimate_line_costs`（role=director / `user_id` なし・`pricing_type='fixed_per_unit'`）に統一する。

- **反映（インポート）**: その案件×区分の**全成果物グループ**の role=director 行へ同じ 1 本あたり単価を書く。案件編集モーダルの「🎬 ディレクター費 → 全グループに反映」（`PUT /api/projects/:id/director-fee`）と同一の挙動にそろえる。
  - `pricing_type='hourly'` の行は**上書きしない**（時間制ディレクター費は [ADR 028](028-hourly-work-timesheet.md) の管轄で、per-unit の意味を持たないため）
  - 値 `0` は role=director の `fixed_per_unit` 行を削除（＝ディレクション費なし）。未設定（空欄 / —）は「変更しない」
  - ランク列の反映でグループが新規自動作成される場合、その新グループにもディレクション費を引き継ぐ（引き継がないと新ランクだけ ¥0 になる）
- **書き出し（エクスポート）**: その区分のグループ群から role=director の per-unit 単価を読む。値が揃っていなければ最大値を代表値にする（クライアント請求列と同じ扱い）。時給行しか無いグループは `—`。
- 旧 `project_director_rates` はこれで**参照ゼロ**になる。テーブル本体の DROP は [ADR 002](002-estimate-lines-unify-deliverable-rates.md) Stage 6 に従う（本 ADR では触らない）。

**データ移行は不要**: 旧テーブルにしか値が無い案件は、シートに値が残っているため切替後のインポートでそのまま `line_costs` に入る。逆に `line_costs` にしか値が無い案件は、切替後のエクスポートでシートに現れる。切替時点の本番データで、両者が食い違う行は 6 行のみで、いずれも上書き事故にはならないことを確認済み。

### Alternatives considered

1. **集約1案件1行ビューのまま双方向** — 見やすいが、金額の書き戻し先が一意に定まらず危険。閲覧専用なら可だが要件（金額書き戻し）を満たさない。却下。
2. **CSV/Excel ファイルのダウンロード/アップロード** — house style は Google Sheets（既存の creatives_export と同様）。シートURLでの同期に統一。
3. **行の追加=新規案件/見積行の作成** — スコープ過大・誤作成リスク。v1 は既存行の更新のみ（未知 line_id は無視）。

## Consequences

- 既存の `sheets.js` / `system_settings` / `project_estimate_line(_costs)` / `clients.billing_org` を再利用。DB スキーマ変更なし（migration 不要）。
- 台帳シートで編集した金額は、ランク単価もディレクション費も同じ `project_estimate_line(_costs)` に着地する。**「台帳に入れたのにシステムに出ない」という分断は原理的に起きなくなった**（2026-08-06 改訂）。
- 反映は「シート再読込→再計算→書き込み」なので冪等。プレビューはあくまで確認用。
- クライアント/案件単位の値はシート上で重複表示されるため、編集時は全該当行を揃える必要がある（食い違いは conflict 表示で反映しない）。
- 行追加・ID列編集は非対応（壊れた行は無視）。将来、新規作成対応や監査ログ化を検討する余地を残す。
