// tests/withholding-ledger.test.js
// 🧾 源泉徴収台帳（ADR 054 §5 Stage D）の純関数テスト。
// 月の境界・支払日は Asia/Tokyo 固定なので、TZ=UTC でも TZ=Asia/Tokyo でも同じ結果になること。
const {
  isoToJstYmd, jstRange, prevMonthOf, paymentDueDate,
  buildLedgerRows, summarizeMonth, summarizeYearByPayee,
  buildMonthlySheetRows, buildYearlySheetRows, buildLedgerSheetRows,
  buildWithholdingReminderText, CATEGORY_LABEL, DETAIL_LABEL,
  taxPaymentDueDate, summarizeWithholdingTargets, buildTaxPaymentFormRows, TAX_FORM_CATEGORY,
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
      paid_total: 99790 + 55000 + 45000,
      needs_review_count: 1,
    });
    expect(summarizeMonth([])).toEqual({ payee_count: 0, payment_count: 0, gross_total: 0, withholding_total: 0, net_total: 0, paid_total: 0, needs_review_count: 0 });
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
    // API 振込の明細は依頼時点のスナップショットなので snapshot_exempt（ローダが付ける）
    { user: yamada, paid_at: '2026-10-31T06:00:00Z', paid_via: 'aozora_api', invoice: invExclusive, apply_no: 'A1', snapshot_exempt: true },
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
  const rows = buildLedgerRows([
    { user: yamada, paid_at: '2026-10-31T06:00:00Z', paid_via: 'aozora_api', invoice: invExclusive, apply_no: 'A1' },
    { user: yamada, paid_at: '2026-10-05T06:00:00Z', paid_via: 'manual', invoice: invInclusive },
    { user: suzuki, paid_at: '2026-10-31T06:00:00Z', paid_via: null, invoice: null, invoice_amount: 45000 },
  ]);
  test('徴収高計算書の人員・支払額・税額（源泉対象のみ）・納付期限（e-Tax）・要確認・ディープリンクを含む', () => {
    const text = buildWithholdingReminderText({
      year: 2026, month: 10,
      summary: summarizeMonth(rows), rows,
      pageUrl: 'https://hfs.example.com/haruka.html?page=payout&withholding=2026-10',
    });
    expect(text).toContain('[title]🧾 源泉所得税の納付リマインド（2026年10月支払分）[/title]');
    // 源泉対象は山田の exclusive 1 件だけ（inclusive・請求書なしは数えない）
    expect(text).toContain('人員: 1名');
    expect(text).toContain('支払額: 110,000円');
    expect(text).toContain('税額: 10,210円');
    expect(text).toContain('（台帳全体: 2名・3件 ／ 支払金額（税込） 210,000円 ／ 差引支払額 199,790円）');
    expect(text).toContain('⚠ 要確認: 1件');
    expect(text).toContain('納付期限 2026/11/10（e-Tax で徴収高計算書を送信→ダイレクト納付/ペイジー）');
    expect(text).toContain('税理士に確認');
    expect(text).toContain('台帳・出力: https://hfs.example.com/haruka.html?page=payout&withholding=2026-10');
  });
  test('10日が土日祝なら繰り下げた期限を出す（2027/1/10 は日曜・11日は成人の日 → 1/12）', () => {
    const text = buildWithholdingReminderText({ year: 2026, month: 12, summary: summarizeMonth([]), rows: [] });
    expect(text).toContain('納付期限 2027/01/12（2027/01/10 が土日祝のため繰り下げ）（e-Tax で徴収高計算書を送信→ダイレクト納付/ペイジー）');
  });
  test('支払 0 件のときは消し込み確認を促しつつ人員 0 名を出す', () => {
    const text = buildWithholdingReminderText({ year: 2026, month: 9, summary: summarizeMonth([]), rows: [] });
    expect(text).toContain('支払の記録がありません');
    expect(text).toContain('人員: 0名');
    expect(text).toContain('税額: 0円');
    expect(text).toContain('納付期限 2026/10/13（2026/10/10 が土日祝のため繰り下げ）'); // 10/10 土・10/12 スポーツの日
  });
});

