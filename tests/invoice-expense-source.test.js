// 請求書に立替経費（実費）の額を明細の合計で付ける（utils/invoice-expense-source.js・ADR 046 追補 2026-11-05）
const { EXPENSE_ITEMS_EMBED, withExpenseItems, applyExpenseAmounts } = require('../utils/invoice-expense-source');

test('埋め込みは立替経費の行（expense / hourly_expense・CR に紐付かない）だけに絞る', () => {
  expect(EXPENSE_ITEMS_EMBED).toBe('expense_items:invoice_items(total_amount)');
  const calls = [];
  const q = { in: (k, v) => { calls.push(['in', k, v]); return q; }, is: (k, v) => { calls.push(['is', k, v]); return q; } };
  expect(withExpenseItems(q)).toBe(q);
  expect(calls).toEqual([
    ['in', 'expense_items.cost_type', ['expense', 'hourly_expense']],
    ['is', 'expense_items.creative_id', null],
  ]);
});

test('新方式の請求書だけに expense_amount（明細の合計・無ければ 0）を付け、埋め込みは外す', () => {
  const invoices = [
    { id: 'a', tax_mode: 'exclusive', expense_items: [{ total_amount: 2000 }, { total_amount: 1641 }] },
    { id: 'b', tax_mode: 'exclusive', expense_items: [] },
    { id: 'c', tax_mode: 'exclusive' },                                   // 埋め込みが返らなかった行も 0
    { id: 'old', tax_mode: 'inclusive', expense_items: [{ total_amount: 500 }] },
    null,
  ];
  expect(applyExpenseAmounts(invoices)).toBe(invoices);
  expect(invoices.slice(0, 4)).toEqual([
    { id: 'a', tax_mode: 'exclusive', expense_amount: 3641 },
    { id: 'b', tax_mode: 'exclusive', expense_amount: 0 },
    { id: 'c', tax_mode: 'exclusive', expense_amount: 0 },
    { id: 'old', tax_mode: 'inclusive' },
  ]);
  expect(applyExpenseAmounts(null)).toBeNull();
});
