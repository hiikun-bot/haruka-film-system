# ADR 031: 作成本数集計の単価は creatives.line_id が無くても案件の成果物グループから解決する

- Status: Proposed
- Date: 2026-08-04
- Related: ADR 002（creatives.line_id 追加）, ADR 022（見積 line rank）, ADR 025（適用期間 applies_from/applies_to）, ADR 027（line の category は project と一致）, ADR 030（締め月末時点で有効な line で解決）

## Context

作成本数集計（`/analytics/creative-by-assignee` `/analytics/creator-summary` `/analytics/creator-detail`）の単価解決は、`computeCreatorCreativeBreakdown()` が **`creative.line_id` → `project_estimate_line_costs`** の 1 経路だけを見る。`line_id` が NULL だと単価行が 1 件も引けず、本数だけカウントして `rate_unknown`（UI 表示「単価不明 / 単価未設定」）になる。

**問題**: `creatives.line_id` を書き込むコードがアプリに存在しない。

- クリエイティブ登録 API（一括 `POST /creatives/bulk` / 単体 `POST /creatives`）の insert payload に `line_id` が無い。
- 更新系にも `creatives.line_id` を書く経路が無い。
- 値が入っているのは 2026-05-06 の移行 SQL（`migrations/2026-05-06_migrate_rates_to_lines.sql` の best-effort バックフィル）で埋めた分だけ。

本番データの月別内訳（2026-08-04 時点・全 712 件）:

| 作成月 | line_id あり | line_id なし |
|---|---|---|
| 2026-04 | 8 | 0 |
| 2026-05 | 165 | 4 |
| 2026-06 | 279 | 0 |
| 2026-07 | 18 | 226 |
| 2026-08 | 0 | 12 |

バックフィルの最終実行（2026-07-08 頃）以降に登録されたクリエイティブは **全件が単価不明**になる。案件側で成果物グループの単価を正しく登録していても表示は変わらない、という状態だった（例: 「【二次利用切り抜き】たごんチーム」は編集者 ¥3,500/本 が登録済みだが、クリエイティブ 26 件すべて `line_id` NULL）。

一方、報酬台帳・請求プレビューが使う `utils/pricing.js` の `resolveCreativeRoleCost()` は **`line_id` 直指定 → `category_id` 一致 → `creative_type` 由来カテゴリ一致 → 案件内全 line** とフォールバックするため、同じデータで金額が出る。**同じクリエイティブが画面によって「¥3,500」と「単価不明」に分かれる**二重定義になっていた。

## Decision

1. **候補 line の選定ロジックを 1 箇所に集約する。** `resolveCreativeRoleCost()` の内部にあった候補選定を `buildCreativeLineCandidates()` として `utils/pricing.js` に切り出し、請求側と集計側の両方から使う。
2. **集計側も `line_id` が無ければ案件から解決する。** `routes/haruka.js` の `resolveCreativeLineForPricing()` で、
   - まず ADR 030 どおり「締め月末時点で有効な同カテゴリ・ランクの line」に寄せる
   - 単価行が引けない（`line_id` NULL / 単価行が空）なら `buildCreativeLineCandidates()` の候補から**単価行を持つ最初の line** を採用する
   - どちらでも見つからなければ従来値のまま（＝従来どおり `rate_unknown`）
3. **集計側の候補は rank 一致を status より優先する（`rankFirst`）。** 集計側だけ以下に変える:
   - `cancelled` / `rejected` のみ除外し、`draft` は候補に残す
   - 並び順は `rank 一致` → `status が ACTIVE（ADR 005）` → `applies_from が新しい順`

   理由: 「プリセットから一括生成」で作られた B/C ランクのグループは `status='draft'` のまま運用されており（本番実データ）、ADR 005 の status フィルタを先に効かせると **担当者のランクと違うランクの単価**を掴む。UI 上ユーザーには A/B/C とも有効なグループに見えているため、ランク一致を優先するほうが実態に合う。請求側（`rankFirst` 未指定）は従来どおり ACTIVE のみで、挙動は変わらない。
4. 適用期間（ADR 025）のフィルタは集計側のみ `asOf = 締め月末` で適用する（ADR 030 と整合）。

`creatives.line_id` のデータ自体は本 ADR では変更しない（次段の作業で登録時自動付与＋バックフィルを行う）。

## Consequences

