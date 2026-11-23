// 立替経費の日付・支払先・領収書（ADR 046 追補 2026-11-23）の純関数。
//   utils/invoice-editor.js: parseExpenseDate / expenseReceiptIssues（lineIssues・checkInvoiceForSubmit 経由）/ receiptNoteOf
//   utils/invoice-receipt.js: ファイル名・種類判定・閲覧の可否・列が無いエラーの見分け
const IE = require('../../utils/invoice-editor');
const R = require('../../utils/invoice-receipt');

const base = { id: 'e1', creative_id: null, cost_type: 'expense', label: 'アートホテル撮影 ガソリン代', unit_price: 1641, quantity: 1 };
const full = { ...base, expense_date: '2026-10-25', expense_payee: 'ENEOS ○○店' };
const codes = (list) => list.map(i => i.code);

describe('parseExpenseDate', () => {
  test.each([
    ['2026-10-25', '2026-10-25'], ['2026/10/25', '2026-10-25'], ['2026/1/5', '2026-01-05'],
    ['２０２６年１０月２５日', '2026-10-25'], [' 2026.10.25 ', '2026-10-25'],
  ])('%s → %s', (input, out) => { expect(IE.parseExpenseDate(input)).toEqual({ value: out }); });
  test('空は未入力', () => {
    expect(IE.parseExpenseDate('')).toEqual({ value: null });
    expect(IE.parseExpenseDate(null)).toEqual({ value: null });
    expect(IE.parseExpenseDate(undefined)).toEqual({ value: null });
  });
  test.each(['2026-02-30', '2026-13-01', '10/25', 'あした', '1999-01-01'])('%s はエラー', (v) => {
    expect(IE.parseExpenseDate(v).error).toBeTruthy();
  });
});

describe('立替経費の提出前チェック（状態ごとの組み合わせ）', () => {
  test('何も入っていない: 日付・支払先・領収書の 3 つ', () => {
    expect(codes(IE.lineIssues(base))).toEqual(['EXPENSE_DATE_MISSING', 'EXPENSE_PAYEE_MISSING', 'RECEIPT_STATUS_MISSING']);
  });
  test('写真を添付: ファイルがあれば OK、無ければ RECEIPT_FILE_MISSING', () => {
    expect(IE.lineIssues({ ...full, receipt_status: 'attached', receipt_file_id: 'drv-1' })).toEqual([]);
    expect(codes(IE.lineIssues({ ...full, receipt_status: 'attached' }))).toEqual(['RECEIPT_FILE_MISSING']);
  });
  test('領収書なし: 理由があれば OK、空白だけは RECEIPT_REASON_MISSING', () => {
    expect(IE.lineIssues({ ...full, receipt_status: 'missing', receipt_missing_reason: 'レシートを紛失したため' })).toEqual([]);
    expect(codes(IE.lineIssues({ ...full, receipt_status: 'missing', receipt_missing_reason: '  ' }))).toEqual(['RECEIPT_REASON_MISSING']);
  });
  test('知らない状態の値は未選択と同じ', () => {
    expect(codes(IE.lineIssues({ ...full, receipt_status: 'maybe' }))).toEqual(['RECEIPT_STATUS_MISSING']);
  });
  test('支払先が空白だけ・日付が壊れている', () => {
    const ok = { ...full, receipt_status: 'missing', receipt_missing_reason: '紛失' };
    expect(codes(IE.lineIssues({ ...ok, expense_payee: ' ' }))).toEqual(['EXPENSE_PAYEE_MISSING']);
    expect(codes(IE.lineIssues({ ...ok, expense_date: '2026-02-30' }))).toEqual(['EXPENSE_DATE_MISSING']);
    // DB から来る DATE（時刻つきで来ても日付部分だけ見る）
    expect(IE.lineIssues({ ...ok, expense_date: '2026-10-25T00:00:00' })).toEqual([]);
  });
  test('requireReceipt=false（列がまだ無い環境）なら見ない', () => {
    expect(IE.lineIssues(base, null, { requireReceipt: false })).toEqual([]);
  });
  test('作業時間報告の立替経費・HFS外・CR の行は対象外', () => {
    expect(IE.lineIssues({ creative_id: null, cost_type: 'hourly_expense', label: '立替経費', unit_price: 3000, quantity: 1 })).toEqual([]);
    expect(IE.lineIssues({ creative_id: null, cost_type: null, label: '撮影補助', unit_price: 100, quantity: 1, manual_reason: '現場' })).toEqual([]);
    expect(IE.lineIssues({ creative_id: 'c', cost_type: 'base_fee', unit_price: 6000 }, 6000)).toEqual([]);
  });
  test('checkInvoiceForSubmit: 欠けた行の item_id つきで返す・requireReceipt=false なら通す', () => {
    const p = { items: [base], issuerId: 'u', creativesById: new Map(), billedKeys: new Set(), refPriceByKey: new Map(), withholdingEnabled: true, expectedTotal: 1641, expectedPayout: 1641 };
    const r = IE.checkInvoiceForSubmit(p);
    expect(r.problems.map(x => [x.item_id, x.code])).toEqual([
      ['e1', 'EXPENSE_DATE_MISSING'], ['e1', 'EXPENSE_PAYEE_MISSING'], ['e1', 'RECEIPT_STATUS_MISSING'],
    ]);
    expect(IE.checkInvoiceForSubmit({ ...p, requireReceipt: false }).problems).toEqual([]);
    // 金額の計算は変わらない（立替経費は消費税・源泉の対象外）
    expect(r.totals).toMatchObject({ subtotal: 0, tax: 0, expense: 1641, withholding: 0, payout: 1641 });
  });
});

