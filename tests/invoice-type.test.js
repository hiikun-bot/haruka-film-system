// メンバー請求書の判定（utils/invoice-type.js・ADR 054 追補 2026-11-22）
// 本番の invoices はメンバー請求書が invoice_type='member'。`invoice_type IS NULL` だけで探すと 1 件も拾えず、
// 源泉徴収台帳と総合振込が「請求書なし」になっていた。'member' / NULL / 'client' の 3 通りを問い合わせ込みで確かめる。

// ---- PostgREST の絞り込みを真似る偽 DB（eq / in / is / gte / lte / lt / or） ----
// 埋め込み先の列（'expense_items.cost_type' など点つき）は親の行を減らさないので無視する。
const MEMBER_OR = 'invoice_type.is.null,invoice_type.neq.client';
const mockTables = {};
const mockCalls = [];
function mockBuilder(table) {
  let rows = (mockTables[table] || []).map(r => ({ ...r }));
  const keep = (key, fn) => { if (!String(key).includes('.')) rows = rows.filter(fn); };
  const b = {
    select() { return b; },
    limit() { return b; },
    eq(k, v) { mockCalls.push([table, 'eq', k, v]); keep(k, r => r[k] === v); return b; },
    in(k, vs) { mockCalls.push([table, 'in', k, vs]); keep(k, r => vs.includes(r[k])); return b; },
    is(k, v) { mockCalls.push([table, 'is', k, v]); keep(k, r => (v === null ? r[k] == null : r[k] === v)); return b; },
    // SQL と同じく NULL は <> で落ちる（単独の neq を使うと NULL 行が消えることを偽 DB でも再現する）
    neq(k, v) { mockCalls.push([table, 'neq', k, v]); keep(k, r => r[k] != null && r[k] !== v); return b; },
    gte(k, v) { keep(k, r => r[k] >= v); return b; },
    lte(k, v) { keep(k, r => r[k] <= v); return b; },
    lt(k, v) { keep(k, r => r[k] < v); return b; },
    or(expr) {
      mockCalls.push([table, 'or', expr]);
      if (expr !== MEMBER_OR) throw new Error(`偽 DB が知らない or: ${expr}`);
      rows = rows.filter(r => r.invoice_type == null || r.invoice_type !== 'client');
      return b;
    },
    then(resolve, reject) { return Promise.resolve({ data: rows, error: null }).then(resolve, reject); },
  };
  return b;
}
jest.mock('../supabase', () => ({ from: (table) => mockBuilder(table) }));

const { CLIENT_INVOICE_TYPE, MEMBER_INVOICE_OR_FILTER, isMemberInvoice, onlyMemberInvoices } = require('../utils/invoice-type');

function invoice(over = {}) {
  return {
    id: 'i1', invoice_number: 'INV-2610-01', issuer_id: 'u1', status: 'submitted', year: 2026, month: 10, invoice_type: 'member',
    tax_mode: 'exclusive', subtotal_amount: 100000, tax_amount: 10000, total_amount: 110000, withholding_amount: 10210, payout_amount: 99790,
    withholding_enabled: true, submitted_at: '2026-11-01T01:00:00Z',
    ...over,
  };
}
function setTables(t) {
  for (const k of Object.keys(mockTables)) delete mockTables[k];
  Object.assign(mockTables, t);
  mockCalls.length = 0;
}
const invoiceTypeCalls = () => mockCalls.filter(c => c[0] === 'invoices' && (c[1] === 'or' || c[2] === 'invoice_type'));