- 2026-07-08 以降に登録された全クリエイティブの単価が、作成本数集計・明細モーダルで表示されるようになる（本数は従来もカウント済みなので、変わるのは金額と `rate_unknown` バッジ）。
- 作成本数集計の金額が「増える方向」に動く。**発行済み請求書（`invoice_items` の単価スナップショット）は不変**。
- 集計と報酬台帳／請求プレビューの単価解決が同じ候補選定を使うようになり、2 系統の乖離が縮む（完全一致ではない: 集計側は締め月末の期間フィルタと rank 優先が入る）。
- `line_id` が NULL のままでも金額が出るため、**紐付けの誤りが表面化しにくくなる**リスクがある。次段（登録時の自動付与＋バックフィル）で `line_id` を実データとして埋め、フォールバックは保険の位置づけに戻す。
- 集計 3 経路のデータロードが `buildLinePricingContext()` に共通化され、`line_id` の有無に関わらず「クリエイティブが所属する案件の全 line」をロードするようになった（クエリ本数は不変、対象案件数ぶん行数が増える）。

## Amendment (2026-08-04): line_id を実データとして埋める（登録時の自動付与＋バックフィル）

上記の Decision は「集計側で救う」だけで、`creatives.line_id` は NULL のままだった。データとしても正しい紐付けを持たせる（紐付けの誤りを画面で追える状態に戻す）ため、以下を追加する。

1. **登録・担当者変更のたびに `line_id` を同期する。** `syncCreativeLineId()` を、クリエイティブ作成（単体・一括）、担当者更新、案件付け替えのタイミングで fire-and-forget で呼ぶ（`syncBallHolderId` と同じ形）。
2. **紐付ける line の決定は `pickCreativeLineId()`（`utils/pricing.js`）に集約する。** 判定は「担当者の `rank_applied` 一致を最優先 → ランク一致が無ければ単価行を持つ候補が 1 つに絞れるときだけ採用 → それ以外は埋めない（null）」。**曖昧なら埋めない**のが原則で、誤った `line_id` は ADR 030 の単価解決を誤らせるため、NULL のままにして ADR 031 のフォールバックに任せるほうが安全。
3. **「今日」時点で有効な line から選ぶ。** 停止済み（`applies_to` が過去）のグループには新規紐付けしない。
4. **案件付け替えの取り残しを外す。** 解決できない場合でも、既存 `line_id` が「今の案件に属さない line」を指しているなら NULL にクリアする（ADR 030 Amendment で実在が確認された誤紐付け）。
5. **既存データは `scripts/backfill_creative_line_id.js` で埋める**（`--dry-run` 既定なし・冪等・`--all` で既紐付けも対象）。

### 併せて修正: `loadEstimateLinesForPricing` が `name` を取っていなかった

ADR 022 の後方互換（`rank` 列が NULL の旧 `project_rates` 移行 line は `name` の「動画 Aランク (旧 project_rates 移行)」でしかランクが判別できない）が、集計側では **select に `name` が無いため機能していなかった**。`name` を select に追加する。これにより旧データ案件のランク一致が復活し、ADR 030/031 の解決精度が上がる。

### 本番の適用結果（2026-08-04 時点）

- `line_id` が NULL の 242 件のうち **222 件が解決**、20 件は「案件に成果物グループが無い」ため未解決（案件側の単価登録が必要）。
- 既存の紐付けから**支払単価が変わるものは 0 件**（dry-run で確認）。

## Alternatives considered

- **A. 集計側は触らず、`creatives.line_id` のバックフィルだけ行う**: 表示は直るが、登録時に付与する仕組みが無い限り翌月また同じ状態に戻る。また既存 238 件の付け替えは ADR 030 で経験したような単価ズレ事故（リサイズ案件が別案件の ¥3,500 グループを掴む）を再発させうるので、表示の止血を先にするほうが安全。
- **B. `rate_unknown` の表示だけ消す**: 原因を隠すだけで金額は 0 のまま。集計が使えない。
- **C. 集計側でも ADR 005 の status フィルタを優先する（rank より status）**: 実装は単純だが、`draft` のまま運用されている B/C ランクの案件で別ランクの単価を計上する。今回の対象案件はたまたま全ランク同額（¥3,500）で実害が無かったが、ランク別単価の案件では誤請求につながるため採らない。
