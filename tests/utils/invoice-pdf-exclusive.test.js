// ADR 046 Stage 4: 新方式（tax_mode='exclusive'）の請求書 PDF と、旧方式（内税）の不変チェック
const crypto = require('crypto');
const {
  buildInvoicePdfModel,
  renderInvoicePdf,
} = require('../../utils/invoice-pdf');
const { extractInvoiceAmount } = require('../../utils/payout');

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const pageCount = (buf) => {
  const m = buf.toString('latin1').match(/\/Type \/Pages[^>]*\/Count (\d+)/);
  return m ? Number(m[1]) : 0;
};

const issuer = () => ({
  id: 'u1', full_name: '國貞 優衣', email: 'x@example.com', phone: '090-0000-0000',
  postal_code: '650-0001', address: '兵庫県神戸市',
  bank_name: '三井住友銀行', bank_code: '0009', branch_name: '神戸', branch_code: '500',
  account_type: '普通', account_number: '1234567', account_holder_kana: 'クニサダ ユイ',
  invoice_registration_number: 'T1234567890123',
});

// 旧方式（内税）。origin/main（Stage 4 前）の描画と 1 バイトも変わらないことをハッシュで確認する
const inclusiveInvoice = () => ({
  id: 'inv-old', invoice_number: 'INV-202609-003', year: 2026, month: 9,
  total_amount: 27500, issued_at: '2026-09-30T03:00:00Z', notes: '備考1\n備考2',
  projects: { id: 'p1', name: 'ショート動画', clients: { id: 'c1', name: 'hertech' } },
  issuer: issuer(),
  invoice_items: [
    { id: 'i1', creative_id: 'cr1', creative_label: 'hertech_0901_A', label: '編集費', quantity: 1, unit: '本', unit_price: 20000, total_amount: 20000, sort_order: 0,
      creatives: { id: 'cr1', file_name: 'hertech_0901_A.mp4', final_deadline: '2026-09-15', projects: { name: 'ショート動画', clients: { name: 'hertech' } } } },
    { id: 'i3', creative_id: null, label: '交通費', quantity: 2, unit: '式', unit_price: 3750, total_amount: 7500, sort_order: 5 },
  ],
});

// 新方式（税抜＋源泉）。提出時に DB へ保存された値（subtotal_amount 等）を持つ
const exclusiveInvoice = (over = {}) => ({
  id: 'inv-new', invoice_number: 'INV-202610-004', year: 2026, month: 10,
  status: 'submitted', tax_mode: 'exclusive', withholding_enabled: true,
  subtotal_amount: 24000, tax_amount: 2400, total_amount: 26400, withholding_amount: 2450, payout_amount: 23950,
  issued_at: null, submitted_at: '2026-10-28T05:00:00Z', notes: '',
  projects: null,
  issuer: issuer(),
  invoice_items: [
    { id: 'a', creative_id: 'cr1', cost_type: 'base_fee', creative_label: 'hertech_241003_A', label: '編集', quantity: 1, unit: '本', unit_price: 6000, total_amount: 6000, sort_order: 0,
      creatives: { id: 'cr1', file_name: 'hertech_241003_A.mp4', status: '納品', delivered_at: '2026-10-02T16:00:00Z', final_deadline: '2026-10-01',
        projects: { name: 'ショート', billing_timing: 'on_delivery', clients: { name: 'hertech' } } } },
    { id: 'b', creative_id: 'cr2', cost_type: 'base_fee', creative_label: 'acme_lp_0928_v2', label: '編集', quantity: 1, unit: '本', unit_price: 3000, total_amount: 3000, sort_order: 1,
      creatives: { id: 'cr2', file_name: 'acme_lp_0928_v2', status: '納品', delivered_at: '2026-09-28T01:00:00Z',
        projects: { name: 'LP', clients: { name: 'ACME' } } } },
    { id: 'c', creative_id: null, cost_type: 'manual', label: '撮影補助（10/12）', quantity: 1, unit: '式', unit_price: 15000, total_amount: 15000, sort_order: 2, manual_reason: '現場対応' },
  ],
  ...over,
});

