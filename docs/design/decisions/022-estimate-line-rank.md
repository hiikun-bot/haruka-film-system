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

支払いランクは **A / B / C** の3段階（**S は使わない**。メンバーマスタの `m-rank` には S があるが、成果物グループの支払いランクは A/B/C のみ）。

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
  ADD COLUMN rank TEXT;   -- NULL | 'A' | 'B' | 'C'（S は使わない。CHECK は付けず UI で A/B/C を強制）
COMMENT ON COLUMN project_estimate_lines.rank IS
  'ADR 022: この成果物グループの作業ランク(NULL|A|B|C)。主に editor/designer の支払単価(line_costs)選別に使う。client_unit_price はランク非依存。';
```

> 2026-06-06 本番適用済み（`ALTER TABLE ... ADD COLUMN IF NOT EXISTS rank TEXT`）。

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

### 支払単価マスタ（category × rank × role）

ランク別の支払額を毎回手入力させず、**マスタから自動入力**する（ユーザー要望：「ある程度は自動化したい」）。

```sql
CREATE TABLE IF NOT EXISTS category_rank_rates (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id UUID NOT NULL REFERENCES creative_categories(id) ON DELETE CASCADE,
  rank        TEXT NOT NULL,                            -- 'A' | 'B' | 'C'
  role_id     UUID NOT NULL REFERENCES roles(id),       -- 制作ロール（editor / designer 等）
  unit_price  INTEGER NOT NULL,                         -- 1 本あたり支払額（円・税抜）
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (category_id, rank, role_id)
);
COMMENT ON TABLE category_rank_rates IS
  'ADR 022: カテゴリ×ランク×制作ロールごとの支払単価マスタ。成果物グループ作成時に line_costs を自動入力する既定値。client 請求(client_unit_price)はランク非依存で対象外。';
```

- 例: `(動画, A, editor)=¥5,000` `(動画, B, editor)=¥4,500` `(静止画, A, designer)=¥3,000`
- **自動入力ロジック**: 成果物グループ保存時に `(category_id, rank)` 一致行を引き、該当ロールの `project_estimate_line_costs` を **未設定なら既定値で作成**。手動編集済みの line_cost は上書きしない（誤上書き防止）。rank 変更時は「マスタから再適用」を明示操作で。
- **client 請求は対象外**（マスタは支払いのみ）。請求は従来どおり line の `client_unit_price`。
- 編集・閲覧権限は **admin / 秘書 / プロデューサー（producer_director 含む）** に限定（採算に直結するため。`effectiveRole` で判定し VIEW AS にも追従。サーバは `requireRole` で同ロールガード）。

### UI

1. **成果物グループ追加／編集モーダル**（`#modal-project-line` 系）に **「ランク」セレクト**（なし / A / B / C）を **カテゴリの直後** に追加。保存（`saveProjectLine`）／読込（`loadProjectLines` / `openProjectLineModal`）に `rank` を載せる。category + rank が揃ったらマスタ単価をプレビュー表示。
2. **マスタ管理画面**に「ランク別単価」の CRUD（カテゴリ × ランク × ロール → 単価のグリッド）を追加。

### 移行（[feedback_db_migration_staging](../../../.claude/projects/-Users-takahashi-satoru-Documents-40---------haruka-film-system/memory/feedback_db_migration_staging.md) 準拠で Stage 分割）

1. **Stage 1（migration）** ✅適用済み: `project_estimate_lines.rank` 列追加 ＋ `category_rank_rates` マスタテーブル作成。コードは触らない。
2. **Stage 2（マスタ管理 UI）**: マスタ管理に「ランク別単価」CRUD を追加し、(category × rank × role) → 単価を登録できるようにする（自動入力の前提データ）。
3. **Stage 3（line rank ＋ 自動入力 ＋ pricing）**: 成果物グループモーダルに rank セレクト追加 + 保存/読込、保存時に `category_rank_rates` から line_costs を自動入力、`pricing.js` を列ベース選別へ（`rank` NULL は name フォールバック）。
4. **Stage 4（バックフィル）**: 既存 `name` の "Aランク"/"Bランク"/"Cランク" を正規表現で `rank` 列へ one-shot 反映。

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

## 確定事項（2026-06-06 ユーザー確定）

1. **rank は A/B/C のみ（S は使わない）**。列は CHECK 制約なしの TEXT、UI で A/B/C を強制。
2. **client 請求はランク非依存**（ランク別なのは支払いのみ）。請求もランク別にしたい要望が出たら将来別途。
3. **(category × rank × role) 支払単価マスタを作る**（`category_rank_rates`）。成果物グループ作成時に line_costs を自動入力する（「ある程度は自動化したい」）。

