const { findCrossMemberDuplicates, lookbackMonths, itemAmount, nameTokens } = require('../../utils/invoice-cross-duplicate');

const users = new Map([
  ['uA', { full_name: '山田 花子', nickname: 'はなこ' }],
  ['uB', { full_name: '佐藤 次郎', nickname: 'じろう' }],
]);
let seq = 0;
const line = (o) => ({ id: `i${++seq}`, invoice_id: `inv-${o.issuer_id}`, year: 2026, month: 10, quantity: 1, ...o });
const run = (items, ym = { year: 2026, month: 10 }) => findCrossMemberDuplicates({ items, usersById: users, ...ym });

describe('findCrossMemberDuplicates', () => {
  test('同じCR・同じ役割を別の2人 → high', () => {
    const r = run([
      line({ issuer_id: 'uA', creative_id: 'c1', cost_type: 'base_fee', unit_price: 4000 }),
      line({ issuer_id: 'uB', creative_id: 'c1', cost_type: 'base_fee', unit_price: 5000 }),
    ]);
    expect(r).toHaveLength(1);
    expect(r[0].level).toBe('high');
  });

  test('同じCR・違う役割・同じ金額 → medium、金額が違えば出さない（編集とD費は普通の組み合わせ）', () => {
    expect(run([
      line({ issuer_id: 'uA', creative_id: 'c1', cost_type: 'director_fee', unit_price: 4000 }),
      line({ issuer_id: 'uB', creative_id: 'c1', cost_type: 'base_fee', unit_price: 4000 }),
    ])[0].level).toBe('medium');
    expect(run([
      line({ issuer_id: 'uA', creative_id: 'c1', cost_type: 'director_fee', unit_price: 1000 }),
      line({ issuer_id: 'uB', creative_id: 'c1', cost_type: 'base_fee', unit_price: 4000 }),
    ])).toHaveLength(0);
  });

  test('同じ人の行どうしは対象外（本人内の二重請求はエディタが止める）', () => {
    expect(run([
      line({ issuer_id: 'uA', creative_id: 'c1', cost_type: 'base_fee', unit_price: 4000 }),
      line({ issuer_id: 'uA', creative_id: 'c1', cost_type: 'base_fee', unit_price: 4000 }),
    ])).toHaveLength(0);
  });

  test('HFS外の行に相手の名前（姓）＋相手に同額の行 → medium（今回の事故の形）', () => {
    const r = run([
      line({ issuer_id: 'uA', creative_id: null, cost_type: 'manual', label: 'カット稿（佐藤さん分）', unit_price: 4000 }),
      line({ issuer_id: 'uB', creative_id: 'c9', creative_name: 'XX_15s_001', cost_type: 'other_fee', unit_price: 4000 }),
    ]);
    expect(r).toHaveLength(1);
    expect(r[0].level).toBe('medium');
    expect(r[0].a.issuer_id).toBe('uA');
  });

  test('HFS外の行に相手のCR名（金額違い）→ low', () => {
    const r = run([
      line({ issuer_id: 'uA', creative_id: null, cost_type: 'manual', label: 'XX_15s_001 カット稿', unit_price: 3000 }),
      line({ issuer_id: 'uB', creative_id: 'c9', creative_name: 'XX_15s_001', cost_type: 'base_fee', unit_price: 4000 }),
    ]);
    expect(r.map(x => x.level)).toEqual(['low']);
  });

  test('HFS外の行に名前だけ（同額なし）→ 人単位で low 1件', () => {
    const r = run([
      line({ issuer_id: 'uA', creative_id: null, cost_type: 'manual', label: 'じろうさん分', unit_price: 3000 }),
      line({ issuer_id: 'uB', creative_id: 'c9', cost_type: 'base_fee', unit_price: 4000 }),
      line({ issuer_id: 'uB', creative_id: 'c8', cost_type: 'base_fee', unit_price: 5000 }),
    ]);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ level: 'low', b: null, b_issuer_id: 'uB' });
  });

  test('立替経費・作業時間・一式の行は見ない', () => {
    expect(run([
      line({ issuer_id: 'uA', creative_id: null, cost_type: 'expense', label: 'じろうさんとのタクシー', unit_price: 4000 }),
      line({ issuer_id: 'uB', creative_id: null, cost_type: 'hourly_fee', label: '作業時間', unit_price: 4000 }),
    ])).toHaveLength(0);
  });

  test('両方とも対象月以外なら出さない／片方が対象月なら出す', () => {
    const a = line({ issuer_id: 'uA', creative_id: 'c1', cost_type: 'base_fee', unit_price: 4000, month: 9 });
    const b = line({ issuer_id: 'uB', creative_id: 'c1', cost_type: 'base_fee', unit_price: 4000, month: 9 });
    expect(run([a, b])).toHaveLength(0);
    expect(run([a, { ...b, month: 10 }])).toHaveLength(1);
  });

  test('強い順に並ぶ', () => {
    const r = run([
      line({ issuer_id: 'uA', creative_id: 'c1', cost_type: 'director_fee', unit_price: 4000 }),
      line({ issuer_id: 'uB', creative_id: 'c1', cost_type: 'base_fee', unit_price: 4000 }),
      line({ issuer_id: 'uA', creative_id: 'c2', cost_type: 'base_fee', unit_price: 1000 }),
      line({ issuer_id: 'uB', creative_id: 'c2', cost_type: 'base_fee', unit_price: 1000 }),
    ]);
    expect(r.map(x => x.level)).toEqual(['high', 'medium']);
  });
});

describe('helpers', () => {
  test('itemAmount', () => {
    expect(itemAmount({ total_amount: 5000, unit_price: 1 })).toBe(5000);
    expect(itemAmount({ unit_price: 2000, quantity: 2 })).toBe(4000);
    expect(itemAmount({ unit_price: 2000 })).toBe(2000);
  });
  test('nameTokens: 姓も使う・1文字は使わない', () => {
    expect(nameTokens({ full_name: '佐藤 次郎', nickname: 'J' })).toEqual(expect.arrayContaining(['佐藤次郎', '佐藤']));
    expect(nameTokens({ full_name: '佐藤 次郎', nickname: 'J' })).not.toContain('j');
  });
  test('lookbackMonths は年をまたぐ', () => {
    expect(lookbackMonths(2026, 2, 3)).toEqual([
      { year: 2025, month: 11 }, { year: 2025, month: 12 }, { year: 2026, month: 1 }, { year: 2026, month: 2 },
    ]);
  });
});
