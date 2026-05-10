-- ADR 011 補足: クリエイティブの全ステータス遷移を audit log に残す。
--
-- 背景: 既存テーブル (creatives, creative_version_history, creative_status_audit) では
--   通常運用でユーザーが押す状態遷移ボタンの時刻が記録されない。
--
-- 用途:
--   - ラウンド比較 UI で「Dチェック/D後修正」等の各ステージ移行時刻を表示
--   - サイクルタイム集計 (制作中→納品まで何日 / 平均D後修正時間 / etc)
--   - 遅延検知バッチからの参照
--
-- 副作用なし: ALTER ではなく純粋な新規 CREATE TABLE。

CREATE TABLE IF NOT EXISTS creative_status_transitions (
  id BIGSERIAL PRIMARY KEY,
  creative_id UUID NOT NULL REFERENCES creatives(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status TEXT NOT NULL,
  changed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 補助情報: そのとき書かれた最新コメント (任意・運用 debug 向け)
  director_comment_at_change TEXT,
  client_comment_at_change   TEXT,
  editor_comment_at_change   TEXT,
  -- そのときの version_num （creative_files.version の最大値）。version 跨ぎの分析用
  version_at_change INTEGER
);

CREATE INDEX IF NOT EXISTS idx_cst_creative_id_changed_at
  ON creative_status_transitions (creative_id, changed_at DESC);

CREATE INDEX IF NOT EXISTS idx_cst_to_status_changed_at
  ON creative_status_transitions (to_status, changed_at DESC);

COMMENT ON TABLE creative_status_transitions IS
  'クリエイティブの全ステータス遷移を時系列で残す audit log。ラウンド比較UIの時刻表示と集計バッチの両方に使う。';
