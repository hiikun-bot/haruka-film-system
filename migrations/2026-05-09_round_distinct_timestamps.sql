-- ADR 011 補足: ラウンド比較UIで「編集者の提出時刻」と「ディレクターの指摘時刻」を分離表示するため、
-- creative_version_history に 2 つの独立タイムスタンプ列を追加する。
--
-- 背景:
--   1 行の snapshot は「修正済→再チェック」遷移時に INSERT される。
--   この行の created_at は再提出時刻 = 編集者の提出時メモの確定時刻に一致する一方、
--   director_comment / client_comment は前ラウンドのチェック段階で書かれたもので
--   実際の指摘時刻は created_at よりも前。From/To 行右端の "5/9 16:22" を共通の
--   created_at で表示すると編集者発言とディレクター発言が同時刻になり違和感が出る。
--
-- 対応:
--   ・editor_submitted_at  : 編集者が再提出ボタンを押して snapshot が確定した時刻
--   ・director_commented_at: ディレクター/クライアントが指摘コメントを書いた時刻
--                            （= 直前のチェック段階の creatives.updated_at 等）
--
--   既存行は NULL のまま許容。フロント側は NULL のとき created_at にフォールバック。
--   副作用なし（ALTER ADD COLUMN IF NOT EXISTS のみ）。

ALTER TABLE creative_version_history
  ADD COLUMN IF NOT EXISTS editor_submitted_at TIMESTAMPTZ;

ALTER TABLE creative_version_history
  ADD COLUMN IF NOT EXISTS director_commented_at TIMESTAMPTZ;
