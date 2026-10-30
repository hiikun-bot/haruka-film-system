// tests/withholding-ledger.test.js
// 🧾 源泉徴収台帳（ADR 054 §5 Stage D）の純関数テスト。
// 月の境界・支払日は Asia/Tokyo 固定なので、TZ=UTC でも TZ=Asia/Tokyo でも同じ結果になること。
const {
  isoToJstYmd, jstRange, prevMonthOf, paymentDueDate,
  buildLedgerRows, summarizeMonth, summarizeYearByPayee,
  buildMonthlySheetRows, buildYearlySheetRows, buildLedgerSheetRows,
  buildWithholdingReminderText, CATEGORY_LABEL, DETAIL_LABEL,
} = require('../utils/withholding-ledger');

const yamada = { id: 'u1', full_name: '山田 花子', nickname: 'はな', address: '兵庫県神戸市1-2-3', postal_code: '650-0001', business_type: 'sole_proprietor', invoice_registration_number: 'T1234567890123' };
const suzuki = { id: 'u2', full_name: '鈴木 一郎', nickname: null, address: '', postal_code: '', business_type: 'corporation', invoice_registration_number: '' };

const invExclusive = {
  id: 'inv1', invoice_number: 'INV-2610-03', tax_mode: 'exclusive', withholding_enabled: true,
  subtotal_amount: 100000, tax_amount: 10000, total_amount: 110000, withholding_amount: 10210, payout_amount: 99790,
};
const invInclusive = { id: 'inv2', invoice_number: 'INV-2609-11', tax_mode: 'inclusive', total_amount: 55000 };

describe('JST の日付・月境界', () => {
  test('UTC 深夜の支払は JST では翌日になる', () => {
    expect(isoToJstYmd('2026-10-31T15:30:00Z')).toBe('2026-11-01');
    expect(isoToJstYmd('2026-10-31T14:59:59Z')).toBe('2026-10-31');
    expect(isoToJstYmd(null)).toBeNull();
    expect(isoToJstYmd('bad')).toBeNull();
  });
  test('jstRange は JST 月初 0:00 を UTC で返す（TZ 非依存）', () => {
    expect(jstRange(2026, 10)).toEqual({ startIso: '2026-09-30T15:00:00.000Z', endIso: '2026-10-31T15:00:00.000Z' });
    expect(jstRange(2026, 12).endIso).toBe('2026-12-31T15:00:00.000Z');
    expect(jstRange(2026)).toEqual({ startIso: '2025-12-31T15:00:00.000Z', endIso: '2026-12-31T15:00:00.000Z' });
    expect(() => jstRange(2026, 13)).toThrow();
  });
  test('前月・納付期限', () => {
    expect(prevMonthOf(2026, 1)).toEqual({ year: 2025, month: 12 });
    expect(prevMonthOf(2026, 11)).toEqual({ year: 2026, month: 10 });
    expect(paymentDueDate(2026, 10)).toBe('2026-11-10');
    expect(paymentDueDate(2026, 12)).toBe('2027-01-10');
  });
});

