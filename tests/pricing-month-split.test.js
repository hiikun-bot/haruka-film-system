// 単価の月またぎ分割（ADR 037 追補その3）を、メモリ上の偽 DB で動かして確かめる。
// PR #1269 の指摘（保存失敗で承認待ちが承認済みに化ける／分割失敗でも保存が続く／同時保存／予定本数の二重計上）の再発防止。
const { createMonthlyPricingSplitter } = require('../utils/pricing-month-split');

// ---- 最小限の偽 supabase（このモジュールが使う書き方だけ） ----
function createFakeDb(seed, { failOn = {} } = {}) {
  const tables = JSON.parse(JSON.stringify(seed));
  let seq = 1000;
  const from = (table) => {
    const st = { table, op: 'select', filters: [], orFilter: null, payload: null, head: false, count: null, single: false, maybe: false, returning: false };
    const rows = () => (tables[table] ||= []);
    const match = (r) => st.filters.every(f => f(r)) && (!st.orFilter || st.orFilter(r));
    const run = () => {
      if (failOn[`${table}.${st.op}`]) return { data: null, error: { message: `fake ${table}.${st.op} failure` } };
      if (st.op === 'select') {
        const hit = rows().filter(match);
        if (st.head) return { data: null, count: hit.length, error: null };
        if (st.single || st.maybe) return { data: hit[0] ? { ...hit[0] } : null, error: null };
        return { data: hit.map(r => ({ ...r })), error: null };
      }
      if (st.op === 'insert') {
        const list = (Array.isArray(st.payload) ? st.payload : [st.payload]).map(r => ({ id: `id${seq++}`, ...r }));
        if (table === 'project_estimate_lines') list.forEach(r => { if (!r.pricing_approval) r.pricing_approval = 'approved'; });
        rows().push(...list);
        const out = list.map(r => ({ ...r }));
        return { data: st.single ? out[0] : out, error: null };
      }
      if (st.op === 'update') {
        const hit = rows().filter(match);
        hit.forEach(r => Object.assign(r, st.payload));
        return { data: st.returning ? hit.map(r => ({ ...r })) : null, error: null };
      }
      if (st.op === 'delete') {
        const keep = rows().filter(r => !match(r));
        const removed = rows().length - keep.length;
        tables[table] = keep;
        if (table === 'project_estimate_lines') {
          const alive = new Set(keep.map(l => l.id));
          tables.project_estimate_line_costs = (tables.project_estimate_line_costs || []).filter(c => alive.has(c.line_id));
        }
        return { data: null, error: null, count: removed };
      }
      return { data: null, error: null };
    };
    const q = {
      select(_cols, opts) { if (st.op !== 'select') st.returning = true; if (opts?.head) st.head = true; return q; },
      insert(p) { st.op = 'insert'; st.payload = p; return q; },
      update(p) { st.op = 'update'; st.payload = p; return q; },
      delete() { st.op = 'delete'; return q; },
      eq(k, v) { st.filters.push(r => r[k] === v); return q; },
      is(k, v) { st.filters.push(r => (r[k] ?? null) === v); return q; },
      lt(k, v) { st.filters.push(r => r[k] != null && r[k] < v); return q; },
      in(k, vs) { st.filters.push(r => vs.includes(r[k])); return q; },
      or(expr) {
        // 'delivered_at.is.null,delivered_at.gte.<iso>' だけ対応
        const m = /^delivered_at\.is\.null,delivered_at\.gte\.(.+)$/.exec(expr);
        st.orFilter = (r) => r.delivered_at == null || r.delivered_at >= m[1];
        return q;
      },
      order() { return q; },
      single() { st.single = true; return q; },
      maybeSingle() { st.maybe = true; return q; },
      then(res, rej) { return Promise.resolve(run()).then(res, rej); },
    };
    return q;
  };
  return { supabase: { from }, tables };
}

const seedBase = () => ({
  project_estimate_lines: [{
    id: 'L1', project_id: 'P1', category_id: 'C1', rank: 'B', name: '【リサイズ】動画', planned_count: 10,
    client_unit_price: 3000, sort_order: 10, currency: 'JPY', tax_included: true, status: 'contracted',
    applies_from: null, applies_to: null, pricing_approval: 'approved', pricing_prev_snapshot: null,
  }],
  project_estimate_line_costs: [
    { id: 'K1', line_id: 'L1', role_id: 'R_editor', user_id: null, unit_price: 3000, pricing_type: 'fixed_per_unit', percentage: null, actual_hours: null },
    { id: 'K2', line_id: 'L1', role_id: 'R_director', user_id: null, unit_price: 500, pricing_type: 'fixed_per_unit', percentage: null, actual_hours: null },
  ],
  creatives: [
    { id: 'CR_sep1', line_id: 'L1', delivered_at: '2026-09-20T03:00:00.000Z' },
    { id: 'CR_sep2', line_id: 'L1', delivered_at: '2026-09-30T14:59:59.000Z' }, // 9/30 23:59 JST
    { id: 'CR_oct',  line_id: 'L1', delivered_at: '2026-09-30T15:00:00.000Z' }, // 10/1 0:00 JST
    { id: 'CR_wip',  line_id: 'L1', delivered_at: null },
  ],
  line_payment_installments: [],
});

