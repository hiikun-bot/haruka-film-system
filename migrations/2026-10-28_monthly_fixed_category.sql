-- =====================================================
-- 月額定額カテゴリ（ADR 053）
-- =====================================================
-- 目的:
--   「東京ガスは片山が月3万円の定額で請求」のように、本数・時間ではなく毎月決まった額で
--   請求する案件を、案件カテゴリ「月額定額」(code='monthly_fixed') として作れるようにする。
--   成果物を持たないので render_kind は時間給作業と同じ 'timesheet'（成果物なし）。
--   金額は ADR 029 の分割支払（line_payment_installments）に各月1行で載る（表の追加なし）。
--
-- 冪等性: ON CONFLICT DO NOTHING で二重実行可。
-- =====================================================

INSERT INTO creative_categories (code, name, render_kind, sort_order, color) VALUES
  ('monthly_fixed', '月額定額', 'timesheet', 61, '#1D4ED8')
ON CONFLICT (code) DO NOTHING;
