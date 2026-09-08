// tests/utils/contract-state.test.js
// 契約管理（ADR 035）utils/contract-state.js の純関数テスト。
// 日付は 'YYYY-MM-DD' の文字列を Date.UTC ベースで計算するので TZ=UTC / TZ=Asia/Tokyo で同結果。

const s = require('../../utils/contract-state');

describe('canTransition（状態遷移表）', () => {
  test('本人は requested/revision_requested → submitted のみ', () => {
    expect(s.canTransition('requested', 'submitted', 'member')).toBe(true);
    expect(s.canTransition('revision_requested', 'submitted', 'member')).toBe(true);
    expect(s.canTransition('submitted', 'active', 'member')).toBe(false);
    expect(s.canTransition('requested', 'cancelled', 'member')).toBe(false);
  });
  test('管理者は submitted → active / revision_requested / cancelled', () => {
    expect(s.canTransition('submitted', 'active', 'admin')).toBe(true);
    expect(s.canTransition('submitted', 'revision_requested', 'admin')).toBe(true);
    expect(s.canTransition('submitted', 'cancelled', 'admin')).toBe(true);
    expect(s.canTransition('requested', 'active', 'admin')).toBe(false);
  });
  test('reconsent_required はシステムのみ、ended/cancelled からは遷移不可', () => {
    expect(s.canTransition('active', 'reconsent_required', 'system')).toBe(true);
    expect(s.canTransition('active', 'reconsent_required', 'admin')).toBe(false);
    expect(s.canTransition('ended', 'active', 'admin')).toBe(false);
    expect(s.canTransition('cancelled', 'requested', 'admin')).toBe(false);
    expect(s.canTransition('unknown', 'active', 'admin')).toBe(false);
  });
});

describe('memberFacingStatus（制作者向け表示）', () => {
  test('requested は draft_state の有無で 未着手 / 入力中', () => {
    expect(s.memberFacingStatus({ status: 'requested' }, null)).toBe('未着手');
    expect(s.memberFacingStatus({ status: 'requested' }, { draft_state: {} })).toBe('未着手');
    expect(s.memberFacingStatus({ status: 'requested' }, { draft_state: { step: 2 } })).toBe('入力中');
  });
  test('その他の状態ラベル', () => {
    expect(s.memberFacingStatus({ status: 'submitted' })).toBe('確認待ち');
    expect(s.memberFacingStatus({ status: 'revision_requested' })).toBe('修正依頼あり');
    expect(s.memberFacingStatus({ status: 'active' })).toBe('契約手続き完了');
    expect(s.memberFacingStatus({ status: 'ending' })).toBe('契約手続き完了（終了予定）');
    expect(s.memberFacingStatus({ status: 'reconsent_required' })).toBe('再同意が必要');
  });
});

describe('consentKindForDocType', () => {
  test('確認書系は acknowledged、それ以外は agreed', () => {
    expect(s.consentKindForDocType('rules_confirmation')).toBe('acknowledged');
    expect(s.consentKindForDocType('succession_notice')).toBe('acknowledged');
    expect(s.consentKindForDocType('basic_agreement')).toBe('agreed');
    expect(s.consentKindForDocType('client_pledge')).toBe('agreed');
  });
});

describe('normalizeName / signerNameMatches', () => {
  test('全角半角・スペースの違いを吸収する', () => {
    expect(s.normalizeName('髙橋　聖')).toBe('髙橋聖');
    expect(s.normalizeName(' 髙橋 聖 ')).toBe('髙橋聖');
    expect(s.normalizeName('Ｔａｒｏ Ｙａｍａｄａ')).toBe('taroyamada');
    expect(s.signerNameMatches('髙橋　聖', '髙橋 聖')).toBe(true);
    expect(s.signerNameMatches('ﾔﾏﾀﾞ', 'ヤマダ')).toBe(true);
  });
  test('別人・空は不一致', () => {
    expect(s.signerNameMatches('高橋聖', '髙橋聖')).toBe(false);
    expect(s.signerNameMatches('', '')).toBe(false);
    expect(s.signerNameMatches(null, '髙橋聖')).toBe(false);
  });
});

