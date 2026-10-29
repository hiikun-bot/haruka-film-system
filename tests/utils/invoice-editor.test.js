// tests/utils/invoice-editor.test.js
// 🧾 請求書エディタ（utils/invoice-editor.js・ADR 046）の純関数テスト。
// - 計算（整数・消費税 floor(S*10/100)・源泉 floor(S*1021/10000)・差引）
// - 新方式の適用月（2026-10 から）/ 支払期限＝翌月末
// - 候補 CR の分類（当月 / 前月・未請求（3 か月）/ 未納品）・初稿請求案件（ADR 034）
// - 本人の役割（1 CR × 役割 = 1 行）
// - 提出時チェック（本人 / 納品済み / 二重請求 / 単価未入力 / 参考単価超の理由 / HFS外の理由 / 合計一致）
// - 新方式の請求書でも既存 PDF（ADR 047）の生成が落ちない
// DB 非依存。`TZ=UTC npx jest` と `TZ=Asia/Tokyo npx jest` の両方で同結果になること。

const IE = require('../../utils/invoice-editor');
const { buildInvoicePdfModel, renderInvoicePdf } = require('../../utils/invoice-pdf');

const ME = 'u-me';
const OTHER = 'u-other';

function cr(over = {}) {
  return {
    id: 'c1', file_name: 'hertech_241003_A_15s', status: '納品',
    delivered_at: '2026-10-03T03:00:00.000Z', first_draft_submitted_at: null,
    final_deadline: '2026-10-05', draft_deadline: '2026-09-30',
    delivered_director_ids: [], delivered_producer_ids: [],
    project_id: 'p1',
    projects: { id: 'p1', name: 'hertech', director_id: 'u-dir', producer_id: 'u-pro', billing_timing: 'on_delivery', clients: { name: 'HerTech' } },
    creative_assignments: [{ user_id: ME, role: 'editor', rank_applied: 'A' }],
    ...over,
  };
}

describe('計算（整数）', () => {
  test('ADR の見本: 小計 24,000 → 消費税 2,400 / 税込 26,400 / 源泉 2,450 / 差引 23,950', () => {
    const items = [
      { creative_id: 'c1', cost_type: 'base_fee', unit_price: null },
      { creative_id: 'c2', cost_type: 'base_fee', unit_price: 9000, quantity: 5 }, // CR 行の数量は無視（1 固定）
      { creative_id: null, cost_type: null, label: '撮影補助', unit_price: 15000, quantity: 1 },
    ];
    expect(IE.computeTotals(items, { withholding_enabled: true })).toEqual({
      subtotal: 24000, tax: 2400, total: 26400, withholding: 2450, payout: 23950, withholding_over_limit: false,
    });
  });
  test('端数は切り捨て（消費税・源泉とも floor）', () => {
    const t = IE.computeTotals([{ creative_id: 'c', cost_type: 'base_fee', unit_price: 12345 }]);
    expect(t.tax).toBe(1234);          // 1234.5
    expect(t.withholding).toBe(1260);  // 12345 × 0.1021 = 1260.42…
    expect(t.payout).toBe(12345 + 1234 - 1260);
  });
  test('浮動小数で 1 円ずれる値でも整数演算で正しい', () => {
    // 6,000 × 0.1021 = 612.6000000000001（浮動小数）→ 整数演算で 612
    expect(IE.computeTotals([{ creative_id: 'c', cost_type: 'base_fee', unit_price: 6000 }]).withholding).toBe(612);
  });
  test('源泉なしは 0、差引＝税込', () => {
    const t = IE.computeTotals([{ creative_id: 'c', cost_type: 'base_fee', unit_price: 10000 }], { withholding_enabled: false });
    expect(t.withholding).toBe(0);
    expect(t.payout).toBe(t.total);
    expect(t.withholding_over_limit).toBe(false);
  });
  test('小計が 100 万円を超えたら警告フラグ（源泉ありのときだけ）', () => {
    const items = [{ creative_id: null, label: 'x', manual_reason: 'r', unit_price: 1000001, quantity: 1 }];
    expect(IE.computeTotals(items).withholding_over_limit).toBe(true);
    expect(IE.computeTotals(items, { withholding_enabled: false }).withholding_over_limit).toBe(false);
    expect(IE.computeTotals([{ creative_id: null, label: 'x', unit_price: 1000000, quantity: 1 }]).withholding_over_limit).toBe(false);
  });
  test('HFS外の行は 単価×数量、固定行（時間・一式）は 単価×1', () => {
    expect(IE.lineAmount({ creative_id: null, cost_type: null, unit_price: 3000, quantity: 3 })).toBe(9000);
    expect(IE.lineAmount({ creative_id: null, cost_type: 'hourly_fee', unit_price: 5233, quantity: 2 })).toBe(5233);
    expect(IE.lineAmount({ creative_id: 'c', cost_type: 'base_fee', unit_price: null })).toBe(0);
  });
  test('源泉の既定: 法人は なし、それ以外（個人・個人事業主・未設定）は あり', () => {
    expect(IE.defaultWithholding('corporation')).toBe(false);
    expect(IE.defaultWithholding('sole_proprietor')).toBe(true);
    expect(IE.defaultWithholding('individual')).toBe(true);
    expect(IE.defaultWithholding(null)).toBe(true);
  });
});