describe('合算支払の差額行（ADR 054 追補 2026-10-30）', () => {
  test('消し込み額 149,790（請求書 99,790 ＋ 外部 PDF 50,000）→ 請求書行＋「請求書外の支払」行、summary の実支払は 149,790', () => {
    const rows = buildLedgerRows([
      { user: yamada, paid_at: '2026-10-31T06:00:00Z', paid_via: 'manual', invoice: invExclusive, paid_amount: 149790, payout_record_id: 'pr1' },
    ]);
    expect(rows).toHaveLength(2);
    const [main, extra] = rows;
    expect(main).toMatchObject({ source: 'invoice_exclusive', invoice_number: 'INV-2610-03', gross: 110000, withholding: 10210, net: 99790, paid_amount: 149790, needs_review: false });
    expect(extra).toMatchObject({
      source: 'extra', invoice_number: null, subtotal: null, tax: null, withholding: 0, gross: 50000, net: 50000,
      user_id: 'u1', paid_date: '2026-10-31', paid_via: 'manual', payout_record_id: 'pr1', extra_of_payout_record_id: 'pr1',
      needs_review: true,
    });
    expect(extra.review_reasons).toEqual(['請求書外の支払（PDF 抽出額との差額）']);
    expect(extra.notes[0]).toContain('差引 99,790円 に対し支払 149,790円');
    const s = summarizeMonth(rows);
    expect(s.paid_total).toBe(149790);
    expect(s.net_total).toBe(149790);
    expect(s.gross_total).toBe(160000);      // 税込 110,000 ＋ 差額 50,000
    expect(s.withholding_total).toBe(10210); // 差額行は源泉 0
    expect(s.payee_count).toBe(1);
    expect(s.needs_review_count).toBe(1);
    // 支払台帳シートの方式列
    const sheet = buildLedgerSheetRows({ rows });
    expect(sheet[2][3]).toBe('請求書外');
    expect(sheet[2][11]).toBe('⚠');
  });
  test('請求書より少なく払った場合は負の差額行で要確認', () => {
    const rows = buildLedgerRows([
      { user: yamada, paid_at: '2026-10-31T06:00:00Z', paid_via: 'manual', invoice: invExclusive, paid_amount: 90000, payout_record_id: 'pr1' },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ source: 'extra', gross: -9790, net: -9790, withholding: 0, needs_review: true });
    expect(rows[1].review_reasons).toEqual(['請求書外の支払（PDF 抽出額との差額）', '請求書の差引額より少なく支払っています']);
    expect(summarizeMonth(rows).paid_total).toBe(90000);
  });
  test('inclusive は total_amount と比較。一致すれば差額行なし・API 振込も同じ', () => {
    const same = buildLedgerRows([
      { user: yamada, paid_at: '2026-10-05T06:00:00Z', paid_via: 'manual', invoice: invInclusive, paid_amount: 55000 },
      { user: suzuki, paid_at: '2026-10-31T06:00:00Z', paid_via: 'aozora_api', invoice: invExclusive, paid_amount: 99790, snapshot_exempt: true, transfer_item_id: 'ti1' },
    ]);
    expect(same).toHaveLength(2);
    expect(same.every(r => r.source !== 'extra')).toBe(true);
    const diff = buildLedgerRows([{ user: yamada, paid_at: '2026-10-05T06:00:00Z', paid_via: 'manual', invoice: invInclusive, paid_amount: 60000 }]);
    expect(diff).toHaveLength(2);
    expect(diff[1]).toMatchObject({ source: 'extra', gross: 5000 });
  });
  test('請求書なし・支払額不明（paid_amount null）は差額行を作らない', () => {
    expect(buildLedgerRows([{ user: suzuki, paid_at: '2026-10-31T06:00:00Z', invoice: null, paid_amount: 45000 }])).toHaveLength(1);
    expect(buildLedgerRows([{ user: yamada, paid_at: '2026-10-31T06:00:00Z', invoice: invExclusive, paid_amount: null }])).toHaveLength(1);
  });
});

