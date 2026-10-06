const {
  buildInvoicePdfModel,
  buildInvoicePdfFileName,
  renderInvoicePdf,
  formatJstDateSlash,
  formatJstDateLong,
  assetsAvailable,
} = require('../../utils/invoice-pdf');
const { extractInvoiceAmount } = require('../../utils/payout');

const baseInvoice = () => ({
  id: 'inv-1',
  invoice_number: 'INV-202609-003',
  year: 2026, month: 9,
  total_amount: 27500,
  issued_at: null,
  notes: '',
  projects: { id: 'p1', name: 'ショート動画', clients: { id: 'c1', name: 'hertech' } },
  issuer: {
    id: 'u1', full_name: '髙橋 聖', email: 'x@example.com', phone: '090-0000-0000',
    postal_code: '650-0001', address: '兵庫県神戸市',
    bank_name: '三井住友銀行', bank_code: '0009', branch_name: '神戸', branch_code: '500',
    account_type: '普通', account_number: '1234567', account_holder_kana: 'タカハシ サトル',
    invoice_registration_number: 'T1234567890123',
  },
  invoice_items: [
    { id: 'i2', creative_id: 'cr1', creative_label: 'hertech_0901_A', label: '編集費', quantity: 1, unit: '本', unit_price: 15000, total_amount: 15000, sort_order: 1,
      creatives: { id: 'cr1', file_name: 'hertech_0901_A.mp4', final_deadline: '2026-09-15', projects: { name: 'ショート動画', clients: { name: 'hertech' } } } },
    { id: 'i1', creative_id: 'cr1', creative_label: 'hertech_0901_A', label: 'ディレクション費', quantity: 1, unit: '本', unit_price: 5000, total_amount: 5000, sort_order: 0,
      creatives: { id: 'cr1', file_name: 'hertech_0901_A.mp4', final_deadline: '2026-09-15', projects: { name: 'ショート動画', clients: { name: 'hertech' } } } },
    { id: 'i3', creative_id: null, label: '交通費', quantity: 2, unit: '式', unit_price: 3750, total_amount: 7500, sort_order: 5 },
  ],
});

describe('buildInvoicePdfModel', () => {
  test('内税計算（税込 total → 税抜小計 floor / 消費税 = 差分）', () => {
    const m = buildInvoicePdfModel(baseInvoice());
    expect(m.total).toBe(27500);
    expect(m.subtotal).toBe(25000);
    expect(m.tax).toBe(2500);
  });

  test('creative 単位でグループ化し、sort_order 順に並べ、creative 無しは「その他」へ', () => {
    const m = buildInvoicePdfModel(baseInvoice());
    expect(m.groups).toHaveLength(1);
    expect(m.groups[0].label).toBe('hertech_0901_A');
    expect(m.groups[0].date).toBe('2026/09/15');
    expect(m.groups[0].project_name).toBe('ショート動画');
    expect(m.groups[0].client_name).toBe('hertech');
    expect(m.groups[0].items.map(i => i.label)).toEqual(['ディレクション費', '編集費']);
    expect(m.manual_rows).toHaveLength(1);
    expect(m.manual_rows[0]).toMatchObject({ label: '交通費', quantity: 2, unit: '式', unit_price: 3750, amount: 7500 });
  });

  test('total_amount が無い明細は数量×単価', () => {
    const inv = baseInvoice();
    inv.invoice_items = [{ id: 'x', creative_id: null, label: 'a', quantity: 3, unit_price: 1000, total_amount: null }];
    const m = buildInvoicePdfModel(inv);
    expect(m.manual_rows[0].amount).toBe(3000);
  });

  test('請求者・振込先・登録番号の行', () => {
    const m = buildInvoicePdfModel(baseInvoice());
    expect(m.issuer_name).toBe('髙橋 聖');
    expect(m.issuer_lines).toEqual(['x@example.com', 'TEL：090-0000-0000', '〒650-0001　兵庫県神戸市', '登録番号：T1234567890123']);
    expect(m.bank_lines).toEqual(['三井住友銀行 (0009)', '神戸支店 (500)', '普通 1234567', '口座名義：タカハシ サトル']);
    expect(m.period).toBe('2026年9月');
    expect(m.recipient).toEqual({ company: 'HARUKA FILM', person: '高橋聖 様' });
  });

  test('振込先未設定・登録番号無しでも落ちない', () => {
    const inv = baseInvoice();
    inv.issuer = { id: 'u1', full_name: '山田 太郎' };
    const m = buildInvoicePdfModel(inv);
    expect(m.bank_lines).toEqual([]);
    expect(m.issuer_lines).toEqual(['登録番号：—']);
  });

  test('発行日は issued_at があればその日（JST）、無ければ now（JST）', () => {
    const inv = baseInvoice();
    inv.issued_at = '2026-09-30T16:00:00Z'; // JST 10/1 01:00
    expect(buildInvoicePdfModel(inv).issue_date).toBe('2026年10月1日');
    inv.issued_at = null;
    expect(buildInvoicePdfModel(inv, { now: new Date('2026-09-29T15:30:00Z') }).issue_date).toBe('2026年9月30日');
  });
});

