---
adr: 027
status: Accepted
date: 2026-07-02
tags: [projects, estimate-lines, categories, billing, data-integrity]
related_tables: [projects, project_estimate_lines, creative_categories]
supersedes: null
superseded_by: null
related_adrs: [002, 005, 022]
---

# 027. 成果物グループのカテゴリは案件の主カテゴリと完全一致必須

- **Status**: Accepted
- **Date**: 2026-07-02
- **Decided by**: ユーザー（hiikun.ascs@gmail.com）

## Context

旧 `project_rates` は動画・静止画両方の単価列を持っていたため、2026-05-06 の
lines 移行（migrations/2026-05-06_migrate_rates_to_lines.sql）で **動画案件にも
静止画 A/B/C の成果物グループが生成された**（「(旧 project_rates 移行)」ラベルの line）。

混在 line が引き起こす問題：

1. **誤単価リスク**: `utils/pricing.js` の `resolveCreativeRoleCost`（請求書プレビュー・
   生成で使用）は、line_id もカテゴリ一致も無い場合の最終フォールバックとして
   **「案件内の全 line」** を候補にする。混在案件では動画クリエイティブが静止画 line の
   単価を掴む余地がある
2. **単価未設定チェッカーのノイズ**: 使わない静止画 line の designer 単価未設定警告が
   出続け、本当の警告が埋もれる
3. **費用台帳同期のノイズ**: 1行=案件×区分のため、使わない区分の行がシートに出続ける

なお、クリエイティブ→line の自動紐付け・集計はカテゴリ一致が原則のため、
混在 line が「存在するだけ」で集計金額が狂うことはない（上記 1 のフォールバック時を除く）。

## Decision

**成果物グループ（project_estimate_lines）のカテゴリは、案件の主カテゴリ
（projects.primary_category_id）と完全一致必須とする（完全ブロック）。**
動画と静止画の両方の請求が必要な仕事は、案件を分けて登録する運用とする。

### 検証ルール（routes/haruka.js `validateLineCategoryAgainstProject`）

- 対象エンドポイント:
  - `POST /projects/:id/lines`（新規作成）
  - `PUT /projects/:id/lines/:line_id`（**category_id を変更する場合のみ**）
  - `POST /projects/:id/lines/generate-preset`（プリセット一括生成）
- `projects.primary_category_id` が **NULL の案件は制限なし**（レガシー救済。
  主カテゴリを設定した時点から制限が効く）
- 既存の不一致 line（移行遺産）は、**カテゴリ据え置きのままの編集（名前・単価等）は許可**。
  不一致カテゴリへの「変更」だけをブロックする

### UI（案件編集モーダル > 見積・費用）

- プリセット一括生成のカテゴリ select・line 追加/編集モーダルのカテゴリ select は、
  主カテゴリ設定済み案件では**主カテゴリのみ**表示（編集時は現在値も残す）

### 既存データのコンバート（ユーザー決定: 削除）

- 「主カテゴリと不一致 かつ 未使用（creatives.line_id 参照 0 件・invoice_items.line_id
  参照 0 件）」の line は**削除**する（line_costs は CASCADE）
- 使用中（クリエイティブ or 請求明細が紐付く）の不一致 line は削除せず個別判断
- 実行前に診断 SQL で件数・内訳を確認する（手順はチャット/PR 参照）

## Consequences

- 単価解決フォールバックが誤カテゴリ line を掴む経路が構造的に消える
- 単価未設定チェッカー・費用台帳から移行遺産のノイズが消える
- 動画+静止画を 1 案件で受ける案件は登録できなくなる → 案件を分ける運用。
  将来本当に必要になれば「補助カテゴリ（project_category_tags）に含まれる
  カテゴリまで許可」への緩和で対応可能（本 ADR の改訂で扱う）
- 主カテゴリ変更時に既存 line と不一致になるケースは今回スコープ外
  （変更自体はブロックしない。不一致 line は既存データ扱いとなる）

## Alternatives

- **A. admin/秘書のみ例外追加可**: サムネ等の混在請求に対応できるが、フォールバック
  誤単価の経路が残る。ユーザー判断で不採用（2026-07-02）
- **B. 警告のみ**: データは増え続けるため不採用
- **C. 補助カテゴリ（project_category_tags）まで許可**: 現時点で運用実態が無いため
  見送り。必要になったら本 ADR を改訂
