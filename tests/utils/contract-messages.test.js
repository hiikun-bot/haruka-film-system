// tests/utils/contract-messages.test.js
// 契約管理（ADR 035）utils/contract-messages.js の文面テスト。
// DB・外部API 非依存。各関数は { chatwork, slack } を返す。

const m = require('../../utils/contract-messages');

const URL = 'https://hfs.example/haruka.html?contract_req=abc';

describe('formatDateJa / joinTitles', () => {
  test('日付は「YYYY年M月D日」', () => {
    expect(m.formatDateJa('2026-09-07')).toBe('2026年9月7日');
    expect(m.formatDateJa('2026-12-31T00:00:00Z')).toBe('2026年12月31日');
    expect(m.formatDateJa(null)).toBe('未設定');
  });
  test('『A』／『A』と『B』／『A』『B』『C』', () => {
    expect(m.joinTitles(['A'])).toBe('『A』');
    expect(m.joinTitles(['A', 'B'])).toBe('『A』と『B』');
    expect(m.joinTitles(['A', 'B', 'C'])).toBe('『A』『B』『C』');
    expect(m.joinTitles([])).toBe('');
  });
});

describe('buildRequestMessage（依頼）', () => {
  test('ADR の文面要素（宛名・主体・文書名・URL・期限）を含み chatwork/slack 両方を返す', () => {
    const r = m.buildRequestMessage({
      displayName: 'ぴょん', partyName: '株式会社HARUKA FILM',
      docTitles: ['業務委託基本契約書', '業務ルール確認書'], url: URL, due: '2026-09-20',
    });
    expect(r.chatwork).toContain('ぴょんさん、お疲れさまです。');
    expect(r.chatwork).toContain('株式会社HARUKA FILMとしての『業務委託基本契約書』と『業務ルール確認書』のご確認・ご同意をお願いします。');
    expect(r.chatwork).toContain('（所要 約10分）');
    expect(r.chatwork).toContain(URL);
    expect(r.chatwork).toContain('回答期限：2026年9月20日');
    expect(r.chatwork).toMatch(/^\[info\]\[title\]/);
    expect(r.slack).toContain(URL);
    expect(r.slack).not.toContain('[info]');
  });
  test('期限なし・追加メッセージあり', () => {
    const r = m.buildRequestMessage({ displayName: 'A', partyName: 'P', docTitles: ['D'], url: URL, extraMessage: '9月中にお願いします' });
    expect(r.slack).not.toContain('回答期限');
    expect(r.slack).toContain('9月中にお願いします');
  });
});

describe('buildReminderMessage（催促）', () => {
  test('送付日・文書名・期限', () => {
    const r = m.buildReminderMessage({ displayName: 'A', sentDate: '2026-09-07', docTitles: ['業務委託基本契約書'], due: '2026-09-20', url: URL });
    expect(r.slack).toContain('2026年9月7日にお送りした『業務委託基本契約書』のご同意がまだ完了していません。');
    expect(r.slack).toContain('回答期限は2026年9月20日です。');
    expect(r.slack).toContain(URL);
  });
});

describe('buildDueNoticeMessage（回答期限）', () => {
  test('before / due / overdue で文面が変わる', () => {
    const p = { displayName: 'A', docTitles: ['D'], due: '2026-09-20', url: URL };
    expect(m.buildDueNoticeMessage({ ...p, kind: 'before' }).slack).toContain('近づいています');
    expect(m.buildDueNoticeMessage({ ...p, kind: 'due' }).slack).toContain('本日');
    expect(m.buildDueNoticeMessage({ ...p, kind: 'overdue' }).slack).toContain('過ぎています');
  });
});

