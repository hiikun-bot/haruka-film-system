// ADR 046 Stage 4: 振込管理の新方式（税抜＋源泉）対応
// - PDF 抽出は「差引お振込額」を最優先（「ご請求金額（税込）」より優先）・旧方式の結果は不変
// - HFS 製 PDF は DB の payout_amount を正（hfsInvoicePayoutAmount）
// - 合算（sumInvoicePdfAmounts）と差分チェックの基準額（resolveDiffInvoiceBasis / taxExclusive）
const {
  extractInvoiceAmount,
  evaluatePayoutDiff,
  evaluatePayoutDiffMulti,
  hfsInvoicePayoutAmount,
  countedInvoicePdfFiles,
  sumInvoicePdfAmounts,
  resolveDiffInvoiceBasis,
} = require('../../utils/payout');

// Stage 4 前（origin/main）の payoutSumInvoiceAmount（routes/haruka.js）と同じ処理。旧データで結果が変わらないことの比較用
function legacySum(pdfFiles) {
  const candidates = (pdfFiles || []).filter(f => !/削除|テンプレ/.test(String(f.name || '')));
  const priced = candidates.filter(f => Number.isFinite(Number(f.amount)) && Number(f.amount) > 0);
  const seikyu = priced.filter(f => f.amount_source === 'seikyu');
  if (seikyu.length) return seikyu.reduce((s, f) => s + Number(f.amount), 0);
  if (priced.length === 1) return Number(priced[0].amount);
  return null;
}

describe('extractInvoiceAmount: 差引お振込額を最優先', () => {
  test('新方式 PDF（ご請求金額 → 差引お振込額 の順に並ぶ）でも差引を拾う', () => {
    const text = 'ご請求金額（税込）\n¥26,400\n差引お振込額\n¥23,950\n小計（税抜） ¥24,000\n源泉徴収税額（10.21%） -¥2,450\n差引お振込額 ¥23,950';
    expect(extractInvoiceAmount(text)).toEqual({ amount: 23950, source: 'sashihiki' });
  });

  test('全角数字・「差引振込額」表記も可。年月の数字は飛ばす', () => {
    expect(extractInvoiceAmount('差引振込額（2026年10月分）　￥１，１９７，４８０')).toEqual({ amount: 1197480, source: 'sashihiki' });
  });

  test('差引の後に金額が無ければ従来のご請求金額へ', () => {
    expect(extractInvoiceAmount('差引お振込額\n\nご請求金額 ¥26,400')).toEqual({ amount: 26400, source: 'seikyu' });
  });

  test('旧方式の文字列は従来どおり（ご請求金額 → 合計の最大値）', () => {
    expect(extractInvoiceAmount('ご請求金額（税込・内税10%） ¥27,500')).toEqual({ amount: 27500, source: 'seikyu' });
    expect(extractInvoiceAmount('税抜小計 25,000\n合計（税込） 27,500\n合計 2,500')).toEqual({ amount: 27500, source: 'gokei' });
    expect(extractInvoiceAmount('請求書\n明細なし')).toBeNull();
  });
});

describe('hfsInvoicePayoutAmount: HFS 製 PDF は DB を正にする', () => {
  const inv = (over = {}) => ({
    id: 'inv-1', status: 'submitted', tax_mode: 'exclusive',
    subtotal_amount: 24000, tax_amount: 2400, total_amount: 26400, withholding_amount: 2450, payout_amount: 23950, ...over,
  });
  test('新方式・提出済み → payout_amount（差引お振込額）', () => {
    expect(hfsInvoicePayoutAmount(inv())).toEqual({
      amount: 23950, source: 'hfs_db', hfs_invoice_id: 'inv-1', tax_mode: 'exclusive',
      subtotal_amount: 24000, total_amount: 26400, withholding_amount: 2450,
    });
    expect(hfsInvoicePayoutAmount(inv({ status: 'approved' })).amount).toBe(23950);
  });
  test('旧方式・未提出・payout 未保存は null（PDF の文字から読む）', () => {
    expect(hfsInvoicePayoutAmount(inv({ tax_mode: 'inclusive', payout_amount: null }))).toBeNull();
    expect(hfsInvoicePayoutAmount(inv({ tax_mode: null }))).toBeNull();
    expect(hfsInvoicePayoutAmount(inv({ status: 'draft' }))).toBeNull();
    expect(hfsInvoicePayoutAmount(inv({ status: 'rejected' }))).toBeNull();
    expect(hfsInvoicePayoutAmount(inv({ payout_amount: null }))).toBeNull();
    expect(hfsInvoicePayoutAmount(null)).toBeNull();
  });
});

