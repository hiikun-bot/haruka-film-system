---
adr: 029
status: Accepted
date: 2026-07-03
tags: [estimate-lines, billing, invoices, hp, lp, installments, payment]
related_tables: [project_estimate_lines, line_payment_installments]
supersedes: null
superseded_by: null
related_adrs: [002, 004, 026, 028]
---

# 029. 一式成果物（HP/LP等）の分割支払スケジュール

- **Status**: Accepted
- **Date**: 2026-07-03
- **Decided by**: ユーザー（hiikun.ascs@gmail.com）

## Context

HP/LP 制作のような一式ものは「本数×単価」に馴染まず、システムに載らないため
2026年6月突合で約32.5万円が構造的差異になった（プレスト・ケアHP 29万・キャピタルLP 3.5万）。

ユーザー要件（2026-07-03）:
- HP/LP には**先払い（着手金）・後払い（納品後）**の概念がある。一括請求ならその限りではなく単価だけで良い
- 例: 60万円を 30万＋30万に分割し、着手前に30万・納品後に30万を渡す
- **「何月に30万円」と月を指定**でき、明細書・請求書に分かりやすく載ること
- 請求書上は「着手金」「納品完了分（2分の2）」のような**表記で判別できる**こと

## Decision

**一式カテゴリ（hp / lp / line 等）の成果物グループに「支払スケジュール
（line_payment_installments）」を持たせ、集計・請求・売上は分割行の対象月に計上する。**

### スキーマ（Stage 1 = migrations/2026-07-03_line_payment_installments.sql）

```sql
CREATE TABLE IF NOT EXISTS line_payment_installments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  line_id UUID NOT NULL REFERENCES project_estimate_lines(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL DEFAULT 1,          -- 分割の順番（1, 2, ...）
  total_count INTEGER NOT NULL DEFAULT 1,  -- 分割数（「2分の1」の2）
  label TEXT NOT NULL,                     -- 例: 着手金 / 中間金 / 納品完了分
  target_month DATE NOT NULL,              -- 計上月（月初日で保持。JST概念の年月）
  client_amount INTEGER NOT NULL DEFAULT 0,   -- クライアント請求分（円）
  payment_amount INTEGER NOT NULL DEFAULT 0,  -- 制作者支払分（円）
  payee_user_id UUID REFERENCES users(id),    -- 支払先（例: 片山）
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
```

### 運用ルール

1. **一括請求＝分割1行**（label「納品完了分」・seq 1/1）。「単価だけ設定したい」ケースは
   これで表現し、集計ロジックは常に installments のみを見る（分岐を作らない）
2. 分割の合計が一式金額（line.client_unit_price / 支払合計）と一致しない場合は UI で警告
3. 請求書明細の表記は「{line名} {label}（{seq}/{total_count}）」
   例: 「プレスト・ケアHP① 着手金（1/2）」
4. 支払先（payee_user_id）は分割行ごとに指定（通常は同一人物）
5. 対象月は本数系の「納品完了日」ではなく **target_month で明示指定**
   （着手金は納品前に発生するため。ADR 026 の delivered_at 基準の例外）

### Stage 2（コード）

- 案件編集 > 見積・費用: 一式カテゴリの line に「📅 支払スケジュール」セクション
  （行追加・ラベル/金額/対象月/支払先・合計不一致警告・一括ボタン=1行自動生成）
- /invoices/preview-items・/invoices/generate: 対象月の installments を
  is_installment アイテムとして表示・請求書化（表記ルール3）
- クリエイター別集計: 対象月の payment_amount を「一式」枠として合算
- 月次売上: client_amount を target_month の売上に計上

## Consequences

- HP/LP の着手金・残金が正しい月の請求書・売上に載り、構造的差異が解消する
- 本数系（動画/静止画）は従来どおりで影響なし
- installments と line の金額二重管理になるため、UI の合計チェックで整合を担保する

## Alternatives

- **A. line を分割数ぶん複製**（30万line×2）: 月指定・着手金表記が持てず却下
- **B. creative 単位の金額上書き（ADR 013）**: 納品前の着手金が表現できず却下
- **C. project_fixed_items の流用**: 経費/追加収入の概念であり、メンバー支払・
  請求書明細への導線が無いため却下
