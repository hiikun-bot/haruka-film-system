-- migrations/2026-05-05_users_creative_default_filters.sql
-- メンバーごとに「クリエイティブ画面の初期表示状態」を保存する列を追加する。
-- 既存の default_creative_tab（共通/動画/デザインの種別タブ）に加えて、
-- ビュー / 表示モード / グルーピング / 期間 / 詳細フィルター（チェックボックス・ステータス・ボール種別）
-- の10種類の初期値をメンバーマスターで管理できるようにする。
--
-- すべて nullable。NULL のときはフロントエンドの既定値（ハードコード）にフォールバック。
--
-- 値の凡例（ALL は NULL 含む）:
--   creative_default_view              : 'all' / 'mine' / 'ball'
--   creative_default_view_mode         : 'gantt' / 'list'
--   creative_default_group_mode        : 'project' / 'client' / 'assignee' / 'team'
--   creative_default_range             : 'week' / '2week' / 'month' / '2month'
--   creative_default_include_ended     : BOOLEAN
--   creative_default_include_delivered : BOOLEAN
--   creative_default_delayed_only      : BOOLEAN
--   creative_default_sos_only          : BOOLEAN
--   creative_default_statuses          : JSONB（文字列配列。NULL = 全選択）
--   creative_default_ball_types        : JSONB（'editor'/'D'/'P'/'client' の配列。NULL = 全選択）
--
-- CHECK 制約はあえて付けない（将来選択肢が増える可能性。バリデーションはサーバ側）。
-- バックフィルなし: NULL のまま放置 → 既存ユーザーの体験は従来どおり（既定値で表示）。

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS creative_default_view              TEXT,
  ADD COLUMN IF NOT EXISTS creative_default_view_mode         TEXT,
  ADD COLUMN IF NOT EXISTS creative_default_group_mode        TEXT,
  ADD COLUMN IF NOT EXISTS creative_default_range             TEXT,
  ADD COLUMN IF NOT EXISTS creative_default_include_ended     BOOLEAN,
  ADD COLUMN IF NOT EXISTS creative_default_include_delivered BOOLEAN,
  ADD COLUMN IF NOT EXISTS creative_default_delayed_only      BOOLEAN,
  ADD COLUMN IF NOT EXISTS creative_default_sos_only          BOOLEAN,
  ADD COLUMN IF NOT EXISTS creative_default_statuses          JSONB,
  ADD COLUMN IF NOT EXISTS creative_default_ball_types        JSONB;