describe('sumInvoicePdfAmounts', () => {
  test('旧データ（seikyu / gokei / null）では Stage 4 前と同じ結果', () => {
    const cases = [
      [],
      [{ name: 'a.pdf', amount: 27500, amount_source: 'seikyu' }],
      [{ name: 'a.pdf', amount: 27500, amount_source: 'seikyu' }, { name: 'b.pdf', amount: 11000, amount_source: 'seikyu' }],
      [{ name: 'a.pdf', amount: 27500, amount_source: 'seikyu' }, { name: '作業時間.pdf', amount: 9999, amount_source: 'gokei' }],
      [{ name: '作業時間.pdf', amount: 9999, amount_source: 'gokei' }],
      [{ name: 'x.pdf', amount: 1000, amount_source: 'gokei' }, { name: 'y.pdf', amount: 2000, amount_source: 'gokei' }],
      [{ name: '【削除】a.pdf', amount: 27500, amount_source: 'seikyu' }, { name: 'b.pdf', amount: null }],
      [{ name: 'テンプレ.pdf', amount: 100, amount_source: 'seikyu' }, { name: 'c.pdf', amount: 5000, amount_source: 'seikyu' }],
    ];
    for (const c of cases) expect(sumInvoicePdfAmounts(c)).toBe(legacySum(c));
  });

  test('新方式（hfs_db / sashihiki）は振込額そのものとして合算・gokei は混ぜない', () => {
    expect(sumInvoicePdfAmounts([
      { name: 'a.pdf', amount: 23950, amount_source: 'hfs_db' },
      { name: 'b.pdf', amount: 11000, amount_source: 'seikyu' },
      { name: '作業時間.pdf', amount: 9999, amount_source: 'gokei' },
    ])).toBe(34950);
    expect(sumInvoicePdfAmounts([{ name: 'a.pdf', amount: 23950, amount_source: 'sashihiki' }])).toBe(23950);
    expect(countedInvoicePdfFiles([{ name: 'a.pdf', amount: 0, amount_source: 'hfs_db' }])).toEqual([]);
  });
});

describe('差分チェック: 新方式は税抜小計で比べ、税抜/税込を取り違えない', () => {
  const excl = (over = {}) => ({ name: 'a.pdf', amount: 23950, amount_source: 'hfs_db', tax_mode: 'exclusive', subtotal_amount: 24000, total_amount: 26400, ...over });

  test('新方式だけ → 税抜小計・taxExclusive', () => {
    expect(resolveDiffInvoiceBasis({ invoiceAmount: 23950, amountSource: 'auto', pdfFiles: [excl()] }))
      .toEqual({ amount: 24000, tax_exclusive: true, basis: 'subtotal' });
  });
  test('新旧混在 → 新方式は税込に揃えて合算（従来の税込判定）', () => {
    const r = resolveDiffInvoiceBasis({ invoiceAmount: 34950, amountSource: 'auto', pdfFiles: [excl(), { name: 'b.pdf', amount: 11000, amount_source: 'seikyu' }] });
    expect(r).toEqual({ amount: 37400, tax_exclusive: false, basis: 'mixed' });
  });
  test('手入力・旧方式だけは invoice_amount のまま', () => {
    expect(resolveDiffInvoiceBasis({ invoiceAmount: 50000, amountSource: 'manual', pdfFiles: [excl()] }))
      .toEqual({ amount: 50000, tax_exclusive: false, basis: 'invoice' });
    expect(resolveDiffInvoiceBasis({ invoiceAmount: 27500, amountSource: 'auto', pdfFiles: [{ name: 'a.pdf', amount: 27500, amount_source: 'seikyu' }] }))
      .toEqual({ amount: 27500, tax_exclusive: false, basis: 'invoice' });
  });

  test('taxExclusive: 税抜小計＝実データなら一致、実データ×1.1（10%上乗せ）は一致にしない', () => {
    expect(evaluatePayoutDiff({ invoiceAmount: 24000, actualTotal: 24000, taxExclusive: true })).toEqual({ status: 'match', delta: 0, delta_with_tax: null });
    expect(evaluatePayoutDiff({ invoiceAmount: 26400, actualTotal: 24000, taxExclusive: true }).status).toBe('diff');
    // 旧方式（既定）は従来どおり税込換算でも一致
    expect(evaluatePayoutDiff({ invoiceAmount: 26400, actualTotal: 24000 }).status).toBe('match');
  });

  test('evaluatePayoutDiffMulti も taxExclusive を引き継ぐ', () => {
    const v = evaluatePayoutDiffMulti({ invoiceAmount: 30000, currentTotal: 24000, prevTotal: 6000, undeliveredTotal: 0, taxExclusive: true });
    expect(v).toMatchObject({ status: 'match', matched_basis: 'current_prev' });
    const w = evaluatePayoutDiffMulti({ invoiceAmount: 33000, currentTotal: 24000, prevTotal: 6000, undeliveredTotal: 0, taxExclusive: true });
    expect(w.status).toBe('diff');
  });
});
