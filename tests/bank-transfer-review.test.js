// PR #1279 コードレビュー対応の純関数テスト（レビュー #1 / #2 / #3 / #4 / #5 / #7）
const plan = require('../utils/bank-transfer-plan');

describe('#1 requestConflicts: preview 後に別の依頼が入った人だけを 409 にする', () => {
  test('duplicate_in_month の excluded だけを user_id にする（他の除外理由は無視）', () => {
    const planned = {
      items: [{ user_id: 'u1' }],
      excluded: [
        { payout_record_id: 'r2', user_id: 'u2', reason_code: 'duplicate_in_month' },
        { payout_record_id: 'r3', user_id: 'u3', reason_code: 'bank_info_recent' },
        { payout_record_id: 'r4', user_id: 'u2', reason_code: 'duplicate_in_month' },
      ],
    };
    expect(plan.requestConflicts(planned)).toEqual(['u2']);
    expect(plan.requestConflicts({ items: [], excluded: [] })).toEqual([]);
  });
  test('token に plan に含めた ids だけ入れていれば、何も変わらない再 plan は衝突しない', () => {
    const NOW = Date.UTC(2026, 10, 1);
    const users = [
      { id: 'ua', full_name: 'A', is_active: true, bank_code: '0310', branch_code: '101', account_type: '普通', account_number: '1', account_holder_kana: 'エー' },
      { id: 'ub', full_name: 'B', is_active: true, bank_code: '0310', branch_code: '101', account_type: '普通', account_number: '2', account_holder_kana: 'ビー' },
    ];
    const records = [
      { id: 'ra', user_id: 'ua', year: 2026, month: 10, status: 'unpaid', invoice_amount: 1000 },
      { id: 'rb', user_id: 'ub', year: 2026, month: 10, status: 'unpaid', invoice_amount: 2000 },
    ];
    // preview: ub は同月に依頼済み → 除外。token に入れるのは ra だけ
    const preview = plan.planTransferItems({ records, users, invoices: [], blockedUserIds: ['ub'], year: 2026, month: 10, now: NOW });
    const tokenIds = preview.items.map(i => i.payout_record_id);
    expect(tokenIds).toEqual(['ra']);
    // request: token の ids だけで再 plan → 衝突なし
    const again = plan.planTransferItems({ records: records.filter(r => tokenIds.includes(r.id)), users, invoices: [], blockedUserIds: ['ub'], year: 2026, month: 10, now: NOW });
    expect(plan.requestConflicts(again)).toEqual([]);
    expect(plan.planHash(again.items, '2026-11-05')).toBe(plan.planHash(preview.items, '2026-11-05'));
    // preview 後に ua も依頼された → 衝突
    const raced = plan.planTransferItems({ records: records.filter(r => tokenIds.includes(r.id)), users, invoices: [], blockedUserIds: ['ub', 'ua'], year: 2026, month: 10, now: NOW });
    expect(plan.requestConflicts(raced)).toEqual(['ua']);
  });
});

describe('#2 itemsToFailOnTerminal: 終了状態で pending の明細だけ failed に落とす', () => {
  test('pending → failed（理由つき）、completed / returned / failed は触らない', () => {
    const items = [
      { id: 'i1', item_id: 1, status: 'pending' },
      { id: 'i2', item_id: 2, status: 'completed' },
      { id: 'i3', item_id: 3, status: 'returned' },
      { id: 'i4', item_id: 4, status: 'failed' },
      { id: 'i5', item_id: 5, status: 'pending' },
    ];
    expect(plan.itemsToFailOnTerminal(items, 'batch_expired')).toEqual([
      { id: 'i1', item_id: 1, status: 'failed', error_detail: { reason: 'batch_expired' } },
      { id: 'i5', item_id: 5, status: 'failed', error_detail: { reason: 'batch_expired' } },
    ]);
    expect(plan.itemsToFailOnTerminal([], 'x')).toEqual([]);
  });
});

