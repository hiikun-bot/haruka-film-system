-- 2026-06-16_msquare_project_id.sql
-- 素材広場 / 動画整理ツール: クライアント → 案件 → 解析動画 のフォルダ階層対応
--
-- 背景:
--   従来、AI 解析の適用 (auto-apply) は「素材広場ルート直下に AI 提案フォルダ
--   （例: ストリート占い四柱推命/ショート動画）を作り直してファイルを移動」していた。
--   このため、アップロード時にクライアント＋案件を選んで案件フォルダへ入れても、
--   解析適用でルート直下のタグフォルダへ移されてしまい、案件単位の整理ができなかった。
--
--   仕様変更:
--     - クライアント＋案件を指定したアップロードは、解析適用後も「その案件フォルダ直下」に
--       配置する（AI タグ階層は作らない）。ファイル名には撮影日を必ず含める。
--     - 案件未指定（自由アップロード）は従来どおり AI タグ階層へ配置する。
--
--   そのためにアップロード→解析適用が別リクエスト/非同期で跨いでも案件を引き継げるよう、
--   どの案件に紐づくアップロードかを行に永続化する project_id 列を追加する。
--
-- 影響:
--   - video_file_organization_tests.project_id : 解析対象 1 件が属する案件（任意）
--   - video_org_upload_sessions.project_id     : Resumable Upload セッションが属する案件
--                                                （complete 時に test 行へ引き継ぐ）
--   既存行は project_id = NULL（＝従来の自由アップロード扱い）。後方互換あり。
--   案件削除時は SET NULL（解析履歴・Drive 上のファイルは残す）。

ALTER TABLE video_file_organization_tests
  ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES projects(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_vfot_project
  ON video_file_organization_tests(project_id);

ALTER TABLE video_org_upload_sessions
  ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES projects(id) ON DELETE SET NULL;
