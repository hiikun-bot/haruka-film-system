---
adr: 009
status: Accepted
date: 2026-05-08
tags: [creatives, projects, billing, invoices, snapshot, history]
related_tables: [creatives, creative_assignments, projects, invoices]
supersedes: null
superseded_by: null
---

# 009. クリエイティブ納品時の担当者スナップショット（director / producer 履歴保全）

- **Status**: Accepted
- **Date**: 2026-05-08
- **Decided by**: ユーザー（hiikun.ascs@gmail.com）

## Context

案件の途中でディレクターやプロデューサーが退職・交代することがある。実運用で
頻発するシナリオなのに、現状の集計・請求ロジックは「いま」の `projects.director_id` /
`projects.producer_id` を直接参照しているため、過去に納品済みのクリエイティブの
件数・取り分・請求金額が遡及的に書き換わる。

### 現状の参照経路（バグに近い設計）

- `aggregateCreatorSummary` ([routes/haruka.js:2729](../../../routes/haruka.js#L2729))
  - L2831-2836: `code === 'director'` / `'producer'` の line_cost は creative_assignments を
    無視して **`creative.projects.director_id` / `producer_id` に直接フォールバック**。
  - 「ディレクター別 当月件数 / 取り分」「プロデューサー別 当月件数 / 取り分」が
    projects 側を書き換えた瞬間に変動する。
- `/invoices/preview-items` ([routes/haruka.js:5747](../../../routes/haruka.js#L5747))
  - L5800-5801: `isDirector = c.projects?.director_id === uid` で「自分が
    プロデューサー / ディレクターの案件」を判定 → `directorFee` / `producerFee` を加算。
  - 納品済みクリエイティブでも同じ経路。projects を書き換えると過去の preview にも影響。
- `/invoices/generate` ([routes/haruka.js:7513](../../../routes/haruka.js#L7513))
  - 同様に projects.director_id / producer_id を参照して invoice_items を生成する。
  - **`invoices` テーブルに insert された後の数値は固定** だが、insert される前の
    「未請求の納品済みクリエイティブ」は projects 書き換えの影響を受ける。

### creative_assignments の現状

PR #218 / PR #362 で `creative_assignments` に `role='director'` / `role='producer'` を
複数 INSERT できるようになったが、これは現在 **「Dチェック / Pチェックを依頼する宛先」**
としてのみ使われており、**集計・請求では参照されていない**（resolvePayee は projects に
フォールバックするだけ）。

## Decision

**クリエイティブが `status='納品'` に遷移した瞬間、その時点での
ディレクター / プロデューサーを `creatives` テーブルに UUID 配列でスナップショットし、
以降の集計・請求はスナップショット側を見るようにする。**

### スキーマ追加

```sql
ALTER TABLE creatives
  ADD COLUMN delivered_director_ids UUID[],
  ADD COLUMN delivered_producer_ids UUID[],
  ADD COLUMN delivered_snapshot_at  TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_creatives_delivered_director_ids
  ON creatives USING GIN (delivered_director_ids);
CREATE INDEX IF NOT EXISTS idx_creatives_delivered_producer_ids
  ON creatives USING GIN (delivered_producer_ids);
```

- `delivered_director_ids` / `delivered_producer_ids` は **UUID 配列**
  （Dチェック / Pチェック複数担当に対応するため。1名の場合も 1 要素配列）。
- `delivered_snapshot_at` は監査用。「いつスナップショットしたか」を保持。
- 配列 NULL = まだ納品されていない（または backfill 未実施の遺物）。
  既存の納品済みデータは migration 内でバックフィルする。

### スナップショット契機

`PUT /api/creatives/:id` ([routes/haruka.js:3741](../../../routes/haruka.js#L3741)) で
`status` が **「納品」以外 → 「納品」** に遷移したとき、トランザクション内で
スナップショットを書き込む。

- `delivered_director_ids` の決定順序:
  1. `creative_assignments` で role='director' のレコードがあれば、その user_id 集合
  2. なければ `[projects.director_id]`（NULL なら空配列 `[]`）
- `delivered_producer_ids` も同様 (`role='producer'` → fallback `[projects.producer_id]`)。
- `delivered_snapshot_at = now()`。

**再納品（差し戻し → 再「納品」）した場合** は **既存スナップショットを上書きしない**。
最初に納品が確定したときの担当者で固定する（経理が一度確定した数字を尊重するため）。
やり直したいときは admin 用の手動再スナップショット API は将来必要になれば作る。

`force_delivered`（途中工程をスキップして納品）の場合も同じ経路でスナップショットする。

### 集計・請求での参照変更

| 関数 / エンドポイント | 変更内容 |
|---|---|
| `aggregateCreatorSummary` | `status='納品'` の creative については `delivered_director_ids` / `delivered_producer_ids` を参照。納品前は従来通り projects フォールバック。 |
| `/invoices/preview-items` | 納品済み creative の director / producer 判定で `delivered_*_ids.includes(uid)` を優先。納品前は projects.director_id を見る。 |
| `/invoices/generate` | preview-items と同じ。生成時に `delivered_*_ids` を参照することで、生成タイミングが projects 書き換え後でも納品時点の担当者で請求できる。 |

`creative_assignments` の director / producer ロール (= Dチェック / Pチェック宛先) は
**通知用途として独立に維持**。集計・請求では納品スナップショットを正とする。

### Backfill

migration の同一トランザクション内で、既存の `status='納品'` クリエイティブに対して:

```sql
UPDATE creatives c
SET delivered_director_ids = COALESCE(
      (SELECT array_agg(DISTINCT ca.user_id)
         FROM creative_assignments ca
        WHERE ca.creative_id = c.id AND ca.role = 'director' AND ca.user_id IS NOT NULL),
      ARRAY[p.director_id]::uuid[]
    ),
    delivered_producer_ids = COALESCE(
      (SELECT array_agg(DISTINCT ca.user_id)
         FROM creative_assignments ca
        WHERE ca.creative_id = c.id AND ca.role = 'producer' AND ca.user_id IS NOT NULL),
      ARRAY[p.producer_id]::uuid[]
    ),
    delivered_snapshot_at = COALESCE(c.force_delivered_at, c.updated_at, now())
FROM projects p
WHERE c.project_id = p.id
  AND c.status = '納品'
  AND c.delivered_director_ids IS NULL;
```

NULL 要素は array_remove で除く（director_id が NULL の案件があるため）。

## Consequences

### Pros
- 案件の途中でディレクター / プロデューサーを交代しても、**過去の納品済み
  クリエイティブの件数・取り分・請求金額は不変**。
- 経理が遡及的に「先月の件数が変わった」「先月の請求が変わった」と困惑しない。
- 退職者がいた月の集計が、退職処理と連動して書き換わる事故を防げる。
- creative_assignments の director / producer ロール（D/P チェック宛先）と、
  実際の集計対象（納品スナップショット）を **役割分離**。Dチェック宛先を変えても
  納品済みの集計は変わらない、という直感に沿う。

### Cons / Trade-offs
- creatives テーブルに 3 列追加（UUID[] 2 + timestamptz 1）。GIN index 2 つ。
  納品クリエイティブ数 × 数バイトのストレージ増。許容範囲。
- 「納品確定後にディレクターを差し替える」ニーズが出たら、admin 用の
  再スナップショット API が必要になる（現時点では不要）。
- `aggregateCreatorSummary` の resolvePayee 分岐が「納品済 vs 未納品」で
  2 経路になる。複雑度は微増。

### 旧経路（projects.director_id 直接参照）の扱い

- 未納品クリエイティブの集計は **projects.director_id 経路を維持**
  （未納品案件の取り分予測はその瞬間の担当者を反映するのが自然）。
- 納品済み 1 件の請求書を `invoices` に insert したらその時点で確定するのは現状通り。
- 旧 `project_director_rates` / `project_producer_rates` テーブル本体は ADR 002 Stage 6
  で DROP 予定。本 ADR は単価テーブル統廃合とは独立。

## Alternatives Considered

### A. creative_assignments を集計・請求の正にする（projects フォールバック撤廃）
- creative_assignments に role='director' / 'producer' を必ず INSERT し、
  resolvePayee はそこだけ見る。
- ❌ 既存の数万件の creative に backfill が必要（同じ）。さらに「Dチェック宛先」と
  「集計対象ディレクター」を creative_assignments の中で区別する列が要る
  （例: `is_billing_target BOOLEAN`）。役割が混ざって設計が複雑になる。
- ❌ 「納品時点で固定する」セマンティクスを持たせるには結局 frozen フラグが要り、
  本案の delivered_*_ids[] と等価なものを作ることになる。

### B. invoice_items / aggregation_log の発行履歴テーブルだけで担保する
- 過去の数字は invoice_items に insert された瞬間に固定されるので、それで足りる
  という見方もある。
- ❌ creator-summary は invoice 発行前に「先月の件数 / 取り分」を表示する画面で、
  invoice 発行前に projects.director_id が変わると数字が動く問題は解決しない。
- ❌ そもそも経理は「invoice 発行前にプレビューで担当別件数を確認する」ため、
  プレビュー段階で固定されている必要がある。

### C. projects.director_id の変更を禁止する
- 過去データが動く問題は防げるが、退職・交代という現実の運用ニーズに反する。却下。

## Migration / Rollout

1. **Phase 1 (この ADR の PR)**: スキーマ追加 + backfill + スナップショット書き込み +
   読み取り経路切り替え（aggregateCreatorSummary / preview-items / invoices/generate）。
2. **Phase 2 (将来)**: 必要なら admin 用「納品スナップショット再計算」API。
3. **Phase 3 (将来)**: `delivered_*_ids` を活用したレポート（「退職者が納品した分の
   未請求残高」等）。本 ADR の射程外。

## Related

- ADR 002（見積行統合・成果物単価）: 集計対象 line_costs の話。本 ADR と独立。
- ADR 008（リーダー≠役職）: チーム単位の連絡窓口の話。本 ADR は creative 単位。
- PR #218 / #362: creative_assignments の director / producer 複数担当対応。
  本 ADR はその拡張ではなく、**集計・請求の参照先を新設のスナップショット列に切り替える** 変更。

## 改訂・実装（2026-07-03）

ユーザー決定「D費は案件ごとに固定のディレクターへ。**作成して納品したタイミングで、
その時マスターに登録されているディレクターに費用を分配する（納品のタイミングでコミット）**。
途中でディレクターが変わったタイミングが分かるように記録する」を受けて実装開始。

- Stage 1: `delivered_director_ids` / `delivered_producer_ids` / `delivered_snapshot_at` を追加、
  納品済みは現在の projects.director_id / producer_id で backfill
- Stage 2: 納品遷移時（通常PUT / 管理者強制変更 / 納品完了モード）にスナップショット書き込み、
  納品から差し戻したらクリア。集計（creator-summary 等）・請求プレビュー/生成の
  director 解決を「スナップショット優先 → projects.director_id フォールバック」に切替
- P費は支払い対象外（2026-07-02 決定）のため、producer スナップショットは担当記録としてのみ保持
- ディレクター交代の履歴は、納品クリエイティブごとのスナップショットとして自然に残る
