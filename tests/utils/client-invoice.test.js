// クライアント請求書の金額の決め方と、画面から送られた選択の照合
const { clientPriceOf, checkClientInvoiceSelection } = require('../../utils/client-invoice');

describe('clientPriceOf', () => {
  test('成果物グループのクライアント単価が優先', () => {
    expect(clientPriceOf({ client_fee: 5000 }, { client_unit_price: 12000 })).toEqual({ amount: 12000, source: 'line' });
  });
  test('グループの単価が無ければ creatives.client_fee', () => {
    expect(clientPriceOf({ client_fee: 5000 }, { client_unit_price: 0 })).toEqual({ amount: 5000, source: 'client_fee' });
    expect(clientPriceOf({ client_fee: 5000 }, null)).toEqual({ amount: 5000, source: 'client_fee' });
  });
  test('どちらも無ければ 0（unknown）', () => {
    expect(clientPriceOf({ client_fee: null }, null)).toEqual({ amount: 0, source: 'unknown' });
    expect(clientPriceOf(null, { client_unit_price: 'abc' })).toEqual({ amount: 0, source: 'unknown' });
  });
});

describe('checkClientInvoiceSelection', () => {
  const candidates = [
    { id: 'c1', file_name: 'a_001', amount: 10000 },
    { id: 'c2', file_name: 'a_002', amount: 8000 },
    { id: 'c3', file_name: 'a_003', amount: 0 },
    { id: 'c4', file_name: 'a_004', amount: 9000, billed_invoice_number: 'INV-202611-002' },
  ];

  test('サーバーの金額で明細と合計を作る', () => {
    const r = checkClientInvoiceSelection({ candidates, items: [{ creative_id: 'c1', client_fee: 10000 }, { creative_id: 'c2', client_fee: 8000 }], expectedTotal: 18000 });
    expect(r).toEqual({ ok: true, total: 18000, rows: [
      { creative_id: 'c1', file_name: 'a_001', amount: 10000 },
      { creative_id: 'c2', file_name: 'a_002', amount: 8000 },
    ] });
  });

  test('金額が送られていなければサーバーの金額をそのまま使う', () => {
    const r = checkClientInvoiceSelection({ candidates, items: [{ creative_id: 'c1' }] });
    expect(r.ok).toBe(true);
    expect(r.total).toBe(10000);
  });

  test('画面の金額がサーバーと違えば 409（書き換えた金額で請求書を作らない）', () => {
    const r = checkClientInvoiceSelection({ candidates, items: [{ creative_id: 'c1', client_fee: 99999 }] });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(409);
    expect(r.problems).toEqual([{ creative_id: 'c1', file_name: 'a_001', reason: 'amount_mismatch', expected: 10000, actual: 99999 }]);
    expect(r.error).toContain('a_001');
  });

  test('対象（クライアント × 月の納品済み）に無い制作は 409', () => {
    const r = checkClientInvoiceSelection({ candidates, items: [{ creative_id: 'other', client_fee: 1 }] });
    expect(r.status).toBe(409);
    expect(r.problems[0].reason).toBe('not_candidate');
  });

  test('単価未設定・請求済み・同じ制作の 2 回は 409', () => {
    const r = checkClientInvoiceSelection({ candidates, items: [
      { creative_id: 'c3', client_fee: 0 }, { creative_id: 'c4', client_fee: 9000 },
      { creative_id: 'c1', client_fee: 10000 }, { creative_id: 'c1', client_fee: 10000 },
    ] });
    expect(r.status).toBe(409);
    expect(r.problems.map(p => p.reason)).toEqual(['no_price', 'already_billed', 'duplicate']);
  });

  test('明細はそろっていても合計が違えば 409', () => {
    const r = checkClientInvoiceSelection({ candidates, items: [{ creative_id: 'c1', client_fee: 10000 }], expectedTotal: 12000 });
    expect(r.status).toBe(409);
    expect(r.problems[0]).toMatchObject({ reason: 'total_mismatch', expected: 10000, actual: 12000 });
  });

  test('明細が空なら 400', () => {
    expect(checkClientInvoiceSelection({ candidates, items: [] }).status).toBe(400);
    expect(checkClientInvoiceSelection({ candidates, items: null }).status).toBe(400);
  });

  test('数値でない金額は不一致として扱う', () => {
    const r = checkClientInvoiceSelection({ candidates, items: [{ creative_id: 'c1', client_fee: 'abc' }] });
    expect(r.status).toBe(409);
    expect(r.problems[0]).toMatchObject({ reason: 'amount_mismatch', actual: null });
  });
});
