// utils/invoice-expense-source.js
// 請求書（invoices 行）に、立替経費（実費）の額を明細（invoice_items）の合計で付ける（ADR 046 追補 2026-11-05）。
//
// invoices に立替経費の列は無い。画面・PDF は 差引 −（税込 − 源泉）で求める（utils/invoice-editor.js expenseOfInvoice）が、
// 源泉徴収台帳と台帳スナップショットは逆算を使わない。逆算だと「差引が税込 − 源泉より多い」ズレが全部
// 立替経費に見えてしまい、「税込 ＋ 立替経費 − 源泉 ＝ 差引」の整合チェックが効かなくなるため。
const supabase = require('../supabase');
const { EXPENSE_COST_TYPES } = require('./invoice-editor');

const IN_CHUNK = 200;

/**
 * 新方式（tax_mode='exclusive'）の請求書に expense_amount（立替経費の明細の合計・無ければ 0）を書き足す。
 * 旧方式の請求書は触らない。渡した配列の要素をそのまま書き換えて返す。
 */
async function attachInvoiceExpenseAmounts(invoices) {
  const targets = (invoices || []).filter(inv => inv && inv.id && inv.tax_mode === 'exclusive');
  if (!targets.length) return invoices;
  const sums = new Map();
  const ids = targets.map(inv => inv.id);
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const { data, error } = await supabase.from('invoice_items')
      .select('invoice_id, total_amount')
      .in('invoice_id', ids.slice(i, i + IN_CHUNK))
      .in('cost_type', EXPENSE_COST_TYPES)
      .is('creative_id', null);
    if (error) throw new Error(`invoice_items（立替経費）取得失敗: ${error.message}`);
    for (const it of data || []) sums.set(it.invoice_id, (sums.get(it.invoice_id) || 0) + (Number(it.total_amount) || 0));
  }
  for (const inv of targets) inv.expense_amount = sums.get(inv.id) || 0;
  return invoices;
}

module.exports = { attachInvoiceExpenseAmounts };