describe('旧方式（内税）の PDF は Stage 4 前と同一', () => {
  beforeEach(() => { jest.useFakeTimers({ now: new Date('2026-10-01T00:00:00Z'), doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] }); });
  afterEach(() => { jest.useRealTimers(); });

  test('モデルに新しいキーが増えていない', () => {
    const m = buildInvoicePdfModel(inclusiveInvoice());
    expect(Object.keys(m).sort()).toEqual([
      'bank_lines', 'groups', 'invoice_number', 'issue_date', 'issuer_lines', 'issuer_name', 'manual_rows',
      'notes', 'period', 'recipient', 'subtotal', 'tax', 'total',
    ]);
  });

  test('tax_mode が inclusive / 未設定なら PDF バイト列が Stage 4 前と同一（固定時刻）', async () => {
    // Stage 4 前（origin/main）の utils/invoice-pdf.js で生成したハッシュ。pdfkit・同梱フォント・ロゴを更新したら作り直す
    const GOLDEN = 'db82a799e94954a26ffbe00e834eae89dd80928d7fc2539b2b2095a7cf8302a0';
    const a = await renderInvoicePdf(buildInvoicePdfModel(inclusiveInvoice()));
    const b = await renderInvoicePdf(buildInvoicePdfModel({ ...inclusiveInvoice(), tax_mode: 'inclusive', payout_amount: null }));
    expect(sha(a)).toBe(GOLDEN);
    expect(sha(b)).toBe(GOLDEN);
  });
});

describe('新方式（exclusive）の PDF モデル', () => {
  test('宛名・件名・請求日（月末）・支払期限（翌月末）', () => {
    const m = buildInvoicePdfModel(exclusiveInvoice());
    expect(m.layout).toBe('exclusive');
    expect(m.recipient).toEqual({ company: '株式会社HARUKA FILM 御中', person: '' });
    expect(m.subject).toBe('2026年10月分 制作費として');
    expect(m.invoice_date).toBe('2026/10/31');
    expect(m.due_date).toBe('2026/11/30');
    expect(m.issuer_lines).toContain('登録番号：T1234567890123');
    expect(m.bank_lines).toEqual(['三井住友銀行 (0009)', '神戸支店 (500)', '普通 1234567', '口座名義：クニサダ ユイ']);
  });

  test('明細は 1 行ずつ（CR は クライアント｜CR（役割）・納品日は JST の計上日、HFS外の行も載る）', () => {
    const m = buildInvoicePdfModel(exclusiveInvoice());
    expect(m.rows).toEqual([
      { no: 1, kind: 'cr', date: '10/03', label: 'hertech｜hertech_241003_A（編集）', unit_price: 6000, quantity: 1, amount: 6000 },
      { no: 2, kind: 'cr', date: '09/28', label: 'ACME｜acme_lp_0928_v2（編集）', unit_price: 3000, quantity: 1, amount: 3000 },
      { no: 3, kind: 'manual', date: '', label: '撮影補助（10/12）', unit_price: 15000, quantity: 1, amount: 15000 },
    ]);
  });

  test('源泉あり: DB 保存値を正にする（小計／消費税／税込／源泉／差引）', () => {
    const m = buildInvoicePdfModel(exclusiveInvoice());
    expect(m).toMatchObject({ subtotal: 24000, tax: 2400, total: 26400, withholding: 2450, payout: 23950, amounts_from: 'db' });
  });

  test('DB 値が欠けていれば明細から再計算（invoice-editor の computeTotals と同じ）', () => {
    const m = buildInvoicePdfModel(exclusiveInvoice({ subtotal_amount: null, tax_amount: null, payout_amount: null, withholding_amount: null, total_amount: null }));
    expect(m).toMatchObject({ subtotal: 24000, tax: 2400, total: 26400, withholding: 2450, payout: 23950, amounts_from: 'recalc' });
  });

  test('源泉なし: 源泉 0・差引＝税込', () => {
    const m = buildInvoicePdfModel(exclusiveInvoice({ withholding_enabled: false, withholding_amount: 0, payout_amount: 26400 }));
    expect(m).toMatchObject({ withholding: 0, payout: 26400, withholding_enabled: false });
    const r = buildInvoicePdfModel(exclusiveInvoice({ withholding_enabled: false, subtotal_amount: null }));
    expect(r).toMatchObject({ withholding: 0, payout: 26400, amounts_from: 'recalc' });
  });

  test('100万円超（源泉は10.21%一律のまま・警告フラグ）', () => {
    const inv = exclusiveInvoice({ subtotal_amount: null, tax_amount: null, total_amount: null, withholding_amount: null, payout_amount: null });
    inv.invoice_items = [{ id: 'z', creative_id: null, cost_type: 'manual', label: '大型案件一式', quantity: 1, unit_price: 1200000, sort_order: 0 }];
    const m = buildInvoicePdfModel(inv);
    expect(m).toMatchObject({ subtotal: 1200000, tax: 120000, total: 1320000, withholding: 122520, payout: 1197480, withholding_over_limit: true });
  });

  test('振込管理の抽出は「差引お振込額」を拾う（PDF と同じ並び）', () => {
    const m = buildInvoicePdfModel(exclusiveInvoice());
    const yen = (n) => `¥${n.toLocaleString('ja-JP')}`;
    const text = [
      '請 求 書', 'No. INV-202610-004', '請求日：2026/10/31', 'お支払期限：2026/11/30',
      `ご請求金額（税込） ${yen(m.total)}`, `差引お振込額 ${yen(m.payout)}`,
      `小計（税抜） ${yen(m.subtotal)}`, `消費税（10%） ${yen(m.tax)}`, `ご請求金額（税込） ${yen(m.total)}`,
      `源泉徴収税額（10.21%） -${yen(m.withholding)}`, `差引お振込額 ${yen(m.payout)}`,
    ].join('\n');
    expect(extractInvoiceAmount(text)).toEqual({ amount: 23950, source: 'sashihiki' });
  });
});

