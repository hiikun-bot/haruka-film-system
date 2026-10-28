---
adr: 053
status: Accepted
date: 2026-10-28
tags: [billing, invoices, installments, monthly-fee, projects]
related_tables: [creative_categories, project_estimate_lines, project_estimate_line_costs, line_payment_installments]
supersedes: null
superseded_by: null
related_adrs: [028, 029, 037, 046]
---

# 053. 月額定額の案件（毎月決まった額で請求する）

- **Status**: Accepted
- **Date**: 2026-10-28
- **Decided by**: ユーザー（hiikun.ascs@gmail.com）

## Context

同じクライアントのディレクションでも、ある人は時給（時間給作業・ADR 028）、別の人は
**毎月決まった額の定額** で請求したいケースが出てきた（2026-10-28 Chatwork 相談）。
これまで HFS には「本数×単価」「時給×時間」「一式の分割（ADR 029）」しかなく、
毎月同じ額を請求する形を案件として登録できなかった。

## Decision

**案件カテゴリ「月額定額」(code='monthly_fixed') を追加し、案件作成モーダルで
支払先・月額（支払）・月額（請求）・期間（開始月〜終了月）を入れると、
期間の各月に ADR 029 の分割支払行（line_payment_installments）を自動で作る。**

- 新しい表は作らない。分割支払の行は既に請求書（旧方式の preview/generate・新方式の請求書エディタ）、
  クリエイター別集計、月次売上に載る経路があるので、それに乗せる
- 支払先ごとに専用グループ「月額定額（◯◯）」を1つ持つ。line_cost は `user_id=支払先`・
  `pricing_type='fixed_total'`・`unit_price=月額`（支払先の目印。本数集計では fixed_total は按分しないので二重計上しない）
- 各月の行の label は「YYYY年M月分」。請求書の表記は「{クライアント}／{案件} 月額定額（{支払先}） 2026年10月分」で、
  （seq/N）は付けない。請求書の種別ラベルは「月額定額」
- 保存 API: `PUT /projects/:id/monthly-fee`（`project.create_edit` / `project.pricing_edit` のどちらか）。
  ディレクターが自分で登録できる（定額で請求する本人が案件追加から登録する想定）。ADR 037 の承認フローに乗り、
  承認権限のない人の登録は「承認待ち」＋admin へ通知
- 月額（請求）は `project.client_price` 権限のある人だけ入力・閲覧できる（ADR 015）
- **変更しても先月以前の行は書き換えない**（請求済みの月を遡って変えない）。今月以降の行だけ作り直す。
  月額 0 で保存すると今月以降を解除する（先月以前は残る）
- 期間は最大 36 か月（分割支払の上限）。延長は終了月を延ばして保存する

## Consequences

- 定額契約の案件を案件追加から登録でき、期間中は毎月の請求書作成画面に「◯年◯月分」として自動で並ぶ
- 同じクライアントで時給の人（時間給作業）と定額の人（月額定額）を別案件で並べられる
- 1案件に複数の支払先を持てる（支払先を切り替えて保存）。モーダルでは1人分ずつ表示する

## Alternatives

- **A. 専用テーブル（project_monthly_fees）を作り、集計時に期間から月を展開**: 請求書・集計・売上の
  3経路すべてに新しい分岐が要る。分割支払の行で表現できるので却下
- **B. 作業時間報告に「定額」行を毎月手入力**: 毎月の手作業が残り、入れ忘れが起きるので却下
- **C. 時間給作業カテゴリに「定額」切替を足す**: 時給の作業時間画面と結びついていて意味が混ざるので却下
