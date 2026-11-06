// 請求書に立替経費（実費）の額を明細の合計で付ける（utils/invoice-expense-source.js・ADR 046 追補 2026-11-05）
const mockCalls = [];
let mockItems = [];
let mockError = null;
jest.mock('../supabase', () => ({
  from: (table) => {
    const q = { table, in: {}, is: {} };
    const b = {
      select: () => b,
      in: (k, v) => { q.in[k] = v; return b; },
      is: (k, v) => { q.is[k] = v; return b; },
      then: (res, rej) => {
        mockCalls.push(q);
        const data = mockItems.filter(it => q.in.invoice_id.includes(it.invoice_id) && q.in.cost_type.includes(it.cost_type) && it.creative_id == null);
        return Promise.resolve({ data: mockError ? null : data, error: mockError }).then(res, rej);
      },
    };
    return b;
  },
}));
const { attachInvoiceExpenseAmounts } = require('../utils/invoice-expense-source');

beforeEach(() => { mockCalls.length = 0; mockError = null; mockItems = []; });

test('新方式の請求書だけに、立替経費の明細（expense / hourly_expense）の合計を付ける', async () => {
  mockItems = [
    { invoice_id: 'a', cost_type: 'expense', creative_id: null, total_amount: 2000 },
    { invoice_id: 'a', cost_type: 'hourly_expense', creative_id: null, total_amount: 1641 },
    { invoice_id: 'a', cost_type: null, creative_id: null, total_amount: 6000 },          // HFS外の行は数えない
    { invoice_id: 'a', cost_type: 'expense', creative_id: 'c1', total_amount: 999 },       // CR に付いた行は数えない
    { invoice_id: 'b', cost_type: 'base_fee', creative_id: 'c2', total_amount: 5000 },
  ];
  const invoices = [
    { id: 'a', tax_mode: 'exclusive' }, { id: 'b', tax_mode: 'exclusive' },
    { id: 'old', tax_mode: 'inclusive' }, null,
  ];
  const out = await attachInvoiceExpenseAmounts(invoices);
  expect(out).toBe(invoices);
  expect(invoices[0].expense_amount).toBe(3641);
  expect(invoices[1].expense_amount).toBe(0);
  expect('expense_amount' in invoices[2]).toBe(false);
  expect(mockCalls).toHaveLength(1); // 1 クエリ（N+1 にしない）
  expect(mockCalls[0]).toMatchObject({ table: 'invoice_items', in: { invoice_id: ['a', 'b'], cost_type: ['expense', 'hourly_expense'] }, is: { creative_id: null } });
});

test('新方式の請求書が無ければ問い合わせない。取得に失敗したら黙って 0 にせず例外にする', async () => {
  await attachInvoiceExpenseAmounts([{ id: 'old', tax_mode: 'inclusive' }]);
  await attachInvoiceExpenseAmounts([]);
  expect(mockCalls).toHaveLength(0);
  mockError = { message: 'boom' };
  await expect(attachInvoiceExpenseAmounts([{ id: 'a', tax_mode: 'exclusive' }])).rejects.toThrow('立替経費');
});