## 追補（2026-06-06）: 予定本数の廃止・実績ベース売上

成果物グループの **「予定本数（planned_count）」をモーダルから廃止**し、売上・採算は **「実際に紐づくクリエイティブ本数 × クライアント単価」** で集計する（ユーザー確定）。

- **実績本数の定義**: そのグループに紐づく creative の件数（`creatives.line_id` 一致・**status は問わず全件**）。
- 一覧の小計・粗利・`calcLineCostFront` は `planned_count` でなく実件数を使う。フロントは `GET /projects/:id/line-creative-counts`（`{line_id: count}`）で件数を取得。
- `project_estimate_lines.planned_count` 列は**残す**（後方互換・既存集計の段階移行のため）。新規グループは 0 のまま。
- **未対応（フォローアップ）**: 採算ダッシュボードの「見込み」列・納期売上見込みは現状まだ `planned_count` を参照（実績列はクリエイティブ実数ベースで既に正しい）。請求書は元々 creative 単位なので影響軽微（`fixed_total`/`hourly` の按分のみ実件数化が必要）。

## 追補（2026-06-07）: 成果物グループを「1本あたり単価の定義」に簡素化

ユーザーフィードバックを受け、成果物グループまわりの過剰なロジックを削いで **1本あたり単価の定義だけ** に整理した。

**確定**
- 成果物グループは per-unit の単価定義のみを持つ：**クライアント単価/本** ＋ **制作者単価/本**。
- **制作者単価**はモーダルに直接入力（1グループ=1ロール）。ロールはカテゴリの `render_kind` から自動判定（`video`→editor / それ以外→designer）。**UI ではロールを扱わない**（ユーザー「ロールごとは不要」）。実体は `project_estimate_line_costs` 1 行（`pricing_type='fixed_per_unit'`, `user_id=NULL`）として upsert。
- 一覧は **per-unit のみ表示**（「クライアント ¥X/本 ／ 制作者 ¥Y/本」）。合計・粗利・本数・コスト内訳アコーディオンは出さない。
- 合計・粗利・採算は **分析（採算）タブ** で見る（creative 実績ベース・既存）。

**撤去**（前述 2026-06-06 追補の実績件数表示も含む）
- **ランク別支払単価マスタ**（`category_rank_rates` のマスター画面UI・CRUD API・成果物グループ作成時の自動入力）を全撤去。「ランクで自動入力は不要」との判断。`category_rank_rates` テーブルは未使用として残置（後で DROP 可）。
- `GET /projects/:id/line-creative-counts` と一覧の実績件数・粗利表示・コスト内訳アコーディオンを撤去。

**残す**
- `rank`（A/B/C）は成果物グループのラベルとして残す（自動入力なし）。
- `planned_count` 列・`project_estimate_line_costs` テーブルは引き続き利用（制作者単価の保存先）。

## 追補（2026-06-07 その2）: ランク単価プリセット＋A/B/C 一括生成

動画編集・静止画バナーでは A/B/C × 制作者単価の3パターンが必ず要るため、毎回1個ずつ作らず **プリセットから3グループをまとめて生成** できるようにした（前述で撤去した「見えない自動入力」とは別物＝**見える形で3グループ生成**）。

**確定（ユーザー）**
- ランク別に変えるのは **制作者単価だけ**（クライアント単価はランク非依存・生成後に案件ごと入力）。
- 生成は **見積・費用タブの手動ボタン**（新規案件時の自動生成はしない）。

**実装**
- **プリセット保存**: `category_rank_rates` を再利用（`(category_id, rank, role_id)`、role はカテゴリの `render_kind` から自動＝editor/designer。UI ではロールを扱わない）。マスター画面に「💴 ランク単価プリセット」（カテゴリ × A/B/C グリッド）。編集は admin/秘書/プロデューサー。
  - `GET /rank-price-presets` / `PUT /rank-price-presets`（1セル upsert）。
- **一括生成**: `POST /projects/:id/lines/generate-preset { category_id }` が、そのカテゴリの A/B/C 成果物グループを作成（`client_unit_price=0`・`status=contracted`・制作者単価はプリセットから line_cost に保存）。同カテゴリで既存の rank はスキップ（重複作成しない）。
  - 見積・費用タブの「📋 プリセットから一括生成」＋カテゴリ select（既定は案件の主カテゴリ）。
- マイグレーション不要（`category_rank_rates` は既存）。
