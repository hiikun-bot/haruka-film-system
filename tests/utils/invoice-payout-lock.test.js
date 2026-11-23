// utils/invoice-payout-lock.js（振込済み・振込依頼中の請求書は戻さない・ADR 046 追補 2026-11-22）
const { payoutLockOf, loadInvoicePayoutLock, isMissingTableError } = require('../../utils/invoice-payout-lock');
const plan = require('../../utils/bank-transfer-plan');

const invoice = { id: 'inv1', issuer_id: 'u1', year: 2026, month: 10, invoice_type: null };

describe('payoutLockOf（純関数）', () => {
  test('振込レコードも依頼も無ければ null', () => {
    expect(payoutLockOf({ invoice })).toBeNull();
    expect(payoutLockOf({ invoice, payoutRecords: [], batches: [], items: [] })).toBeNull();
  });
  test('同じ本人・年月が paid なら paid', () => {
    const r = payoutLockOf({ invoice, payoutRecords: [{ user_id: 'u1', year: 2026, month: 10, status: 'paid' }] });
    expect(r.code).toBe('paid');
    expect(r.error).toMatch(/振込済みのため/);
  });
  test('unpaid・別の月・別の年・別の人は対象外（年月は文字列でも比べられる）', () => {
    expect(payoutLockOf({ invoice, payoutRecords: [
      { user_id: 'u1', year: 2026, month: 10, status: 'unpaid' },
      { user_id: 'u1', year: 2026, month: 9, status: 'paid' },
      { user_id: 'u1', year: 2025, month: 10, status: 'paid' },
      { user_id: 'u2', year: 2026, month: 10, status: 'paid' },
    ] })).toBeNull();
    expect(payoutLockOf({ invoice: { ...invoice, year: '2026', month: '10' }, payoutRecords: [{ user_id: 'u1', year: 2026, month: 10, status: 'paid' }] }).code).toBe('paid');
  });
  test('進行中の依頼（BLOCKING_BATCH_STATUSES）に本人の明細があれば transfer_in_progress', () => {
    for (const status of plan.BLOCKING_BATCH_STATUSES) {
      const r = payoutLockOf({ invoice, batches: [{ id: 'b1', status }], items: [{ batch_id: 'b1', user_id: 'u1', status: 'pending' }] });
      expect(r.code).toBe('transfer_in_progress');
      expect(r.error).toMatch(/総合振込を依頼中/);
    }
  });
  test('取消・期限切れ・失敗の依頼、failed / returned の明細、他人の明細は対象外', () => {
    for (const status of ['cancelled', 'expired', 'failed']) {
      expect(payoutLockOf({ invoice, batches: [{ id: 'b1', status }], items: [{ batch_id: 'b1', user_id: 'u1', status: 'pending' }] })).toBeNull();
    }
    for (const status of ['failed', 'returned']) {
      expect(payoutLockOf({ invoice, batches: [{ id: 'b1', status: 'completed' }], items: [{ batch_id: 'b1', user_id: 'u1', status }] })).toBeNull();
    }
    expect(payoutLockOf({ invoice, batches: [{ id: 'b1', status: 'approved' }], items: [{ batch_id: 'b1', user_id: 'u2', status: 'pending' }] })).toBeNull();
  });
  test('paid と依頼中の両方なら paid を優先', () => {
    const r = payoutLockOf({
      invoice,
      payoutRecords: [{ user_id: 'u1', year: 2026, month: 10, status: 'paid' }],
      batches: [{ id: 'b1', status: 'approved' }], items: [{ batch_id: 'b1', user_id: 'u1', status: 'pending' }],
    });
    expect(r.code).toBe('paid');
  });
  test('メンバー請求書だけが対象（クライアント宛て・請求者なし・請求書なしは null）', () => {
    const paid = [{ user_id: 'u1', year: 2026, month: 10, status: 'paid' }];
    expect(payoutLockOf({ invoice: { ...invoice, invoice_type: 'client' }, payoutRecords: paid })).toBeNull();
    expect(payoutLockOf({ invoice: { ...invoice, invoice_type: 'member' }, payoutRecords: paid }).code).toBe('paid');
    expect(payoutLockOf({ invoice: { ...invoice, issuer_id: null }, payoutRecords: paid })).toBeNull();
    expect(payoutLockOf({ payoutRecords: paid })).toBeNull();
    expect(payoutLockOf()).toBeNull();
  });
});

describe('isMissingTableError', () => {
  test('テーブルなしのエラーだけ true', () => {
    expect(isMissingTableError({ code: '42P01', message: 'relation "payout_transfer_items" does not exist' })).toBe(true);
    expect(isMissingTableError({ code: 'PGRST205', message: "Could not find the table 'public.payout_transfer_batches' in the schema cache" })).toBe(true);
    expect(isMissingTableError({ message: 'relation "x" does not exist' })).toBe(true);
    expect(isMissingTableError({ code: '57014', message: 'canceling statement due to statement timeout' })).toBe(false);
    expect(isMissingTableError(null)).toBe(false);
  });
});

