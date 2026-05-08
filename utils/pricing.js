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

// =====================================================
// 請求書向け: 1 creative × 1 ロールの単価解決ヘルパ（Stage 5）
// =====================================================
// 旧 project_rates / director_rates / producer_rates の代わりに、
// project_estimate_lines + project_estimate_line_costs から
// 「この creative にこの user (= role) で請求するときの単価」を引く。
//
// Stage 5 (PR #TBD) で旧テーブル read 経路は撤去。Stage 6 で旧テーブル DROP 予定。
//
// 設計上の制約:
//   - 旧 project_rates が持っていた cost_type 4 分割 (base_fee/script_fee/ai_fee/other_fee) は
//     新スキーマでは role 単位の単一 unit_price に統合されている。
//     よって invoice_items.cost_type の 'script_fee' / 'ai_fee' / 'other_fee' は
//     新スキーマからは生成されない。editor/designer の line_cost は cost_type='base_fee' に丸める。
//   - line.status が ACTIVE_LINE_STATUSES に含まれない line は集計対象外（ADR 005）。
//   - assignment.rank_applied での line 選別: line.name に 'Aランク'/'Bランク'/'Cランク' が含まれていれば
//     優先マッチ（旧 project_rates の rank A/B/C を踏襲）。

/**
 * 旧 cost_type と roles.code のマッピング。
 *
 * 旧スキーマ (project_rates / project_director_rates / project_producer_rates) では
 * editor/designer の単価は base_fee/script_fee/ai_fee/other_fee の 4 分割で持っていた。
 * 新スキーマでは role 単位の単一 unit_price なので、editor/designer の line_cost は
 * 'base_fee' に丸めて invoice_items.cost_type に保存する。
 * director/producer はそのまま。
 */
const ROLE_TO_INVOICE_COST_TYPE = {
  editor:    'base_fee',
  designer:  'base_fee',
  director:  'director_fee',
  producer:  'producer_fee',
  // sub_director / sub_producer は invoice_items.cost_type の ALLOWED にないため、
  // 当面は base_fee 扱いにフォールバック（必要なら ALLOWED 拡張時に対応）。
  sub_director: 'base_fee',
  sub_producer: 'base_fee',
};

function roleCodeToInvoiceCostType(roleCode) {
  return ROLE_TO_INVOICE_COST_TYPE[roleCode] || 'other_fee';
}

/**
 * 与えられた creative + 担当ロール (assignment.role / 'director' / 'producer') に対して、
 * project_estimate_lines / project_estimate_line_costs から「この 1 本にいくら払うか」を返す。
 *
 * @param {object} args
 * @param {object} args.creative          - { id, project_id, line_id?, category_id?, creative_type?, ... }
 * @param {string} args.roleCode          - 'editor' | 'designer' | 'director' | 'producer' | ...
 * @param {string|null} args.rankApplied  - 'A' | 'B' | 'C' | null（line 選別用）
 * @param {object} args.linesByProject    - Map<project_id, line[]>（line には category 情報含む）
 * @param {object} args.lineCostsByLine   - { [line_id]: line_cost[] }（role embed: { roles: { code } }）
 * @param {string[]} [args.activeStatuses] - 集計対象 status（既定 ACTIVE_LINE_STATUSES）
 * @returns {{ unit_price: number, line_id: string|null, line_cost_id: string|null }} 見つからなければ unit_price=0
 */
