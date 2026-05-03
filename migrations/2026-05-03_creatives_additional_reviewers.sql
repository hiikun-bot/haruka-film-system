-- ============================================================
-- creatives.additional_reviewer_ids — Dチェック依頼の追加レビュアー
--
-- 背景:
--   デザインチームのようにディレクター不在の案件で、編集者がDチェック依頼を
--   出す際にチームメンバーを「追加で呼ぶ」ためのフィールド。
--
-- 仕様:
--   ・creative_assignments には INSERT しない（請求書ロジックには影響させない）
--   ・ball_holder_id は元のディレクターのまま
--   ・追加メンバーは「チェック参加者」扱い
--   ・通知発火は notification_logs に直接 INSERT（type: 'director_check_additional'）
--
-- 冪等性: IF NOT EXISTS / GIN INDEX も IF NOT EXISTS
-- ============================================================

ALTER TABLE creatives
  ADD COLUMN IF NOT EXISTS additional_reviewer_ids UUID[] NOT NULL DEFAULT '{}';

-- 配列の包含検索（受信者一覧 / 「自分が追加で呼ばれているクリエイティブ」抽出向け）
CREATE INDEX IF NOT EXISTS idx_creatives_additional_reviewers
  ON creatives USING GIN(additional_reviewer_ids);
