---
adr: 022
status: Accepted
date: 2026-06-06
tags: [pricing, rank, estimate, deliverable, payout, editor, billing]
related_tables: [project_estimate_lines, project_estimate_line_costs, creatives, users]
supersedes: null
superseded_by: null
related_adrs: [002, 004, 013]
---

# 022. 成果物グループ（見積明細）にランクを第一級の列として持たせる

- **Status**: Accepted
- **Date**: 2026-06-06
- **Decided by**: ユーザー（hiikun.ascs@gmail.com）

## Context

動画編集・静止画バナーの **作業者（編集者／デザイナー）への支払い** は、ランク別の定価になっている：

- A ランク … 1 本 ¥5,000
- B ランク … 1 本 ¥4,500
- C ランク … 1 本 …

ランクは **A / B / C** の3段階（メンバーマスタの `m-rank` は `S / A / B / C`。支払い運用では主に A/B/C を使う）。

### 現状の歪み

[ADR 002](002-estimate-lines-unify-deliverable-rates.md) で旧 `project_rates`（**rank A/B/C × video/design**）を `project_estimate_lines` に畳んだ際、**ランク軸が「1 グループ＝単一の単価」に潰れた**。今のスキーマには rank 列が無い。

そのため現状では **ランクが `project_estimate_lines.name` の文字列（"Aランク" / "Bランク" / "Cランク"）でしか表現されていない**。実際 [utils/pricing.js](../../../utils/pricing.js) の `resolveCreativeRoleCost()` は `rankApplied`（'A'|'B'|'C'）を受け取り、`line.name.includes('Aランク')` で line を選別している（229–237 行付近）：

```js
// 3) rank マッチを優先順位の先頭に持ってくる（rank が無ければそのまま）
if (rankApplied) {
  const rankMarker = `${rankApplied}ランク`;
  const idx = candidates.findIndex(l => (l.name || '').includes(rankMarker));
  ...
}
```

これは脆い：
- ランクが「名前」に手打ち依存。表記揺れ（"Aﾗﾝｸ" / "A ランク" / 空欄）で pricing が壊れる
- ランクが見積・採算・請求の構造として扱えない（集計・フィルタ・自動入力ができない）
- 「動画 5 本」を 1 グループにまとめてランク混在にすると、`予定本数 × 単価` が合わない（ユーザー指摘）

### 重要な前提（請求と支払いの分離）

**クライアントへの請求額と、作業者への支払額は別軸**（混ぜてはいけない）。
今回のランク別単価が効くのは **作業者（editor / designer）への支払い**（原価＝`project_estimate_line_costs`）であって、`client_unit_price`（売上）ではない。

## Decision

**`project_estimate_lines` に `rank` 列を第一級として追加し、`name` 文字列マッチを置き換える。**

### モデル

```sql
ALTER TABLE project_estimate_lines
  ADD COLUMN rank TEXT;   -- NULL | 'S' | 'A' | 'B' | 'C'（メンバーランクと同スケール）
COMMENT ON COLUMN project_estimate_lines.rank IS
  'ADR 022: この成果物グループの作業ランク。主に editor/designer の支払単価(line_costs)選別に使う。client_unit_price はランク非依存。';
```

- `rank` は **この成果物グループの作業ランク** を表す。
- 用途は主に **editor / designer の支払単価（`project_estimate_line_costs`）の選別**。`client_unit_price`（クライアント請求）はランクと **独立**（請求と支払いの分離原則）。
- 成果物グループの基本単位を **(category × rank)** とする。
  「動画 A ランク 3 本 × ¥(支払)」「動画 B ランク 2 本」を **別グループ** に分け、`name` 手打ちではなく `rank` 列で正式に表現する。グループ内はランク単一なので `予定本数 × 単価` が常に整合する。

### pricing.js の変更

`resolveCreativeRoleCost()` のランク選別を、名前文字列マッチから **列比較** に置換：

```js
// 旧: candidates.findIndex(l => (l.name||'').includes(`${rankApplied}ランク`))
// 新: candidates.findIndex(l => l.rank === rankApplied)
//     後方互換: l.rank が NULL のときのみ従来の name 文字列マッチにフォールバック
```

### UI

成果物グループ追加／編集モーダル（`#modal-project-line` 系）に **「ランク」セレクト**（なし / S / A / B / C）を **カテゴリの直後** に追加。保存（`saveProjectLine`）／読込（`loadProjectLines` / `openProjectLineModal`）に `rank` を載せる。

### 移行（[feedback_db_migration_staging](../../../.claude/projects/-Users-takahashi-satoru-Documents-40---------haruka-film-system/memory/feedback_db_migration_staging.md) 準拠で Stage 分割）

1. **Stage 1（migration）**: `ALTER TABLE project_estimate_lines ADD COLUMN rank TEXT;` を本番適用。コードは触らない。
2. **Stage 2（読み書き）**: モーダルに rank セレクト追加 + 保存/読込。`pricing.js` を列ベース選別へ（`rank` NULL は name フォールバック）。← migration 適用済み確認後に作る。
3. **Stage 3（バックフィル）**: 既存 `name` の "Aランク"/"Bランク"/"Cランク" を正規表現で `rank` 列へ one-shot 反映。
4. **Stage 4（将来・任意）**: `(category × rank) → 支払単価` のマスタを設け、グループ作成時に line_costs を自動入力。本 ADR の範囲外・必要になったら別 ADR。

## Consequences

### 解決すること
- ランク別支払いが **名前依存でなく構造** で表現でき、表記揺れで pricing が壊れない
- グループ内はランク単一なので `予定本数 × 単価` が常に整合する（ユーザーの当初の不安が解消）
- ランクで採算・集計・フィルタ・自動入力ができる土台になる

### 残る／注意
- **client 請求はランク非依存のまま**（請求もランク別にしたい要望が出たら別途検討）
- creative 1 本だけの例外（「今回だけ 2 倍請求」等）は引き続き [ADR 013](013-creative-level-rate-overrides.md) の override で扱う（rank は体系的定価、override は例外）
- 1 グループ＝1 ランクなので、同カテゴリで複数ランクを扱う案件はグループが複数になる（ADR 002 の複数グループ前提どおり）
- 移行は nullable 列 + バックフィルで **非破壊**

## Alternatives considered

- **(却下) 現状維持（`name` に "Aランク" 文字列）** — 表記揺れで pricing が壊れる。構造化されず集計・自動入力ができない。
- **(却下) ランクを creative 側だけに持たせる** — creative には既に「実際に誰がどのランクで作業したか」を示す `assignment.rank_applied` がある。だが「この見積枠は A ランク定価」という **見積・採算の単位はグループ側** が自然。両者は役割が異なる（creative=実績ランク、line=定価ランク）ので、line に rank を持たせる。
- **(却下) ADR 013 の per-creative override で全部やる** — override は例外用。毎本手入力になり、体系的なランク定価には不向き。

## Open points（実装前にユーザー確定）

1. **rank enum に S を含めるか** — メンバーランクは `S/A/B/C`、今回の支払いは `A/B/C`。整合のため `NULL|S|A|B|C` を許容しておく案（実運用は A/B/C 中心）。
2. **client 請求もランド別にする可能性** — 本 ADR では分離（請求はランク非依存）。将来要望が出たら `client_unit_price` 側のランク化を別途。
3. **(category × rank) 支払単価マスタ（Stage 4）を作るか** — グループ作成時の自動入力。旧 `project_rates` 相当の再導入。必要になったら別 ADR。