describe('入力値の正規化 parseMoney', () => {
  test('空は未入力（null）', () => {
    expect(IE.parseMoney('')).toEqual({ value: null });
    expect(IE.parseMoney(null)).toEqual({ value: null });
    expect(IE.parseMoney('  ')).toEqual({ value: null });
  });
  test('カンマ・円記号・全角数字を数値に', () => {
    expect(IE.parseMoney('12,000').value).toBe(12000);
    expect(IE.parseMoney('¥8000').value).toBe(8000);
    expect(IE.parseMoney('１５０００円').value).toBe(15000);
    expect(IE.parseMoney(0).value).toBe(0);
  });
  test('小数・負数・文字はエラー', () => {
    expect(IE.parseMoney('-1').error).toBeTruthy();
    expect(IE.parseMoney('1.5').error).toBeTruthy();
    expect(IE.parseMoney('abc').error).toBeTruthy();
    expect(IE.parseMoney(1.5).error).toBeTruthy();
    expect(IE.parseMoney(-3).error).toBeTruthy();
  });
});

describe('適用月・日付', () => {
  test('既定は 2026-10 から新方式', () => {
    const from = IE.parseExclusiveFrom(null);
    expect(from).toBe('2026-10');
    expect(IE.isExclusiveYm('2026-09', from)).toBe(false);
    expect(IE.isExclusiveYm('2026-10', from)).toBe(true);
    expect(IE.isExclusiveYm('2027-01', from)).toBe(true);
  });
  test('system_settings の値の揺れを吸収（読めなければ既定）', () => {
    expect(IE.parseExclusiveFrom('2026-11')).toBe('2026-11');
    expect(IE.parseExclusiveFrom('"2026-11"')).toBe('2026-11');
    expect(IE.parseExclusiveFrom('2026-11-01')).toBe('2026-11');
    expect(IE.parseExclusiveFrom('202612')).toBe('2026-12');
    expect(IE.parseExclusiveFrom('x')).toBe('2026-10');
    expect(IE.parseExclusiveFrom('2026-13')).toBe('2026-10');
  });
  test('支払期限は翌月末・請求日は対象月末（年跨ぎ・閏年）', () => {
    expect(IE.paymentDueDate(2026, 10)).toBe('2026-11-30');
    expect(IE.paymentDueDate(2026, 12)).toBe('2027-01-31');
    expect(IE.paymentDueDate(2028, 1)).toBe('2028-02-29');
    expect(IE.invoiceDate(2026, 10)).toBe('2026-10-31');
    expect(IE.invoiceDate(2026, 2)).toBe('2026-02-28');
  });
  test('年月の加減算と遡り起点（3 か月）', () => {
    expect(IE.addMonthsYm('2026-01', -1)).toBe('2025-12');
    expect(IE.lookbackStartYm('2026-10')).toBe('2026-07');
    expect(IE.lookbackStartYm('2027-02')).toBe('2026-11');
  });
  test('JST の月範囲（UTC 前日 15:00 起点）', () => {
    expect(IE.jstMonthRangeIso(2026, 10)).toEqual({ startIso: '2026-09-30T15:00:00.000Z', endIso: '2026-10-31T15:00:00.000Z' });
  });
});

