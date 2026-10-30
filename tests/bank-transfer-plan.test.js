const plan = require('../utils/bank-transfer-plan');

const NOW = Date.UTC(2026, 10, 1, 0, 0, 0); // 2026-11-01

function user(over = {}) {
  return {
    id: 'u1', full_name: '山田 花子', nickname: 'はな', is_active: true,
    bank_code: '0310', branch_code: '101', account_type: '普通', account_number: '1234567',
    account_holder_kana: 'ヤマダ　ハナコ', bank_info_updated_at: null,
    ...over,
  };
}
function record(over = {}) {
  return { id: 'r1', user_id: 'u1', year: 2026, month: 10, status: 'unpaid', invoice_amount: 110000, ...over };
}
function invoice(over = {}) {
  return {
    id: 'i1', invoice_number: 'INV-2610-01', issuer_id: 'u1', status: 'submitted', year: 2026, month: 10, invoice_type: null,
    tax_mode: 'exclusive', subtotal_amount: 100000, tax_amount: 10000, total_amount: 110000, withholding_amount: 10210, payout_amount: 99790,
    ...over,
  };
}

describe('planTransferItems', () => {
  test('exclusive の請求書 → payout_amount・台帳用の内訳つき', () => {
    const r = plan.planTransferItems({ records: [record()], users: [user()], invoices: [invoice()], year: 2026, month: 10, now: NOW });
    expect(r.excluded).toEqual([]);
    expect(r.total_count).toBe(1);
    expect(r.total_amount).toBe(99790);
    const it = r.items[0];
    expect(it.item_id).toBe(1);
    expect(it.beneficiary_name).toBe('ﾔﾏﾀﾞ ﾊﾅｺ');
    expect(it.account_number_last4).toBe('****4567');
    expect(it.amount_source).toBe('invoice');
    expect(it.invoice_id).toBe('i1');
    expect(it.gross_amount).toBe(110000);
    expect(it.tax_amount).toBe(10000);
    expect(it.withholding_amount).toBe(10210);
    expect(it.display_name).toBe('はな（山田 花子）');
  });

  test('inclusive の請求書 → total_amount・源泉 0', () => {
    const r = plan.planTransferItems({ records: [record()], users: [user()], invoices: [invoice({ tax_mode: 'inclusive', payout_amount: null, withholding_amount: null, tax_amount: null, subtotal_amount: null })], year: 2026, month: 10, now: NOW });
    expect(r.items[0].amount).toBe(110000);
    expect(r.items[0].withholding_amount).toBe(0);
  });

  test('請求書が無ければ payout_records.invoice_amount（PDF 額）＋警告', () => {
    const r = plan.planTransferItems({ records: [record({ invoice_amount: 45000 })], users: [user()], invoices: [], year: 2026, month: 10, now: NOW });
    expect(r.items[0].amount).toBe(45000);
    expect(r.items[0].amount_source).toBe('pdf');
    expect(r.items[0].warnings).toContain('請求書なし（PDF 抽出額を使用）');
    expect(r.warnings.length).toBe(1);
  });

  test('下書き・クライアント請求書・別月の請求書は数えない', () => {
    const r = plan.planTransferItems({
      records: [record({ invoice_amount: 45000 })], users: [user()],
      invoices: [invoice({ status: 'draft' }), invoice({ id: 'i2', invoice_type: 'client' }), invoice({ id: 'i3', month: 9 })],
      year: 2026, month: 10, now: NOW,
    });
    expect(r.items[0].amount_source).toBe('pdf');
  });

  test('同月に複数の請求書があれば合算して警告', () => {
    const r = plan.planTransferItems({ records: [record()], users: [user()], invoices: [invoice(), invoice({ id: 'i2', invoice_number: 'INV-2610-02', payout_amount: 10000, total_amount: 11000, withholding_amount: 1000, tax_amount: 1000 })], year: 2026, month: 10, now: NOW });
    expect(r.items[0].amount).toBe(109790);
    expect(r.items[0].invoice_numbers).toEqual(['INV-2610-01', 'INV-2610-02']);
    expect(r.items[0].warnings.some(w => w.includes('2 件'))).toBe(true);
  });

  test('除外: 振込済み / 無効 / 二重 / 口座変更 7 日以内 / 口座不備 / 金額不明', () => {
    const recent = new Date(NOW - 2 * 24 * 60 * 60 * 1000).toISOString();
    const r = plan.planTransferItems({
      records: [
        record({ id: 'r1', user_id: 'u1' }),
        record({ id: 'r2', user_id: 'u2', status: 'paid' }),
        record({ id: 'r3', user_id: 'u3' }),
        record({ id: 'r4', user_id: 'u4' }),
        record({ id: 'r5', user_id: 'u5' }),
        record({ id: 'r6', user_id: 'u6', invoice_amount: null }),
        record({ id: 'r7', user_id: 'u7', month: 9 }),
      ],
      notFoundIds: ['r0'],
      users: [
        user({ id: 'u1', is_active: false }),
        user({ id: 'u2' }),
        user({ id: 'u3' }),
        user({ id: 'u4', bank_info_updated_at: recent }),
        user({ id: 'u5', account_number: '123456789' }),
        user({ id: 'u6' }),
        user({ id: 'u7' }),
      ],
      invoices: [],
      blockedUserIds: ['u3'],
      year: 2026, month: 10, now: NOW,
    });
    expect(r.items).toEqual([]);
    const byRec = Object.fromEntries(r.excluded.map(e => [e.payout_record_id, e]));
    expect(byRec.r0.reason_code).toBe('record_not_found');
    expect(byRec.r1.reason_code).toBe('inactive');
    expect(byRec.r2.reason_code).toBe('already_paid');
    expect(byRec.r3.reason_code).toBe('duplicate_in_month');
    expect(byRec.r4.reason_code).toBe('bank_info_recent');
    expect(byRec.r4.days_remaining).toBe(5);
    expect(byRec.r5.reason_code).toBe('bank_info_invalid');
    expect(byRec.r5.errors[0]).toMatch(/8 桁以上/);
    expect(byRec.r6.reason_code).toBe('amount_unknown');
    expect(byRec.r7.reason_code).toBe('wrong_month');
  });

  test('口座変更から 7 日たてば対象になる', () => {
    const old = new Date(NOW - 8 * 24 * 60 * 60 * 1000).toISOString();
    const r = plan.planTransferItems({ records: [record()], users: [user({ bank_info_updated_at: old })], invoices: [invoice()], year: 2026, month: 10, now: NOW });
    expect(r.items.length).toBe(1);
  });

  test('並びは氏名順で安定（item_id が 1 から振られ、同じ入力なら同じハッシュ）', () => {
    const inputs = {
      records: [record({ id: 'rb', user_id: 'ub' }), record({ id: 'ra', user_id: 'ua' })],
      users: [user({ id: 'ua', full_name: '佐藤 太郎' }), user({ id: 'ub', full_name: '山田 花子' })],
      invoices: [invoice({ issuer_id: 'ua' }), invoice({ id: 'i2', issuer_id: 'ub' })],
      year: 2026, month: 10, now: NOW,
    };
    const a = plan.planTransferItems(inputs);
    const b = plan.planTransferItems({ ...inputs, records: [...inputs.records].reverse() });
    expect(a.items.map(i => i.user_id)).toEqual(['ua', 'ub']);
    expect(a.items.map(i => i.item_id)).toEqual([1, 2]);
    expect(plan.planHash(a.items, '2026-11-05')).toBe(plan.planHash(b.items, '2026-11-05'));
    expect(plan.planHash(a.items, '2026-11-06')).not.toBe(plan.planHash(a.items, '2026-11-05'));
  });
});