describe('新方式（exclusive）の PDF 描画', () => {
  test('PDF バイナリを返す（1 ページ）', async () => {
    const buf = await renderInvoicePdf(buildInvoicePdfModel(exclusiveInvoice({ notes: '備考です' })));
    expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(pageCount(buf)).toBe(1);
  });

  test('源泉なし・振込先未設定でも落ちない', async () => {
    const inv = exclusiveInvoice({ withholding_enabled: false, withholding_amount: 0, payout_amount: 26400 });
    inv.issuer = { id: 'u1', full_name: '山田 太郎' };
    const buf = await renderInvoicePdf(buildInvoicePdfModel(inv));
    expect(pageCount(buf)).toBe(1);
  });

  const manyRows = (n, labelOf) => {
    const inv = exclusiveInvoice({ subtotal_amount: null });
    inv.invoice_items = [];
    for (let i = 0; i < n; i++) {
      inv.invoice_items.push({ id: `a${i}`, creative_id: `cr${i}`, cost_type: 'base_fee', creative_label: labelOf(i), label: '編集', unit_price: 1000, sort_order: i,
        creatives: { status: '納品', delivered_at: '2026-10-10T00:00:00Z', projects: { clients: { name: 'hertech' } } } });
    }
    inv.notes = '備考1\n備考2';
    return inv;
  };

  test('1 行に収まる明細 80 行は 4 ページ（空ページが増えない）', async () => {
    // 1 行 ≒ 22pt。1 ページ目 ≒ 18 行、2・3 ページ目 ≒ 31 行ずつ、4 ページ目に合計・振込先・備考
    // （pdfkit の自動改ページ＝下余白より下への text が起きると 5 ページ以上になる）
    const buf = await renderInvoicePdf(buildInvoicePdfModel(manyRows(80, i => `hertech_${String(i).padStart(4, '0')}`)));
    expect(pageCount(buf)).toBe(4);
  });

  test('折り返す長い品目が混ざっても落ちない', async () => {
    const buf = await renderInvoicePdf(buildInvoicePdfModel(manyRows(40, i => `案件${i}_とても長いファイル名_` + 'あ'.repeat(i % 3 ? 5 : 80))));
    expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(pageCount(buf)).toBeGreaterThan(1);
  });
});
