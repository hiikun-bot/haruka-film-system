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
  buildSubmitCalendarUrl,
  parseHfClients,
  parseMonthStr,
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

  test('プレーン版（お知らせ用）は装飾記法なしで見出し重複もない', () => {
    const t = buildInvoiceAnnounceTexts('2026-09');
    expect(t.plain).not.toContain('[info]');
    expect(t.plain).not.toContain('*📄');
    expect(t.plain).not.toContain('(bow)');
    expect(t.plain).toContain('みなさんお疲れ様でございます');
    expect(t.plain).toContain('9/26(土)~9/28(月)');
  });

  test('Slack 版は Chatwork 専用記法を含まない', () => {
    const t = buildInvoiceAnnounceTexts('2026-09');
    expect(t.slack).not.toContain('[info]');
    expect(t.slack).not.toContain('[title]');
    expect(t.slack).not.toContain('(bow)');
    expect(t.slack).not.toContain('(please)');
    expect(t.slack).toContain('請求書送付についてのご案内');
  });

  test('秘書・くるみ・ひーくんへの言及が無く、送り主は Chatwork=私／Slack・お知らせ=髙橋', () => {
    const t = buildInvoiceAnnounceTexts('2026-09');
    for (const text of [t.chatwork, t.slack, t.plain]) {
      expect(text).not.toContain('秘書');
      expect(text).not.toContain('くるみ');
      expect(text).not.toContain('ひーくん');
    }
    expect(t.chatwork).toContain('質問ありましたら私へDM');
    expect(t.chatwork).toContain('こちらのフォルダは私とご本人のみ閲覧できます');
    expect(t.chatwork).toContain('提出前に私へDMでご連絡ください');
    expect(t.chatwork).not.toContain('髙橋');
    for (const text of [t.slack, t.plain]) {
      expect(text).toContain('質問ありましたら髙橋へDM');
      expect(text).toContain('こちらのフォルダは髙橋とご本人のみ閲覧できます');
      expect(text).toContain('提出前に髙橋へDMでご連絡ください');
      expect(text).not.toMatch(/私(へ|と)/);
    }
  });

  test('請求システムでの提出が本線: 3ステップを案内し、旧 DM 報告手順と HF案件リストは載せない', () => {
    const t = buildInvoiceAnnounceTexts('2026-09', { hfClients: ['テスト様'] });
    for (const text of [t.chatwork, t.slack, t.plain]) {
      expect(text).toContain('【HARUKA FILM SYSTEM（請求システム）】での提出が基本です');
      expect(text).toContain('「＋ 今月の請求書を作成」');
      expect(text).toContain('③「提出する」ボタンを押す');
      expect(text).toContain('従来のフォーマット（PDF提出）でも受け付けます');
      expect(text).not.toContain('PDFのURLを');
      expect(text).not.toContain('HF案件');
      expect(text).not.toContain('✅');
    }
  });

  test('提出日のすぐ後に Google カレンダー登録リンク（終日 26〜28日・Asia/Tokyo）が付く', () => {
    const t = buildInvoiceAnnounceTexts('2026-11');
    const u = new URL(t.calendarUrl);
    expect(u.origin + u.pathname).toBe('https://calendar.google.com/calendar/render');
    expect(u.searchParams.get('action')).toBe('TEMPLATE');
    expect(u.searchParams.get('dates')).toBe('20261126/20261129');
    expect(u.searchParams.get('ctz')).toBe('Asia/Tokyo');
    expect(u.searchParams.get('text')).toBe('【HARUKA FILM】請求書の提出（11/26〜11/28）');
    for (const text of [t.chatwork, t.slack, t.plain]) {
      expect(text).toContain(`11/26(木)~11/28(土)\n📅 カレンダー登録：${t.calendarUrl}`);
    }
  });

  test('カレンダーの終了日は月末またぎでも正しい（平年2月は 3/1、うるう年は 2/29）', () => {
    expect(new URL(buildSubmitCalendarUrl(2027, 2)).searchParams.get('dates')).toBe('20270226/20270301');
    expect(new URL(buildSubmitCalendarUrl(2028, 2)).searchParams.get('dates')).toBe('20280226/20280229');
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