describe('buildBulkTransferBody', () => {
  test('仕様の項目名・文字列型で組み立てる', () => {
    const r = plan.planTransferItems({ records: [record()], users: [user()], invoices: [invoice()], year: 2026, month: 10, now: NOW });
    const body = plan.buildBulkTransferBody({ accountId: '101012698906', transferDesignatedDate: '2026-11-05', transferDataName: plan.transferDataNameFor(2026, 10), items: r.items });
    expect(body).toEqual({
      accountId: '101012698906',
      transferDesignatedDate: '2026-11-05',
      transferDateHolidayCode: '1',
      transferDataName: '26年10月分報酬',
      totalCount: '1',
      totalAmount: '99790',
      bulkTransfers: [{
        itemId: '1', beneficiaryBankCode: '0310', beneficiaryBranchCode: '101', accountTypeCode: '1',
        accountNumber: '1234567', beneficiaryName: 'ﾔﾏﾀﾞ ﾊﾅｺ', transferAmount: '99790',
      }],
    });
    expect(body.transferDataName.length).toBeLessThanOrEqual(10);
  });
});

describe('summarizeItems / validateDesignatedDate', () => {
  test('summarizeItems は口座番号の全桁を含まない', () => {
    const r = plan.planTransferItems({ records: [record()], users: [user()], invoices: [invoice()], year: 2026, month: 10, now: NOW });
    const s = plan.summarizeItems(r.items)[0];
    expect(s.account_number).toBeUndefined();
    expect(s.account_number_last4).toBe('****4567');
    expect(s.amount).toBe(99790);
  });
  test('振込指定日の検証', () => {
    expect(plan.validateDesignatedDate('2026-11-05', '2026-11-01')).toEqual({ ok: true, value: '2026-11-05' });
    expect(plan.validateDesignatedDate('2026-10-31', '2026-11-01').ok).toBe(false);
    expect(plan.validateDesignatedDate('2026-13-01', '2026-11-01').ok).toBe(false);
    expect(plan.validateDesignatedDate('2026/11/05', '2026-11-01').ok).toBe(false);
    expect(plan.validateDesignatedDate('2027-03-01', '2026-11-01').ok).toBe(false);
  });
});

