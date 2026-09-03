// tests/utils/pricing.test.js
// utils/pricing.js のユニットテスト。
// 現在の実装挙動をそのまま固定する（リグレッション検知用）。

const {
  ACTIVE_LINE_STATUSES,
  calculateLineCost,
  calculateLineEconomics,
  calculateProjectEconomics,
  indexLineCostsByLine,
  roleCodeToInvoiceCostType,
  resolveCreativeRoleCost,
  buildCreativeLineCandidates,
  creativeRankApplied,
  pickCreativeLineId,
  lineRankOf,
} = require('../../utils/pricing');

describe('ACTIVE_LINE_STATUSES', () => {
  test('ADR 005 の 3 ステータスのみ', () => {
    expect(ACTIVE_LINE_STATUSES).toEqual(['contracted', 'in_progress', 'delivered']);
  });
});

describe('calculateLineCost', () => {
  const line = { client_unit_price: 10000, planned_count: 10 };

  test('lineCost が null なら 0', () => {
    expect(calculateLineCost(null, line)).toBe(0);
  });

  test('line が null なら 0', () => {
    expect(calculateLineCost({ pricing_type: 'fixed_per_unit', unit_price: 5000 }, null)).toBe(0);
  });

  test('fixed_per_unit: unit_price × planned_count', () => {
    expect(calculateLineCost({ pricing_type: 'fixed_per_unit', unit_price: 5000 }, line)).toBe(50000);
  });

  test('pricing_type 未指定は fixed_per_unit にフォールバック', () => {
    expect(calculateLineCost({ unit_price: 5000 }, line)).toBe(50000);
  });

  test('percentage: client_unit_price × planned_count × percentage / 100', () => {
    expect(calculateLineCost({ pricing_type: 'percentage', percentage: 20 }, line)).toBe(20000);
  });

  test('hourly: unit_price × actual_hours', () => {
    expect(calculateLineCost({ pricing_type: 'hourly', unit_price: 3000, actual_hours: 2.5 }, line)).toBe(7500);
  });

  test('fixed_total: 本数に依存せず unit_price そのまま', () => {
    expect(calculateLineCost({ pricing_type: 'fixed_total', unit_price: 80000 }, line)).toBe(80000);
  });

  test('未知の pricing_type は 0（安全側）', () => {
    expect(calculateLineCost({ pricing_type: 'per_view', unit_price: 5000 }, line)).toBe(0);
  });

  test('数値文字列は Number() で解釈される', () => {
    expect(calculateLineCost(
      { pricing_type: 'fixed_per_unit', unit_price: '5000' },
      { client_unit_price: '10000', planned_count: '3' },
    )).toBe(15000);
  });

  test('数値化できない値は 0 扱い', () => {
    expect(calculateLineCost({ pricing_type: 'fixed_per_unit', unit_price: 'abc' }, line)).toBe(0);
    expect(calculateLineCost({ pricing_type: 'hourly', unit_price: 3000, actual_hours: null }, line)).toBe(0);
  });
});

describe('calculateLineEconomics', () => {
  test('line が null なら全部 0', () => {
    expect(calculateLineEconomics(null, [])).toEqual({ revenue: 0, costs: 0, profit: 0 });
  });

  test('売上 = client_unit_price × planned_count、粗利 = 売上 - 原価', () => {
    const line = { client_unit_price: 12000, planned_count: 5 };
    const lineCosts = [
      { pricing_type: 'fixed_per_unit', unit_price: 4000 },  // 20000
      { pricing_type: 'percentage', percentage: 10 },        // 6000
    ];
    expect(calculateLineEconomics(line, lineCosts)).toEqual({
      revenue: 60000,
      costs: 26000,
      profit: 34000,
    });
  });

  test('lineCosts が null でも costs=0 で計算できる', () => {
    const line = { client_unit_price: 12000, planned_count: 5 };
    expect(calculateLineEconomics(line, null)).toEqual({ revenue: 60000, costs: 0, profit: 60000 });
  });
});

