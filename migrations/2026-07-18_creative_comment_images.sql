-- クリエイティブ詳細のコメントに貼り付けた画像を保存する。
-- 用途:
--   1) Dチェック等「修正指示・承認コメント」欄（director_note）にクリップボード画像を添付
--      → 添付先はラウンド識別子 (source, source_id)。
--         入力中は source='live' / source_id='live-<creativeId>' にステージングし、
--         ステータス遷移時にサーバ側で source='transition' / source_id=<transition.id> へ
--         再キーして、その修正指示ラウンドに永続的に紐づける（reply_id IS NULL の行のみ）。
--   2) 各ラウンドの返信スレッド（creative_round_replies）への添付
--      → reply_id で返信 1 件に紐づく。
--
-- 画像本体はつぶやき画像と同じく base64 data URL をそのまま列に格納し、
-- 一覧 API では image_data を SELECT せず GET /comment-images/:id/image で遅延配信する
-- （一覧ペイロード肥大を避ける。[[project_base64_columns_payload]] の教訓）。

CREATE TABLE IF NOT EXISTS creative_comment_images (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  creative_id  uuid NOT NULL REFERENCES creatives(id) ON DELETE CASCADE,
  -- 返信への添付はこちら（返信削除で画像も消える）
  reply_id     uuid REFERENCES creative_round_replies(id) ON DELETE CASCADE,
  -- コメント欄（director_note）への添付はラウンド識別子で紐づける。
  --   source: 'live' | 'transition' | 'version'（creative_round_replies と同じ体系）
  source       text,
  source_id    text,
  image_data   text NOT NULL,            -- data:<mime>;base64,<...>
  mime         text,
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz
);

COMMENT ON TABLE creative_comment_images IS
  'クリエイティブ詳細のコメント（Dチェック指示欄 / ラウンド返信）に貼り付けた画像。image_data=base64 data URL。返信は reply_id、指示欄は (source, source_id) で紐づく。';

-- クリエイティブ単位のバルク取得用（モーダル open 時に全件先読み・image_data は引かない）
CREATE INDEX IF NOT EXISTS idx_cci_creative_created
  ON creative_comment_images(creative_id, created_at)
  WHERE deleted_at IS NULL;

-- 返信単位の引き当て
CREATE INDEX IF NOT EXISTS idx_cci_reply
  ON creative_comment_images(reply_id)
  WHERE deleted_at IS NULL AND reply_id IS NOT NULL;

-- ラウンド識別子（指示欄画像）の引き当て・再キー対象抽出
CREATE INDEX IF NOT EXISTS idx_cci_source
  ON creative_comment_images(creative_id, source, source_id)
  WHERE deleted_at IS NULL AND reply_id IS NULL;
