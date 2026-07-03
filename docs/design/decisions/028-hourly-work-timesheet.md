---
adr: 028
status: Accepted
date: 2026-07-02
tags: [work-hours, timesheet, hourly, billing, payment, secretary]
related_tables: [work_hour_entries, users, projects, project_estimate_lines]
supersedes: null
superseded_by: null
related_adrs: [004, 026, 027]
---

# 028. 作業時間報告（タイムシート）— 時給制の支払い・請求をシステムに取り込む

- **Status**: Accepted
- **Date**: 2026-07-02
- **Decided by**: ユーザー（hiikun.ascs@gmail.com）

## Context

時給で動くメンバーの精算が Google スプレッドシート「作業時間報告書」で行われており、
システムの支払い集計・請求プレビューに一切載らない（2026年6月突合で顕在化）。

- 秘書業（瀬川愛里 ¥1,600/h、南成美 ¥1,800/h、楢戸真奈実 ¥1,500/h 等）は**必ず時給**
- 案件に紐づく時給もある（ハビーのディレクション: 支払 ¥1,500/h・クライアント請求 ¥2,500/h。
  岡田寛子・川崎かおりが該当）
- ADR 004 の `pricing_type='hourly'` ＋ `line_costs.actual_hours` は存在するが、
  時間が累計1値で月別に持てず、クリエイティブ単位に按分できないため
  支払い集計（creator-summary）・請求プレビューから明示的に除外されている

既存スプレッドシートのフォーマット（ユーザー提示・これを正とする）:
日付／業務開始時間／業務終了時間／稼働時間(分)=自動計算／業務内容／立替経費／経費内容／
領収書あり(1,000円超は提出)、ヘッダに時給・合計勤務時間(h)・月給・経費合計・合計。

## Decision

**専用メニュー「⏱ 作業時間」を新設し、日別タイムシートをシステムで記録する。
月次合計（時給×時間＋立替経費）を支払い集計・請求書プレビューに「時間制」行として合算する。**

### 運用ルール（ユーザー決定）

1. 専用メニューからいつでも入力できる（本人入力）
2. admin/秘書/プロデューサー層が月単位で「確認済み」にでき、確認済み後は本人編集ロック
3. 秘書は必ず時給 → users に既定時給を持たせ、時給が設定されている人は
   メンバー画面等で「時給制（¥N/h・用途）」と分かるように表示する
4. 案件紐付きの時給（ハビー等）は行で案件を選択。支払時給・請求時給は案件側の
   時間制成果物グループから解決（支払 ¥1,500/h・請求 ¥2,500/h）
5. 稼働時間(分)は開始/終了から自動計算（手修正可）。小数第3位以下切り捨てで h 換算
6. 立替経費は経費内容・領収書チェック付きで行に記録し、月次合計に加算

### スキーマ（Stage 1 = migrations/2026-07-02_work_hour_entries.sql）

```sql
-- 時給制メンバーの明示（NULL = 時給制ではない）
ALTER TABLE users ADD COLUMN IF NOT EXISTS hourly_rate INTEGER;
ALTER TABLE users ADD COLUMN IF NOT EXISTS hourly_note TEXT;  -- 例: '秘書業'

CREATE TABLE IF NOT EXISTS work_hour_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  work_date DATE NOT NULL,
  start_time TIME,
  end_time TIME,
  minutes INTEGER NOT NULL CHECK (minutes >= 0),
  description TEXT,
  project_id UUID REFERENCES projects(id) ON DELETE SET NULL,  -- NULL = 秘書業等の案件非紐付き
  line_id UUID REFERENCES project_estimate_lines(id) ON DELETE SET NULL, -- 時間制lineの根拠
  hourly_rate_applied INTEGER,          -- 登録時点の支払時給スナップショット（円/h）
  client_hourly_rate_applied INTEGER,   -- 登録時点の請求時給スナップショット（案件紐付き時のみ）
  expense_amount INTEGER DEFAULT 0,
  expense_note TEXT,
  receipt_submitted BOOLEAN DEFAULT false,
  status TEXT DEFAULT 'draft',          -- draft | confirmed
  confirmed_by UUID REFERENCES users(id),
  confirmed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
```

- 月の判定は `work_date` の JST 月（ADR 026 と同じ考え方。DATE 型なのでズレなし）
- 単価は**行作成時にスナップショット**（`*_applied`）。後から時給を改定しても
  過去の記録は変わらない（「月末までの変更が正」運用と整合）
- 時間制の成果物グループは `pricing_type='hourly'` の line_cost（支払時給）を持ち、
  line.client_unit_price を**時間単価（円/h）として解釈**する（時間制 line のみ。ADR 027 の
  カテゴリ一致制約は同様に適用）

