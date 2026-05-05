-- 案件にサブプロデューサー（複数）を設定できるようにする
-- 背景:
--   現状、Pチェックは projects.producer_id（1人）にしか頼めない。
--   秘書や同僚プロデューサーにPチェックを依頼するケースがあるため、
--   案件ごとに「Pチェック依頼可能者」を複数登録できるようにする。
--   クリエイティブ側で Pチェックへ進める確認ダイアログでこのリストから選ばせる。
--
-- データモデル:
--   projects.sub_producer_ids UUID[] DEFAULT '{}'
--   - users(id) を参照する UUID 配列（FK制約はPostgreSQLの仕様上、配列要素には付かない）
--   - サーバー側で users テーブル & 案件のチームメンバーシップで都度バリデーションする
--   - 空配列許容（デフォルト '{}'）
--
-- インデックス:
--   GIN インデックスで「あるユーザーをサブプロデューサーに含む案件」検索を高速化する
--   （クリエイティブ側Pチェック確認ダイアログ等で利用想定）
--
-- 関連:
--   サブディレクター機能（PR #216, #228, migrations/2026-05-03_project_sub_directors.sql）と
--   完全パラレルな実装。

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS sub_producer_ids UUID[] DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_projects_sub_producers
  ON projects USING GIN(sub_producer_ids);