describe('二重依頼の除外（ADR 054 §3-2 追補）', () => {
  const batches = [
    { id: 'b-requesting', status: 'requesting' },
    { id: 'b-await', status: 'awaiting_approval' },
    { id: 'b-done', status: 'completed' },
    { id: 'b-expired', status: 'expired' },
    { id: 'b-cancel', status: 'cancelled' },
    { id: 'b-failed', status: 'failed' },
  ];
  const items = [
    { batch_id: 'b-requesting', user_id: 'u-req', status: 'pending' },
    { batch_id: 'b-await', user_id: 'u-await', status: 'pending' },
    { batch_id: 'b-done', user_id: 'u-done', status: 'completed' },
    { batch_id: 'b-done', user_id: 'u-returned', status: 'returned' },
    { batch_id: 'b-done', user_id: 'u-failed-item', status: 'failed' },
    { batch_id: 'b-expired', user_id: 'u-expired', status: 'pending' },
    { batch_id: 'b-cancel', user_id: 'u-cancel', status: 'pending' },
    { batch_id: 'b-failed', user_id: 'u-failed-batch', status: 'pending' },
  ];
  test('requesting / awaiting_approval / completed の未確定・完了明細を持つ人だけブロック', () => {
    const blocked = plan.blockedUserIdsFromItems(batches, items);
    expect([...blocked].sort()).toEqual(['u-await', 'u-done', 'u-req']);
  });
  test('BLOCKING_BATCH_STATUSES に requesting が含まれる', () => {
    expect(plan.BLOCKING_BATCH_STATUSES).toContain('requesting');
    expect(plan.BLOCKING_BATCH_STATUSES).not.toContain('expired');
  });
  test('request 時の再評価: ブロック対象の user_id を返す（空なら OK）', () => {
    const blocked = plan.blockedUserIdsFromItems(batches, items);
    expect(plan.alreadyRequestedUserIds([{ user_id: 'u-await' }, { user_id: 'u-new' }, { user_id: 'u-await' }], blocked)).toEqual(['u-await']);
    expect(plan.alreadyRequestedUserIds([{ user_id: 'u-new' }, { user_id: 'u-expired' }], blocked)).toEqual([]);
  });
  test('planTransferItems でも blockedUserIds の人は duplicate_in_month で除外', () => {
    const blocked = plan.blockedUserIdsFromItems(batches, items);
    const r = plan.planTransferItems({
      records: [record({ id: 'r1', user_id: 'u-await' }), record({ id: 'r2', user_id: 'u-expired' })],
      users: [user({ id: 'u-await' }), user({ id: 'u-expired' })],
      invoices: [invoice({ issuer_id: 'u-await' }), invoice({ id: 'i2', issuer_id: 'u-expired' })],
      blockedUserIds: blocked, year: 2026, month: 10, now: NOW,
    });
    expect(r.items.map(i => i.user_id)).toEqual(['u-expired']);
    expect(r.excluded[0]).toMatchObject({ payout_record_id: 'r1', reason_code: 'duplicate_in_month' });
  });
});

