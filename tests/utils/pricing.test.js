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
  const EMPTY = { unit_price: 0, line_id: null, line_cost_id: null };

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
    expect(result).toEqual({ unit_price: 2000, line_id: 'l2', line_cost_id: 'lc2' });
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
    expect(result).toEqual({ unit_price: 5000, line_id: 'l2', line_cost_id: 'lc2' });
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
    expect(result).toEqual({ unit_price: 0, line_id: 'l1', line_cost_id: 'lc1' });
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
});