describe('JST 日付フォーマット', () => {
  test('formatJstDateSlash は UTC 深夜を JST の翌日に', () => {
    expect(formatJstDateSlash('2026-09-30T15:30:00Z')).toBe('2026/10/01');
    expect(formatJstDateSlash('2026-09-15')).toBe('2026/09/15');
    expect(formatJstDateSlash('')).toBe('');
    expect(formatJstDateSlash('not a date')).toBe('');
  });
  test('formatJstDateLong', () => {
    expect(formatJstDateLong('2026-09-30T15:30:00Z')).toBe('2026年10月1日');
  });
});

describe('buildInvoicePdfFileName', () => {
  test('印刷タイトルから日付を抜いた安定名（空白除去・記号サニタイズ）', () => {
    const inv = baseInvoice();
    expect(buildInvoicePdfFileName(inv, inv.issuer)).toBe('請求書_2026年9月_高橋宛_髙橋聖_INV-202609-003.pdf');
    inv.invoice_number = 'INV/2026:09?';
    expect(buildInvoicePdfFileName(inv, { full_name: '山田　太郎' })).toBe('請求書_2026年9月_高橋宛_山田太郎_INV-2026-09-.pdf');
  });
  test('issuer 引数が無ければ inv.issuer、それも無ければ 不明', () => {
    const inv = baseInvoice();
    expect(buildInvoicePdfFileName(inv)).toBe('請求書_2026年9月_高橋宛_髙橋聖_INV-202609-003.pdf');
    inv.issuer = null;
    expect(buildInvoicePdfFileName(inv)).toBe('請求書_2026年9月_高橋宛_不明_INV-202609-003.pdf');
  });
});

describe('renderInvoicePdf', () => {
  test('フォント同梱 + PDF バイナリを返す', async () => {
    expect(assetsAvailable()).toBe(true);
    const buf = await renderInvoicePdf(buildInvoicePdfModel(baseInvoice()));
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(buf.length).toBeGreaterThan(5000);
  });

  test('明細 80 件でも複数ページで落ちない', async () => {
    const inv = baseInvoice();
    inv.invoice_items = [];
    for (let i = 0; i < 40; i++) {
      inv.invoice_items.push({ id: `a${i}`, creative_id: `cr${i}`, creative_label: `案件${i}_とても長いファイル名_` + 'あ'.repeat(40), label: '編集費', quantity: 1, unit: '本', unit_price: 1000, total_amount: 1000, sort_order: i,
        creatives: { final_deadline: '2026-09-01', projects: { name: 'ショート動画', clients: { name: 'hertech' } } } });
      inv.invoice_items.push({ id: `b${i}`, creative_id: `cr${i}`, creative_label: `案件${i}`, label: 'ディレクション費', quantity: 1, unit: '本', unit_price: 500, total_amount: 500, sort_order: i,
        creatives: { final_deadline: '2026-09-01' } });
    }
    inv.notes = '備考1行目\n備考2行目';
    const buf = await renderInvoicePdf(buildInvoicePdfModel(inv));
    expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    // /Count N は複数ページ
    const m = buf.toString('latin1').match(/\/Type \/Pages[^>]*\/Count (\d+)/);
    expect(m && Number(m[1])).toBeGreaterThan(1);
  });

  test('振込管理の金額抽出は「ご請求金額」の見出し＋金額の並びを前提にしている', () => {
    // PDF テキストと同じ並び（見出し→税率→金額）で抽出できることを確認（PDF 本体の
    // テキスト抽出は Drive 側で行うため、ここでは描画順と同じ文字列で検証する）
    const m = buildInvoicePdfModel(baseInvoice());
    const text = `ご請求金額（税込・内税10%） ¥${m.total.toLocaleString('ja-JP')}`;
    expect(extractInvoiceAmount(text)).toEqual({ amount: 27500, source: 'seikyu' });
  });
});
