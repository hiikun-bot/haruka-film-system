-- 🏦 ADR 054（PR #1279 レビュー #2）: 同じ振込レコードに対する「有効な明細」を DB で 1 件に制限する
--
-- 背景:
--   依頼 API のダブルクリック（同じ preview_token の同時 2 リクエスト）は、アプリ層の「同月の未確定明細があれば除外」
--   が read-before-insert のため、2 つの batch（別の冪等キー）を作れてしまう。
--   payout_transfer_items(payout_record_id) に部分ユニークインデックスを張り、status が pending / completed の明細は
--   1 つの振込レコードにつき 1 件しか INSERT できないようにする（先に INSERT した側だけが銀行への送信に進む）。
--   batch が expired / cancelled / failed になるときはアプリが pending の明細を failed に落とすので、その後は再依頼できる。
--   returned / failed の明細はインデックスの対象外（＝再依頼できる）。
--
-- 冪等: CREATE UNIQUE INDEX IF NOT EXISTS。2回流しても落ちない。
-- 既存データに pending/completed の重複があると失敗する（Stage B 稼働前なので無い前提）。
-- 本番Supabaseへの適用が必要（適用後に PR へ db-migration-applied ラベル）。

CREATE UNIQUE INDEX IF NOT EXISTS uq_payout_transfer_items_active_record
  ON payout_transfer_items(payout_record_id)
  WHERE status IN ('pending', 'completed');

COMMENT ON INDEX uq_payout_transfer_items_active_record IS
  'ADR054: 1 つの payout_record に有効な明細（pending/completed）は 1 件だけ。二重振込の最終防壁';