describe('receiptNoteOf（PDF に小さく添える）', () => {
  test('あり／なし／未入力', () => {
    expect(IE.receiptNoteOf({ ...full, receipt_status: 'attached', receipt_file_id: 'drv-1' })).toBe('（領収書あり）');
    expect(IE.receiptNoteOf({ ...full, receipt_status: 'attached' })).toBe('');
    expect(IE.receiptNoteOf({ ...full, receipt_status: 'missing', receipt_missing_reason: '紛失' })).toBe('（領収書なし）');
    expect(IE.receiptNoteOf(full)).toBe('');
    expect(IE.receiptNoteOf({ creative_id: null, cost_type: 'hourly_expense', receipt_status: 'missing' })).toBe('');
  });
});

describe('buildReceiptFileName', () => {
  test('領収書_YYYYMMDD_内容_金額円.拡張子', () => {
    expect(R.buildReceiptFileName({ expenseDate: '2026-10-25', label: 'アートホテル撮影 ガソリン代', amount: 1641, mime: 'image/jpeg' }))
      .toBe('領収書_20261025_アートホテル撮影 ガソリン代_1641円.jpg');
    expect(R.buildReceiptFileName({ expenseDate: '2026-10-25', label: 'タクシー', amount: 0, mime: 'application/pdf' }))
      .toBe('領収書_20261025_タクシー_0円.pdf');
    expect(R.buildReceiptFileName({ expenseDate: '2026-10-25', label: 'x', amount: 10, mime: 'image/heic' })).toMatch(/\.heic$/);
    expect(R.buildReceiptFileName({ expenseDate: '2026-10-25', label: 'x', amount: 10, mime: 'image/png' })).toMatch(/\.png$/);
  });
  test('ファイル名に使えない文字は置き換え、長い内容は切る', () => {
    const name = R.buildReceiptFileName({ expenseDate: '2026-10-25', label: '東京/大阪 "往復" <新幹線>:*?|\\\n代', amount: 29000, mime: 'image/jpeg' });
    expect(name).toBe('領収書_20261025_東京_大阪 _往復_ _新幹線______代_29000円.jpg');
    expect(name).not.toMatch(/[\\/:*?"<>|\n]/);
    const long = R.buildReceiptFileName({ expenseDate: '2026-10-25', label: 'あ'.repeat(100), amount: 1, mime: 'image/jpeg' });
    expect(long).toBe(`領収書_20261025_${'あ'.repeat(40)}_1円.jpg`);
  });
  test('内容が空なら「立替経費」・金額が無ければ省く・日付が無ければ JST の今日', () => {
    // 2026-10-31 15:30 UTC = 2026-11-01 00:30 JST（UTC だと前日になる時間帯）
    const now = new Date('2026-10-31T15:30:00Z');
    expect(R.buildReceiptFileName({ expenseDate: null, label: '  ', amount: null, mime: 'image/jpeg', now })).toBe('領収書_20261101_立替経費.jpg');
    expect(R.buildReceiptFileName({ expenseDate: '', label: '../..', amount: '', mime: 'image/jpeg', now })).toBe('領収書_20261101_立替経費.jpg');
  });
});

describe('sniffReceiptMime（中身の先頭で種類を判定）', () => {
  const pad = (b) => Buffer.concat([Buffer.from(b), Buffer.alloc(16)]);
  test('JPEG / PNG / PDF / HEIC / HEIF', () => {
    expect(R.sniffReceiptMime(pad([0xFF, 0xD8, 0xFF, 0xE1]))).toBe('image/jpeg');
    expect(R.sniffReceiptMime(pad([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))).toBe('image/png');
    expect(R.sniffReceiptMime(pad(Buffer.from('%PDF-1.7')))).toBe('application/pdf');
    expect(R.sniffReceiptMime(pad(Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic')])))).toBe('image/heic');
    expect(R.sniffReceiptMime(pad(Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmif1')])))).toBe('image/heif');
  });
  test('それ以外（HTML・GIF・mp4・短すぎる）は null', () => {
    expect(R.sniffReceiptMime(pad(Buffer.from('<html><body>')))).toBeNull();
    expect(R.sniffReceiptMime(pad(Buffer.from('GIF89a')))).toBeNull();
    expect(R.sniffReceiptMime(pad(Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom')])))).toBeNull();
    expect(R.sniffReceiptMime(Buffer.from([0xFF, 0xD8]))).toBeNull();
    expect(R.sniffReceiptMime(null)).toBeNull();
  });
});

describe('canViewReceipt（本人と管理者だけ）', () => {
  const invoice = { id: 'inv1', issuer_id: 'u1' };
  test('本人は見られる', () => { expect(R.canViewReceipt({ invoice, userId: 'u1', isStaff: false })).toBe(true); });
  test('管理者（admin/秘書）は見られる', () => { expect(R.canViewReceipt({ invoice, userId: 'admin1', isStaff: true })).toBe(true); });
  test('他人は見られない', () => { expect(R.canViewReceipt({ invoice, userId: 'u2', isStaff: false })).toBe(false); });
  test('未ログイン・請求書なしは見られない', () => {
    expect(R.canViewReceipt({ invoice, userId: null, isStaff: true })).toBe(false);
    expect(R.canViewReceipt({ invoice: null, userId: 'u1', isStaff: true })).toBe(false);
  });
});

describe('isMissingReceiptColumnError', () => {
  test('領収書の列が無いエラーだけ true', () => {
    expect(R.isMissingReceiptColumnError({ code: '42703', message: 'column invoice_items.receipt_status does not exist' })).toBe(true);
    expect(R.isMissingReceiptColumnError({ code: 'PGRST204', message: "Could not find the 'expense_date' column of 'invoice_items' in the schema cache" })).toBe(true);
    expect(R.isMissingReceiptColumnError({ code: '42703', message: 'column invoices.tax_mode does not exist' })).toBe(false);
    expect(R.isMissingReceiptColumnError({ code: '57014', message: 'receipt_status timeout' })).toBe(false);
    expect(R.isMissingReceiptColumnError(null)).toBe(false);
  });
});

describe('receiptContentDisposition', () => {
  test('日本語ファイル名は RFC 5987・inline / attachment', () => {
    const v = R.receiptContentDisposition('領収書_20261025_x_1円.jpg');
    expect(v).toMatch(/^inline; filename="[\x20-\x7E]+"; filename\*=UTF-8''/);
    expect(R.receiptContentDisposition('a.pdf', { download: true })).toMatch(/^attachment; /);
  });
});

describe('請求書 PDF に領収書の有無を添える（写真は入れない）', () => {
  const { buildInvoicePdfModel, renderInvoicePdf } = require('../../utils/invoice-pdf');
  const inv = {
    id: 'inv1', invoice_number: 'INV-202610-013', year: 2026, month: 10, status: 'submitted',
    tax_mode: 'exclusive', subtotal_amount: 6000, tax_amount: 600, total_amount: 6600,
    withholding_enabled: true, withholding_amount: 612, payout_amount: 9629,
    issuer: { id: 'u1', full_name: 'テスト 太郎' },
    invoice_items: [
      { id: 'i1', creative_id: null, cost_type: null, label: '撮影同行', unit_price: 6000, quantity: 1, sort_order: 0, manual_reason: '直接依頼' },
      { id: 'i2', creative_id: null, cost_type: 'expense', label: 'タクシー代', unit_price: 2000, quantity: 1, sort_order: 1, receipt_status: 'attached', receipt_file_id: 'drv-1' },
      { id: 'i3', creative_id: null, cost_type: 'expense', label: 'ガソリン代', unit_price: 1641, quantity: 1, sort_order: 2, receipt_status: 'missing' },
      { id: 'i4', creative_id: null, cost_type: 'hourly_expense', creative_label: '立替経費（作業時間報告）', label: '立替経費', unit_price: 0, quantity: 1, sort_order: 3 },
    ],
  };
  test('立替経費の品目に（領収書あり）／（領収書なし）が付き、金額は変わらない', async () => {
    const model = buildInvoicePdfModel(inv);
    expect(model.rows.map(r => r.label)).toEqual([
      '撮影同行',
      '立替経費（実費）｜タクシー代（領収書あり）',
      '立替経費（実費）｜ガソリン代（領収書なし）',
      '立替経費（作業時間報告）（実費）',
    ]);
    expect(model).toMatchObject({ subtotal: 6000, total: 6600, payout: 9629 });
    const buf = await renderInvoicePdf(model);
    expect(buf.slice(0, 4).toString()).toBe('%PDF');
  });
});