describe('buildLedgerRows', () => {
  test('exclusive は請求書の4列、inclusive は total のみ源泉0、請求書なしは要確認', () => {
    const rows = buildLedgerRows([
      { user: suzuki, paid_at: '2026-10-31T06:00:00Z', paid_via: null, invoice: null, invoice_amount: 45000, apply_no: null, payout_record_id: 'pr2' },
      { user: yamada, paid_at: '2026-10-31T06:00:00Z', paid_via: 'aozora_api', invoice: invExclusive, apply_no: '2026103100000001', transfer_item_id: 'ti1' },
      { user: yamada, paid_at: '2026-10-05T06:00:00Z', paid_via: 'manual', invoice: invInclusive, apply_no: null },
    ]);
    expect(rows.map(r => `${r.paid_date} ${r.user_name}`)).toEqual([
      '2026-10-05 山田 花子', '2026-10-31 山田 花子', '2026-10-31 鈴木 一郎',
    ]);

    const inc = rows[0];
    expect(inc).toMatchObject({ source: 'invoice_inclusive', subtotal: null, tax: null, withholding: 0, gross: 55000, net: 55000, paid_via: 'manual', paid_via_label: '手動', needs_review: false });
    expect(inc.notes).toContain('旧方式（内税）・源泉なし');

    const exc = rows[1];
    expect(exc).toMatchObject({
      source: 'invoice_exclusive', invoice_number: 'INV-2610-03',
      subtotal: 100000, tax: 10000, withholding: 10210, gross: 110000, net: 99790,
      paid_via: 'aozora_api', paid_via_label: 'API', apply_no: '2026103100000001', needs_review: false,
    });

    const pdf = rows[2];
    expect(pdf).toMatchObject({ source: 'pdf', invoice_number: null, subtotal: null, tax: null, withholding: 0, gross: 45000, net: 45000, needs_review: true, paid_via: 'manual' });
    expect(pdf.review_reasons).toEqual(['請求書なし（PDF抽出額を税込として計上）']);
  });

  test('金額の不整合・源泉0・支払日なしは要確認理由になる', () => {
    const [bad] = buildLedgerRows([{
      user: yamada, paid_at: null, paid_via: 'manual',
      invoice: { ...invExclusive, withholding_amount: 0, payout_amount: 110000, total_amount: 120000 },
    }]);
    expect(bad.needs_review).toBe(true);
    expect(bad.review_reasons).toEqual(expect.arrayContaining([
      '支払日が未設定',
      '請求書の税抜＋消費税と税込額が一致しない',
      '源泉ありの請求書なのに源泉額が0',
    ]));
    expect(bad.paid_date).toBeNull();
    const [noAmt] = buildLedgerRows([{ user: suzuki, paid_at: '2026-10-01T01:00:00Z', invoice: null, invoice_amount: null }]);
    expect(noAmt.review_reasons).toEqual(['請求書なし・金額不明']);
    expect(noAmt.gross).toBe(0);
  });

  test('exclusive で源泉なし（法人）は要確認にしない', () => {
    const [r] = buildLedgerRows([{
      user: suzuki, paid_at: '2026-10-20T01:00:00Z', paid_via: 'manual',
      invoice: { ...invExclusive, withholding_enabled: false, withholding_amount: 0, payout_amount: 110000 },
    }]);
    expect(r.needs_review).toBe(false);
    expect(r.withholding).toBe(0);
    expect(r.notes).toContain('源泉なし（法人・対象外）');
  });
});

describe('summarizeMonth / summarizeYearByPayee', () => {
  const rows = buildLedgerRows([
    { user: yamada, paid_at: '2026-10-31T06:00:00Z', paid_via: 'aozora_api', invoice: invExclusive, apply_no: 'A1' },
    { user: yamada, paid_at: '2026-10-05T06:00:00Z', paid_via: 'manual', invoice: invInclusive },
    { user: suzuki, paid_at: '2026-10-31T06:00:00Z', paid_via: null, invoice: null, invoice_amount: 45000 },
  ]);
  test('人数は重複しない・金額は合算・要確認件数', () => {
    expect(summarizeMonth(rows)).toEqual({
      payee_count: 2, payment_count: 3,
      gross_total: 110000 + 55000 + 45000,
      withholding_total: 10210,
      net_total: 99790 + 55000 + 45000,
      needs_review_count: 1,
    });
    expect(summarizeMonth([])).toEqual({ payee_count: 0, payment_count: 0, gross_total: 0, withholding_total: 0, net_total: 0, needs_review_count: 0 });
  });
  test('支払調書用は支払先ごとに住所・区分・細目・個人/法人・インボイス番号を付けて合算', () => {
    const payees = summarizeYearByPayee(rows, new Map([[yamada.id, yamada], [suzuki.id, suzuki]]));
    expect(payees.map(p => p.user_name)).toEqual(['山田 花子', '鈴木 一郎']);
    expect(payees[0]).toMatchObject({
      user_id: 'u1', postal_code: '650-0001', address: '兵庫県神戸市1-2-3',
      category: CATEGORY_LABEL, detail: DETAIL_LABEL,
      gross_total: 165000, withholding_total: 10210, net_total: 154790, payment_count: 2,
      entity_type: '個人', invoice_registration_number: 'T1234567890123', needs_review_count: 0,
    });
    expect(payees[1]).toMatchObject({ entity_type: '法人', gross_total: 45000, withholding_total: 0, needs_review_count: 1 });
    expect(CATEGORY_LABEL).toBe('報酬・料金等（所得税法204条1項）');
  });
});

