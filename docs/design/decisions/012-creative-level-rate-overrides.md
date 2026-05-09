---
adr: 012
status: Accepted
date: 2026-05-10
tags: [pricing, creative, override, billing, payout, admin-only]
related_tables: [creatives, creative_cost_overrides, project_estimate_lines, project_estimate_line_costs]
supersedes: null
superseded_by: null
related_adrs: [002, 004, 006]
---

# 012. クリエイティブ単位の単価上書き（請求額・支払額）

- **Status**: Accepted
- **Date**: 2026-05-10
- **Decided by**: ユーザー（hiikun.ascs@gmail.com）

## Context

[ADR 002](002-estimate-lines-unify-deliverable-rates.md) は `project_estimate_lines` を deliverable 兼売上単位として定め、1 line に複数 creatives がぶら下がる多対一モデルを採用した。
[ADR 004](004-pricing-extensibility.md) で line 配下の `project_estimate_line_costs` が role × user × pricing_type（fixed_per_unit / percentage / hourly / fixed_total）で原価を持つことになった。

これは「1 line 配下の creatives は同単価」という前提に立つが、実運用では **特定の 1 本だけ単価が異なる** ケースが頻発している：

- 「今回の動画は 通常の 2 倍請求で OK もらいました」（ユーザー請求額のみ × 2）
- ユーザーへの請求 ¥12,000 に対し、編集者 ¥8,000 / ディレクター ¥4,000 のような **個別の支払い配分**

これを表現する既存手段（line を分ける／planned_count を増やす）はいずれも不正確で、運用上「事後修正」（納品後でも管理者が単価を訂正できる）の中で扱いたい強い要望がある。

## Decision

### モデル

クリエイティブ 1 本に対して **2 種類の上書き値** を許す。どちらも NULL（未設定）のときは line 側の値（ADR 002+004 のロジック）を継承する。

1. **クライアント請求額の上書き**
   `creatives.override_client_amount NUMERIC NULL`
   - その creative 単独の売上額（税抜）。NULL なら `line.client_unit_price`（数量 1 換算）を継承
   - line の `planned_count × client_unit_price` で売上を見ていたところは、override がある creative はその額を使い、override が無い creative は line 単価で按分する

2. **ロール別支払額の上書き**
   新テーブル `creative_cost_overrides(creative_id, role_id, user_id NULL, amount)`
   - `(creative_id, role_id, user_id)` で UNIQUE
   - `user_id` が NULL = 「そのロール全体に対する上書き（担当が誰でも適用）」
   - `user_id` が非 NULL = 「そのロールのその担当者に対する上書き」
   - 該当行が無いロールは `project_estimate_line_costs` のロジック（ADR 004）で従来通り計算

### 解決ロジック（utils/pricing.js での適用）

クリエイティブ単位の請求額を解く関数：

```
resolveCreativeClientAmount(creative, line):
  if creative.override_client_amount is not null:
    return creative.override_client_amount
  return line.client_unit_price  // 1 本あたりの単価
```

クリエイティブ × ロール単位の支払額を解く関数：

```
resolveCreativeRoleCost(creative, role, user, line):
  // 1) creative_cost_overrides の (creative_id, role_id, user_id) 一致行
  // 2) 1) が無ければ (creative_id, role_id, user_id IS NULL) 行
  // 3) どちらも無ければ project_estimate_line_costs ベース（既存ロジック）
```

### 権限

**admin（`users.role = 'admin'`）のみ** が `creatives.override_client_amount` および `creative_cost_overrides` を作成・編集・削除できる。

- 理由：請求額と支払額は会社全体の収支に直結し、ディレクター／プロデューサー／秘書を含む現場担当が誤って動かすと採算が崩れる。「クライアントとの個別交渉で決まった例外単価」の責任は経営側に集約する。
- API（`PUT /api/creatives/:id/rate-overrides`）はサーバー側で `req.session.role === 'admin'` を強制する。
- UI（事後修正モーダル内の単価編集セクション）は admin 以外には非表示。

### UI 配置

クリエイティブ詳細モーダル（`modal-creative-detail`）から開く **事後修正モーダル（`modal-creative-postedit`）** の中に「💰 単価編集」セクションを admin にだけ表示する。

- 表示項目：
  - クライアント請求額（line 単価を初期値、空欄=line 継承）
  - ロール別支払額（line_costs から拾った各 (role × user) 行を初期値、空欄=line 継承）