describe('日付（JST カレンダー）', () => {
  test('jstToday は UTC 深夜でも JST の日付になる', () => {
    expect(s.jstToday(new Date('2026-09-07T15:30:00Z'))).toBe('2026-09-08');
    expect(s.jstToday(new Date('2026-09-07T14:59:00Z'))).toBe('2026-09-07');
  });
  test('addDays / addYears / daysBetween / defaultEndDate', () => {
    expect(s.addDays('2026-09-30', 1)).toBe('2026-10-01');
    expect(s.addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(s.addYears('2028-02-29', 1)).toBe('2029-02-28');
    expect(s.daysBetween('2026-09-01', '2026-09-30')).toBe(29);
    expect(s.daysBetween('2026-09-30', '2026-09-01')).toBe(-29);
    expect(s.defaultEndDate('2026-09-22')).toBe('2027-09-21');
    expect(s.renewDeadline('2027-09-21', 30)).toBe('2027-08-22');
  });
  test('不正な日付は null / false', () => {
    expect(s.isValidYmd('2026-02-30')).toBe(false);
    expect(s.isValidYmd('2026-9-1')).toBe(false);
    expect(s.addDays('bad', 1)).toBeNull();
    expect(s.daysBetween('2026-01-01', null)).toBeNull();
  });
  test('computeTokenExpiry は 90日後、isTokenExpired', () => {
    const now = new Date('2026-09-07T00:00:00Z');
    expect(s.computeTokenExpiry(now)).toBe('2026-12-06T00:00:00.000Z');
    expect(s.isTokenExpired('2026-09-06T00:00:00Z', now)).toBe(true);
    expect(s.isTokenExpired('2026-09-08T00:00:00Z', now)).toBe(false);
    expect(s.isTokenExpired(null, now)).toBe(false);
  });
});

describe('ワーカー判定', () => {
  const DAY = 86_400_000;
  const NOW = Date.parse('2026-09-10T01:00:00Z');

  test('needsReminder は last_reminded_at → sent_at → requested_at の順で基準にする', () => {
    expect(s.needsReminder({ nowMs: NOW, sentAt: new Date(NOW - 3 * DAY).toISOString(), intervalDays: 3 })).toBe(true);
    expect(s.needsReminder({ nowMs: NOW, sentAt: new Date(NOW - 2 * DAY).toISOString(), intervalDays: 3 })).toBe(false);
    expect(s.needsReminder({ nowMs: NOW, sentAt: new Date(NOW - 10 * DAY).toISOString(), lastRemindedAt: new Date(NOW - 1 * DAY).toISOString(), intervalDays: 3 })).toBe(false);
    expect(s.needsReminder({ nowMs: NOW, requestedAt: new Date(NOW - 5 * DAY).toISOString(), intervalDays: 3 })).toBe(true);
    expect(s.needsReminder({ nowMs: NOW, intervalDays: 3 })).toBe(false);
    expect(s.needsReminder({ nowMs: NOW, sentAt: new Date(NOW - 9 * DAY).toISOString(), intervalDays: 0 })).toBe(false);
  });

  test('dueNoticeKind', () => {
    expect(s.dueNoticeKind({ dueDate: '2026-09-13', today: '2026-09-10', noticeDays: 3 })).toBe('before');
    expect(s.dueNoticeKind({ dueDate: '2026-09-10', today: '2026-09-10', noticeDays: 3 })).toBe('due');
    expect(s.dueNoticeKind({ dueDate: '2026-09-09', today: '2026-09-10', noticeDays: 3 })).toBe('overdue');
    expect(s.dueNoticeKind({ dueDate: '2026-09-12', today: '2026-09-10', noticeDays: 3 })).toBeNull();
  });

  test('nextExpiryStage は 60 → 30 の順、送信済みは飛ばす', () => {
    expect(s.nextExpiryStage({ endDate: '2026-11-09', today: '2026-09-10', sentStages: null })).toBe('60');
    expect(s.nextExpiryStage({ endDate: '2026-11-09', today: '2026-09-10', sentStages: '60' })).toBeNull();
    expect(s.nextExpiryStage({ endDate: '2026-10-10', today: '2026-09-10', sentStages: '60' })).toBe('30');
    expect(s.nextExpiryStage({ endDate: '2026-10-10', today: '2026-09-10', sentStages: '60,30' })).toBeNull();
    // いきなり 30日以内なら 60 は送らず 30 を送る
    expect(s.nextExpiryStage({ endDate: '2026-09-20', today: '2026-09-10', sentStages: null })).toBe('30');
    // 期限超過は null
    expect(s.nextExpiryStage({ endDate: '2026-09-01', today: '2026-09-10', sentStages: null })).toBeNull();
    expect(s.nextExpiryStage({ endDate: '2027-09-10', today: '2026-09-10', sentStages: null })).toBeNull();
  });

  test('needsRenewNotice は締切の 30日前以内で未送信なら true', () => {
    // end 2026-11-09, renew_notice 30 → 締切 2026-10-10。今日 09-10 は 30日前
    expect(s.needsRenewNotice({ endDate: '2026-11-09', today: '2026-09-10', renewNoticeDays: 30, sentStages: null })).toBe(true);
    expect(s.needsRenewNotice({ endDate: '2026-11-09', today: '2026-09-10', renewNoticeDays: 30, sentStages: '60,renew' })).toBe(false);
    expect(s.needsRenewNotice({ endDate: '2026-12-31', today: '2026-09-10', renewNoticeDays: 30, sentStages: null })).toBe(false);
    expect(s.needsRenewNotice({ endDate: '2026-09-20', today: '2026-09-10', renewNoticeDays: 30, sentStages: null })).toBe(false);
  });

  test('endDateAction: ending→end、active 自動更新→renew、active 非自動→end、未到来→null', () => {
    expect(s.endDateAction({ status: 'ending', endDate: '2026-09-10', today: '2026-09-10', autoRenew: true })).toBe('end');
    expect(s.endDateAction({ status: 'active', endDate: '2026-09-09', today: '2026-09-10', autoRenew: true })).toBe('renew');
    expect(s.endDateAction({ status: 'active', endDate: '2026-09-09', today: '2026-09-10', autoRenew: false })).toBe('end');
    expect(s.endDateAction({ status: 'active', endDate: '2026-09-11', today: '2026-09-10', autoRenew: true })).toBeNull();
    expect(s.endDateAction({ status: 'ended', endDate: '2026-09-01', today: '2026-09-10', autoRenew: true })).toBeNull();
  });

  test('parseStages / joinStages', () => {
    expect(Array.from(s.parseStages('60, 30'))).toEqual(['60', '30']);
    expect(s.joinStages(new Set())).toBeNull();
    expect(s.joinStages(new Set(['60', 'renew']))).toBe('60,renew');
  });
});
