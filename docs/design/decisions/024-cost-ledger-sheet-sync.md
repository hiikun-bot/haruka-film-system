---
adr: 024
status: Accepted
date: 2026-06-28
tags: [cost-ledger, spreadsheet, sync, export, import, billing, pricing]
related_tables: [project_estimate_lines, project_estimate_line_costs, project_director_rates, clients, system_settings]
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
- `project_estimate_line_costs`（制作ロールの支払単価）
- `project_director_rates`（案件×制作種別のディレクション費）
- `clients.billing_org`（請求区分、[ADR 023](023-client-billing-org.md)）

> **改訂 (2026-06-28)**: 当初は「1行=1見積行」の明細フォーマットで実装した（#907）が、ユーザーの実際の運用・編集モデルと合わなかった（旧 project_rates 移行で rank 列が NULL のため誤差分が大量発生し、ユーザーが編集する「ランクA/B/C＝価格列」を拾えなかった）。下記の通り **「1行=案件×区分、ランクA/B/Cは価格列」の友好フォーマット**へ変更する。

## Decision（改訂後）

**「1行 = 案件 × 区分(カテゴリ)」**の友好フォーマットで双方向同期する。ランクA/B/C は **各ランクの制作支払単価の列**として持つ（ユーザーの編集モデル：案件ごとに 動画ABC / 静止画ABC を持つ）。

- 同期先はスプレッドシートの **先頭シート**。URL は `system_settings.cost_ledger_sheet_url`（未設定時はデフォルト定数）。
- 列: `# / クライアント / 請求区分 / 案件名 / 区分 / クライアント請求 / ディレクション費 / ランクA / ランクB / ランクC` ＋ 非表示ID列 `project_id / client_id / category_id / creative_type`。
- ランク価格の保存先は、その案件×区分の rank=A/B/C 見積行の制作（editor/designer）支払単価 `project_estimate_line_costs.unit_price`。**該当ランクの見積行が無ければ、反映時に見積行＋コストを自動作成する。** ただし **rank無しの既存「汎用行」があれば、新規作成せずそれを当該ランクに昇格して再利用する**（「汎用行＋自動作成A/B/C」の二重化を防ぐ。2026-06-28 追補）。
- hidden ID 列が無い行は「クライアント名＋案件名」「区分名」で後方互換マッチする（既存シートからの初回取り込み用）。
- **エクスポート**（`POST /api/cost-ledger/export`）: DB→シート。意味のある見積行のみ（planned>0 / 請求>0 / 支払単価>0 のいずれか）。L列以降に `line_id / project_id / client_id / creative_type / creator_cost_id / creator_role_id` を**非表示ID列**として出力（突き合わせ用）。
- **インポート プレビュー**（`POST /api/cost-ledger/import/preview`）: シートを読み、DB と突き合わせて差分を返す（書き込みなし）。
- **インポート 反映**（`POST /api/cost-ledger/import/apply`）: **シートを読み直して再計算**してから反映（クライアントから送られた差分は信用しない）。
- 書き戻し対象と粒度:
  - 行単位（line_id で一意）: client_unit_price / planned_count / rank / 制作支払単価（line_costs。cost が無く値があれば creator ロールで insert）
  - クライアント単位: billing_org（行をまたぐため、値が食い違えば **conflict** として反映スキップ）
  - 案件×制作種別単位: director_fee（同上。`UNIQUE(project_id, creative_type)` に upsert）
- 操作 UI は管理画面（page-master）の「📊 費用台帳同期」。権限は **admin / secretary**（財務データの書き戻しを伴うため）。同期先URLの変更は最高管理者のみ。

### Alternatives considered

1. **集約1案件1行ビューのまま双方向** — 見やすいが、金額の書き戻し先が一意に定まらず危険。閲覧専用なら可だが要件（金額書き戻し）を満たさない。却下。
2. **CSV/Excel ファイルのダウンロード/アップロード** — house style は Google Sheets（既存の creatives_export と同様）。シートURLでの同期に統一。
3. **行の追加=新規案件/見積行の作成** — スコープ過大・誤作成リスク。v1 は既存行の更新のみ（未知 line_id は無視）。

## Consequences

- 既存の `sheets.js` / `system_settings` / `project_estimate_line(_costs)` / `project_director_rates` / `clients.billing_org` を再利用。DB スキーマ変更なし（migration 不要）。
- 反映は「シート再読込→再計算→書き込み」なので冪等。プレビューはあくまで確認用。
- クライアント/案件単位の値はシート上で重複表示されるため、編集時は全該当行を揃える必要がある（食い違いは conflict 表示で反映しない）。
- 行追加・ID列編集は非対応（壊れた行は無視）。将来、新規作成対応や監査ログ化を検討する余地を残す。
