// utils/invoice-expense-source.js
// 請求書（invoices 行）に、立替経費（実費）の額を明細（invoice_items）の合計で付ける（ADR 046 追補 2026-11-05）。
//
// invoices に立替経費の列は無い。請求書 PDF は 差引 −（税込 − 源泉）で求める（utils/invoice-editor.js expenseOfInvoice）が、
// 源泉徴収台帳と台帳スナップショットは逆算を使わない。逆算だと「差引が税込 − 源泉より多い」ズレが全部
// 立替経費に見えてしまい、「税込 ＋ 立替経費 − 源泉 ＝ 差引」の整合チェックが効かなくなるため。
//
// 使い方（請求書を取る問い合わせに明細を埋め込む＝追加の往復なし・N+1 なし）:
//   const q = supabase.from('invoices').select(`${COLUMNS}, ${EXPENSE_ITEMS_EMBED}`)…;
//   const { data } = await withExpenseItems(q);
//   applyExpenseAmounts(data);   // 各行に expense_amount が付く
const { EXPENSE_COST_TYPES } = require('./invoice-editor');

const EXPENSE_ITEMS_ALIAS = 'expense_items';
/** invoices の select に足す埋め込み。withExpenseItems で立替経費の行だけに絞る */
const EXPENSE_ITEMS_EMBED = `${EXPENSE_ITEMS_ALIAS}:invoice_items(total_amount)`;

/** 埋め込んだ明細を立替経費の行（cost_type が expense / hourly_expense・CR に紐付かない）だけに絞る。請求書の行は減らない */
function withExpenseItems(query) {
  return query
    .in(`${EXPENSE_ITEMS_ALIAS}.cost_type`, EXPENSE_COST_TYPES)
    .is(`${EXPENSE_ITEMS_ALIAS}.creative_id`, null);
}

/**
 * 新方式（tax_mode='exclusive'）の請求書に expense_amount（埋め込んだ立替経費の明細の合計・無ければ 0）を書き足し、
 * 埋め込み（expense_items）は外す。旧方式の請求書には付けない。渡した配列の要素をそのまま書き換えて返す。
 */
function applyExpenseAmounts(invoices) {
  for (const inv of invoices || []) {
    if (!inv) continue;
    const items = inv[EXPENSE_ITEMS_ALIAS];
    delete inv[EXPENSE_ITEMS_ALIAS];
    if (inv.tax_mode !== 'exclusive') continue;
    inv.expense_amount = (Array.isArray(items) ? items : []).reduce((s, it) => s + (Number(it && it.total_amount) || 0), 0);
  }
  return invoices;
}

module.exports = { EXPENSE_ITEMS_EMBED, withExpenseItems, applyExpenseAmounts };
