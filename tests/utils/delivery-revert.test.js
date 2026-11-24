const DR = require('../../utils/delivery-revert');

describe('isCreativeLeader（ロールではなく担当で判定）', () => {
  const creative = { delivered_director_ids: ['snapD'], delivered_producer_ids: ['snapP'] };
  test('案件の director / producer 本人', () => {
    expect(DR.isCreativeLeader({ creative: {}, project: { director_id: 'u1' }, assignments: [], userId: 'u1' })).toBe(true);
    expect(DR.isCreativeLeader({ creative: {}, project: { producer_id: 'u1' }, assignments: [], userId: 'u1' })).toBe(true);
  });
  test('納品時スナップショットの D/P 本人', () => {
    expect(DR.isCreativeLeader({ creative, project: null, assignments: [], userId: 'snapD' })).toBe(true);
    expect(DR.isCreativeLeader({ creative, project: null, assignments: [], userId: 'snapP' })).toBe(true);
  });
  test('creative_assignments の director / producer / producer_director', () => {
    for (const role of ['director', 'producer', 'producer_director']) {
      expect(DR.isCreativeLeader({ creative: {}, project: {}, assignments: [{ user_id: 'u1', role }], userId: 'u1' })).toBe(true);
    }
  });
  test('editor / designer 担当はリーダー格ではない', () => {
    for (const role of ['editor', 'designer', 'director_as_editor', 'wcheck']) {
      expect(DR.isCreativeLeader({ creative: {}, project: {}, assignments: [{ user_id: 'u1', role }], userId: 'u1' })).toBe(false);
    }
  });
  test('他人の制作は director ロールでも false', () => {
    expect(DR.isCreativeLeader({ creative, project: { director_id: 'x' }, assignments: [{ user_id: 'y', role: 'director' }], userId: 'u1' })).toBe(false);
    expect(DR.isCreativeLeader({ creative, project: {}, assignments: [], userId: null })).toBe(false);
  });
});

describe('decideDeliveryRevert', () => {
  // 2026-11-24 12:00 JST
  const now = new Date('2026-11-24T03:00:00Z');
  const thisMonth = { status: '納品', delivered_at: '2026-11-20T01:00:00Z' };
  // JST では 11/1 0:30（UTC では 10/31）→ 今月扱い
  const jstMonthStart = { status: '納品', delivered_at: '2026-10-31T15:30:00Z' };
  const lastMonth = { status: '納品', delivered_at: '2026-10-31T14:30:00Z' }; // JST 10/31 23:30

  test('未納品は戻せない', () => {
    const d = DR.decideDeliveryRevert({ creative: { status: 'Dチェック' }, canRevertAny: true, isLeader: true, issuedInvoices: [], now });
    expect(d.canRevert).toBe(false);
    expect(d.scope).toBeNull();
  });
  test('担当 D/P は今月分を戻せる（JST の月境界）', () => {
    expect(DR.decideDeliveryRevert({ creative: thisMonth, canRevertAny: false, isLeader: true, issuedInvoices: [], now }))
      .toMatchObject({ canRevert: true, scope: 'own', pastMonth: false });
    expect(DR.decideDeliveryRevert({ creative: jstMonthStart, canRevertAny: false, isLeader: true, issuedInvoices: [], now }))
      .toMatchObject({ canRevert: true, pastMonth: false });
  });
  test('担当 D/P は先月以前・納品日なしを戻せない', () => {
    const d = DR.decideDeliveryRevert({ creative: lastMonth, canRevertAny: false, isLeader: true, issuedInvoices: [], now });
    expect(d).toMatchObject({ canRevert: false, scope: 'own', pastMonth: true });
    expect(d.reason).toContain('2026-10');
    expect(DR.decideDeliveryRevert({ creative: { status: '納品', delivered_at: null }, canRevertAny: false, isLeader: true, issuedInvoices: [], now }).canRevert).toBe(false);
  });
  test('管理者・PD（全件）は先月以前も戻せる', () => {
    expect(DR.decideDeliveryRevert({ creative: lastMonth, canRevertAny: true, isLeader: false, issuedInvoices: [], now }))
      .toMatchObject({ canRevert: true, scope: 'any', pastMonth: true });
  });
  test('担当でも全件権限者でもなければ scope=null', () => {
    expect(DR.decideDeliveryRevert({ creative: thisMonth, canRevertAny: false, isLeader: false, issuedInvoices: [], now }))
      .toMatchObject({ canRevert: false, scope: null });
  });
  test('提出済み・承認済みの請求書に載っていれば管理者でも戻せない', () => {
    const d = DR.decideDeliveryRevert({
      creative: thisMonth, canRevertAny: true, isLeader: true,
      issuedInvoices: [{ invoice_number: 'INV-1', status: 'submitted' }, { invoice_number: 'INV-1', status: 'submitted' }, { invoice_number: 'INV-2', status: 'approved' }],
      now,
    });
    expect(d.canRevert).toBe(false);
    expect(d.reason).toContain('INV-1（提出済み）、INV-2（承認済み）');
  });
  test('納品完了日なしは「先月以前」ではなく unknownDate（管理者・PD は戻せる）', () => {
    const d = DR.decideDeliveryRevert({ creative: { status: '納品', delivered_at: null }, canRevertAny: true, isLeader: false, issuedInvoices: [], now });
    expect(d).toMatchObject({ canRevert: true, pastMonth: false, unknownDate: true });
  });
  test('差し戻し中（rejected）・下書きは「直せる請求書」、提出済み等は違う', () => {
    expect(DR.isEditableInvoiceStatus('draft')).toBe(true);
    expect(DR.isEditableInvoiceStatus('rejected')).toBe(true);
    for (const s of ['submitted', 'approved', 'paid', null, undefined]) expect(DR.isEditableInvoiceStatus(s)).toBe(false);
    expect(DR.invoiceStatusLabel('rejected')).toBe('差し戻し中');
  });
  test('force_delivered だけ立っている場合も納品扱い', () => {
    expect(DR.isDeliveredCreative({ status: 'クライアントチェック中', force_delivered: true })).toBe(true);
  });
});

describe('buildRevertTargets', () => {
  test('P なし案件は Pチェック系を出さない・初期値は直前ステータス', () => {
    const r = DR.buildRevertTargets({ hasProducer: false, previousStatus: 'Dチェック' });
    expect(r.targets.some(s => s.startsWith('Pチェック'))).toBe(false);
    expect(r.defaultTarget).toBe('Dチェック');
  });
  test('直前ステータスが不明ならクライアントチェック中', () => {
    expect(DR.buildRevertTargets({ hasProducer: true, previousStatus: null }).defaultTarget).toBe('クライアントチェック中');
    expect(DR.buildRevertTargets({ hasProducer: true, previousStatus: '納品' }).defaultTarget).toBe('クライアントチェック中');
  });
  test('標準外の直前ステータス（旧値）は候補の先頭に入る', () => {
    const r = DR.buildRevertTargets({ hasProducer: true, previousStatus: '編集' });
    expect(r.targets[0]).toBe('編集');
    expect(r.targets).not.toContain('納品');
  });
});

describe('normalizeRevertReason', () => {
  test('必須・500 文字まで', () => {
    expect(DR.normalizeRevertReason('  ').ok).toBe(false);
    expect(DR.normalizeRevertReason(undefined).ok).toBe(false);
    expect(DR.normalizeRevertReason('x'.repeat(501)).ok).toBe(false);
    expect(DR.normalizeRevertReason(' 押し間違い ')).toEqual({ ok: true, reason: '押し間違い' });
  });
});