describe('ledger_snapshot（支払時点の凍結額）優先', () => {
  const snapshot = {
    amount: 99790, invoice_id: 'inv1', invoice_number: 'INV-2610-03',
    subtotal_amount: 100000, tax_amount: 10000, withholding_amount: 10210, payout_amount: 99790, snapshot_at: '2026-10-31T06:00:01Z',
  };
  test('スナップショットがあれば、後から編集された現在の請求書ではなくスナップショットの額を使う', () => {
    const editedInvoice = { ...invExclusive, subtotal_amount: 200000, tax_amount: 20000, total_amount: 220000, withholding_amount: 20420, payout_amount: 199580 };
    const [r] = buildLedgerRows([
      { user: yamada, paid_at: '2026-10-31T06:00:00Z', paid_via: 'manual', invoice: editedInvoice, paid_amount: 99790, snapshot },
    ]);
    expect(r).toMatchObject({ source: 'invoice_exclusive', invoice_number: 'INV-2610-03', subtotal: 100000, tax: 10000, withholding: 10210, gross: 110000, net: 99790, from_snapshot: true, needs_review: false });
    expect(r.notes).not.toContain('スナップショット無し（請求書の後編集で変わる可能性）');
  });
  test('スナップショットが無い行は現在の請求書から組み立てて注記を付ける（API 振込の明細は除外）', () => {
    const [manual] = buildLedgerRows([{ user: yamada, paid_at: '2026-10-31T06:00:00Z', paid_via: 'manual', invoice: invExclusive, paid_amount: 99790 }]);
    expect(manual.from_snapshot).toBe(false);
    expect(manual.needs_review).toBe(false);
    expect(manual.notes).toContain('スナップショット無し（請求書の後編集で変わる可能性）');
    const [api] = buildLedgerRows([{ user: yamada, paid_at: '2026-10-31T06:00:00Z', paid_via: 'aozora_api', invoice: invExclusive, paid_amount: 99790, snapshot_exempt: true }]);
    expect(api.notes).not.toContain('スナップショット無し（請求書の後編集で変わる可能性）');
    const [none] = buildLedgerRows([{ user: suzuki, paid_at: '2026-10-31T06:00:00Z', invoice: null, paid_amount: 45000 }]);
    expect(none.notes).toEqual([]); // 請求書を使っていない行には付けない
  });
  test('スナップショットの請求書なし（invoice_id 無し）は amount を税込として要確認、inclusive は payout_amount を税込', () => {
    const [pdf] = buildLedgerRows([{ user: suzuki, paid_at: '2026-10-31T06:00:00Z', invoice: null, snapshot: { amount: 45000, snapshot_at: '2026-10-31T06:00:01Z' } }]);
    expect(pdf).toMatchObject({ source: 'pdf', gross: 45000, net: 45000, needs_review: true, from_snapshot: false });
    const [inc] = buildLedgerRows([{ user: yamada, paid_at: '2026-10-05T06:00:00Z', invoice: null, snapshot: { amount: 55000, invoice_id: 'inv2', invoice_number: 'INV-2609-11', payout_amount: 55000 } }]);
    expect(inc).toMatchObject({ source: 'invoice_inclusive', invoice_number: 'INV-2609-11', gross: 55000, net: 55000, withholding: 0, from_snapshot: true });
  });
  test('スナップショットの額と支払額がずれていれば差額行（スナップショットの差引と比較）', () => {
    const rows = buildLedgerRows([{ user: yamada, paid_at: '2026-10-31T06:00:00Z', paid_via: 'manual', invoice: invExclusive, paid_amount: 149790, snapshot: { ...snapshot, amount: 149790 } }]);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ source: 'extra', gross: 50000 });
    expect(summarizeMonth(rows).paid_total).toBe(149790);
  });
});

