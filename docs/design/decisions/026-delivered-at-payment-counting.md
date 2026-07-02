---
adr: 026
status: Accepted
date: 2026-07-02
tags: [creatives, billing, invoices, analytics, payment]
related_tables: [creatives, creative_status_transitions]
supersedes: null
superseded_by: null
---

# 026. 支払い本数カウントの基準を「納品完了日時（delivered_at）」に変更する

- **Status**: Accepted
- **Date**: 2026-07-02
- **Decided by**: ユーザー（hiikun.ascs@gmail.com）

## Context

メンバーへの支払い額の元になる「当月納品本数」の集計（分析タブ クリエイター別集計 /
案件×担当者集計の delivered モード、および `/invoices/preview-items`）は、
これまで **`creatives.final_deadline`（最終締切日）** で対象月を判定していた。

そのため実請求（メンバーは「実際に納品した月」で請求書を書く）とズレる：

- 締切 6/30 のクリエイティブを 7/1 に納品完了にしても 6 月本数にカウントされる
- 逆に締切 7/1 のものを 6 月中に前倒し納品しても 7 月扱いになる
- 2026年6月分の実請求 PDF とシステム計算値の突合で、このズレが差額要因として顕在化した

また「納品完了日」を表す専用カラムが存在せず、以下が散在していた：

- `creative_status_transitions`（2026-05-09〜）: 全ステータス遷移の履歴。「→納品」の
  changed_at が実質の納品完了日時だが、集計からは参照されていない
- `force_delivered_at`: 納品完了モード（強制納品）のときのみ記録
- ADR 009 の `delivered_snapshot_at`: Accepted だが未実装

## Decision

**その月の最終日 23:59（JST）までに status が「納品」になったものだけを当月本数に
カウントする。** 例: 6月分 = 6/30 23:59 JST までに納品完了したもの。7/1 に納品完了に
なったものは 7 月分。

### 1. スキーマ（Stage 1 = migrations/2026-07-02_creatives_delivered_at.sql）

```sql
ALTER TABLE creatives ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_creatives_delivered_at
  ON creatives (delivered_at) WHERE delivered_at IS NOT NULL;
```

既存の納品済みデータは以下の優先順で backfill する：

1. `creative_status_transitions` の最後の「→納品」changed_at（実クリック時刻）
2. `force_delivered_at`
3. `final_deadline` を JST 0時として変換（履歴の無い古いデータ。従来カウントと同月を維持）
4. `updated_at`（最終保険）

### 2. 書き込み契機（Stage 2）

- 通常 PUT / 管理者強制変更 / 納品完了モードで status が「納品」**以外 → 納品** に
  遷移したとき `delivered_at = now()` をセット
- 「納品」から他ステータスに戻したら `delivered_at = NULL` にクリア
  （再納品時は再セット＝**最後に納品完了になった時刻**が正）
- 管理者・秘書はクリエイティブ詳細から `delivered_at` を手動補正できる。
  補正すればカウント月も変わる（月末の誤操作・深夜跨ぎの救済）

### 3. 集計側の参照切替（Stage 2）

- `aggregateCreatorSummary` / `aggregateCreativeByAssignee` の **delivered モード**の
  月判定を `final_deadline` → `delivered_at` に変更
- `/invoices/preview-items` の納品済みクリエイティブの月判定も `delivered_at` に変更
- 月境界は **JST** で判定する（`Date.UTC(year, month-1, 1) - 9h` 方式。
  feedback: 時間ロジックはJST明示に従い、`TZ=UTC` / `TZ=Asia/Tokyo` 両方でテスト）
- 「全件」モードの `created_at` 判定は変更しない

## Consequences

- 支払い集計がメンバーの実請求（実納品月ベース）と一致するようになる
- final_deadline は純粋な「締切」に戻り、締切遅れの検知（締切月 ≠ 納品月）も分析可能になる
- 月末〜月初の納品操作タイミングが支払い月を左右するため、運用ルール
  （「月内カウントしたいものは月末までに納品ステータスへ」）の周知が必要
- 2026-05-09 より前に納品済みの古いデータは実クリック時刻が残っていないため、
  final_deadline ベースの backfill となり従来集計と同月のまま（実害なし）

## Alternatives

- **A. creative_status_transitions を集計時に都度 JOIN**: 列追加不要だが、
  手動補正ができず（履歴の書き換えになる）、集計クエリも重くなるため却下
- **B. final_deadline 基準のまま運用でカバー**: 実請求とのズレが構造的に残るため却下
- **C. ADR 009 の delivered_snapshot_at と統合**: ADR 009 は担当者スナップショットが
  主目的で未実装。delivered_at は独立して先行導入し、ADR 009 実装時に
  snapshot 契機を delivered_at セットと同一トランザクションに揃える
