-- =====================================================================
-- パフォーマンス用インデックス追加 第2弾（頻出クエリの未インデックスパターン）
--
-- routes/haruka.js の実クエリを調査し、既存インデックス
-- （supabase_schema.sql・migrations/ 全体）でカバーできていない
-- フィルタ／ソートパターンのみを対象にした。
--
-- 1) creatives(final_deadline ASC NULLS LAST) WHERE status <> '納品'
--    想定クエリ:
--      SELECT ... FROM creatives
--      WHERE status <> '納品'
--      ORDER BY final_deadline ASC NULLS LAST;
--    用途:
--      - メインのクリエイティブ一覧 API（routes/haruka.js:5790-5804。
--        include_done なし・キーワード検索なしのデフォルト表示）
--    既存 idx_creatives_status_deadline (status, final_deadline) は
--    eq('status', ...) には効くが neq には効かない。納品済が大半を
--    占めるテーブルなので、稼働中だけを持つ部分インデックスにして
--    ソート込みで 1 本で返せるようにする。
--
-- 2) creatives(creative_type text_pattern_ops)
--    想定クエリ:
--      ... WHERE creative_type LIKE 'video_%';
--      ... WHERE creative_type LIKE 'design_%' OR creative_type IN ('lp','hp','line');
--    用途:
--      - 一覧 API の tab=video / tab=design フィルタ（routes/haruka.js:5797-5801）
--      - タブ件数カウント 3 本（routes/haruka.js:5955-5961, 5981-5984）
--    LIKE 前方一致は通常の btree では使えないため text_pattern_ops を指定。
--    等値（lp/hp/line）も同じインデックスで引ける。
--
-- 3) invoices(invoice_type, year, month)
--    想定クエリ:
--      SELECT ... FROM invoices
--      WHERE invoice_type = 'client' AND year = ? AND month = ?;
--      SELECT ... FROM invoices
--      WHERE invoice_type IS NULL AND year = ? AND month = ?;
--    用途:
--      - 月次の確定売上／確定原価集計（routes/haruka.js:4436-4456）
--    既存 idx_invoices_issuer_year_month (issuer_id, year, month) では
--    invoice_type 起点の集計をカバーできない。btree は IS NULL 検索にも効く。
--
-- 4) invoices(created_at DESC)
--    想定クエリ:
--      SELECT * FROM invoices ORDER BY created_at DESC;
--    用途:
--      - 請求書一覧 API（routes/haruka.js:10609。フィルタ無し時は全件ソート）
--    ソート列のインデックスが無く、毎回全件ソートになっていた。
--
-- 5) tweet_comments(user_id) WHERE deleted_at IS NULL
--    想定クエリ:
--      SELECT tweet_id FROM tweet_comments
--      WHERE user_id = ? AND deleted_at IS NULL;
--    用途:
--      - つぶやき mine フィルタの「自分が参加したコメント」集合
--        （routes/haruka.js:11953）
--    既存は idx_tweet_comments_tweet (tweet_id, created_at) と
--    mentioned_user_ids の GIN のみで user_id 起点が未索引。
--    論理削除済みを除いた部分インデックスにして小さく保つ。
--
-- 対象外にしたもの:
--   - creatives.status の neq 用の単独追加: 1) の部分インデックスで
--     ソートまで含めてカバーされるため不要。
--   - invoices.status: 一覧 API でフィルタに使われるが、常に
--     issuer_id / year / month と併用されるため既存複合で十分。
-- =====================================================================

-- 1) 稼働中クリエイティブ一覧（neq('status','納品') + final_deadline ソート）
CREATE INDEX IF NOT EXISTS idx_creatives_active_final_deadline
  ON creatives (final_deadline ASC NULLS LAST)
  WHERE status <> '納品';

-- 2) creative_type の LIKE 前方一致（tab=video / tab=design・タブ件数）
CREATE INDEX IF NOT EXISTS idx_creatives_creative_type_pattern
  ON creatives (creative_type text_pattern_ops);

-- 3) 月次売上・原価集計（invoice_type + year + month）
CREATE INDEX IF NOT EXISTS idx_invoices_type_year_month
  ON invoices (invoice_type, year, month);

-- 4) 請求書一覧の created_at DESC ソート
CREATE INDEX IF NOT EXISTS idx_invoices_created_at
  ON invoices (created_at DESC);

-- 5) つぶやき mine フィルタ（user_id 起点・論理削除除外）
CREATE INDEX IF NOT EXISTS idx_tweet_comments_user_active
  ON tweet_comments (user_id)
  WHERE deleted_at IS NULL;

NOTIFY pgrst, 'reload schema';
