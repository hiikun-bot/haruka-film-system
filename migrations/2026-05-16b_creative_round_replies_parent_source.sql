-- creative_round_replies の親メッセージ識別を「source + source_id」の汎用キーに変更。
--
-- 背景: 「前回」セクションのページは kind ごとに実体が異なるテーブルから来る。
--   - submit / approve_handoff / deliver → creative_version_history.id を参照
--   - revise (修正依頼)                  → creative_status_transitions.id を参照
--   - live (制作中ライブ修正依頼)         → 合成 ID  `live-<creative_id>` (DB 行なし)
--
-- 初版 migration では version_history_id (FK→creative_version_history) を NOT NULL にしてしまったため、
-- revise / live ページに返信を紐づけられず、UI に返信ボタンが出ない問題が発生。
--
-- 本 migration では旧スキーマを破棄して、自然キー (source, source_id) に作り直す。
-- 本番にはまだ実データが入っていない前提（直前にデプロイされたばかり）で DROP/CREATE で再構築する。

DROP TABLE IF EXISTS creative_round_replies CASCADE;

CREATE TABLE creative_round_replies (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  creative_id  uuid NOT NULL REFERENCES creatives(id) ON DELETE CASCADE,
  -- 親メッセージの種類:
  --   'version'    → source_id は creative_version_history.id (uuid 文字列)
  --   'transition' → source_id は creative_status_transitions.id (uuid 文字列)
  --   'live'       → source_id は `live-<creative_id>` (合成 ID)
  source       text NOT NULL CHECK (source IN ('version', 'transition', 'live')),
  source_id    text NOT NULL CHECK (length(source_id) > 0 AND length(source_id) <= 128),
  body         text NOT NULL CHECK (length(body) > 0 AND length(body) <= 4000),
  author_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz
);

COMMENT ON TABLE creative_round_replies IS
  'クリエイティブ詳細モーダル「前回」セクション各メッセージへのスレッド返信。親は (source, source_id) で識別: version=creative_version_history.id / transition=creative_status_transitions.id / live=合成 ID。';

-- スレッド取得用（親メッセージ単位の時系列ロード）
CREATE INDEX idx_crr_parent_created
  ON creative_round_replies(source, source_id, created_at)
  WHERE deleted_at IS NULL;

-- クリエイティブ単位のバルク取得用（モーダル open 時に creative 全件先読み）
CREATE INDEX idx_crr_creative_created
  ON creative_round_replies(creative_id, created_at)
  WHERE deleted_at IS NULL;

-- updated_at 自動更新 trigger（初版 migration と同一）
CREATE OR REPLACE FUNCTION trg_creative_round_replies_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS creative_round_replies_updated_at ON creative_round_replies;
CREATE TRIGGER creative_round_replies_updated_at
  BEFORE UPDATE ON creative_round_replies
  FOR EACH ROW EXECUTE FUNCTION trg_creative_round_replies_updated_at();

NOTIFY pgrst, 'reload schema';