function makeSplitter(db) {
  return createMonthlyPricingSplitter({
    supabase: db.supabase,
    todayStrJST: () => '2026-10-28',
    buildLinePricingSnapshot: async (lineId) => ({
      client_unit_price: db.tables.project_estimate_lines.find(l => l.id === lineId)?.client_unit_price || 0,
      costs: db.tables.project_estimate_line_costs.filter(c => c.line_id === lineId).map(c => ({ role_id: c.role_id, unit_price: c.unit_price })),
    }),
    isMissingAppliesColumn: () => false,
    isMissingPricingApprovalColumn: () => false,
    isMissingLpiTable: () => false,
    monthlyFeeLinePrefix: '月額定額',
    notifyAutoError: async () => ({ ok: true }),
  });
}
const line = (db, id) => db.tables.project_estimate_lines.find(l => l.id === id);
const lineOf = (db, crId) => db.tables.creatives.find(c => c.id === crId).line_id;

describe('splitLineForMonthlyPricing', () => {
  test('先月以前の納品分は旧グループ、今月分・未納品は新グループへ。旧は先月末で停止', async () => {
    const db = createFakeDb(seedBase());
    const req = {};
    const sp = await makeSplitter(db).splitLineForMonthlyPricing(req, 'L1');
    expect(sp.error).toBeUndefined();
    expect(sp.split).toEqual({ from_line_id: 'L1', to_line_id: sp.lineId, applies_from: '2026-10-01' });
    expect(line(db, 'L1').applies_to).toBe('2026-09-30');
    expect(line(db, sp.lineId).applies_from).toBe('2026-10-01');
    expect(lineOf(db, 'CR_sep1')).toBe('L1');
    expect(lineOf(db, 'CR_sep2')).toBe('L1');
    expect(lineOf(db, 'CR_oct')).toBe(sp.lineId);
    expect(lineOf(db, 'CR_wip')).toBe(sp.lineId);
    // 単価行は写され、cost id が付け替えられる
    expect(sp.costIdMap.get('K1')).toBeTruthy();
    expect(db.tables.project_estimate_line_costs.filter(c => c.line_id === sp.lineId)).toHaveLength(2);
    // 承認権限のない人の書き込みで承認待ちにするときの分け元つきスナップショット
    expect(req._pricingSplitSnapshots.get(sp.lineId)).toMatchObject({ split_from_line_id: 'L1', split_applies_from: '2026-10-01' });
  });

  test('予定本数は旧（先月以前の納品数）と新（残り）で分け合い、合計は変わらない', async () => {
    const db = createFakeDb(seedBase());
    const sp = await makeSplitter(db).splitLineForMonthlyPricing({}, 'L1');
    expect(line(db, 'L1').planned_count).toBe(2);
    expect(line(db, sp.lineId).planned_count).toBe(8);
  });

  test('旧グループが承認待ちなら、新グループも作成時点で承認待ち（承認済みに化けない）', async () => {
    const seed = seedBase();
    Object.assign(seed.project_estimate_lines[0], {
      pricing_approval: 'pending', pricing_requested_by: 'U_dir', pricing_requested_at: '2026-09-27T00:00:00Z',
      pricing_prev_snapshot: { client_unit_price: 3000, costs: [{ role_id: 'R_editor', unit_price: 3000 }] },
    });
    const db = createFakeDb(seed);
    const req = {};
    const sp = await makeSplitter(db).splitLineForMonthlyPricing(req, 'L1');
    const nl = line(db, sp.lineId);
    expect(nl.pricing_approval).toBe('pending');
    expect(nl.pricing_requested_by).toBe('U_dir');
    expect(nl.pricing_prev_snapshot).toMatchObject({ client_unit_price: 3000, split_from_line_id: 'L1', split_applies_from: '2026-10-01' });
    expect(req._pricingSplitSnapshots).toBeUndefined();
  });

  test('一度も承認されていない新規グループ（スナップショット無し）でも分け元を持つ', async () => {
    const seed = seedBase();
    Object.assign(seed.project_estimate_lines[0], { pricing_approval: 'pending', pricing_prev_snapshot: null });
    const db = createFakeDb(seed);
    const sp = await makeSplitter(db).splitLineForMonthlyPricing({}, 'L1');
    expect(line(db, sp.lineId).pricing_prev_snapshot).toMatchObject({ split_from_line_id: 'L1', costs: [] });
  });

  test('同時保存: 旧グループが先に止められていたら 409（二重に分けない・旧へ書かない）', async () => {
    const db = createFakeDb(seedBase());
    const splitter = makeSplitter(db);
    const [a, b] = await Promise.all([
      splitter.splitLineForMonthlyPricing({}, 'L1'),
      splitter.splitLineForMonthlyPricing({ query: { expect_active: '1' } }, 'L1'),
    ]);
    const results = [a, b];
    expect(results.filter(r => r.split)).toHaveLength(1);
    expect(results.filter(r => r.error?.status === 409)).toHaveLength(1);
    expect(db.tables.project_estimate_lines).toHaveLength(2);
  });

  test('画面では現役だと思って編集したが既に停止済み（expect_active=1）なら 409。過去月の訂正（指定なし）は通す', async () => {
    const seed = seedBase();
    seed.project_estimate_lines[0].applies_to = '2026-09-30';
    const db = createFakeDb(seed);
    const splitter = makeSplitter(db);
    expect((await splitter.splitLineForMonthlyPricing({ query: { expect_active: '1' } }, 'L1')).error.status).toBe(409);
    const ok = await splitter.splitLineForMonthlyPricing({}, 'L1');
    expect(ok.error).toBeUndefined();
    expect(ok.split).toBeNull();
    expect(ok.lineId).toBe('L1');
  });

  test.each([
    ['単価行の複製', 'project_estimate_line_costs.insert'],
    ['クリエイティブの付け替え', 'creatives.update'],
    ['新グループの作成', 'project_estimate_lines.insert'],
  ])('%s に失敗したら元に戻してエラーを返す（保存を続けさせない）', async (_label, failKey) => {
    const db = createFakeDb(seedBase(), { failOn: { [failKey]: true } });
    const sp = await makeSplitter(db).splitLineForMonthlyPricing({}, 'L1');
    expect(sp.error.status).toBe(500);
    expect(sp.split).toBeNull();
    // 1 グループのまま・停止も予定本数も元どおり
    expect(db.tables.project_estimate_lines).toHaveLength(1);
    expect(line(db, 'L1')).toMatchObject({ applies_to: null, planned_count: 10 });
  });

  test('読み取りに失敗したらエラー（分けずに旧グループへ書き込ませない）', async () => {
    const db = createFakeDb(seedBase(), { failOn: { 'creatives.select': true } });
    const sp = await makeSplitter(db).splitLineForMonthlyPricing({}, 'L1');
    expect(sp.error.status).toBe(500);
    expect(line(db, 'L1').applies_to).toBeNull();
  });

  test.each([
    ['先月以前の納品が無い', (s) => { s.creatives = s.creatives.filter(c => !c.id.startsWith('CR_sep')); }],
    ['単価が未入力（¥0 の入れ忘れは遡って直す）', (s) => { s.project_estimate_lines[0].client_unit_price = 0; s.project_estimate_line_costs.forEach(c => { c.unit_price = 0; }); }],
    ['一式（fixed_total）の単価行がある', (s) => { s.project_estimate_line_costs[0].pricing_type = 'fixed_total'; }],
    ['分割支払がある', (s) => { s.line_payment_installments.push({ id: 'I1', line_id: 'L1' }); }],
    ['月額定額', (s) => { s.project_estimate_lines[0].name = '月額定額（川崎）'; }],
  ])('分けない: %s', async (_label, mutate) => {
    const seed = seedBase();
    mutate(seed);
    const db = createFakeDb(seed);
    const sp = await makeSplitter(db).splitLineForMonthlyPricing({}, 'L1');
    expect(sp.error).toBeUndefined();
    expect(sp.split).toBeNull();
    expect(db.tables.project_estimate_lines).toHaveLength(1);
  });
});

describe('undoMonthlySplit', () => {
  test('書き込み失敗後に呼ぶと、分ける前の 1 グループ（予定本数・クリエイティブ・停止解除）に戻る', async () => {
    const db = createFakeDb(seedBase());
    const splitter = makeSplitter(db);
    const sp = await splitter.splitLineForMonthlyPricing({}, 'L1');
    await splitter.undoMonthlySplit(sp.split);
    expect(db.tables.project_estimate_lines).toHaveLength(1);
    expect(line(db, 'L1')).toMatchObject({ applies_to: null, planned_count: 10 });
    expect(db.tables.creatives.every(c => c.line_id === 'L1')).toBe(true);
    expect(db.tables.project_estimate_line_costs.every(c => c.line_id === 'L1')).toBe(true);
  });
});
