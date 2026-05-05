-- クリエイティブ事後修正監査ログ
-- 用途: クリエイティブ追加時に案件を取り違えて登録した等のケースで、
--       後から正しい案件・属性へ付け替えたときの「誰が・いつ・何を・どう変えたか・なぜ」を記録する。
-- creative_id は creatives.id を参照（クリエイティブ削除時にログも消えるよう CASCADE）。
-- field_name はホワイトリスト的に運用（'project_id' / 'creative_type' / 'product_id' / 'appeal_type_id' / 'file_name' / 'memo' / 'note' 等）。
-- old_value / new_value は表示用スナップショット（uuid列でも案件名等の人間可読値を入れる）。
-- reason は「案件変更」だけ必須、その他項目は任意（サーバ側で検証）。
-- 本番Supabaseへの適用が必要。
CREATE TABLE IF NOT EXISTS creative_edit_logs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creative_id     UUID NOT NULL REFERENCES creatives(id) ON DELETE CASCADE,
  edited_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  edited_by_name  TEXT,                       -- 表示用スナップショット（離職等で users が消えても残す）
  edited_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  field_name      TEXT NOT NULL,              -- 'project_id' / 'creative_type' / 'product_id' / 'appeal_type_id' / 'file_name' / 'memo' / 'note' 等
  old_value       TEXT,                       -- 旧値（uuid列でも人間可読な表示値を入れる）
  new_value       TEXT,                       -- 新値（同上）
  reason          TEXT                        -- 任意。案件変更（field_name = 'project_id'）のときのみアプリ層で必須化
);

CREATE INDEX IF NOT EXISTS idx_creative_edit_logs_creative
  ON creative_edit_logs(creative_id, edited_at DESC);
CREATE INDEX IF NOT EXISTS idx_creative_edit_logs_edited_at
  ON creative_edit_logs(edited_at DESC);
