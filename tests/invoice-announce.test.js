// tests/invoice-announce.test.js
// 請求書案内（毎月20日の自動送信）のユニットテスト。
//
// TZ=UTC / TZ=Asia/Tokyo のどちらで実行しても同じ結果になることが重要
// （Railway は UTC 動作のため）。CI とローカル両方で通ること。
//
// workers/invoice-announce-scheduler.js は supabase.js（env 必須・欠落時
// process.exit）を require するため、supabase / notifications をモックして
// 純関数部分（判定ロジック・JST変換）だけを検証する。

jest.mock('../supabase', () => ({}));
jest.mock('../notifications', () => ({
  sendChatworkRoom: jest.fn(),
  sendSlackChannel: jest.fn(),
  notifyAutoError: jest.fn(),
}));

const {
  buildInvoiceAnnounceTexts,
  parseHfClients,
  parseMonthStr,
  DEFAULT_HF_CLIENTS,
} = require('../utils/invoice-announce');

const {
  decideInvoiceAnnounceAction,
  jstNowParts,
  prevMonth,
} = require('../workers/invoice-announce-scheduler');

describe('buildInvoiceAnnounceTexts', () => {
  test('提出日は26〜28日で曜日付き（2026-07: 旧秘書の実投稿と同一の 7/26(日)~7/28(火)）', () => {
    const t = buildInvoiceAnnounceTexts('2026-07');
    expect(t.submitPeriodLabel).toBe('7/26(日)~7/28(火)');
    expect(t.chatwork).toContain('7/26(日)~7/28(火)');
    expect(t.slack).toContain('7/26(日)~7/28(火)');
  });

  test('2026-09 の提出日は 9/26(土)~9/28(月)', () => {
    const t = buildInvoiceAnnounceTexts('2026-09');
    expect(t.submitPeriodLabel).toBe('9/26(土)~9/28(月)');
  });

  test('Chatwork 版は [info][title] 囲みと Chatwork 絵文字を含む', () => {
    const t = buildInvoiceAnnounceTexts('2026-09');
    expect(t.chatwork).toContain('[info][title]請求書送付についてのご案内[/title]');
    expect(t.chatwork).toContain('[/info]');
    expect(t.chatwork).toContain('(bow)');
  });

  test('Slack 版は Chatwork 専用記法を含まない', () => {
    const t = buildInvoiceAnnounceTexts('2026-09');
    expect(t.slack).not.toContain('[info]');
    expect(t.slack).not.toContain('[title]');
    expect(t.slack).not.toContain('(bow)');
    expect(t.slack).not.toContain('(please)');
    expect(t.slack).toContain('請求書送付についてのご案内');
  });

  test('秘書チーム解体後の文面: 秘書・くるみへの言及が無く、問い合わせ先はひーくん', () => {
    const t = buildInvoiceAnnounceTexts('2026-09');
    for (const text of [t.chatwork, t.slack]) {
      expect(text).not.toContain('秘書');
      expect(text).not.toContain('くるみ');
      expect(text).toContain('質問ありましたらひーくんへDM');
      expect(text).toContain('こちらのフォルダはひーくんと本人のみ閲覧できます');
    }
  });

  test('HF案件リストは既定値を含み、上書きも可能', () => {
    const def = buildInvoiceAnnounceTexts('2026-09');
    for (const c of DEFAULT_HF_CLIENTS) expect(def.chatwork).toContain(`✅${c}`);
    const t = buildInvoiceAnnounceTexts('2026-09', { hfClients: ['テスト様'] });
    expect(t.chatwork).toContain('✅テスト様');
    expect(t.chatwork).not.toContain('✅よたさん');
  });

  test('不正な月指定は throw', () => {
    expect(() => buildInvoiceAnnounceTexts('2026-13')).toThrow();
    expect(() => buildInvoiceAnnounceTexts('9月')).toThrow();
    expect(() => buildInvoiceAnnounceTexts('')).toThrow();
  });
});