- 保存は事後修正モーダルの保存ボタンに統合せず、独立した「単価を保存」ボタンを置く（誤操作防止）。

## Consequences

### Positive

- 「2 倍請求」など個別交渉を line を分けずに表現できる。集計・進捗・カテゴリ統計は ADR 002 の構造を維持できる
- ロール別支払額を独立に上書きできるので、請求 2 倍だが編集者には通常額、のようなケースも扱える
- 編集権限が admin に閉じるため、事故が起きにくい

### Negative

- 売上 / 原価の解決ロジックが「override → line」の二段階になり、`utils/pricing.js` と `routes/invoices` / 案件粗利計算の両方で fallback ロジックが必要
- マイグレーションは creatives への列追加と新テーブルの 2 件
- 既存データはすべて NULL/空テーブルで開始（破壊的変更なし）

### 集計クエリへの影響

- 案件粗利・売上集計：`SUM(creatives.override_client_amount)` + `SUM(line.client_unit_price * (planned_count - overridden_count))` の構造に書き換えが必要
- 請求書プレビュー（`/api/invoices/preview-items`）：creative 単位で出力する場合は override を優先
- これらは Stage を分けて適用する（最初は creatives テーブルの UI/API のみ、集計反映は別 PR）

## Alternatives considered

### A. multiplier（倍率）1 本

`creatives.rate_multiplier NUMERIC DEFAULT 1.0` で「2 倍」を表現する案。
- 却下理由：ユーザー要望は「自分が指定した金額で上書きしたい」「請求と各ロール支払いを別々に設定したい（請求 ¥12,000 / 編集 ¥8,000 / D ¥4,000）」。倍率では役割別の独立上書きが表現できない。

### B. line を分ける（既存モデルで 1 本 1 line を運用）

例外案件のたびに line を増やす運用。
- 却下理由：line 増殖はカテゴリ別集計を歪め、納期管理（ADR 010）も複雑化する。例外は構造ではなく差分で表現すべき。

### C. 請求書プレビュー側のみ編集（DB 非保持）

`/invoices/preview-items` の編集 UI で都度上書きし DB には保存しない案。
- 却下理由：事後参照（過去の例外単価がいくらだったか）が辿れず、複数月にまたがる長期案件で再現性が落ちる。

## Migration

`migrations/2026-05-10_creative_rate_overrides.sql`:

```sql
-- 1) creatives へクライアント請求額の上書き列を追加
ALTER TABLE creatives ADD COLUMN IF NOT EXISTS override_client_amount NUMERIC;
COMMENT ON COLUMN creatives.override_client_amount IS
  'ADR 012: NULL = line.client_unit_price 継承。非 NULL = この creative 単独の売上額（税抜・admin のみ編集可）';

-- 2) ロール別支払額の上書きテーブル
CREATE TABLE IF NOT EXISTS creative_cost_overrides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creative_id UUID NOT NULL REFERENCES creatives(id) ON DELETE CASCADE,
  role_id UUID NOT NULL REFERENCES roles(id),
  user_id UUID REFERENCES users(id),
  amount NUMERIC NOT NULL,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID REFERENCES users(id),
  updated_by UUID REFERENCES users(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS creative_cost_overrides_uniq
  ON creative_cost_overrides (creative_id, role_id, COALESCE(user_id, '00000000-0000-0000-0000-000000000000'::uuid));

CREATE INDEX IF NOT EXISTS creative_cost_overrides_creative_idx
  ON creative_cost_overrides (creative_id);

COMMENT ON TABLE creative_cost_overrides IS
  'ADR 012: クリエイティブ単位のロール別支払額上書き。admin のみ編集可。user_id NULL = ロール全体上書き';
```

ロールバック: `DROP TABLE creative_cost_overrides;` および `ALTER TABLE creatives DROP COLUMN override_client_amount;`。Stage 1 で導入する集計反映は別 ADR を切らずにこの ADR の範囲で扱う。

## Status transition

- 2026-05-10: Accepted（このドキュメント作成と同時、Stage 1 = 列・テーブル追加 + 事後修正 UI のみ）
- Stage 2（別 PR）: utils/pricing.js / 案件粗利 / 請求書プレビューに override を反映
- Stage 3（別 PR）: 旧 line 粒度の集計をやめて creative 粒度の集計へ移行（ここで完成）