describe('isMemberInvoice / onlyMemberInvoices', () => {
  test("'member'・NULL・未設定はメンバー請求書、'client' だけが対象外", () => {
    expect(isMemberInvoice({ invoice_type: 'member' })).toBe(true);
    expect(isMemberInvoice({ invoice_type: null })).toBe(true);
    expect(isMemberInvoice({})).toBe(true);
    expect(isMemberInvoice({ invoice_type: 'client' })).toBe(false);
    expect(isMemberInvoice(null)).toBe(false);
    expect(isMemberInvoice(undefined)).toBe(false);
    expect(CLIENT_INVOICE_TYPE).toBe('client');
  });

  test('問い合わせには or（NULL または client 以外）を足す。単独の is(null) / neq は使わない', () => {
    expect(MEMBER_INVOICE_OR_FILTER).toBe(MEMBER_OR);
    const calls = [];
    const q = { or: (expr) => { calls.push(['or', expr]); return q; } };
    expect(onlyMemberInvoices(q)).toBe(q);
    expect(calls).toEqual([['or', MEMBER_OR]]);
  });

  test("偽 DB: or は 'member' と NULL を残す（単独の neq だと NULL が落ちる）", async () => {
    setTables({ invoices: [invoice({ id: 'm' }), invoice({ id: 'n', invoice_type: null }), invoice({ id: 'c', invoice_type: 'client' })] });
    const viaOr = await onlyMemberInvoices(mockBuilder('invoices'));
    expect(viaOr.data.map(r => r.id)).toEqual(['m', 'n']);
    const viaNeq = await mockBuilder('invoices').neq('invoice_type', 'client');
    expect(viaNeq.data.map(r => r.id)).toEqual(['m']);
    const viaIsNull = await mockBuilder('invoices').is('invoice_type', null);
    expect(viaIsNull.data.map(r => r.id)).toEqual(['n']);
  });
});

describe('総合振込: 請求書の取得（utils/bank-transfer.js）', () => {
  const bt = require('../utils/bank-transfer');
  const plan = require('../utils/bank-transfer-plan');
  const NOW = Date.UTC(2026, 10, 1, 0, 0, 0);
  const user = (over = {}) => ({
    id: 'u1', full_name: '山田 花子', nickname: 'はな', is_active: true,
    bank_code: '0310', branch_code: '101', account_type: '普通', account_number: '1234567',
    account_holder_kana: 'ヤマダ　ハナコ', bank_info_updated_at: null, ...over,
  });
  const record = (over = {}) => ({ id: 'r1', user_id: 'u1', year: 2026, month: 10, status: 'unpaid', invoice_amount: 110000, ...over });

  test.each([['member'], [null]])('loadPlanInputs: invoice_type=%p の請求書を拾い、明細は請求書の額になる', async (type) => {
    setTables({ payout_records: [record()], users: [user()], invoices: [invoice({ invoice_type: type })], payout_transfer_batches: [] });
    const inputs = await bt.loadPlanInputs({ year: 2026, month: 10, payoutRecordIds: ['r1'] });
    expect(inputs.invoices.map(i => i.id)).toEqual(['i1']);
    expect(invoiceTypeCalls()).toEqual([['invoices', 'or', MEMBER_OR]]);
    const r = plan.planTransferItems({ ...inputs, year: 2026, month: 10, now: NOW });
    expect(r.items[0].amount_source).toBe('invoice');
    expect(r.items[0].amount).toBe(99790);
    expect(r.items[0].gross_amount).toBe(110000);
    expect(r.items[0].withholding_amount).toBe(10210);
    expect(r.warnings).toEqual([]);
  });

  test("loadPlanInputs: 'client' の請求書は拾わない（PDF 抽出額＋警告のまま）", async () => {
    setTables({ payout_records: [record({ invoice_amount: 45000 })], users: [user()], invoices: [invoice({ invoice_type: 'client' })], payout_transfer_batches: [] });
    const inputs = await bt.loadPlanInputs({ year: 2026, month: 10, payoutRecordIds: ['r1'] });
    expect(inputs.invoices).toEqual([]);
    const r = plan.planTransferItems({ ...inputs, year: 2026, month: 10, now: NOW });
    expect(r.items[0].amount_source).toBe('pdf');
    expect(r.items[0].warnings).toContain('請求書なし（PDF 抽出額を使用）');
  });

  test.each([['member'], [null]])('loadLedgerSnapshotForRecord: invoice_type=%p なら源泉額・税抜額が入る', async (type) => {
    setTables({ invoices: [invoice({ invoice_type: type, expense_items: [{ total_amount: 2000 }], payout_amount: 101790 })] });
    const snap = await bt.loadLedgerSnapshotForRecord(record(), 101790);
    expect(invoiceTypeCalls()).toEqual([['invoices', 'or', MEMBER_OR]]);
    expect(snap).toMatchObject({
      amount: 101790, invoice_id: 'i1', invoice_count: 1,
      subtotal_amount: 100000, tax_amount: 10000, withholding_amount: 10210, total_amount: 110000, expense_amount: 2000,
    });
  });

  test("loadLedgerSnapshotForRecord: 'client' しか無ければ請求書なしのスナップショット", async () => {
    setTables({ invoices: [invoice({ invoice_type: 'client' })] });
    const snap = await bt.loadLedgerSnapshotForRecord(record(), 45000);
    expect(snap).toMatchObject({ amount: 45000, invoice_id: null, invoice_count: 0, subtotal_amount: null, withholding_amount: null });
  });
});