describe('#3 resolveItemStatuses / nextItemKeyFor: 明細が揃うまで completed にしない', () => {
  const items = [
    { id: 'i1', item_id: 1, status: 'pending' },
    { id: 'i2', item_id: 2, status: 'pending' },
    { id: 'i3', item_id: 3, status: 'completed' },
  ];
  test('info が無い item は unresolved に残る（20:手続済でも全件完了にしない）', () => {
    const r = plan.resolveItemStatuses({ items, infos: [{ itemId: '1', unableDetailInfos: [{ transferDetailStatus: '1' }] }], transferStatus: '20' });
    expect(r.patches).toEqual([{ id: 'i1', item_id: 1, status: 'completed', error_detail: null }]);
    expect(r.unresolved).toEqual([2]);
  });
  test('30:不能・組戻あり は明細ごとに completed / failed / returned', () => {
    const infos = [
      { itemId: '1', unableDetailInfos: [{ transferDetailStatus: '2' }] },
      { itemId: '2', unableDetailInfos: [{ transferDetailStatus: '1', refundStatus: '2', isRepayment: true, repaymentDate: '2026-11-06' }] },
    ];
    const r = plan.resolveItemStatuses({ items, infos, transferStatus: '30' });
    expect(r.patches.map(p => [p.item_id, p.status])).toEqual([[1, 'failed'], [2, 'returned']]);
    expect(r.patches[1].error_detail).toMatchObject({ refund_status: '2', is_repayment: true, repayment_date: '2026-11-06', transfer_status: '30' });
    expect(r.unresolved).toEqual([]);
  });
  test('40:手続不成立 は info が無くても全件 failed', () => {
    const r = plan.resolveItemStatuses({ items, infos: [], transferStatus: '40' });
    expect(r.patches.map(p => p.status)).toEqual(['failed', 'failed']);
    expect(r.unresolved).toEqual([]);
  });
  test('手続中（12）で info があっても未確定なら unresolved', () => {
    const r = plan.resolveItemStatuses({ items, infos: [{ itemId: '1', unableDetailInfos: [] }], transferStatus: '12' });
    expect(r.patches).toEqual([]);
    expect(r.unresolved).toEqual([1, 2]);
  });
  test('nextItemKeyFor: 500 件ずつ辿り、総件数に達したら止める', () => {
    expect(plan.nextItemKeyFor({ startKey: 1, fetchedCount: 500, totalCount: 1500 })).toBe(501);
    expect(plan.nextItemKeyFor({ startKey: 501, fetchedCount: 500, totalCount: 1500 })).toBe(1001);
    expect(plan.nextItemKeyFor({ startKey: 1001, fetchedCount: 500, totalCount: 1500 })).toBeNull();
    expect(plan.nextItemKeyFor({ startKey: 1, fetchedCount: 3, totalCount: 3 })).toBeNull();
    expect(plan.nextItemKeyFor({ startKey: 1, fetchedCount: 0, totalCount: 3 })).toBeNull();
    expect(plan.nextItemKeyFor({ startKey: 1, fetchedCount: 120, totalCount: 700 })).toBeNull(); // 500 未満＝最終ページ
  });
});

describe('#4 classifyRequestResponse: applyNo / resultCode が揃わない 2xx は応答消失扱い', () => {
  test('正常（2:未完了 / 1:完了）', () => {
    expect(plan.classifyRequestResponse({ accountId: 'x', resultCode: '2', applyNo: '2026110112345678' }))
      .toEqual({ outcome: 'accepted', applyNo: '2026110112345678', resultCode: '2', status: 'awaiting_approval', approvedAt: null });
    expect(plan.classifyRequestResponse({ resultCode: '1', applyNo: '2026110112345678', applyEndDatetime: '2026-11-01T10:00:00+09:00' }))
      .toMatchObject({ outcome: 'accepted', status: 'approved', approvedAt: '2026-11-01T10:00:00+09:00' });
  });
  test('applyNo 無し・桁違い・resultCode 不明 → pending', () => {
    expect(plan.classifyRequestResponse({ resultCode: '2' }).outcome).toBe('pending');
    expect(plan.classifyRequestResponse({ resultCode: '2', applyNo: '123' }).outcome).toBe('pending');
    expect(plan.classifyRequestResponse({ resultCode: '9', applyNo: '2026110112345678' }).outcome).toBe('pending');
    expect(plan.classifyRequestResponse(null).outcome).toBe('pending');
    expect(plan.classifyRequestResponse({}).reason).toMatch(/受付番号/);
  });
});

describe('#5 decideBatchFromResultCode: 取消依頼の期限切れは元の依頼を保ちマーカーを消す', () => {
  test('8 かつ取消依頼中 → status 変更なし・clearCancel', () => {
    expect(plan.decideBatchFromResultCode({ resultCode: '8', status: 'awaiting_approval', cancelRequested: true }))
      .toMatchObject({ status: null, clearCancel: true, inquire: false });
  });
  test('8 で取消依頼なし → expired', () => {
    expect(plan.decideBatchFromResultCode({ resultCode: '8', status: 'awaiting_approval', cancelRequested: false }))
      .toMatchObject({ status: 'expired', clearCancel: false });
  });
  test('2 → awaiting_approval（取消依頼中・approved 以降は触らない）、1 → 状況照会へ', () => {
    expect(plan.decideBatchFromResultCode({ resultCode: '2', status: 'requested', cancelRequested: false }).status).toBe('awaiting_approval');
    expect(plan.decideBatchFromResultCode({ resultCode: '2', status: 'approved', cancelRequested: false }).status).toBeNull();
    expect(plan.decideBatchFromResultCode({ resultCode: '2', status: 'requested', cancelRequested: true }).status).toBeNull();
    expect(plan.decideBatchFromResultCode({ resultCode: '1', status: 'awaiting_approval', cancelRequested: false })).toMatchObject({ status: null, inquire: true });
    expect(plan.decideBatchFromResultCode({ resultCode: '7', status: 'approved', cancelRequested: false }).note).toMatch(/不明/);
  });
});

