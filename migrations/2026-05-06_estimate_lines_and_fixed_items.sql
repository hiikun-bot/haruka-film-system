-- =====================================================
-- Estimate Lines & Fixed Items (Stage 1: ADR 002+004+005+006 統合 / migration のみ)
-- =====================================================
-- このPRは「テーブル新設・列追加」のみを行う。データ移行・コード書き換え・UI切替は
-- 後続 Stage で扱う（Stage 2: 旧 8 テーブルからのデータ移行 / Stage 3: 計算ロジック /
-- Stage 4: UI / Stage 5: 旧参照除去 / Stage 6: 旧テーブル DROP）。
--
-- 関連 ADR:
--   - ADR 002: docs/design/decisions/002-estimate-lines-unify-deliverable-rates.md
--     見積行（クライアント請求）と deliverable（納品物）を一本化する縦持ちテーブル
--   - ADR 003: docs/design/decisions/003-roles-as-master-data.md
--     line_costs.role_id は roles マスタ参照（PR #310 で適用済）
--   - ADR 004: docs/design/decisions/004-pricing-extensibility.md
--     currency / pricing_type / percentage / actual_hours の拡張ポイント
--   - ADR 005: docs/design/decisions/005-estimate-deliverable-lifecycle.md
--     status (draft/estimated/contracted/in_progress/delivered/cancelled/rejected)
--   - ADR 006: docs/design/decisions/006-project-fixed-costs.md
--     スタジオ・機材・出張費等の本数非依存「案件固定費」を扱う表
--
-- 参考migration:
--   migrations/2026-05-05_creative_categories.sql
--   migrations/2026-05-06_roles_master.sql
--
-- 冪等性:
--   CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS
--   を徹底。再実行しても破壊しない。
--
-- 原子性:
--   全体を BEGIN ... COMMIT でラップ。途中失敗時は完全ロールバック。
--
-- 本番影響:
--   - 新規テーブル 3 つ作成（FK 先 projects/creative_categories/roles/users はすべて存在済）
--   - 既存テーブル creatives / invoice_items に NULL 許容列追加（短時間の AccessExclusiveLock）
--   - データ INSERT は行わない（旧 rates 系の移行は Stage 2 で別 migration で実施）
-- =====================================================

BEGIN;