describe('候補 CR の分類', () => {
  test('当月に納品 → billable、計上日は JST の納品日', () => {
    const c = cr();
    expect(IE.classifyCandidate(c, c.projects, '2026-10')).toBe('billable');
    expect(IE.billingDateOf(c, c.projects)).toBe('2026-10-03');
  });
  test('月末深夜の納品は JST で判定（UTC では前月でも JST 当月）', () => {
    const c = cr({ delivered_at: '2026-09-30T15:30:00.000Z' }); // JST 10/1 00:30
    expect(IE.classifyCandidate(c, c.projects, '2026-10')).toBe('billable');
    const d = cr({ delivered_at: '2026-10-31T15:00:00.000Z' }); // JST 11/1 00:00 → 10 月の請求には出さない
    expect(IE.classifyCandidate(d, d.projects, '2026-10')).toBe(null);
  });
  test('前月以前（3 か月以内）の納品 → previous、4 か月前は出さない', () => {
    const c9 = cr({ delivered_at: '2026-09-28T03:00:00.000Z' });
    const c7 = cr({ delivered_at: '2026-07-01T03:00:00.000Z' });
    const c6 = cr({ delivered_at: '2026-06-30T03:00:00.000Z' });
    expect(IE.classifyCandidate(c9, c9.projects, '2026-10')).toBe('previous');
    expect(IE.classifyCandidate(c7, c7.projects, '2026-10')).toBe('previous');
    expect(IE.classifyCandidate(c6, c6.projects, '2026-10')).toBe(null);
  });
  test('新方式の開始月より前（旧方式の月）は遡らない', () => {
    const c9 = cr({ delivered_at: '2026-09-28T03:00:00.000Z' });
    const c10 = cr({ delivered_at: '2026-10-05T03:00:00.000Z' });
    expect(IE.classifyCandidate(c9, c9.projects, '2026-10', { notBeforeYm: '2026-10' })).toBe(null);
    expect(IE.classifyCandidate(c10, c10.projects, '2026-11', { notBeforeYm: '2026-10' })).toBe('previous');
    expect(IE.classifyCandidate(c9, c9.projects, '2026-11', { notBeforeYm: '2026-10' })).toBe(null);
    expect(IE.previousStartYm('2027-03', '2026-10')).toBe('2026-12');
    expect(IE.previousStartYm('2026-11', '2026-10')).toBe('2026-10');
    expect(IE.previousStartYm('2026-11', null)).toBe('2026-08');
  });
  test('未納品で当月締切 → undelivered（計上日なし）、他月締切は出さない', () => {
    const c = cr({ status: 'Dチェック中', delivered_at: null, final_deadline: '2026-10-20' });
    expect(IE.classifyCandidate(c, c.projects, '2026-10')).toBe('undelivered');
    expect(IE.billingDateOf(c, c.projects)).toBe(null);
    const n = cr({ status: 'Dチェック中', delivered_at: null, final_deadline: '2026-11-02' });
    expect(IE.classifyCandidate(n, n.projects, '2026-10')).toBe(null);
  });
  test('delivered_at の無い旧データの納品済みは final_deadline の月で扱う', () => {
    const c = cr({ delivered_at: null, final_deadline: '2026-10-12' });
    expect(IE.classifyCandidate(c, c.projects, '2026-10')).toBe('billable');
    expect(IE.billingDateOf(c, c.projects)).toBe('2026-10-12');
  });
  test('初稿請求案件（on_first_draft）は初稿提出済みなら請求可（§7-1）', () => {
    const proj = { ...cr().projects, billing_timing: 'on_first_draft' };
    const c = cr({ status: 'クライアントチェック中', delivered_at: null, first_draft_submitted_at: '2026-10-08T01:00:00.000Z', projects: proj });
    expect(IE.isBillableCreative(c, proj)).toBe(true);
    expect(IE.classifyCandidate(c, proj, '2026-10')).toBe('billable');
    expect(IE.billingDateOf(c, proj)).toBe('2026-10-08');
    const notYet = cr({ status: '制作中', delivered_at: null, first_draft_submitted_at: null, draft_deadline: '2026-10-15', projects: proj });
    expect(IE.isBillableCreative(notYet, proj)).toBe(false);
    expect(IE.classifyCandidate(notYet, proj, '2026-10')).toBe('undelivered');
  });
  test('通常案件は初稿提出だけでは請求できない', () => {
    const c = cr({ status: 'クライアントチェック中', delivered_at: null, first_draft_submitted_at: '2026-10-08T01:00:00.000Z' });
    expect(IE.isBillableCreative(c, c.projects)).toBe(false);
  });
});