describe('parseHfClients / parseMonthStr', () => {
  test('改行・カンマ・読点区切りを配列化、空は null', () => {
    expect(parseHfClients('A様\nB様')).toEqual(['A様', 'B様']);
    expect(parseHfClients('A様, B様、C様')).toEqual(['A様', 'B様', 'C様']);
    expect(parseHfClients('')).toBeNull();
    expect(parseHfClients('  \n ')).toBeNull();
  });
  test('parseMonthStr は YYYY-MM のみ許可', () => {
    expect(parseMonthStr('2026-09')).toEqual({ year: 2026, month: 9 });
    expect(parseMonthStr('2026-9')).toBeNull();
    expect(parseMonthStr('2026-00')).toBeNull();
  });
});

describe('decideInvoiceAnnounceAction', () => {
  test('初回起動（キー無し）: 20日以降は当月を消化済みマーク（送信しない）', () => {
    expect(decideInvoiceAnnounceAction({ jstDate: '2026-08-20', jstHour: 15, lastSentMonth: null }))
      .toEqual({ action: 'bootstrap', markMonth: '2026-08' });
  });

  test('初回起動（キー無し）: 20日前は前月を消化済みマーク（当月20日から自動化）', () => {
    expect(decideInvoiceAnnounceAction({ jstDate: '2026-09-05', jstHour: 15, lastSentMonth: null }))
      .toEqual({ action: 'bootstrap', markMonth: '2026-08' });
    // 年またぎ
    expect(decideInvoiceAnnounceAction({ jstDate: '2027-01-05', jstHour: 15, lastSentMonth: null }))
      .toEqual({ action: 'bootstrap', markMonth: '2026-12' });
  });

  test('20日 10時以降・未送信月なら送信', () => {
    expect(decideInvoiceAnnounceAction({ jstDate: '2026-09-20', jstHour: 10, lastSentMonth: '2026-08' }))
      .toEqual({ action: 'send', month: '2026-09' });
  });

  test('20日でも 10時前は送信しない', () => {
    expect(decideInvoiceAnnounceAction({ jstDate: '2026-09-20', jstHour: 9, lastSentMonth: '2026-08' }))
      .toEqual({ action: 'skip' });
  });

  test('送信済みの月はスキップ（二重送信ガード）', () => {
    expect(decideInvoiceAnnounceAction({ jstDate: '2026-09-20', jstHour: 12, lastSentMonth: '2026-09' }))
      .toEqual({ action: 'skip' });
    expect(decideInvoiceAnnounceAction({ jstDate: '2026-09-21', jstHour: 12, lastSentMonth: '2026-09' }))
      .toEqual({ action: 'skip' });
  });

  test('20日に送れなかった場合は22日までリカバリ送信、23日以降は見送り', () => {
    expect(decideInvoiceAnnounceAction({ jstDate: '2026-09-22', jstHour: 11, lastSentMonth: '2026-08' }))
      .toEqual({ action: 'send', month: '2026-09' });
    expect(decideInvoiceAnnounceAction({ jstDate: '2026-09-23', jstHour: 11, lastSentMonth: '2026-08' }))
      .toEqual({ action: 'skip' });
  });

  test('19日以前は送信しない', () => {
    expect(decideInvoiceAnnounceAction({ jstDate: '2026-09-19', jstHour: 12, lastSentMonth: '2026-08' }))
      .toEqual({ action: 'skip' });
  });
});

describe('jstNowParts（サーバーTZ 非依存で JST を返す）', () => {
  test('UTC 01:00 は JST 10:00（同日）', () => {
    expect(jstNowParts(new Date('2026-09-20T01:00:00Z'))).toEqual({ date: '2026-09-20', hour: 10 });
  });
  test('UTC 23:00 は JST 翌日 08:00（日付繰り上がり）', () => {
    expect(jstNowParts(new Date('2026-09-19T23:00:00Z'))).toEqual({ date: '2026-09-20', hour: 8 });
  });
  test('UTC 15:00 は JST 翌日 00:00', () => {
    expect(jstNowParts(new Date('2026-09-19T15:00:00Z'))).toEqual({ date: '2026-09-20', hour: 0 });
  });
});

describe('prevMonth', () => {
  test('通常月と年またぎ', () => {
    expect(prevMonth('2026-09')).toBe('2026-08');
    expect(prevMonth('2026-01')).toBe('2025-12');
  });
});