describe('#7 verifyIdToken: aud が配列でも通る', () => {
  const crypto = require('crypto');
  let aozora;
  beforeAll(() => {
    process.env.AOZORA_ENV = 'staging';
    process.env.AOZORA_CLIENT_ID = 'cid';
    process.env.AOZORA_CLIENT_SECRET = 'csecret';
    jest.resetModules();
    jest.doMock('../supabase', () => ({ from: () => ({}) }));
    aozora = require('../utils/aozora-api');
  });
  const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const token = (payload) => {
    const h = b64u({ typ: 'JWT', alg: 'HS256' });
    const p = b64u(payload);
    const s = crypto.createHmac('sha256', 'csecret').update(`${h}.${p}`).digest('base64url');
    return `${h}.${p}.${s}`;
  };
  test('aud: 文字列 / 配列（含む） は ok、配列（含まない）は aud エラー', () => {
    const now = Math.floor(Date.now() / 1000);
    const base = { iss: 'https://stg-api.gmo-aozora.com/', sub: 'S', exp: now + 600, iat: now, nonce: 'n', azp: 'cid' };
    expect(aozora.verifyIdToken(token({ ...base, aud: 'cid' }), { nonce: 'n' }).ok).toBe(true);
    expect(aozora.verifyIdToken(token({ ...base, aud: ['other', 'cid'] }), { nonce: 'n' }).ok).toBe(true);
    expect(aozora.verifyIdToken(token({ ...base, aud: ['other'] }), { nonce: 'n' })).toEqual({ ok: false, reason: 'aud' });
    expect(aozora.verifyIdToken(token({ ...base, aud: 'cid' }), { nonce: 'x' })).toEqual({ ok: false, reason: 'nonce' });
  });
  test('isLostResponse: timeout / 5xx / 429 は true、4xx / token エラーは false', () => {
    const E = aozora.AozoraApiError;
    expect(aozora.isLostResponse(new E({ status: null }))).toBe(true);
    expect(aozora.isLostResponse(new E({ status: 503 }))).toBe(true);
    expect(aozora.isLostResponse(new E({ status: 429 }))).toBe(true);
    expect(aozora.isLostResponse(new E({ status: 400 }))).toBe(false);
    expect(aozora.isLostResponse(new E({ status: 500, phase: 'token' }))).toBe(false);
    expect(aozora.isLostResponse(new Error('x'))).toBe(false);
  });
});

describe('preview_token（jti つき）', () => {
  let bt;
  beforeAll(() => {
    process.env.SESSION_SECRET = 'test-secret';
    jest.resetModules();
    jest.doMock('../supabase', () => ({ from: () => ({}) }));
    bt = require('../utils/bank-transfer');
  });
  test('jti が入り、呼ぶたびに違う。改ざん・期限切れは null', () => {
    const args = { year: 2026, month: 10, payoutRecordIds: ['b', 'a'], transferDesignatedDate: '2026-11-05', hash: 'h', requesterId: 'u', connectionId: 'c', totalCount: 1, totalAmount: 100, totalFee: 145 };
    const t1 = bt.signPreviewToken(args);
    const t2 = bt.signPreviewToken(args);
    const p1 = bt.verifyPreviewToken(t1);
    const p2 = bt.verifyPreviewToken(t2);
    expect(p1.jti).toMatch(/^[0-9a-f-]{36}$/);
    expect(p1.jti).not.toBe(p2.jti);
    expect(p1.ids).toEqual(['a', 'b']);
    expect(p1.v).toBe(2);
    expect(bt.verifyPreviewToken(t1, Date.now() + 11 * 60 * 1000)).toBeNull();
    expect(bt.verifyPreviewToken(t1.slice(0, -2) + 'zz')).toBeNull();
  });
  test('reauthStatus: reauth_at が 10 分以内なら ok', () => {
    expect(bt.reauthStatus({ session: { reauth_at: Date.now() - 60 * 1000 } })).toMatchObject({ ok: true });
    expect(bt.reauthStatus({ session: { reauth_at: Date.now() - 11 * 60 * 1000 } })).toEqual({ ok: false, remaining_sec: 0 });
    expect(bt.reauthStatus({})).toEqual({ ok: false, remaining_sec: 0 });
  });
});