describe('明細の品目名 crItemLabel', () => {
  test('編集（base_fee）は役割を付けない', () => {
    expect(IE.crItemLabel('hertech', 'hertech_241003_A', 'base_fee', '編集')).toBe('hertech｜hertech_241003_A');
  });
  test('編集以外は（役割）を付ける', () => {
    expect(IE.crItemLabel('hertech', 'hertech_241003_A', 'director_fee', 'ディレクション費')).toBe('hertech｜hertech_241003_A（ディレクション費）');
  });
  test('クライアント名が無ければ区切りを付けない', () => {
    expect(IE.crItemLabel('', 'a_001', 'script_fee', '台本作成')).toBe('a_001（台本作成）');
  });
});

describe('本人の役割（1 CR × 役割 = 1 行）', () => {
  test('編集担当 → base_fee（参考単価は担当 role で引く）', () => {
    expect(IE.issuerCostRoles(cr(), ME)).toEqual([{ cost_type: 'base_fee', role_code: 'editor', rank_applied: 'A' }]);
  });
  test('編集もディレクションもしていれば 2 行', () => {
    const c = cr({ delivered_director_ids: [ME] });
    expect(IE.issuerCostRoles(c, ME).map(r => r.cost_type)).toEqual(['base_fee', 'director_fee']);
  });
  test('納品時スナップショットの D が優先（今の projects.director_id ではない）', () => {
    const c = cr({ creative_assignments: [], delivered_director_ids: ['u-old-dir'] });
    expect(IE.issuerCostRoles(c, 'u-dir')).toEqual([]);
    expect(IE.issuerCostRoles(c, 'u-old-dir').map(r => r.cost_type)).toEqual(['director_fee']);
  });
  test('プロデューサー', () => {
    const c = cr({ creative_assignments: [] });
    expect(IE.issuerCostRoles(c, 'u-pro').map(r => r.cost_type)).toEqual(['producer_fee']);
  });
  test('関係ない人は空', () => {
    expect(IE.issuerCostRoles(cr(), OTHER)).toEqual([]);
  });
  test('Wチェック担当だけの CR は請求の役割にならない（制作担当の一覧に混ぜない）', () => {
    const c = cr({ creative_assignments: [{ user_id: OTHER, role: 'editor', rank_applied: 'A' }, { user_id: ME, role: 'wcheck', rank_applied: 'A' }] });
    expect(IE.issuerCostRoles(c, ME)).toEqual([]);
  });
  test('Wチェック担当でも D なら ディレクション費だけ', () => {
    const c = cr({ creative_assignments: [{ user_id: ME, role: 'wcheck', rank_applied: 'A' }], delivered_director_ids: [ME] });
    expect(IE.issuerCostRoles(c, ME).map(r => r.cost_type)).toEqual(['director_fee']);
  });
});

describe('行の注意 lineIssues', () => {
  test('単価未入力', () => {
    expect(IE.lineIssues({ creative_id: 'c', cost_type: 'base_fee', unit_price: null }, 6000).map(i => i.code)).toEqual(['PRICE_MISSING']);
  });
  test('0 円は未入力ではない', () => {
    expect(IE.lineIssues({ creative_id: 'c', cost_type: 'base_fee', unit_price: 0 }, 6000)).toEqual([]);
  });
  test('参考単価より高い → 理由必須（理由があれば OK・参考単価 0 は判定しない）', () => {
    const it = { creative_id: 'c', cost_type: 'base_fee', unit_price: 9000 };
    expect(IE.lineIssues(it, 8000).map(i => i.code)).toEqual(['OVER_REFERENCE_NO_REASON']);
    expect(IE.lineIssues({ ...it, price_change_reason: '追加修正 2 回分' }, 8000)).toEqual([]);
    expect(IE.lineIssues(it, 0)).toEqual([]);
    expect(IE.lineIssues(it, null)).toEqual([]);
    expect(IE.lineIssues({ ...it, unit_price: 8000 }, 8000)).toEqual([]);
  });
  test('HFS外の行は理由・品目・数量が必要', () => {
    const codes = IE.lineIssues({ creative_id: null, cost_type: null, label: '', unit_price: 100, quantity: 0 }).map(i => i.code);
    expect(codes).toEqual(expect.arrayContaining(['MANUAL_NO_REASON', 'LABEL_MISSING', 'QUANTITY_INVALID']));
    expect(IE.lineIssues({ creative_id: null, cost_type: null, label: '撮影補助', unit_price: 100, quantity: 1, manual_reason: '現場対応' })).toEqual([]);
  });
  test('固定行（作業時間・一式）は理由不要', () => {
    expect(IE.lineIssues({ creative_id: null, cost_type: 'hourly_fee', label: '時間報酬', unit_price: 5000, quantity: 1 })).toEqual([]);
  });
});

