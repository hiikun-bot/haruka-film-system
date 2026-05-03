-- 案件にサブディレクター（複数）を設定できるようにする
-- 背景:
--   現状、Dチェックは projects.director_id（1人）にしか頼めない。
--   秘書や同僚ディレクターにDチェックを依頼するケースがあるため、
--   案件ごとに「Dチェック依頼可能者」を複数登録できるようにする。
--   クリエイティブ側で Dチェックへ進める確認ダイアログでこのリストから選ばせる。
--
-- データモデル:
--   projects.sub_director_ids UUID[] DEFAULT '{}'
--   - users(id) を参照する UUID 配列（FK制約はPostgreSQLの仕様上、配列要素には付かない）
--   - サーバー側で users テーブル & 案件のチームメンバーシップで都度バリデーションする
--   - 空配列許容（デフォルト '{}'）
--
-- インデックス:
--   GIN インデックスで「あるユーザーをサブディレクターに含む案件」検索を高速化する
--   （クリエイティブ側Dチェック確認ダイアログ等で利用想定）

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS sub_director_ids UUID[] DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_projects_sub_directors
  ON projects USING GIN(sub_director_ids);