describe('loadInvoicePayoutLock（読み込み）', () => {
  // テーブルごとに { rows } か { error } を返す小さな偽 supabase。呼ばれたテーブルと select 列を記録する
  function fakeSupabase(tables) {
    const calls = [];
    return {
      calls,
      from(table) {
        const filters = [];
        const b = {
          select(cols) { calls.push({ table, cols }); return b; },
          eq(c, v) { filters.push(r => r[c] === v); return b; },
          in(c, vs) { filters.push(r => vs.includes(r[c])); return b; },
          then(res, rej) {
            const t = tables[table] || {};
            const out = t.error ? { data: null, error: t.error } : { data: (t.rows || []).filter(r => filters.every(f => f(r))), error: null };
            return Promise.resolve(out).then(res, rej);
          },
        };
        return b;
      },
    };
  }
  const missing = { code: '42P01', message: 'relation does not exist' };

  test('paid の振込レコードがあれば paid（総合振込のテーブルは読まない）', async () => {
    const sb = fakeSupabase({ payout_records: { rows: [{ user_id: 'u1', year: 2026, month: 10, status: 'paid' }] } });
    expect((await loadInvoicePayoutLock(sb, invoice)).code).toBe('paid');
    expect(sb.calls.map(c => c.table)).toEqual(['payout_records']);
  });
  test('別の本人・別の月の paid は拾わない', async () => {
    const sb = fakeSupabase({ payout_records: { rows: [
      { user_id: 'u2', year: 2026, month: 10, status: 'paid' },
      { user_id: 'u1', year: 2026, month: 9, status: 'paid' },
    ] } });
    expect(await loadInvoicePayoutLock(sb, invoice)).toBeNull();
  });
  test('進行中の依頼に本人の明細があれば transfer_in_progress（batch は status も読む）', async () => {
    const sb = fakeSupabase({
      payout_transfer_batches: { rows: [{ id: 'b1', year: 2026, month: 10, status: 'awaiting_approval' }, { id: 'b0', year: 2026, month: 10, status: 'cancelled' }] },
      payout_transfer_items: { rows: [{ batch_id: 'b1', user_id: 'u1', status: 'pending' }] },
    });
    expect((await loadInvoicePayoutLock(sb, invoice)).code).toBe('transfer_in_progress');
    expect(sb.calls.find(c => c.table === 'payout_transfer_batches').cols).toMatch(/status/);
  });
  test('取消済みの依頼・他人の明細・failed の明細・別の月の依頼は null', async () => {
    expect(await loadInvoicePayoutLock(fakeSupabase({
      payout_transfer_batches: { rows: [{ id: 'b0', year: 2026, month: 10, status: 'cancelled' }] },
      payout_transfer_items: { rows: [{ batch_id: 'b0', user_id: 'u1', status: 'pending' }] },
    }), invoice)).toBeNull();
    expect(await loadInvoicePayoutLock(fakeSupabase({
      payout_transfer_batches: { rows: [{ id: 'b1', year: 2026, month: 10, status: 'approved' }] },
      payout_transfer_items: { rows: [{ batch_id: 'b1', user_id: 'u2', status: 'pending' }, { batch_id: 'b1', user_id: 'u1', status: 'failed' }] },
    }), invoice)).toBeNull();
    expect(await loadInvoicePayoutLock(fakeSupabase({
      payout_transfer_batches: { rows: [{ id: 'b1', year: 2026, month: 9, status: 'approved' }] },
      payout_transfer_items: { rows: [{ batch_id: 'b1', user_id: 'u1', status: 'pending' }] },
    }), invoice)).toBeNull();
  });
  test('テーブルが無い環境は落とさず「該当なし」', async () => {
    expect(await loadInvoicePayoutLock(fakeSupabase({
      payout_records: { error: missing }, payout_transfer_batches: { error: missing }, payout_transfer_items: { error: missing },
    }), invoice)).toBeNull();
    // 総合振込だけ未適用でも、振込レコードの paid は見る
    expect((await loadInvoicePayoutLock(fakeSupabase({
      payout_records: { rows: [{ user_id: 'u1', year: 2026, month: 10, status: 'paid' }] }, payout_transfer_batches: { error: missing },
    }), invoice)).code).toBe('paid');
    expect(await loadInvoicePayoutLock(fakeSupabase({
      payout_transfer_batches: { rows: [{ id: 'b1', year: 2026, month: 10, status: 'approved' }] }, payout_transfer_items: { error: missing },
    }), invoice)).toBeNull();
  });
  test('テーブルなし以外の読み出しエラーは throw（判定できないまま戻さない）', async () => {
    const boom = { code: '57014', message: 'statement timeout' };
    await expect(loadInvoicePayoutLock(fakeSupabase({ payout_records: { error: boom } }), invoice)).rejects.toThrow(/payout_records/);
    await expect(loadInvoicePayoutLock(fakeSupabase({ payout_transfer_batches: { error: boom } }), invoice)).rejects.toThrow(/payout_transfer_batches/);
    await expect(loadInvoicePayoutLock(fakeSupabase({
      payout_transfer_batches: { rows: [{ id: 'b1', year: 2026, month: 10, status: 'approved' }] }, payout_transfer_items: { error: boom },
    }), invoice)).rejects.toThrow(/payout_transfer_items/);
  });
  test('クライアント宛て・年月なしの請求書は DB を読まずに null', async () => {
    const sb = fakeSupabase({ payout_records: { rows: [{ user_id: 'u1', year: 2026, month: 10, status: 'paid' }] } });
    expect(await loadInvoicePayoutLock(sb, { ...invoice, invoice_type: 'client' })).toBeNull();
    expect(await loadInvoicePayoutLock(sb, { ...invoice, year: null })).toBeNull();
    expect(await loadInvoicePayoutLock(sb, null)).toBeNull();
    expect(sb.calls).toHaveLength(0);
  });
});
