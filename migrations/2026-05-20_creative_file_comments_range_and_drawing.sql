-- creative_file_comments: コメント時間範囲・ペイント画像・対応済みチェック
--
-- timecode_end: 範囲指定の終端タイムコード（NULL の場合は単点コメント＝従来挙動）
--               形式は既存 timecode と同じ ("HH:MM:SS:FF" または "MM:SS")。
--               シークバー上の葉アイコンを左右にドラッグして範囲を作った時に保存する。
-- drawing:      Frame.io 風ペイント（筆/矢印/四角/直線）の保存データ。
--               形式は { dataUrl: string, w: number, h: number } の JSONB。
--               dataUrl は PNG（透過、現在フレームと同じアスペクト比）。
--               コメント一覧で 🎨 アイコンを表示してクリックで再表示する。
-- resolved:     対応済みフラグ（Frame.io の Completed 相当）。コメント右端の ○ を
--               クリックすると true / false がトグルされる。
-- resolved_at:  対応済みにした時刻。
-- resolved_by:  対応済みにしたユーザー。表示用。

ALTER TABLE creative_file_comments
  ADD COLUMN IF NOT EXISTS timecode_end TEXT;

ALTER TABLE creative_file_comments
  ADD COLUMN IF NOT EXISTS drawing JSONB;

ALTER TABLE creative_file_comments
  ADD COLUMN IF NOT EXISTS resolved BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE creative_file_comments
  ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;

ALTER TABLE creative_file_comments
  ADD COLUMN IF NOT EXISTS resolved_by UUID REFERENCES users(id) ON DELETE SET NULL;

-- 範囲付きコメントだけを高速に絞り込めるよう partial index を張る
CREATE INDEX IF NOT EXISTS idx_cfc_timecode_end_not_null
  ON creative_file_comments ((timecode_end IS NOT NULL))
  WHERE timecode_end IS NOT NULL;

-- ペイント付きコメントだけを高速に絞り込めるよう partial index を張る
CREATE INDEX IF NOT EXISTS idx_cfc_drawing_not_null
  ON creative_file_comments ((drawing IS NOT NULL))
  WHERE drawing IS NOT NULL;

-- 未対応コメントの絞り込みを高速化（ファイル別の未対応件数バッジ用）
CREATE INDEX IF NOT EXISTS idx_cfc_unresolved
  ON creative_file_comments (creative_file_id)
  WHERE resolved = false;
