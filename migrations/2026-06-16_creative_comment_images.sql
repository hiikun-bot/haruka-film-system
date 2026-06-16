-- 修正指示コメントへの画像添付（bug-report #008cc267）
--
-- 目的:
--   ディレクター/プロデューサー/クライアントが書く「修正指示・承認コメント」
--   (cd-director-note → creatives.director_comment) に画像を添付できるようにする。
--   デザインの「この部分」を文章で伝えにくいケースで、貼り付け/ファイル選択した
--   画像を一緒に保存・表示する。
--
-- 保存方式:
--   既存の tweets.image_data / bug_reports.screenshot_data_url と同じく
--   base64 data URL をそのまま DB に保存する（Supabase Storage / Drive は使わない）。
--   クライアント側で長辺リサイズ + JPEG 圧縮してから送るため 1枚あたり数百KB に収まる。
--   jsonb 配列 [{ "url": "data:image/...", "w": 1280, "h": 720 }, ...]。
--
-- 履歴:
--   creatives.director_comment が「前回/今回」履歴へスナップショットされるのと対称に、
--   creative_status_transitions に *_at_change として画像配列もスナップショットする。
--   これによりラウンド比較UIの「前回」コメントにも添付画像が残る。
--
-- 副作用:
--   純粋な列追加（IF NOT EXISTS）。既存行は空配列 / NULL で初期化され挙動は変わらない。

ALTER TABLE creatives
  ADD COLUMN IF NOT EXISTS director_comment_images jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE creative_status_transitions
  ADD COLUMN IF NOT EXISTS director_comment_images_at_change jsonb;

COMMENT ON COLUMN creatives.director_comment_images IS
  '修正指示・承認コメント(director_comment)に添付された画像の data URL 配列 [{url,w,h}]。bug-report #008cc267。';
COMMENT ON COLUMN creative_status_transitions.director_comment_images_at_change IS
  '遷移時点の creatives.director_comment_images スナップショット。ラウンド比較UIの前回コメント画像表示用。';
