// tests/billing-count-inquiry.test.js
// 制作本数ヒアリング（毎月末の自動送信）のユニットテスト。
//
// TZ=UTC / TZ=Asia/Tokyo のどちらで実行しても同じ結果になることが重要
// （Railway は UTC 動作のため）。CI とローカル両方で通ること。
//
// workers/billing-count-inquiry-scheduler.js は supabase.js（env 必須・欠落時
// process.exit）を require するため、supabase / notifications をモックして
// 純関数部分（判定ロジック・文面生成）だけを検証する。

jest.mock('../supabase', () => ({}));
jest.mock('../notifications', () => ({
  sendChatworkRoom: jest.fn(),
  notifyAutoError: jest.fn(),
}));

const {
  DEFAULT_TARGETS,
  lastDayOfMonth,
  prevMonth,
  parseTargets,
  buildBillingInquiryMessage,
} = require('../utils/billing-count-inquiry');

const {
  decideBillingInquiryAction,
} = require('../workers/billing-count-inquiry-scheduler');

describe('lastDayOfMonth / prevMonth', () => {
  test('月末日を正しく返す（30日・31日・平年2月・閏年2月）', () => {
    expect(lastDayOfMonth(2026, 9)).toBe(30);
    expect(lastDayOfMonth(2026, 8)).toBe(31);
    expect(lastDayOfMonth(2026, 2)).toBe(28);
    expect(lastDayOfMonth(2028, 2)).toBe(29);
  });

  test('prevMonth は年またぎも正しい', () => {
    expect(prevMonth('2026-09')).toBe('2026-08');
    expect(prevMonth('2026-01')).toBe('2025-12');
  });
});

describe('buildBillingInquiryMessage', () => {
  test('既定ターゲットは よたさんルームで みっつー宛て [To:] 付き', () => {
    expect(DEFAULT_TARGETS).toHaveLength(1);
    const t = DEFAULT_TARGETS[0];
    expect(t.roomId).toBe('405007443');
    const msg = buildBillingInquiryMessage(t);
    expect(msg.startsWith('[To:7839661]安齋智光（みっつー）さん\n\n')).toBe(true);
    expect(msg).toContain('【毎月末の自動送信メッセージです🤖】');
    expect(msg).toContain('みっつー、お疲れさまです😊');
    expect(msg).toContain('よたさんへの今月分の請求にあたり');
    expect(msg).toContain('ロング動画');
    expect(msg).toContain('ショート動画');
    expect(msg).toContain('・動画制作：　　本');
    expect(msg).toContain('・サムネイル制作：　　枚');
    expect(msg).toContain('・台本作成：　　本');
    expect(msg).toContain('よろしくお願いいたします☺️');
  });

  test('toAccountId が非数字なら [To:] を付けない（Chatwork silent 失敗の予防）', () => {
    const msg = buildBillingInquiryMessage({ roomId: '1', toAccountId: 'abc123', toName: 'X', body: '本文' });
    expect(msg).toBe('本文');
  });

  test('toAccountId 省略時は本文のみ', () => {
    expect(buildBillingInquiryMessage({ roomId: '1', body: '本文' })).toBe('本文');
  });
});

describe('parseTargets', () => {
  test('正しい JSON 配列はターゲット化される', () => {
    const raw = JSON.stringify([{ label: 'テスト', roomId: '123', toAccountId: '456', toName: '太郎', body: 'こんにちは' }]);
    const targets = parseTargets(raw);
    expect(targets).toHaveLength(1);
    expect(targets[0].roomId).toBe('123');
  });

  test('不正 JSON・空配列・必須欠落は null（既定へフォールバック）', () => {
    expect(parseTargets('not json')).toBeNull();
    expect(parseTargets('[]')).toBeNull();
    expect(parseTargets(JSON.stringify([{ roomId: '123' }]))).toBeNull(); // body 無し
    expect(parseTargets(null)).toBeNull();
  });
});

describe('decideBillingInquiryAction', () => {
  test('初回起動（月中）は前月を消化済みマークして当月末から開始', () => {
    const d = decideBillingInquiryAction({ jstDate: '2026-09-15', jstHour: 12, lastSentMonth: null });
    expect(d).toEqual({ action: 'bootstrap', markMonth: '2026-08' });
  });

  test('初回起動（月末日）は当月を消化済みマーク（当日分は手動済み想定）', () => {
    const d = decideBillingInquiryAction({ jstDate: '2026-08-31', jstHour: 14, lastSentMonth: null });
    expect(d).toEqual({ action: 'bootstrap', markMonth: '2026-08' });
  });

  test('月末日 10時以降・未送信月なら send', () => {
    const d = decideBillingInquiryAction({ jstDate: '2026-09-30', jstHour: 10, lastSentMonth: '2026-08' });
    expect(d).toEqual({ action: 'send', month: '2026-09' });
  });

  test('月末日でも 10時前は skip', () => {
    const d = decideBillingInquiryAction({ jstDate: '2026-09-30', jstHour: 9, lastSentMonth: '2026-08' });
    expect(d).toEqual({ action: 'skip' });
  });

  test('月末日でも送信済みの月は skip（二重送信ガード）', () => {
    const d = decideBillingInquiryAction({ jstDate: '2026-09-30', jstHour: 15, lastSentMonth: '2026-09' });
    expect(d).toEqual({ action: 'skip' });
  });

  test('月末日以外（月中）は skip', () => {
    const d = decideBillingInquiryAction({ jstDate: '2026-09-29', jstHour: 15, lastSentMonth: '2026-08' });
    expect(d).toEqual({ action: 'skip' });
  });

  test('月末に送れなかった場合、翌月2日までリカバリ送信（対象は前月）', () => {
    const d1 = decideBillingInquiryAction({ jstDate: '2026-10-01', jstHour: 10, lastSentMonth: '2026-08' });
    expect(d1).toEqual({ action: 'send', month: '2026-09' });
    const d2 = decideBillingInquiryAction({ jstDate: '2026-10-02', jstHour: 23, lastSentMonth: '2026-08' });
    expect(d2).toEqual({ action: 'send', month: '2026-09' });
  });

  test('翌月3日以降はリカバリしない', () => {
    const d = decideBillingInquiryAction({ jstDate: '2026-10-03', jstHour: 12, lastSentMonth: '2026-08' });
    expect(d).toEqual({ action: 'skip' });
  });

  test('月初でも前月送信済みなら skip', () => {
    const d = decideBillingInquiryAction({ jstDate: '2026-10-01', jstHour: 12, lastSentMonth: '2026-09' });
    expect(d).toEqual({ action: 'skip' });
  });

  test('年またぎのリカバリ（1月1日に12月分）', () => {
    const d = decideBillingInquiryAction({ jstDate: '2027-01-01', jstHour: 11, lastSentMonth: '2026-11' });
    expect(d).toEqual({ action: 'send', month: '2026-12' });
  });

  test('2月末日（平年28日）でも発火する', () => {
    const d = decideBillingInquiryAction({ jstDate: '2027-02-28', jstHour: 10, lastSentMonth: '2027-01' });
    expect(d).toEqual({ action: 'send', month: '2027-02' });
  });
});