describe('スプレッドシート行', () => {
  const rows = buildLedgerRows([
    { user: yamada, paid_at: '2026-10-31T06:00:00Z', paid_via: 'aozora_api', invoice: invExclusive, apply_no: 'A1' },
    { user: suzuki, paid_at: '2026-10-31T06:00:00Z', paid_via: null, invoice: null, invoice_amount: 45000 },
  ]);
  test('月次 納付用', () => {
    const sheet = buildMonthlySheetRows({ year: 2026, month: 10, summary: summarizeMonth(rows) });
    expect(sheet[0][0]).toBe('支払年月');
    expect(sheet[1]).toEqual(['2026年10月', CATEGORY_LABEL, 2, 2, 155000, 10210, 144790, 1, '2026-11-10']);
    expect(sheet.some(r => String(r[0]).includes('税理士'))).toBe(true);
  });
  test('年次 支払調書用', () => {
    const sheet = buildYearlySheetRows({ year: 2026, payees: summarizeYearByPayee(rows, { u1: yamada, u2: suzuki }) });
    expect(sheet[0]).toEqual(['氏名', '郵便番号', '住所', '区分', '細目', '年間支払金額（税込）', '年間源泉徴収税額', '差引支払額', '支払件数', '個人/法人', 'インボイス登録番号', '要確認件数']);
    expect(sheet[1][0]).toBe('山田 花子');
    expect(sheet[1][6]).toBe(10210);
    expect(sheet[3][0]).toBe('合計');
    expect(sheet[3][5]).toBe(155000);
  });
  test('支払台帳', () => {
    const sheet = buildLedgerSheetRows({ rows });
    expect(sheet[0]).toEqual(['支払日', '氏名', '請求書番号', '方式', '税抜', '消費税', '源泉徴収税額', '税込', '差引支払額', '経路', '受付番号', '要確認', '備考']);
    expect(sheet[1]).toEqual(['2026-10-31', '山田 花子', 'INV-2610-03', '税抜', 100000, 10000, 10210, 110000, 99790, 'API', 'A1', '', '']);
    expect(sheet[2]).toEqual(['2026-10-31', '鈴木 一郎', 'なし', '請求書なし', '', '', 0, 45000, 45000, '手動', '', '⚠', '請求書なし（PDF抽出額を税込として計上）']);
    expect(sheet[3][0]).toBe('合計');
  });
});

describe('buildWithholdingReminderText', () => {
  test('人数・支払金額・源泉税額・要確認・納付期限・税理士確認を含む', () => {
    const text = buildWithholdingReminderText({
      year: 2026, month: 10,
      summary: { payee_count: 7, payment_count: 8, gross_total: 1234560, withholding_total: 98765, net_total: 1135795, needs_review_count: 1 },
      pageUrl: 'https://hfs.example.com/haruka.html?page=payout&withholding=2026-10',
    });
    expect(text).toContain('[title]🧾 源泉所得税の納付リマインド（2026年10月支払分）[/title]');
    expect(text).toContain('人数: 7名（8件）');
    expect(text).toContain('支払金額（税込）: 1,234,560円');
    expect(text).toContain('源泉徴収税額: 98,765円');
    expect(text).toContain('⚠ 要確認: 1件');
    expect(text).toContain('納付期限: 2026-11-10');
    expect(text).toContain('税理士に確認');
    expect(text).toContain('台帳・出力: https://hfs.example.com/haruka.html?page=payout&withholding=2026-10');
  });
  test('支払 0 件のときは消し込み確認を促す', () => {
    const text = buildWithholdingReminderText({ year: 2026, month: 9, summary: summarizeMonth([]) });
    expect(text).toContain('支払の記録がありません');
    expect(text).not.toContain('人数:');
  });
});