-- -----------------------------------------------------
-- 1) project_estimate_lines : 見積行 / deliverable 統合（ADR 002 + 004 + 005）
-- -----------------------------------------------------
-- ADR 002 の中核テーブル。1 行 = 1 見積項目 = 1 deliverable 群（planned_count 本）。
--
-- 列の役割:
--   - project_id    : どの案件の見積行か（必須）
--   - category_id   : どのクリエイティブカテゴリ（動画/静止画/HP/LP/LINE）か。
--                     カテゴリ非依存の見積（例: 戦略コンサル枠）の場合 NULL も許容。
--   - name          : 任意ラベル「フェーズ1ショート」「メインカット」等。UI 表示用。
--   - planned_count : 本数。納品物が増えたら +1 する。
--   - client_unit_price : クライアント請求の単価（円換算後の値、currency と整合）。
--   - sort_order    : 案件モーダル内での並び順。
--   - currency      : ADR 004 通貨拡張。当面 'JPY' 固定だが列だけ用意。
--   - tax_included  : ADR 004 税込/税抜。当面 TRUE 既定。
--   - status        : ADR 005 ライフサイクル
--                       draft       : 入力中（未提出）
--                       estimated   : 見積提出済（受注未確定）
--                       contracted  : 受注（deliverable 化）
--                       in_progress : 制作進行中
--                       delivered   : 納品済
--                       cancelled   : 取り消し（受注後キャンセル）
--                       rejected    : 失注（見積却下）
--   - status_changed_at : status を最後に変えた時刻。集計・履歴用。
--
-- INDEX:
--   - project_id 単独 / status 単独 / category_id 単独。
--   - 案件詳細の lookup（project_id + status）はカード少のため compound 不要、
--     単独インデックスで十分。必要になったら Stage 3 以降で追加検討。
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS project_estimate_lines (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id         UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  category_id        UUID REFERENCES creative_categories(id),
  name               TEXT,
  planned_count      INTEGER NOT NULL DEFAULT 0,
  client_unit_price  INTEGER NOT NULL DEFAULT 0,
  sort_order         INTEGER,
  currency           CHAR(3) NOT NULL DEFAULT 'JPY',
  tax_included       BOOLEAN NOT NULL DEFAULT TRUE,
  status             TEXT NOT NULL DEFAULT 'draft',
  status_changed_at  TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pel_project  ON project_estimate_lines(project_id);
CREATE INDEX IF NOT EXISTS idx_pel_status   ON project_estimate_lines(status);
CREATE INDEX IF NOT EXISTS idx_pel_category ON project_estimate_lines(category_id);
ALTER TABLE project_estimate_lines ENABLE ROW LEVEL SECURITY;

-- -----------------------------------------------------
-- 2) project_estimate_line_costs : 見積行 × ロール別コスト（ADR 002 + 003 + 004）
-- -----------------------------------------------------
-- 1 line に対して、複数のロール（プロデューサー/ディレクター/編集者…）の
-- コスト行を縦持ちで保持する。
--
-- ADR 003 に基づき role_id は roles(id) FK（TEXT enum ではない）。
-- ADR 004 に基づき pricing_type で課金方式を選べるようにする。
--
-- 列の役割:
--   - line_id       : 親見積行（必須）
--   - role_id       : どのロールへの支払いか（必須、roles マスタ参照）
--   - user_id       : 特定担当者宛なら指定。ロール固定額でユーザー未確定なら NULL。
--   - unit_price    : 単価（pricing_type に応じた解釈）
--   - currency      : ADR 004。'JPY' 既定。
--   - pricing_type  : 課金方式（ADR 004）
--                       'fixed_per_unit' : 1 本あたり固定額（既定）
--                       'percentage'     : クライアント請求の % 歩合
--                       'hourly'         : 時間単価 × actual_hours
--                       'fixed_total'    : line 全体で固定総額（本数によらない）
--   - percentage    : pricing_type='percentage' のとき 0-100 の値（NUMERIC(5,2)）
--   - actual_hours  : pricing_type='hourly' のとき実工数（NUMERIC(8,2)）
--
-- UNIQUE(line_id, role_id, user_id):
--   同一 line × 同一 role × 同一 user は 1 行のみ。
--   user_id NULL は「ロール固定枠」を表し、user_id 指定行と共存可。
--   PostgreSQL の UNIQUE は NULL 同士を別物とみなすため、
--   NULL の row が複数できないよう運用注意（必要なら Stage 3 で部分 UNIQUE INDEX 化）。
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS project_estimate_line_costs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  line_id       UUID NOT NULL REFERENCES project_estimate_lines(id) ON DELETE CASCADE,
  role_id       UUID NOT NULL REFERENCES roles(id),
  user_id       UUID REFERENCES users(id),
  unit_price    INTEGER NOT NULL DEFAULT 0,
  currency      CHAR(3) NOT NULL DEFAULT 'JPY',
  pricing_type  TEXT NOT NULL DEFAULT 'fixed_per_unit',
  percentage    NUMERIC(5,2),
  actual_hours  NUMERIC(8,2),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (line_id, role_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_pelc_line ON project_estimate_line_costs(line_id);
CREATE INDEX IF NOT EXISTS idx_pelc_role ON project_estimate_line_costs(role_id);
CREATE INDEX IF NOT EXISTS idx_pelc_user ON project_estimate_line_costs(user_id);
ALTER TABLE project_estimate_line_costs ENABLE ROW LEVEL SECURITY;

-- -----------------------------------------------------
-- 3) project_fixed_items : 案件固定費・固定収入（ADR 006）
-- -----------------------------------------------------
-- 「本数に依存しない」案件固定の費用や追加収入を扱う。
--   例: スタジオレンタル / 機材費 / 出張費 / ロケ地代 / 別料金収入 etc.
-- estimate_lines 側に擬似カテゴリで混ぜると本数 × 単価ロジックが歪むため別表で持つ。
--
-- 列の役割:
--   - item_type      : 'expense' | 'revenue'
--   - category       : 'studio' | 'equipment' | 'travel' | 'location' | 'other'
--                      （文字列のまま保持。Stage 後期にマスタ化検討）
--   - amount         : 金額（円換算後）
--   - currency       : ADR 004。'JPY' 既定。
--   - occurred_on    : 発生日（精算月の判定に使う）
--   - paid_to        : 外部支払先テキスト（フリーテキスト）
--   - paid_to_user_id: 内部メンバーへの支払いの場合に指定
--   - status         : 'planned' | 'committed' | 'incurred' | 'cancelled'
--                        planned   : 予定（見積段階）
--                        committed : 発注確定
--                        incurred  : 実費発生
--                        cancelled : 中止
--   - notes          : 自由記述メモ
--   - created_by     : 入力したユーザー（監査用）
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS project_fixed_items (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  item_type       TEXT NOT NULL,
  category        TEXT,
  name            TEXT NOT NULL,
  amount          INTEGER NOT NULL DEFAULT 0,
  currency        CHAR(3) NOT NULL DEFAULT 'JPY',
  occurred_on     DATE,
  paid_to         TEXT,
  paid_to_user_id UUID REFERENCES users(id),
  status          TEXT NOT NULL DEFAULT 'planned',
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by      UUID REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_pfi_project ON project_fixed_items(project_id);
CREATE INDEX IF NOT EXISTS idx_pfi_status  ON project_fixed_items(status);
ALTER TABLE project_fixed_items ENABLE ROW LEVEL SECURITY;

-- -----------------------------------------------------
-- 4) creatives.line_id : 納品物がどの見積行に紐づくか（ADR 002）
-- -----------------------------------------------------
-- ADR 002 の双方向参照を成立させるため、creatives 側にも line_id 列を追加。
-- NULL 許容（既存 creatives は当面 NULL のまま、Stage 2 以降で line を紐付けていく）。
-- ON DELETE は明示しない（既定の NO ACTION）。creative の親 line を消す側は
-- アプリ側で handling する想定。誤って line ごと吹き飛ばさないため CASCADE は付けない。
-- -----------------------------------------------------
ALTER TABLE creatives
  ADD COLUMN IF NOT EXISTS line_id UUID REFERENCES project_estimate_lines(id);