describe('checkDesignatedDateMatch（token の日付と body の日付）', () => {
  test('一致すれば ok', () => {
    expect(plan.checkDesignatedDateMatch('2026-11-05', '2026-11-05')).toEqual({ ok: true, value: '2026-11-05' });
    expect(plan.checkDesignatedDateMatch('2026-11-05', ' 2026-11-05 ')).toEqual({ ok: true, value: '2026-11-05' });
  });
  test('違えば date_mismatch、無ければ date_required', () => {
    expect(plan.checkDesignatedDateMatch('2026-11-05', '2026-11-06')).toMatchObject({ ok: false, code: 'date_mismatch' });
    expect(plan.checkDesignatedDateMatch('2026-11-05', '')).toMatchObject({ ok: false, code: 'date_required' });
    expect(plan.checkDesignatedDateMatch('2026-11-05', undefined)).toMatchObject({ ok: false, code: 'date_required' });
  });
});

describe('buildLedgerSnapshot（支払時点の凍結）', () => {
  test('exclusive の請求書から内訳を写す', () => {
    const s = plan.buildLedgerSnapshot({ amount: 99790, invoices: [invoice()], now: new Date(NOW) });
    expect(s).toEqual({
      amount: 99790, invoice_id: 'i1', invoice_number: 'INV-2610-01', invoice_count: 1,
      subtotal_amount: 100000, tax_amount: 10000, withholding_amount: 10210, payout_amount: 99790, total_amount: 110000,
      snapshot_at: new Date(NOW).toISOString(),
    });
  });
  test('inclusive は源泉 0、複数は合算、請求書なしは null', () => {
    const inc = plan.buildLedgerSnapshot({ amount: 110000, invoices: [invoice({ tax_mode: 'inclusive', subtotal_amount: null, tax_amount: null, withholding_amount: null, payout_amount: null })] });
    expect(inc.withholding_amount).toBe(0);
    expect(inc.payout_amount).toBe(110000);
    expect(inc.subtotal_amount).toBeNull();
    const two = plan.buildLedgerSnapshot({ amount: 109790, invoices: [invoice(), invoice({ id: 'i2', invoice_number: 'INV-2610-02', payout_amount: 10000, total_amount: 11000, withholding_amount: 1000, tax_amount: 1000, subtotal_amount: 10000 })] });
    expect(two.invoice_number).toBe('INV-2610-01, INV-2610-02');
    expect(two.withholding_amount).toBe(11210);
    expect(two.payout_amount).toBe(109790);
    const none = plan.buildLedgerSnapshot({ amount: 45000, invoices: [] });
    expect(none).toMatchObject({ amount: 45000, invoice_id: null, invoice_number: null, invoice_count: 0, withholding_amount: null, payout_amount: null });
  });
});

describe('matchPendingAcceptance（応答が消えた依頼の受付確認）', () => {
  const batch = { transfer_data_name: '26年10月分報酬', total_count: 2, total_amount: 150000, transfer_designated_date: '2026-11-05' };
  const res = (over) => ({ bulkTransferDetails: [{ transferStatus: '2', transferApplies: [{ applyNo: '2026110112345678' }], bulktransferResponses: [{ transferDataName: '26年10月分報酬', totalCount: '2', totalAmount: '150000', transferDesignatedDate: '2026-11-05', ...over }] }] });
  test('振込データ名＋件数＋合計が一致すれば applyNo を返す', () => {
    expect(plan.matchPendingAcceptance(res(), batch)).toEqual({ applyNo: '2026110112345678', transferStatus: '2' });
  });
  test('件数・合計・データ名・指定日のどれかが違えば null', () => {
    expect(plan.matchPendingAcceptance(res({ totalCount: '3' }), batch)).toBeNull();
    expect(plan.matchPendingAcceptance(res({ totalAmount: '150001' }), batch)).toBeNull();
    expect(plan.matchPendingAcceptance(res({ transferDataName: '26年9月分報酬' }), batch)).toBeNull();
    expect(plan.matchPendingAcceptance(res({ transferDesignatedDate: '2026-11-06' }), batch)).toBeNull();
    expect(plan.matchPendingAcceptance({}, batch)).toBeNull();
  });
});