describe('calculateProjectEconomics', () => {
  test('引数なしでも 0 で返る', () => {
    expect(calculateProjectEconomics()).toEqual({ revenue: 0, costs: 0, profit: 0, line_count: 0 });
  });

  test('ACTIVE_LINE_STATUSES のみ集計対象（draft/estimated/rejected/cancelled は除外）', () => {
    const lines = [
      { id: 'l1', status: 'contracted',  client_unit_price: 10000, planned_count: 2 },
      { id: 'l2', status: 'in_progress', client_unit_price: 20000, planned_count: 1 },
      { id: 'l3', status: 'delivered',   client_unit_price: 5000,  planned_count: 4 },
      { id: 'l4', status: 'draft',       client_unit_price: 99999, planned_count: 9 },
      { id: 'l5', status: 'estimated',   client_unit_price: 99999, planned_count: 9 },
      { id: 'l6', status: 'rejected',    client_unit_price: 99999, planned_count: 9 },
      { id: 'l7', status: 'cancelled',   client_unit_price: 99999, planned_count: 9 },
      null,
    ];
    const result = calculateProjectEconomics({ lines, lineCostsByLine: {} });
    expect(result.revenue).toBe(20000 + 20000 + 20000);
    expect(result.costs).toBe(0);
    expect(result.line_count).toBe(3);
  });

  test('lineCostsByLine の原価が line ごとに反映される', () => {
    const lines = [
      { id: 'l1', status: 'contracted', client_unit_price: 10000, planned_count: 2 },
    ];
    const lineCostsByLine = {
      l1: [{ pricing_type: 'fixed_per_unit', unit_price: 3000 }], // 6000
    };
    expect(calculateProjectEconomics({ lines, lineCostsByLine })).toEqual({
      revenue: 20000, costs: 6000, profit: 14000, line_count: 1,
    });
  });

  test('statuses 指定で集計対象を上書きできる', () => {
    const lines = [
      { id: 'l1', status: 'estimated', client_unit_price: 10000, planned_count: 1 },
      { id: 'l2', status: 'contracted', client_unit_price: 5000, planned_count: 1 },
    ];
    const result = calculateProjectEconomics({ lines, lineCostsByLine: {}, statuses: ['estimated'] });
    expect(result.revenue).toBe(10000);
    expect(result.line_count).toBe(1);
  });

  test('statuses が空配列なら既定の ACTIVE_LINE_STATUSES を使う', () => {
    const lines = [{ id: 'l1', status: 'contracted', client_unit_price: 5000, planned_count: 1 }];
    const result = calculateProjectEconomics({ lines, lineCostsByLine: {}, statuses: [] });
    expect(result.revenue).toBe(5000);
  });

  test('fixed_items: revenue は売上、expense は原価、cancelled は除外（ADR 006）', () => {
    const fixedItems = [
      { item_type: 'revenue', amount: 30000, status: 'active' },
      { item_type: 'expense', amount: 10000, status: 'active' },
      { item_type: 'expense', amount: 99999, status: 'cancelled' },
      { item_type: 'unknown', amount: 99999, status: 'active' }, // 未知 item_type は無視
      null,
    ];
    expect(calculateProjectEconomics({ lines: [], lineCostsByLine: {}, fixedItems })).toEqual({
      revenue: 30000, costs: 10000, profit: 20000, line_count: 0,
    });
  });
});

describe('indexLineCostsByLine', () => {
  test('line_id ごとにグループ化する', () => {
    const lcs = [
      { id: 'c1', line_id: 'l1' },
      { id: 'c2', line_id: 'l1' },
      { id: 'c3', line_id: 'l2' },
    ];
    const map = indexLineCostsByLine(lcs);
    expect(Object.keys(map).sort()).toEqual(['l1', 'l2']);
    expect(map.l1.map(c => c.id)).toEqual(['c1', 'c2']);
    expect(map.l2.map(c => c.id)).toEqual(['c3']);
  });

  test('null 要素・line_id なしはスキップ', () => {
    expect(indexLineCostsByLine([null, { id: 'c1' }, { id: 'c2', line_id: 'l1' }]))
      .toEqual({ l1: [{ id: 'c2', line_id: 'l1' }] });
  });

  test('null 入力は空オブジェクト', () => {
    expect(indexLineCostsByLine(null)).toEqual({});
  });
});

describe('roleCodeToInvoiceCostType', () => {
  test.each([
    ['editor', 'base_fee'],
    ['designer', 'base_fee'],
    ['director', 'director_fee'],
    ['producer', 'producer_fee'],
    ['sub_director', 'base_fee'],
    ['sub_producer', 'base_fee'],
  ])('%s → %s', (role, expected) => {
    expect(roleCodeToInvoiceCostType(role)).toBe(expected);
  });

  test('未知ロールは other_fee', () => {
    expect(roleCodeToInvoiceCostType('animator')).toBe('other_fee');
    expect(roleCodeToInvoiceCostType(null)).toBe('other_fee');
  });
});

