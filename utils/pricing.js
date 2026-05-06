// utils/pricing.js
// =====================================================
// 案件・見積の単価／粗利計算ヘルパ（ADR 002 + 004 + 005 + 006）
//
// このモジュールは「単価 × 本数」「ロール別コスト」「案件固定費」を
// 1 関数に集約することで、課金タイプ追加・計算ロジック変更が
// 全画面（accounting / dashboard / analytics 等）に一括反映されるようにする。
//
// 関連 ADR:
//   - ADR 002: 見積明細を deliverable と rates の統合単位にする
//   - ADR 004: 単価の拡張性（通貨・課金タイプ）
//   - ADR 005: 見積もりと deliverable のライフサイクル分離
//   - ADR 006: 案件固定費（本数非依存）の粗利反映
//
// 設計のポイント:
//   - status フィルタは ADR 005 で明示された 'contracted' / 'in_progress' / 'delivered'
//     のみを売上・粗利集計に含める。'estimated' / 'draft' / 'rejected' / 'cancelled'
//     は集計対象外。
//   - pricing_type ごとの計算は switch 1 箇所に閉じる（ADR 004）
//   - fixed_items は status='cancelled' を除き、item_type='revenue' は売上、
//     'expense' は原価に反映する（ADR 006）
//
// 既知の制約（Stage 4 で扱う）:
//   - 移行 line に紐付かない creatives（line_id IS NULL）は集計から漏れる。
//     これは Stage 4 UI で手動補正する想定で、本モジュールの責務外。
// =====================================================

/**
 * 売上・粗利集計に含める line.status の集合（ADR 005）。
 *   - contracted  : 受注済（deliverable 化）
 *   - in_progress : 制作進行中（creative 紐付け済）
 *   - delivered   : 納品済（請求対象）
 * 'draft' / 'estimated' / 'rejected' / 'cancelled' は除外。
 */
const ACTIVE_LINE_STATUSES = ['contracted', 'in_progress', 'delivered'];

/**
 * 1つの project_estimate_line_costs 行が consume するコストを計算する（ADR 004）。
 *
 * @param {object} lineCost - project_estimate_line_costs の row
 *   { pricing_type, unit_price, percentage, actual_hours, ... }
 * @param {object} line - 親 project_estimate_lines の row
 *   { client_unit_price, planned_count, ... }
 * @returns {number} このコスト行が案件原価として乗せる金額（円）
 */
function calculateLineCost(lineCost, line) {
  if (!lineCost || !line) return 0;
  const pricingType = lineCost.pricing_type || 'fixed_per_unit';
  const unitPrice    = Number(lineCost.unit_price)   || 0;
  const percentage   = Number(lineCost.percentage)   || 0;
  const actualHours  = Number(lineCost.actual_hours) || 0;
  const clientUnit   = Number(line.client_unit_price) || 0;
  const plannedCount = Number(line.planned_count)     || 0;

  switch (pricingType) {
    case 'fixed_per_unit':
      return unitPrice * plannedCount;
    case 'percentage':
      return clientUnit * plannedCount * percentage / 100;
    case 'hourly':
      return unitPrice * actualHours;
    case 'fixed_total':
      return unitPrice;
    default:
      // 未知の pricing_type は安全側 (=0) に倒す。新タイプ追加時はここに case を追加。
      return 0;
  }
}

/**
 * 1 line（見積行 = deliverable）の売上・原価・粗利を計算する。
 *
 * @param {object} line       - project_estimate_lines の row
 * @param {object[]} lineCosts - 同 line に紐付く project_estimate_line_costs の row 群
 * @returns {{ revenue: number, costs: number, profit: number }}
 */
function calculateLineEconomics(line, lineCosts) {
  if (!line) return { revenue: 0, costs: 0, profit: 0 };
  const clientUnit   = Number(line.client_unit_price) || 0;
  const plannedCount = Number(line.planned_count)     || 0;
  const revenue = clientUnit * plannedCount;
  const costs = (lineCosts || []).reduce((sum, lc) => sum + calculateLineCost(lc, line), 0);
  return { revenue, costs, profit: revenue - costs };
}

/**
 * 案件全体の売上・原価・粗利を集計する（ADR 002 + 005 + 006）。
 *
 * @param {object} args
 * @param {object[]} args.lines              - project_estimate_lines（status 含む）
 * @param {object} args.lineCostsByLine      - { [line_id]: project_estimate_line_costs[] }
 * @param {object[]} [args.fixedItems]       - project_fixed_items（item_type/status/amount 含む）
 * @param {string[]} [args.statuses]         - 集計対象 status（既定 ACTIVE_LINE_STATUSES）
 * @returns {{ revenue: number, costs: number, profit: number, line_count: number }}
 */
function calculateProjectEconomics({ lines, lineCostsByLine, fixedItems, statuses } = {}) {
  const allowed = new Set(Array.isArray(statuses) && statuses.length ? statuses : ACTIVE_LINE_STATUSES);
  const activeLines = (lines || []).filter(l => l && allowed.has(l.status));

  let revenue = 0;
  let costs   = 0;
  for (const line of activeLines) {
    const lcs = (lineCostsByLine && lineCostsByLine[line.id]) || [];
    const econ = calculateLineEconomics(line, lcs);
    revenue += econ.revenue;
    costs   += econ.costs;
  }

  for (const item of (fixedItems || [])) {
    if (!item) continue;
    if (item.status === 'cancelled') continue;
    const amount = Number(item.amount) || 0;
    if (item.item_type === 'revenue')      revenue += amount;
    else if (item.item_type === 'expense') costs   += amount;
  }

  return { revenue, costs, profit: revenue - costs, line_count: activeLines.length };
}

/**
 * lineCosts の配列から { [line_id]: lineCosts[] } に index する。
 * Supabase の embed や個別取得の結果を共通形式にそろえる用。
 */
function indexLineCostsByLine(lineCosts) {
  const map = {};
  for (const lc of (lineCosts || [])) {
    if (!lc || !lc.line_id) continue;
    if (!map[lc.line_id]) map[lc.line_id] = [];
    map[lc.line_id].push(lc);
  }
  return map;
}

module.exports = {
  ACTIVE_LINE_STATUSES,
  calculateLineCost,
  calculateLineEconomics,
  calculateProjectEconomics,
  indexLineCostsByLine,
};