### 集計への反映（Stage 2）

- クリエイター別集計（/analytics/creator-summary）: 対象月の confirmed + draft 実績を
  「時間制」行として合算（hourly_amount = Σ minutes/60 × hourly_rate_applied、
  小数第3位以下切り捨て）。本数カウントとは別枠
- 請求書プレビュー（/invoices/preview-items）: 月次合計を時間明細
  （「秘書業 N.NNh × ¥1,600」等）として表示
- 月次売上: 案件紐付き実績の Σ 時間 × client_hourly_rate_applied を売上に計上
- 経費は支払合計にのみ加算（売上・粗利には含めない。立替のため）

## Consequences

- 秘書・時給ディレクションの精算がシステム内で完結し、スプレッドシート突合が不要になる
- 支払い集計と実請求の構造的差異（時給もの）が解消される
- メンバー画面で時給制メンバーが判別できるようになる
- 既存スプレッドシート運用からの移行期間中は二重入力になるため、移行月を決めて切り替える

## Alternatives

- **A. line_costs.actual_hours の月次化**: 列追加で月別配列を持つ案。lines の責務が肥大化
  し、経費・確認フローを持てないため却下
- **B. 時間チャージをクリエイティブとして登録**: 「6月分 15h」を creative 化する案。
  status フローや納品概念が時間に馴染まず却下
- **C. スプレッドシート同期**: 既存報告書を read して取り込む案。フォーマット崩れに弱く、
  確認フロー・単価スナップショットを持てないため却下（将来のインポート補助はあり得る）

## 改訂（2026-07-03 ユーザー指示）

1. **明細の案件は全案件から選択可**。時間制単価がある案件はその単価スナップショット、
   無い案件は「サポート先の記録」として紐付けのみ行い、金額は本人の既定時給で計算する
   （秘書の「ひげごろーさん支援」等に対応）
2. **行入力は案件を最初に選ぶ列順**。案件なし（既定時給）の選択肢は、対象メンバーが
   秘書の場合のみ「ひーくん（管理者サポート）※既定」と表示する（判定は閲覧者ではなく
   対象メンバー基準。自分のシートは実効ロール＝VIEW AS 対応）
3. **他メンバーのシート閲覧・月次確認・代理編集・メンバー切替は admin のみ**に変更
   （当初の admin/秘書/P層から縮小。秘書・P層は自分のシートのみ）。
   単価マスク（本人と admin のみ金額表示）は API 直叩き対策として維持
4. メンバー切替セレクタに**ロール絞り込み**を追加（全ロール/秘書/編集者/…）

## 改訂（2026-07-03 ユーザー指示・第2回）

**案件の時給登録の入口を💰内訳の外に出す。** 成果物グループ→内訳→コスト追加という深い導線は
わかりにくいため、案件編集モーダル「見積・費用」タブのディレクター費バーを
**「1本あたり／⏱ 時給」の切替式**に拡張する。

- 「⏱ 時給」を選ぶと支払時給（円/h）と請求時給（円/h・client_price 権限のみ）を入力できる
- 保存時、時間制 line（ロール固定 director の hourly line_cost を持つ line）を案件に1つ自動管理する。
  無ければ「ディレクション（時給）」グループを status=contracted で自動作成
- 請求時給は line.client_unit_price に保存（時間制 line の client_unit_price=円/h 解釈は本文どおり）
- 0円で解除。自動作成した専用グループが空（他コスト・紐付きクリエイティブ無し）ならグループごと削除
- データ表現は変更なし（line_costs 縦持ちのまま）。UI の入口だけ案件レベルに引き上げる
- 1本あたりの「全グループに反映」は時給行（hourly）を上書きしない
- メンバー個別の時給差（同一案件で人ごとに単価を変える）は従来どおり💰内訳から
  user_id 付き hourly コストで設定（whResolveProjectHourly が本人指定行を優先）

## 改訂（2026-07-03 ユーザー指示・第3回）

**明細の案件プルダウンは初期表示を「時給設定のある案件のみ」に絞る。**
全案件を並べると数十件になり選びにくいため（ユーザー報告）。

- 初期表示: 時間単価つきの案件（¥N/h 表示）＋「案件なし＝既定時給」のみ
- 最下部の「＋ 時給設定のない案件も表示（既定時給で記録）…」を選ぶと全案件に展開
  （第1回改訂の「サポート先の記録」ユースケースは展開操作で引き続き可能）
- 選択済みの時給なし案件（過去行）は絞り込み中でも option を個別に足して表示を維持する