function resolveCreativeRoleCost({
  creative,
  roleCode,
  rankApplied,
  linesByProject,
  lineCostsByLine,
  activeStatuses,
} = {}) {
  if (!creative || !roleCode) return { unit_price: 0, line_id: null, line_cost_id: null };
  const allowed = new Set(Array.isArray(activeStatuses) && activeStatuses.length ? activeStatuses : ACTIVE_LINE_STATUSES);

  // 1) 候補 line の解決
  //    優先順位: creative.line_id (直接) > project + category 一致 > project 一致のみ
  const projLines = (linesByProject && linesByProject.get && linesByProject.get(creative.project_id))
    || (linesByProject && linesByProject[creative.project_id])
    || [];
  let candidates = [];
  if (creative.line_id) {
    const direct = projLines.find(l => l && l.id === creative.line_id);
    if (direct) candidates = [direct];
  }
  if (!candidates.length && creative.category_id) {
    candidates = projLines.filter(l => l && l.category_id === creative.category_id);
  }
  if (!candidates.length) {
    // creative_type → category code でフォールバック（旧データ救済: video_short → video, design_* → image）
    const ct = creative.creative_type || '';
    const wantCatCode = ct.startsWith('video') ? 'video' : ct.startsWith('design') ? 'image' : null;
    if (wantCatCode) {
      candidates = projLines.filter(l => l && l.category && l.category.code === wantCatCode);
    }
  }
  if (!candidates.length) {
    candidates = projLines.slice(); // 最後の手段：プロジェクト内の全 line
  }

  // 2) status フィルタ
  candidates = candidates.filter(l => allowed.has(l.status));
  if (!candidates.length) return { unit_price: 0, line_id: null, line_cost_id: null };

  // 3) rank マッチを優先順位の先頭に持ってくる（rank が無ければそのまま）
  if (rankApplied) {
    const rankMarker = `${rankApplied}ランク`;
    const idx = candidates.findIndex(l => (l.name || '').includes(rankMarker));
    if (idx > 0) {
      const [rankMatch] = candidates.splice(idx, 1);
      candidates.unshift(rankMatch);
    }
  }

  // 4) 候補 line を順番に見て、roleCode の line_cost を持つ最初の line を採用
  //    (director/producer の line_cost が rank A の line にしかない、というケースを救うため)
  //
  // 注: 請求は 1 creative = 1 unit 単位なので「per-unit 価格」を返す（line 全体ではない）。
  //   - fixed_per_unit: そのまま unit_price
  //   - percentage    : client_unit_price × percentage / 100
  //   - hourly        : 時間単価は per-unit に意味があるとすれば「1 本あたり実工数 = actual_hours / planned_count」
  //                     とみなして unit_price × (actual_hours / planned_count) を返す。
  //                     planned_count<=0 の場合は 0（invoice では本数=0 で請求しない前提）。
  //   - fixed_total   : line 全体固定額。1 本あたりに案分するため fixed_total / planned_count を返す。
  //                     planned_count<=0 の場合は 0。
  for (const line of candidates) {
    const costs = (lineCostsByLine && lineCostsByLine[line.id]) || [];
    const lc = costs.find(c => {
      const code = c?.role?.code || c?.roles?.code || c?.role_code;
      return code === roleCode;
    });
    if (!lc) continue;
    const pricingType = lc.pricing_type || 'fixed_per_unit';
    const unitPriceLc  = Number(lc.unit_price)   || 0;
    const percentage   = Number(lc.percentage)   || 0;
    const actualHours  = Number(lc.actual_hours) || 0;
    const clientUnit   = Number(line.client_unit_price) || 0;
    const plannedCount = Number(line.planned_count)     || 0;
    let perUnit = 0;
    switch (pricingType) {
      case 'fixed_per_unit':
        perUnit = unitPriceLc;
        break;
      case 'percentage':
        perUnit = clientUnit * percentage / 100;
        break;
      case 'hourly':
        perUnit = plannedCount > 0 ? unitPriceLc * actualHours / plannedCount : 0;
        break;
      case 'fixed_total':
        perUnit = plannedCount > 0 ? unitPriceLc / plannedCount : 0;
        break;
      default:
        perUnit = 0;
    }
    // 請求金額は整数（円）に丸める。0.5 切り上げ。
    perUnit = Math.round(perUnit);
    return { unit_price: perUnit, line_id: line.id, line_cost_id: lc.id || null };
  }

  return { unit_price: 0, line_id: null, line_cost_id: null };
}

module.exports = {
  ACTIVE_LINE_STATUSES,
  calculateLineCost,
  calculateLineEconomics,
  calculateProjectEconomics,
  indexLineCostsByLine,
  roleCodeToInvoiceCostType,
  resolveCreativeRoleCost,
};