describe('resolveCreativeRoleCost', () => {
  const EMPTY = { unit_price: 0, line_id: null, line_cost_id: null, pricing_approval: null };

  function makeLine(over = {}) {
    return {
      id: 'l1',
      status: 'contracted',
      client_unit_price: 10000,
      planned_count: 4,
      category_id: 'cat-video',
      name: '動画編集',
      rank: null,
      category: { code: 'video' },
      ...over,
    };
  }

  test('creative / roleCode が無ければ 0', () => {
    expect(resolveCreativeRoleCost()).toEqual(EMPTY);
    expect(resolveCreativeRoleCost({ creative: { id: 'c1', project_id: 'p1' } })).toEqual(EMPTY);
  });

  test('creative.line_id 直結 line を最優先で使う', () => {
    const lines = [
      makeLine({ id: 'l1' }),
      makeLine({ id: 'l2' }),
    ];
    const result = resolveCreativeRoleCost({
      creative: { id: 'c1', project_id: 'p1', line_id: 'l2' },
      roleCode: 'editor',
      linesByProject: { p1: lines },
      lineCostsByLine: {
        l1: [{ id: 'lc1', role: { code: 'editor' }, pricing_type: 'fixed_per_unit', unit_price: 1000 }],
        l2: [{ id: 'lc2', role: { code: 'editor' }, pricing_type: 'fixed_per_unit', unit_price: 2000 }],
      },
    });
    expect(result).toEqual({ unit_price: 2000, line_id: 'l2', line_cost_id: 'lc2', pricing_approval: 'approved' });
  });

  test('line_id が無ければ category_id 一致で line を選ぶ', () => {
    const lines = [
      makeLine({ id: 'l1', category_id: 'cat-image' }),
      makeLine({ id: 'l2', category_id: 'cat-video' }),
    ];
    const result = resolveCreativeRoleCost({
      creative: { id: 'c1', project_id: 'p1', category_id: 'cat-video' },
      roleCode: 'editor',
      linesByProject: { p1: lines },
      lineCostsByLine: {
        l1: [{ id: 'lc1', role: { code: 'editor' }, unit_price: 1000 }],
        l2: [{ id: 'lc2', role: { code: 'editor' }, unit_price: 2000 }],
      },
    });
    expect(result.line_id).toBe('l2');
    expect(result.unit_price).toBe(2000);
  });

  test('creative_type から category code へフォールバック（video_short → video / design_* → image）', () => {
    const lines = [
      makeLine({ id: 'lv', category: { code: 'video' } }),
      makeLine({ id: 'li', category: { code: 'image' } }),
    ];
    const lineCostsByLine = {
      lv: [{ id: 'lcv', role: { code: 'editor' }, unit_price: 3000 }],
      li: [{ id: 'lci', role: { code: 'editor' }, unit_price: 4000 }],
    };
    const video = resolveCreativeRoleCost({
      creative: { id: 'c1', project_id: 'p1', creative_type: 'video_short' },
      roleCode: 'editor',
      linesByProject: { p1: lines },
      lineCostsByLine,
    });
    expect(video.line_id).toBe('lv');
    const design = resolveCreativeRoleCost({
      creative: { id: 'c2', project_id: 'p1', creative_type: 'design_banner' },
      roleCode: 'editor',
      linesByProject: { p1: lines },
      lineCostsByLine,
    });
    expect(design.line_id).toBe('li');
  });

  test('最後の手段としてプロジェクト内の全 line から探す', () => {
    const lines = [makeLine({ id: 'l1' })];
    const result = resolveCreativeRoleCost({
      creative: { id: 'c1', project_id: 'p1' }, // line_id / category_id / creative_type なし
      roleCode: 'editor',
      linesByProject: { p1: lines },
      lineCostsByLine: { l1: [{ id: 'lc1', role: { code: 'editor' }, unit_price: 1500 }] },
    });
    expect(result.unit_price).toBe(1500);
  });

  test('ACTIVE でない status の line は除外される', () => {
    const lines = [makeLine({ id: 'l1', status: 'estimated' })];
    const result = resolveCreativeRoleCost({
      creative: { id: 'c1', project_id: 'p1', line_id: 'l1' },
      roleCode: 'editor',
      linesByProject: { p1: lines },
      lineCostsByLine: { l1: [{ id: 'lc1', role: { code: 'editor' }, unit_price: 1500 }] },
    });
    expect(result).toEqual(EMPTY);
  });

  test('activeStatuses 指定で status フィルタを上書きできる', () => {
    const lines = [makeLine({ id: 'l1', status: 'estimated' })];
    const result = resolveCreativeRoleCost({
      creative: { id: 'c1', project_id: 'p1', line_id: 'l1' },
      roleCode: 'editor',
      linesByProject: { p1: lines },
      lineCostsByLine: { l1: [{ id: 'lc1', role: { code: 'editor' }, unit_price: 1500 }] },
      activeStatuses: ['estimated'],
    });
    expect(result.unit_price).toBe(1500);
  });

  test('rankApplied: line.rank 一致の line が優先される（ADR 022）', () => {
    const lines = [
      makeLine({ id: 'l1', rank: 'B' }),
      makeLine({ id: 'l2', rank: 'A' }),
    ];
    const result = resolveCreativeRoleCost({
      creative: { id: 'c1', project_id: 'p1', category_id: 'cat-video' },
      roleCode: 'editor',
      rankApplied: 'A',
      linesByProject: { p1: lines },
      lineCostsByLine: {
        l1: [{ id: 'lc1', role: { code: 'editor' }, unit_price: 1000 }],
        l2: [{ id: 'lc2', role: { code: 'editor' }, unit_price: 2000 }],
      },
    });
    expect(result.line_id).toBe('l2');
  });

  test('rankApplied: rank 列が NULL の旧データは line.name の "Aランク" 文字列でマッチ', () => {
    const lines = [
      makeLine({ id: 'l1', name: 'Bランク動画' }),
      makeLine({ id: 'l2', name: 'Aランク動画' }),
    ];
    const result = resolveCreativeRoleCost({
      creative: { id: 'c1', project_id: 'p1', category_id: 'cat-video' },
      roleCode: 'editor',
      rankApplied: 'A',
      linesByProject: { p1: lines },
      lineCostsByLine: {
        l1: [{ id: 'lc1', role: { code: 'editor' }, unit_price: 1000 }],
        l2: [{ id: 'lc2', role: { code: 'editor' }, unit_price: 2000 }],
      },
    });
    expect(result.line_id).toBe('l2');
  });

  test('roleCode の line_cost が無い line はスキップして次の候補へ', () => {
    const lines = [
      makeLine({ id: 'l1' }),
      makeLine({ id: 'l2' }),
    ];
    const result = resolveCreativeRoleCost({
      creative: { id: 'c1', project_id: 'p1', category_id: 'cat-video' },
      roleCode: 'director',
      linesByProject: { p1: lines },
      lineCostsByLine: {
        l1: [{ id: 'lc1', role: { code: 'editor' }, unit_price: 1000 }],
        l2: [{ id: 'lc2', role: { code: 'director' }, unit_price: 5000 }],
      },
    });
    expect(result).toEqual({ unit_price: 5000, line_id: 'l2', line_cost_id: 'lc2', pricing_approval: 'approved' });
  });

  test('role code は role.code / roles.code / role_code のどれでも引ける', () => {
    const lines = [makeLine({ id: 'l1' })];
    for (const lc of [
      { id: 'lc1', role: { code: 'editor' }, unit_price: 100 },
      { id: 'lc1', roles: { code: 'editor' }, unit_price: 100 },
      { id: 'lc1', role_code: 'editor', unit_price: 100 },
    ]) {
      const result = resolveCreativeRoleCost({
        creative: { id: 'c1', project_id: 'p1', line_id: 'l1' },
        roleCode: 'editor',
        linesByProject: { p1: lines },
        lineCostsByLine: { l1: [lc] },
      });
      expect(result.unit_price).toBe(100);
    }
  });

  test('percentage: client_unit_price × percentage / 100（per-unit）', () => {
    const lines = [makeLine({ id: 'l1', client_unit_price: 10000 })];
    const result = resolveCreativeRoleCost({
      creative: { id: 'c1', project_id: 'p1', line_id: 'l1' },
      roleCode: 'editor',
      linesByProject: { p1: lines },
      lineCostsByLine: { l1: [{ id: 'lc1', role: { code: 'editor' }, pricing_type: 'percentage', percentage: 15 }] },
    });
    expect(result.unit_price).toBe(1500);
  });

  test('hourly: unit_price × actual_hours / planned_count、planned_count<=0 は 0', () => {
    const lines = [makeLine({ id: 'l1', planned_count: 4 })];
    const result = resolveCreativeRoleCost({
      creative: { id: 'c1', project_id: 'p1', line_id: 'l1' },
      roleCode: 'editor',
      linesByProject: { p1: lines },
      lineCostsByLine: { l1: [{ id: 'lc1', role: { code: 'editor' }, pricing_type: 'hourly', unit_price: 3000, actual_hours: 6 }] },
    });
    expect(result.unit_price).toBe(4500); // 3000 * 6 / 4

    const zeroCount = resolveCreativeRoleCost({
      creative: { id: 'c1', project_id: 'p1', line_id: 'l1' },
      roleCode: 'editor',
      linesByProject: { p1: [makeLine({ id: 'l1', planned_count: 0 })] },
      lineCostsByLine: { l1: [{ id: 'lc1', role: { code: 'editor' }, pricing_type: 'hourly', unit_price: 3000, actual_hours: 6 }] },
    });
    expect(zeroCount.unit_price).toBe(0);
  });

  test('fixed_total: unit_price / planned_count、planned_count<=0 は 0', () => {
    const lines = [makeLine({ id: 'l1', planned_count: 4 })];
    const result = resolveCreativeRoleCost({
      creative: { id: 'c1', project_id: 'p1', line_id: 'l1' },
      roleCode: 'editor',
      linesByProject: { p1: lines },
      lineCostsByLine: { l1: [{ id: 'lc1', role: { code: 'editor' }, pricing_type: 'fixed_total', unit_price: 10000 }] },
    });
    expect(result.unit_price).toBe(2500);
  });

  test('per-unit 金額は Math.round で整数円に丸める', () => {
    const lines = [makeLine({ id: 'l1', planned_count: 3 })];
    const result = resolveCreativeRoleCost({
      creative: { id: 'c1', project_id: 'p1', line_id: 'l1' },
      roleCode: 'editor',
      linesByProject: { p1: lines },
      lineCostsByLine: { l1: [{ id: 'lc1', role: { code: 'editor' }, pricing_type: 'fixed_total', unit_price: 10000 }] },
    });
    expect(result.unit_price).toBe(3333); // 3333.33... → 3333
  });

  test('未知の pricing_type は 0 円（line/line_cost は返る）', () => {
    const lines = [makeLine({ id: 'l1' })];
    const result = resolveCreativeRoleCost({
      creative: { id: 'c1', project_id: 'p1', line_id: 'l1' },
      roleCode: 'editor',
      linesByProject: { p1: lines },
      lineCostsByLine: { l1: [{ id: 'lc1', role: { code: 'editor' }, pricing_type: 'per_view', unit_price: 5000 }] },
    });
    expect(result).toEqual({ unit_price: 0, line_id: 'l1', line_cost_id: 'lc1', pricing_approval: 'approved' });
  });

  test('linesByProject は Map でも plain object でも動く', () => {
    const lines = [makeLine({ id: 'l1' })];
    const lineCostsByLine = { l1: [{ id: 'lc1', role: { code: 'editor' }, unit_price: 700 }] };
    const creative = { id: 'c1', project_id: 'p1', line_id: 'l1' };

    const viaMap = resolveCreativeRoleCost({
      creative, roleCode: 'editor',
      linesByProject: new Map([['p1', lines]]),
      lineCostsByLine,
    });
    expect(viaMap.unit_price).toBe(700);

    const viaObj = resolveCreativeRoleCost({
      creative, roleCode: 'editor',
      linesByProject: { p1: lines },
      lineCostsByLine,
    });
    expect(viaObj.unit_price).toBe(700);
  });

  // ADR 037: 承認待ちの単価は候補から外さず、そのまま採用して pricing_approval で知らせる
  test('承認待ち（pricing_approval=pending）の line も採用し、pricing_approval:"pending" を返す（ADR 037）', () => {
    const lines = [makeLine({ id: 'l1', pricing_approval: 'pending' })];
    const result = resolveCreativeRoleCost({
      creative: { id: 'c1', project_id: 'p1', line_id: 'l1' },
      roleCode: 'editor',
      linesByProject: { p1: lines },
      lineCostsByLine: { l1: [{ id: 'lc1', role: { code: 'editor' }, unit_price: 4000 }] },
    });
    expect(result).toEqual({ unit_price: 4000, line_id: 'l1', line_cost_id: 'lc1', pricing_approval: 'pending' });
  });

  test('承認待ち line は候補順を変えない（rank 一致の pending line が approved line より優先される）', () => {
    const lines = [
      makeLine({ id: 'l1', rank: 'B', pricing_approval: 'approved' }),
      makeLine({ id: 'l2', rank: 'A', pricing_approval: 'pending' }),
    ];
    const result = resolveCreativeRoleCost({
      creative: { id: 'c1', project_id: 'p1', category_id: 'cat-video' },
      roleCode: 'editor',
      rankApplied: 'A',
      linesByProject: { p1: lines },
      lineCostsByLine: {
        l1: [{ id: 'lc1', role: { code: 'editor' }, unit_price: 1000 }],
        l2: [{ id: 'lc2', role: { code: 'editor' }, unit_price: 2000 }],
      },
    });
    expect(result.line_id).toBe('l2');
    expect(result.pricing_approval).toBe('pending');
  });

  test('pricing_approval 列が無い line（migration 未適用）は approved 扱い', () => {
    const lines = [makeLine({ id: 'l1' })]; // pricing_approval 未定義
    const result = resolveCreativeRoleCost({
      creative: { id: 'c1', project_id: 'p1', line_id: 'l1' },
      roleCode: 'editor',
      linesByProject: { p1: lines },
      lineCostsByLine: { l1: [{ id: 'lc1', role: { code: 'editor' }, unit_price: 100 }] },
    });
    expect(result.pricing_approval).toBe('approved');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// buildCreativeLineCandidates — 単価解決に使う候補 line の選定（ADR 031）
// creatives.line_id が NULL のクリエイティブを「単価不明」にしないための経路。
// ─────────────────────────────────────────────────────────────────────────
describe('buildCreativeLineCandidates（単価解決の候補 line）', () => {
  function line(over = {}) {
    return {
      id: 'l1',
      project_id: 'p1',
      status: 'contracted',
      category_id: 'cat-video',
      rank: null,
      applies_from: null,
      applies_to: null,
      client_unit_price: 10000,
      planned_count: 0,
      ...over,
    };
  }
  const CATEGORY_ID_BY_CODE = new Map([['video', 'cat-video'], ['image', 'cat-image']]);

  test('creative が無ければ空配列', () => {
    expect(buildCreativeLineCandidates()).toEqual([]);
    expect(buildCreativeLineCandidates({ creative: null })).toEqual([]);
  });

  test('line_id NULL でも creative_type からカテゴリ一致の line を候補にする（categoryIdByCode 経由）', () => {
    const lines = [line({ id: 'video-A', rank: 'A' }), line({ id: 'image-A', category_id: 'cat-image' })];
    const got = buildCreativeLineCandidates({
      creative: { project_id: 'p1', line_id: null, category_id: null, creative_type: 'video_short' },
      linesByProject: new Map([['p1', lines]]),
      categoryIdByCode: CATEGORY_ID_BY_CODE,
    });
    expect(got.map(l => l.id)).toEqual(['video-A']);
  });

  test('rankFirst=true: rank 一致なら status が draft でも rank 不一致の contracted より優先（ADR 031）', () => {
    const lines = [
      line({ id: 'A-contracted', rank: 'A', status: 'contracted' }),
      line({ id: 'C-draft',      rank: 'C', status: 'draft' }),
    ];
    const got = buildCreativeLineCandidates({
      creative: { project_id: 'p1', line_id: null, creative_type: 'video_short' },
      rankApplied: 'C',
      linesByProject: new Map([['p1', lines]]),
      categoryIdByCode: CATEGORY_ID_BY_CODE,
      rankFirst: true,
    });
    expect(got[0].id).toBe('C-draft');
  });

  test('rankFirst=true でも cancelled / rejected は候補から外す', () => {
    const lines = [
      line({ id: 'C-cancelled', rank: 'C', status: 'cancelled' }),
      line({ id: 'A-contracted', rank: 'A', status: 'contracted' }),
    ];
    const got = buildCreativeLineCandidates({
      creative: { project_id: 'p1', line_id: null, creative_type: 'video_short' },
      rankApplied: 'C',
      linesByProject: new Map([['p1', lines]]),
      categoryIdByCode: CATEGORY_ID_BY_CODE,
      rankFirst: true,
    });
    expect(got.map(l => l.id)).toEqual(['A-contracted']);
  });

  test('rankFirst 未指定（請求側）は従来どおり status=ACTIVE のみ・rank 一致を先頭に寄せる', () => {
    const lines = [
      line({ id: 'A-contracted', rank: 'A', status: 'contracted' }),
      line({ id: 'C-draft',      rank: 'C', status: 'draft' }),
      line({ id: 'C-delivered',  rank: 'C', status: 'delivered' }),
    ];
    const got = buildCreativeLineCandidates({
      creative: { project_id: 'p1', line_id: null, creative_type: 'video_short' },
      rankApplied: 'C',
      linesByProject: new Map([['p1', lines]]),
      categoryIdByCode: CATEGORY_ID_BY_CODE,
    });
    expect(got.map(l => l.id)).toEqual(['C-delivered', 'A-contracted']);
  });

  test('asOf 指定時は適用期間（ADR 025）外の line を候補から外す', () => {
    const lines = [
      line({ id: 'old', applies_from: '2026-01-01', applies_to: '2026-06-30' }),
      line({ id: 'new', applies_from: '2026-07-01', applies_to: null }),
    ];
    const args = {
      creative: { project_id: 'p1', line_id: null, creative_type: 'video_short' },
      linesByProject: new Map([['p1', lines]]),
      categoryIdByCode: CATEGORY_ID_BY_CODE,
      rankFirst: true,
    };
    expect(buildCreativeLineCandidates({ ...args, asOf: '2026-08-31' }).map(l => l.id)).toEqual(['new']);
    expect(buildCreativeLineCandidates({ ...args, asOf: '2026-05-31' }).map(l => l.id)).toEqual(['old']);
  });

  test('カテゴリ一致が無ければ案件内の全 line を候補にする（最後の手段）', () => {
    const lines = [line({ id: 'lp', category_id: 'cat-lp' })];
    const got = buildCreativeLineCandidates({
      creative: { project_id: 'p1', line_id: null, creative_type: 'video_short' },
      linesByProject: new Map([['p1', lines]]),
      categoryIdByCode: CATEGORY_ID_BY_CODE,
      rankFirst: true,
    });
    expect(got.map(l => l.id)).toEqual(['lp']);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// pickCreativeLineId — creatives.line_id に実際に保存する line の決定（ADR 031 補強）
// 「曖昧なら埋めない」が原則。誤った line_id は ADR 030 の単価解決を誤らせる。
// ─────────────────────────────────────────────────────────────────────────
describe('pickCreativeLineId（creatives.line_id の自動紐付け）', () => {
  function line(over = {}) {
    return {
      id: 'l1', project_id: 'p1', status: 'contracted', category_id: 'cat-video',
      rank: null, name: null, applies_from: null, applies_to: null,
      client_unit_price: 10000, planned_count: 0,
      ...over,
    };
  }
  const CATEGORY_ID_BY_CODE = new Map([['video', 'cat-video'], ['image', 'cat-image']]);
  const editorCost = (lineId) => [{ id: `lc-${lineId}`, line_id: lineId, role: { code: 'editor' }, unit_price: 3500 }];
  const creative = (over = {}) => ({
    project_id: 'p1', line_id: null, category_id: null, creative_type: 'video_short',
    creative_assignments: [{ role: 'editor', rank_applied: 'C' }],
    ...over,
  });
  const call = (lines, costsByLine, c) => pickCreativeLineId({
    creative: c,
    linesByProject: new Map([['p1', lines]]),
    costsByLine,
    categoryIdByCode: CATEGORY_ID_BY_CODE,
    asOf: '2026-08-04',
  });

  test('担当者のランクに一致する line を選ぶ（status が draft でも）', () => {
    const lines = [line({ id: 'A', rank: 'A' }), line({ id: 'C', rank: 'C', status: 'draft' })];
    const costs = new Map([['A', editorCost('A')], ['C', editorCost('C')]]);
    expect(call(lines, costs, creative())).toBe('C');
  });

  test('rank 列が NULL の旧データは name の "Cランク" 表記で一致させる（ADR 022 互換）', () => {
    const lines = [
      line({ id: 'A', name: '動画 Aランク (旧 project_rates 移行)' }),
      line({ id: 'C', name: '動画 Cランク (旧 project_rates 移行)' }),
    ];
    const costs = new Map([['A', editorCost('A')], ['C', editorCost('C')]]);
    expect(call(lines, costs, creative())).toBe('C');
  });

  test('ランク一致が無く候補が複数なら埋めない（曖昧なので null）', () => {
    const lines = [line({ id: 'A', rank: 'A' }), line({ id: 'B', rank: 'B' })];
    const costs = new Map([['A', editorCost('A')], ['B', editorCost('B')]]);
    expect(call(lines, costs, creative())).toBeNull();
  });

  test('ランク一致が無くても候補が 1 つに絞れるなら採用する', () => {
    const lines = [line({ id: 'only', rank: 'A' })];
    const costs = new Map([['only', editorCost('only')]]);
    expect(call(lines, costs, creative())).toBe('only');
  });

  test('単価行を持たない line は候補にしない', () => {
    const lines = [line({ id: 'C', rank: 'C' }), line({ id: 'A', rank: 'A' })];
    const costs = new Map([['A', editorCost('A')]]); // C には単価行なし
    expect(call(lines, costs, creative())).toBe('A');
  });

  test('停止済み（applies_to が過去）の line は選ばない', () => {
    const lines = [
      line({ id: 'C-old', rank: 'C', applies_to: '2026-06-30' }),
      line({ id: 'C-new', rank: 'C', applies_from: '2026-07-01' }),
    ];
    const costs = new Map([['C-old', editorCost('C-old')], ['C-new', editorCost('C-new')]]);
    expect(call(lines, costs, creative())).toBe('C-new');
  });

  test('既存の line_id には引きずられず担当ランクで選び直す', () => {
    const lines = [line({ id: 'A', rank: 'A' }), line({ id: 'C', rank: 'C' })];
    const costs = new Map([['A', editorCost('A')], ['C', editorCost('C')]]);
    expect(call(lines, costs, creative({ line_id: 'A' }))).toBe('C');
  });

  test('案件に line が無ければ null', () => {
    expect(call([], new Map(), creative())).toBeNull();
    expect(pickCreativeLineId({})).toBeNull();
  });
});

describe('creativeRankApplied', () => {
  test('制作担当（editor/designer/director_as_editor）の rank_applied を優先', () => {
    expect(creativeRankApplied({ creative_assignments: [
      { role: 'director', rank_applied: 'A' },
      { role: 'editor', rank_applied: 'C' },
    ] })).toBe('C');
  });

  test('制作担当がいなければ最初に見つかった rank_applied', () => {
    expect(creativeRankApplied({ creative_assignments: [{ role: 'director', rank_applied: 'B' }] })).toBe('B');
  });

  test('rank_applied が無ければ null', () => {
    expect(creativeRankApplied({ creative_assignments: [{ role: 'editor', rank_applied: null }] })).toBeNull();
    expect(creativeRankApplied({})).toBeNull();
    expect(creativeRankApplied()).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// lineRankOf — 成果物グループのランク判定（ADR 022 / 旧 project_rates 移行データ互換）
// rank 列が NULL の line が本番に 57/156 件あり、ここを間違えると
// ADR 030 の分類キーが A/B/C で衝突して単価がランクをまたいで揺れる。
// ─────────────────────────────────────────────────────────────────────────
describe('lineRankOf（成果物グループのランク判定）', () => {
  test('rank 列があればそれを大文字で返す', () => {
    expect(lineRankOf({ rank: 'A' })).toBe('A');
    expect(lineRankOf({ rank: 'b', name: '動画 Cランク' })).toBe('B'); // rank 列が優先
  });

  test('rank 列が NULL なら name の「Aランク」表記から判定する', () => {
    expect(lineRankOf({ rank: null, name: '動画 Aランク (旧 project_rates 移行)' })).toBe('A');
    expect(lineRankOf({ rank: null, name: '静止画 Cランク' })).toBe('C');
  });

  test('どちらも無ければ null（分類キーで衝突させないため）', () => {
    expect(lineRankOf({ rank: null, name: '切り抜き編集' })).toBeNull();
    expect(lineRankOf({ rank: null, name: null })).toBeNull();
    expect(lineRankOf(null)).toBeNull();
  });
});