describe('提出時チェック checkInvoiceForSubmit', () => {
  const base = () => {
    const c1 = cr();
    const c2 = cr({ id: 'c2', file_name: 'acme', delivered_at: '2026-09-28T03:00:00.000Z' });
    const items = [
      { id: 'i1', creative_id: 'c1', cost_type: 'base_fee', unit_price: 6000, quantity: 1 },
      { id: 'i2', creative_id: 'c2', cost_type: 'base_fee', unit_price: 9000, quantity: 1, price_change_reason: '追加修正' },
      { id: 'i3', creative_id: null, cost_type: null, label: '撮影補助', unit_price: 15000, quantity: 1, manual_reason: '現場対応' },
    ];
    return {
      items,
      issuerId: ME,
      creativesById: new Map([['c1', c1], ['c2', c2]]),
      billedKeys: new Set(),
      refPriceByKey: new Map([['c1::base_fee', 6000], ['c2::base_fee', 8000]]),
      withholdingEnabled: true,
      expectedTotal: 33000,   // 小計 30,000 + 消費税 3,000
      expectedPayout: 29937,  // 33,000 − 源泉 floor(30,000×10.21%)=3,063
    };
  };
  const codes = (r) => r.problems.map(p => p.code);

  test('問題なしなら problems は空・合計を返す', () => {
    const r = IE.checkInvoiceForSubmit(base());
    expect(r.problems).toEqual([]);
    expect(r.totals.payout).toBe(29937);
  });
  test('他人の CR', () => {
    const p = base();
    p.creativesById.set('c1', cr({ creative_assignments: [{ user_id: OTHER, role: 'editor' }] }));
    expect(codes(IE.checkInvoiceForSubmit(p))).toContain('NOT_OWN');
  });
  test('自分の役割でない cost_type（編集担当が director_fee を請求）', () => {
    const p = base();
    p.items[0].cost_type = 'director_fee';
    expect(codes(IE.checkInvoiceForSubmit(p))).toContain('NOT_OWN_ROLE');
  });
  test('未納品', () => {
    const p = base();
    p.creativesById.set('c1', cr({ status: 'Dチェック中', delivered_at: null }));
    expect(codes(IE.checkInvoiceForSubmit(p))).toContain('NOT_DELIVERED');
  });
  test('他の提出済み請求書に同じ (creative_id, cost_type)', () => {
    const p = base();
    p.billedKeys = new Set(['c1::base_fee']);
    const r = IE.checkInvoiceForSubmit(p);
    expect(codes(r)).toContain('DUPLICATE');
    expect(r.problems.find(x => x.code === 'DUPLICATE').item_id).toBe('i1');
  });
  test('同じ請求書の中で重複', () => {
    const p = base();
    p.items.push({ id: 'i4', creative_id: 'c1', cost_type: 'base_fee', unit_price: 0, quantity: 1 });
    expect(codes(IE.checkInvoiceForSubmit(p))).toEqual(['DUPLICATE_IN_INVOICE']);
  });
  test('CR が見つからない', () => {
    const p = base();
    p.creativesById.delete('c2');
    expect(codes(IE.checkInvoiceForSubmit(p))).toContain('CREATIVE_NOT_FOUND');
  });
  test('単価未入力', () => {
    const p = base();
    p.items[0].unit_price = null;
    p.expectedTotal = 26400; p.expectedPayout = 23950; // 小計 24,000（ADR の見本と同じ）
    expect(codes(IE.checkInvoiceForSubmit(p))).toEqual(['PRICE_MISSING']);
  });
  test('参考単価超で理由なし', () => {
    const p = base();
    p.items[1].price_change_reason = '';
    expect(codes(IE.checkInvoiceForSubmit(p))).toEqual(['OVER_REFERENCE_NO_REASON']);
  });
  test('HFS外の行に理由なし', () => {
    const p = base();
    p.items[2].manual_reason = ' ';
    expect(codes(IE.checkInvoiceForSubmit(p))).toEqual(['MANUAL_NO_REASON']);
  });
  test('画面の合計とずれていれば TOTAL_MISMATCH（未送信も止める）', () => {
    const p = base();
    p.expectedTotal = 32999;
    expect(codes(IE.checkInvoiceForSubmit(p))).toEqual(['TOTAL_MISMATCH']);
    const q = base();
    delete q.expectedPayout;
    expect(codes(IE.checkInvoiceForSubmit(q))).toEqual(['TOTAL_MISMATCH']);
  });
  test('明細ゼロは EMPTY', () => {
    const p = base();
    p.items = []; p.expectedTotal = 0; p.expectedPayout = 0;
    expect(codes(IE.checkInvoiceForSubmit(p))).toEqual(['EMPTY']);
  });
  test('数量が 1 以外で保存されていても CR 行は 1 本として計算', () => {
    const p = base();
    p.items[0].quantity = 3;
    expect(IE.checkInvoiceForSubmit(p).problems).toEqual([]);
  });
});