describe('taxPaymentDueDate / summarizeWithholdingTargets / buildTaxPaymentFormRows', () => {
  test('納付期限は翌月10日。土日祝は翌営業日へ（祝日表のある年）、無い年は土日だけ繰り下げて holiday_checked=false', () => {
    // 9月支払分 → 10/10 土・10/11 日・10/12 スポーツの日 → 10/13
    expect(taxPaymentDueDate(2026, 9)).toEqual({ date: '2026-10-13', base: '2026-10-10', holiday_checked: true, shifted: true });
    expect(taxPaymentDueDate(2026, 10)).toEqual({ date: '2026-11-10', base: '2026-11-10', holiday_checked: true, shifted: false });
    expect(taxPaymentDueDate(2026, 12)).toEqual({ date: '2027-01-12', base: '2027-01-10', holiday_checked: true, shifted: true });
    // 2030 は祝日表に無い: 2030-01-10 は木曜なのでそのまま、holiday_checked=false
    expect(taxPaymentDueDate(2029, 12)).toEqual({ date: '2030-01-10', base: '2030-01-10', holiday_checked: false, shifted: false });
  });
  const rows = buildLedgerRows([
    { user: yamada, paid_at: '2026-10-31T06:00:00Z', paid_via: 'aozora_api', invoice: invExclusive, apply_no: 'A1' },
    { user: yamada, paid_at: '2026-10-05T06:00:00Z', paid_via: 'manual', invoice: invInclusive },
    { user: suzuki, paid_at: '2026-10-31T06:00:00Z', paid_via: null, invoice: null, invoice_amount: 45000 },
    { user: suzuki, paid_at: '2026-10-20T06:00:00Z', paid_via: 'manual', invoice: { ...invExclusive, id: 'inv9', invoice_number: 'INV-2610-09', subtotal_amount: 50000, tax_amount: 5000, total_amount: 55000, withholding_amount: 5105, payout_amount: 49895 } },
  ]);
  test('源泉対象（源泉>0）だけを数える', () => {
    expect(summarizeWithholdingTargets(rows)).toEqual({
      payee_count: 2, payment_count: 2, gross_total: 165000, withholding_total: 15315,
      first_paid_date: '2026-10-20', last_paid_date: '2026-10-31', excluded_count: 2,
    });
    expect(summarizeWithholdingTargets([]).first_paid_date).toBeNull();
  });
  test('徴収高計算書 転記用は e-Tax の入力順', () => {
    const sheet = buildTaxPaymentFormRows(summarizeMonth(rows), rows, { year: 2026, month: 10 });
    const byLabel = Object.fromEntries(sheet.filter(r => r.length >= 2).map(r => [r[0], r[1]]));
    expect(sheet[0]).toEqual(['項目', '値', '注記']);
    expect(sheet.slice(1, 13).map(r => r[0])).toEqual([
      '納期等の区分（支払年月）', '区分', '区分コード', '支払年月日', '人員', '支払額', '税額', '本税', '延滞税', '合計額', '納付の目的（摘要）', '納付期限',
    ]);
    expect(byLabel['納期等の区分（支払年月）']).toBe('2026-10');
    expect(byLabel['区分']).toBe(TAX_FORM_CATEGORY);
    expect(TAX_FORM_CATEGORY).toBe('原稿料・講演料等');
    expect(byLabel['区分コード']).toBe('');
    expect(sheet.find(r => r[0] === '区分コード')[2]).toBe('様式で確認');
    expect(byLabel['支払年月日']).toBe('2026/10/20〜2026/10/31');
    expect(byLabel['人員']).toBe(2);
    expect(byLabel['支払額']).toBe(165000);
    expect(byLabel['税額']).toBe(15315);
    expect(byLabel['本税']).toBe(15315);
    expect(byLabel['延滞税']).toBe(0);
    expect(byLabel['合計額']).toBe(15315);
    expect(byLabel['納付の目的（摘要）']).toBe('2026年10月分報酬');
    expect(byLabel['納付期限']).toBe('2026/11/10'); // 火曜・祝日でないのでそのまま
    expect(sheet.find(r => r[0] === '納付期限')[2]).toBe('支払月の翌月10日');
    // 繰り下げの注記は 9 月支払分（10/10 土 → 10/13）で確認
    const sep = buildTaxPaymentFormRows(summarizeMonth([]), [], { year: 2026, month: 9 });
    expect(sep.find(r => r[0] === '納付期限')[1]).toBe('2026/10/13');
    expect(sep.find(r => r[0] === '納付期限')[2]).toContain('翌営業日に繰り下げ');
    expect(sheet.some(r => String(r[0]).startsWith('要確認 1件（請求書なし・源泉 0 で計上）'))).toBe(true);
  });
  test('支払日が1日だけなら範囲でなく1つ', () => {
    const one = buildLedgerRows([{ user: yamada, paid_at: '2026-11-30T06:00:00Z', paid_via: 'manual', invoice: invExclusive }]);
    const sheet = buildTaxPaymentFormRows(summarizeMonth(one), one, { year: 2026, month: 11 });
    expect(sheet.find(r => r[0] === '支払年月日')[1]).toBe('2026/11/30');
    expect(sheet.find(r => r[0] === '納付期限')[1]).toBe('2026/12/10');
    expect(sheet.some(r => String(r[0]).startsWith('要確認 0件'))).toBe(true);
  });
});