CREATE INDEX IF NOT EXISTS idx_creatives_line_id ON creatives(line_id);

-- -----------------------------------------------------
-- 5) invoice_items.line_id : 請求項目がどの見積行に紐づくか（ADR 002）
-- -----------------------------------------------------
-- 既存の invoice_items.creative_id と並走させる（dual-read 期間）。
-- Stage 2 以降で line ベースに集計を寄せ、Stage 5 で creative_id を deprecate 予定。
-- NULL 許容（既存 invoice_items は当面 NULL のまま）。
-- -----------------------------------------------------
ALTER TABLE invoice_items
  ADD COLUMN IF NOT EXISTS line_id UUID REFERENCES project_estimate_lines(id);
CREATE INDEX IF NOT EXISTS idx_invoice_items_line_id ON invoice_items(line_id);

-- -----------------------------------------------------
-- 6) PostgREST にスキーマリロード通知
-- -----------------------------------------------------
NOTIFY pgrst, 'reload schema';

COMMIT;

-- =====================================================
-- 検証クエリ（適用後に手動で実行）
-- =====================================================
-- -- 新テーブル 3 つが存在すること
-- SELECT table_name FROM information_schema.tables
--  WHERE table_schema='public'
--    AND table_name IN ('project_estimate_lines','project_estimate_line_costs','project_fixed_items')
--  ORDER BY table_name;
--
-- -- 既存 2 テーブルへ line_id 列が追加されていること
-- SELECT table_name, column_name FROM information_schema.columns
--  WHERE table_schema='public' AND column_name='line_id'
--    AND table_name IN ('creatives','invoice_items');
--
-- -- INDEX 確認
-- SELECT indexname FROM pg_indexes
--  WHERE schemaname='public'
--    AND indexname IN (
--      'idx_pel_project','idx_pel_status','idx_pel_category',
--      'idx_pelc_line','idx_pelc_role','idx_pelc_user',
--      'idx_pfi_project','idx_pfi_status',
--      'idx_creatives_line_id','idx_invoice_items_line_id'
--    )
--  ORDER BY indexname;
--
-- -- FK 整合性（roles / projects / creative_categories / users が見えていること）
-- SELECT conname, conrelid::regclass AS table_name, confrelid::regclass AS ref_table
--   FROM pg_constraint
--  WHERE contype='f'
--    AND conrelid::regclass::text IN (
--          'project_estimate_lines','project_estimate_line_costs','project_fixed_items'
--        )
--  ORDER BY 2, 1;

-- =====================================================
-- ロールバック手順（手動）
-- =====================================================
-- BEGIN;
--   ALTER TABLE invoice_items DROP COLUMN IF EXISTS line_id;
--   ALTER TABLE creatives     DROP COLUMN IF EXISTS line_id;
--   DROP TABLE IF EXISTS project_fixed_items;
--   DROP TABLE IF EXISTS project_estimate_line_costs;
--   DROP TABLE IF EXISTS project_estimate_lines;
-- COMMIT;
