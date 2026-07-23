-- 2026-07-23_portfolio_gallery.sql
-- 作品ギャラリー（ポートフォリオ抽出）用のカラム追加。
--
-- 目的:
--   クリエイターが「自分の納品済み作品」を案件ごと・向き（縦/正方/横）ごとに
--   一覧で見せられるようにする。作品には任意の説明文を付けられる。
--
-- 1) creatives.portfolio_note
--    作品の説明文（初期値 NULL＝未入力）。ギャラリーのホバー表示とライトボックスで使う。
--    note / memo とは用途が別:
--      note  … 制作時の指示メモ（社内向け）
--      memo  … 一覧の備考
--      portfolio_note … 「作品としてどう語るか」（ポートフォリオ向けの説明）
--
-- 2) creative_files.media_width / media_height / media_meta_checked_at
--    ギャラリーのレーン分け（縦 9:16 / 正方 1:1 / 横 16:9）に使う実寸のキャッシュ。
--    比率の解決順は creatives.creative_size（サイズ区分マスター）→ このキャッシュ →
--    Drive の videoMediaMetadata / imageMediaMetadata を都度取得してここへ書き戻す。
--    media_meta_checked_at は「取得を試みた時刻」。取得しても width/height が返らない
--    ファイル（Drive 側が未処理・非対応 mime 等）を毎回叩き直さないための再試行抑制に使う。

ALTER TABLE creatives
  ADD COLUMN IF NOT EXISTS portfolio_note text;

ALTER TABLE creative_files
  ADD COLUMN IF NOT EXISTS media_width            integer,
  ADD COLUMN IF NOT EXISTS media_height           integer,
  ADD COLUMN IF NOT EXISTS media_meta_checked_at  timestamptz;

-- 作品一覧は「status='納品' を案件ごとに」引くのが唯一のアクセスパターン。
-- 部分インデックスで納品済みだけを対象にする（納品は全体の一部なのでサイズが小さい）。
CREATE INDEX IF NOT EXISTS idx_creatives_delivered_portfolio
  ON creatives (project_id, delivered_at DESC)
  WHERE status = '納品';