describe('buildRevisionMessage / buildApprovalMessage', () => {
  test('修正依頼は理由と URL', () => {
    const r = m.buildRevisionMessage({ displayName: 'A', reason: '住所の番地が抜けています', url: URL });
    expect(r.slack).toContain('ご入力内容について確認をお願いしたい点があります。');
    expect(r.slack).toContain('住所の番地が抜けています');
    expect(r.slack).toContain(URL);
  });
  test('承認は完了とダウンロード案内', () => {
    const r = m.buildApprovalMessage({ displayName: 'A', docTitles: ['業務委託基本契約書'] });
    expect(r.slack).toContain('『業務委託基本契約書』の契約手続きが完了しました。');
    expect(r.slack).toContain('「契約・登録手続き」からダウンロードできます');
  });
});

describe('buildReconsentMessage（再同意）', () => {
  test('版・変更点・有効のまま', () => {
    const r = m.buildReconsentMessage({ displayName: 'A', docTitle: '業務ルール確認書', versionLabel: 'v2', summary: '生成AIの利用ルールを追加', url: URL });
    expect(r.slack).toContain('『業務ルール確認書』がv2に改訂されました（変更点：生成AIの利用ルールを追加）。');
    expect(r.slack).toContain('同意までは現在の版が有効のままです。');
  });
});

describe('buildExpiryMessage（有効期限）', () => {
  test('自動更新ありは更新拒絶期限を案内', () => {
    const r = m.buildExpiryMessage({ displayName: 'A', docTitle: '業務委託基本契約書', partyName: '株式会社HARUKA FILM', contractDate: '2026-09-22', endDate: '2027-09-21', renewDeadline: '2027-08-22', autoRenew: true });
    expect(r.slack).toContain('『業務委託基本契約書』（株式会社HARUKA FILM・2026年9月22日締結）の有効期限が2027年9月21日に来ます。');
    expect(r.slack).toContain('同じ条件で1年間自動更新されます。');
    expect(r.slack).toContain('2027年8月22日までにご連絡ください。');
  });
  test('自動更新なしは再契約案内', () => {
    const r = m.buildExpiryMessage({ displayName: 'A', docTitle: 'D', partyName: 'P', contractDate: '2026-01-01', endDate: '2026-12-31', autoRenew: false });
    expect(r.slack).not.toContain('自動更新されます');
    expect(r.slack).toContain('継続をご希望の場合');
  });
});

describe('管理者向け', () => {
  test('確認待ち', () => {
    const r = m.buildAdminSubmittedMessage({ memberName: 'ぴょん', docTitles: ['D1', 'D2'], partyName: 'P', url: URL });
    expect(r.slack).toContain('ぴょんさんが『D1』と『D2』（P）に同意しました。承認をお願いします。');
    expect(r.slack).toContain(URL);
  });
  test('日次サマリは件数と（先頭5名）を並べる', () => {
    const r = m.buildAdminSummaryMessage({
      date: '2026-09-08',
      counts: { awaiting: 2, unattended: 1, overdue: 0, expiring: 7, reconsent: 0 },
      items: { awaiting: ['A', 'B'], unattended: ['C'], expiring: ['1', '2', '3', '4', '5', '6', '7'] },
      listUrl: 'https://hfs.example/haruka.html?page=contract-admin',
    });
    expect(r.slack).toContain('2026年9月8日時点');
    expect(r.slack).toContain('・確認待ち（承認が必要）：2件（A、B）');
    expect(r.slack).toContain('・未対応（3日以上未閲覧）：1件（C）');
    expect(r.slack).toContain('・回答期限切れ：0件');
    expect(r.slack).toContain('・30日以内に有効期限：7件（1、2、3、4、5 ほか）');
    expect(r.slack).toContain('・再同意が必要：0件');
    expect(r.slack).toContain('?page=contract-admin');
  });
  test('有効期限・更新拒絶', () => {
    expect(m.buildAdminExpiryMessage({ memberName: 'A', docTitle: 'D', partyName: 'P', endDate: '2026-11-09', daysLeft: 60, autoRenew: true }).slack).toContain('（あと60日）');
    expect(m.buildAdminRenewNoticeMessage({ memberName: 'A', docTitle: 'D', partyName: 'P', endDate: '2026-11-09', renewDeadline: '2026-10-10' }).slack).toContain('2026年10月10日までに本人へ通知が必要です。');
  });
});
