# ADR 030: 作成本数集計・請求の単価は「締め月末時点で有効な成果物グループ」で解決する

- Status: Proposed
- Date: 2026-07-30
- Related: ADR 022（見積 line rank）, ADR 025（成果物グループの適用期間 applies_from/applies_to・停止/再開）, ADR 026（delivered_at で納品月判定）, ADR 027（line の category は project と一致）

## Context

作成本数集計（`/analytics/creator-summary` `/analytics/creator-detail`）と、それを共有する単価計算は、`computeCreatorCreativeBreakdown()`（`routes/haruka.js`）で行っている。ここでのクリエイター支払単価の解決は **`creative.line_id` 固定の1経路のみ**：

```
creative.line_id → project_estimate_lines(その行) → project_estimate_line_costs.unit_price
```

一方 ADR 025 で、成果物グループ（line）には **適用期間 `applies_from`/`applies_to` と 停止/再開** が導入されている。単価変更の推奨運用は「旧グループを停止（`applies_to`=当日）し、新グループを作成（`applies_from`=当日）」で **履歴を残す**形。

**問題**：集計は `applies_from`/`applies_to` を**一切見ていない**。クリエイティブは作成時に紐づいた `line_id` を持ち続けるため、単価変更後に既に納品されたクリエイティブは **停止した旧グループの単価**を表示・計上し続ける。

### 実例（2026-07 さんなな / hertech【リサイズ】Webデザイン_静止画）
- 現在の成果物グループの制作者単価は **¥1,000/本**（新グループ）。
- しかし納品済みリサイズ6件は **停止した旧¥3,500グループ**に `line_id` が紐づいたまま。
- 結果、作成本数集計は該当6件を **¥3,500** で計上（請求書の実額 ¥1,000 と乖離）。

### 要件（ユーザー）
> 請求は月単位で締め処理されるため、**その月末時点での最新の単価**を反映したい。

## Decision

`computeCreatorCreativeBreakdown()` の単価解決を、**`creative.line_id` 固定ではなく、締め月末時点で有効な成果物グループから解決**する。

1. クリエイティブの分類キーは、現在紐づく line から **`(project_id, category_id, rank)`** を取得する（ADR 027 により category は project 内で一意方向）。
2. その `(project_id, category_id, rank)` に属する成果物グループのうち、**締め月末（JST 月末 23:59）時点で適用中**のものを1つ選ぶ：
   - `applies_from IS NULL OR applies_from <= 月末`
   - かつ `applies_to IS NULL OR applies_to >= 月末`
   - 複数該当時は `applies_from` が最新のもの（＝直近に有効化された単価）。
3. 選ばれた line の `project_estimate_line_costs.unit_price` を単価として用いる。
4. **フォールバック**：有効な line が見つからない／`applies_from`/`applies_to` 列が未適用の環境では、**従来どおり `creative.line_id`** を使う（タブを壊さない）。

### スコープ / 安全性
- **発行済み請求書は不変**：`invoice_items` は生成時に `unit_price` をスナップショット保存しているため、本変更は**過去に発行した請求書を遡って変えない**。
- 影響するのは「作成本数集計の表示（analytics）」と「**これから生成する**請求のプレビュー/生成」。後者はむしろ「締め時点の正しい単価で請求」になるので望ましい。
- 「最新」の基準は **納品日ではなく締め月末**（要件どおり）。月をまたいだ後で単価を変えても、確定済み月の集計は当時の月末基準で安定する（＝締め後に過去月が動きにくい）。

## Consequences

- 過去分の作成本数集計の金額が、単価変更のあった案件で**訂正方向に変わる**（意図した是正）。
- 集計のデータロードで、対象クリエイティブが属する **project の line を `applies_from/applies_to` 付きで追加ロード**する必要がある（`line_id` 集合だけでなく `(project_id, category_id, rank)` 集合でロード）。
- 単価変更の運用が「旧停止＋新作成」で正しく履歴管理されている前提。**同一 `(project, category, rank)` で期間が重複する複数 active line**があると解決が非決定的になるため、`applies_from` 降順の tie-break を定義（上記2）。将来的には重複を作らせないバリデーションを別途検討。

## Amendment (2026-07-30): 解決キーは「クリエイティブが所属する案件」基準

当初は「クリエイティブが紐づく line(`creative.line_id`→baseLine) の `project_id`」で解決していたが、実データで **`line_id` が隣の案件の成果物グループを指しているケース**が判明した（例: 所属は【リサイズ】案件で正しい単価は ¥1,000 なのに、`line_id` は別案件「Webデザイン_静止画」の ¥3,500 グループを指す。両案件は同じ `category_id`）。この場合、正しい単価 line は別 project にあり、`baseLine.project_id` キーでは届かず旧単価のままになる。

そこで解決キーを **`creative.project_id`（クリエイティブが実際に所属する案件）× `baseLine.category_id` × `baseLine.rank`** に変更する。データロードも、baseLine の project に加えて **クリエイティブの `project_id` 群の line** を候補に含める。

- 効果: `line_id` が隣の案件を指す紐付けズレでも、**所属案件の同カテゴリ・ランクの締め日有効単価**へ寄る。
- フォールバック: 所属案件に該当 `(category, rank)` の有効 line が無ければ、従来どおり元 line(`baseLine.id`) を使う。
- データ（`creative.line_id`）は変更しない。

## Alternatives considered

- **A. 個別データ修正（手動付け替え / 旧グループ単価上書き）**：単価変更のたびに毎月手作業が発生し、取りこぼす。恒久性なし。
- **B-alt. 納品日時点で有効な line で解決**：会計的には自然だが、ユーザー要件は「締め月末時点の最新」。締め前に単価が確定するワークフローに合わせ、月末基準を採用。
- **C. 納品時に creative へ単価スナップショット列を追加**：DB 変更が大きく、締め前の単価変更を反映できない（スナップショットが早すぎる）。ADR 025 の期間モデルがあるので不要。
