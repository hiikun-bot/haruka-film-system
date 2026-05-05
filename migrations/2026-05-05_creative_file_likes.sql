-- ====================================================================
-- 2026-05-05 creative_file_likes: クリエイティブファイルへのタイムコード別いいね
-- ====================================================================
-- 本番500エラー修正:
--   GET /api/haruka/creative-files/{id}/likes が
--   "Could not find the table 'public.creative_file_likes' in the schema cache"
--   で失敗していた。routes/haruka.js の以下エンドポイントが参照しているテーブルが
--   supabase_schema.sql にも migrations/ にも存在しなかったため新規作成。
--
-- 参照箇所（routes/haruka.js:6168-6248）:
--   GET    /creative-files/:id/likes
--   POST   /creative-files/:id/likes  (upsert onConflict: creative_file_id,user_id,timecode_sec)
--   DELETE /creative-files/:fileId/likes/:likeId
--   GET    /likes/ranking
--   GET    /likes/ranking/users
--
-- スキーマ判断:
--   - timecode_sec: NUMERIC (Math.round(parseFloat(...) * 100) / 100 で小数2桁化)
--   - user_id: NOT NULL + ON DELETE CASCADE
--     （ranking/users で users(full_name) を直接読むため NULL は避ける。
--      ユーザー削除時はいいねも消えるのが自然。
--      コメント側は SET NULL だが、いいねは履歴より関連性重視で CASCADE 採用）
--   - UNIQUE (creative_file_id, user_id, timecode_sec) は upsert の onConflict 用
-- ====================================================================

CREATE TABLE IF NOT EXISTS creative_file_likes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creative_file_id UUID NOT NULL REFERENCES creative_files(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  timecode_sec NUMERIC(10, 2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (creative_file_id, user_id, timecode_sec)
);

-- パフォーマンス: ファイル単位の取得（GET /creative-files/:id/likes）が頻発
CREATE INDEX IF NOT EXISTS idx_cfl_creative_file_id ON creative_file_likes(creative_file_id);

-- パフォーマンス: ユーザー別ランキング集計
CREATE INDEX IF NOT EXISTS idx_cfl_user_id ON creative_file_likes(user_id);