describe('新方式の請求書でも既存 PDF（ADR 047）が落ちない', () => {
  const inv = {
    id: 'inv1', invoice_number: 'INV-202610-004', year: 2026, month: 10, status: 'submitted',
    tax_mode: 'exclusive', subtotal_amount: 24000, tax_amount: 2400, total_amount: 26400,
    withholding_enabled: true, withholding_amount: 2450, payout_amount: 23950,
    issuer: { id: ME, full_name: '國貞 優衣' },
    invoice_items: [
      { id: 'i1', creative_id: 'c1', cost_type: 'base_fee', label: '編集', unit: '本', unit_price: 6000, quantity: 1, total_amount: 6000, sort_order: 0, creatives: { file_name: 'a', final_deadline: '2026-10-05' } },
      { id: 'i2', creative_id: 'c2', cost_type: 'base_fee', label: '編集', unit: '本', unit_price: null, quantity: 1, total_amount: 0, sort_order: 1, creatives: { file_name: 'b' } },
      { id: 'i3', creative_id: null, cost_type: null, label: '撮影補助', unit: '式', unit_price: 15000, quantity: 1, total_amount: 15000, sort_order: 2, manual_reason: '現場対応' },
    ],
  };
  test('モデル化・描画とも例外なし（Stage 4 で新方式の描画に置き換える）', async () => {
    const model = buildInvoicePdfModel(inv);
    expect(model.total).toBe(26400);
    const buf = await renderInvoicePdf(model);
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.slice(0, 4).toString()).toBe('%PDF');
  });
});

describe('検索（searchNorm / matchesSearch）', () => {
  test('全角/半角・大文字/小文字・ひらがな/カタカナ・区切り記号の違いを無視する', () => {
    expect(IE.searchNorm('ﾊﾞﾙｾﾛﾅ_15S')).toBe('バルセロナ15s');
    expect(IE.searchNorm('ばるせろな 15s')).toBe('バルセロナ15s');
    expect(IE.matchesSearch('hertech｜バルセロナ_LP-01_v2', 'ばるせろな lp01')).toBe(true);
    expect(IE.matchesSearch('acme_banner_03', 'acme banner03')).toBe(true);
    expect(IE.matchesSearch('acme_banner_03', 'acme 04')).toBe(false);
  });
  test('語が無ければ全部ヒット', () => {
    expect(IE.matchesSearch('anything', '   ')).toBe(true);
  });
});

describe('並び替え（sortRows）', () => {
  const rows = [
    { creative_id: 'a', billing_date: '2026-10-03', client_name: 'Bclient', creative_label: 'b_01' },
    { creative_id: null, cost_type: 'hourly_fee', label: '時間報酬' },
    { creative_id: 'b', billing_date: '2026-10-26', client_name: 'Aclient', creative_label: 'a_01' },
    { creative_id: 'c', billing_date: '2026-10-10', client_name: '', creative_label: 'c_01' },
    { creative_id: null, label: '撮影補助' },
  ];
  const ids = (list) => list.map(r => r.creative_id || r.label);
  test('納品日が新しい順・古い順（CR 以外は元の順で後ろ）', () => {
    expect(ids(IE.sortRows(rows, 'date_desc'))).toEqual(['b', 'c', 'a', '時間報酬', '撮影補助']);
    expect(ids(IE.sortRows(rows, 'date_asc'))).toEqual(['a', 'c', 'b', '時間報酬', '撮影補助']);
  });
  test('クライアント名順（クライアント無しは最後）', () => {
    expect(ids(IE.sortRows(rows, 'client'))).toEqual(['b', 'a', 'c', '時間報酬', '撮影補助']);
  });
  test('知らないモードは元の順のまま・元の配列は変えない', () => {
    expect(ids(IE.sortRows(rows, 'xxx'))).toEqual(ids(rows));
    IE.sortRows(rows, 'date_desc');
    expect(rows[0].creative_id).toBe('a');
  });
});