describe('源泉徴収台帳: 請求書の取得（utils/withholding-ledger-source.js）', () => {
  const source = require('../utils/withholding-ledger-source');
  const ledger = require('../utils/withholding-ledger');
  // 2026-11-05 10:00 JST に手動で消し込んだ 10 月分（ledger_snapshot 無し＝現在の請求書から組み立てる行）
  const paidRecord = (over = {}) => ({
    id: 'r1', user_id: 'u1', year: 2026, month: 10, invoice_amount: 99790, amount_source: 'manual', status: 'paid',
    paid_at: '2026-11-05T01:00:00.000Z', paid_via: 'manual', transfer_item_id: null, ledger_snapshot: null, ...over,
  });
  const tables = (invoices) => ({
    payout_transfer_items: [], payout_records: [paidRecord()],
    users: [{ id: 'u1', full_name: '山田 花子', nickname: 'はな' }], invoices,
  });

  test.each([['member'], [null]])('loadPayments: invoice_type=%p の請求書が支払行に付く', async (type) => {
    setTables(tables([invoice({ invoice_type: type })]));
    const { payments } = await source.loadPayments(ledger.jstRange(2026, 11));
    expect(payments).toHaveLength(1);
    expect(payments[0].invoice).toMatchObject({ id: 'i1', withholding_amount: 10210, subtotal_amount: 100000 });
    expect(payments[0].invoice_amount).toBeNull();
    expect(invoiceTypeCalls()).toEqual([['invoices', 'or', MEMBER_OR]]);
  });

  test("loadPayments: 'client' の請求書は付かない（請求書なしの支払として扱う）", async () => {
    setTables(tables([invoice({ invoice_type: 'client' })]));
    const { payments } = await source.loadPayments(ledger.jstRange(2026, 11));
    expect(payments).toHaveLength(1);
    expect(payments[0].invoice).toBeNull();
    expect(payments[0].invoice_amount).toBe(99790);
  });

  test("buildMonthReport: 'member' の請求書なら月次集計に源泉額が出る（支払月＝JST の 11 月）", async () => {
    setTables(tables([invoice()]));
    const nov = await source.buildMonthReport(2026, 11);
    expect(nov.rows).toHaveLength(1);
    expect(JSON.stringify(nov.summary)).toContain('10210');
    const oct = await source.buildMonthReport(2026, 10);
    expect(oct.rows).toHaveLength(0);
  });

  test('訂正前に消し込んだ支払（請求書なしで保存された ledger_snapshot）も、現在の請求書から源泉額が出る', async () => {
    const plan = require('../utils/bank-transfer-plan');
    const emptySnapshot = plan.buildLedgerSnapshot({ amount: 99790, invoices: [], now: new Date('2026-11-05T01:00:00Z') });
    expect(emptySnapshot).toMatchObject({ invoice_id: null, subtotal_amount: null, payout_amount: null });
    const t = tables([invoice()]);
    t.payout_records = [paidRecord({ ledger_snapshot: emptySnapshot })];
    setTables(t);
    const nov = await source.buildMonthReport(2026, 11);
    expect(nov.rows).toHaveLength(1);
    expect(nov.rows[0].from_snapshot).toBe(false);
    expect(JSON.stringify(nov.rows[0])).toContain('10210');
    expect(JSON.stringify(nov.rows[0])).toContain('スナップショット無し');
  });
});
