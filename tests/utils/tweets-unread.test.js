const { resolveUnreadSince, DEFAULT_LOOKBACK_MS, MAX_LOOKBACK_MS } = require('../../utils/tweets-unread');

describe('resolveUnreadSince', () => {
  const now = new Date('2026-09-16T03:00:00.000Z'); // JST 12:00

  test('欠落・空文字・不正文字列は 24時間前', () => {
    for (const raw of [undefined, null, '', '   ', 'abc', 42]) {
      expect(resolveUnreadSince(raw, now).getTime()).toBe(now.getTime() - DEFAULT_LOOKBACK_MS);
    }
  });

  test('妥当な ISO はそのまま', () => {
    const iso = '2026-09-15T22:30:00.000Z';
    expect(resolveUnreadSince(iso, now).toISOString()).toBe(iso);
  });

  test('未来は now に丸める（端末時計ズレ）', () => {
    expect(resolveUnreadSince('2026-09-17T00:00:00.000Z', now).getTime()).toBe(now.getTime());
  });

  test('30日より前は 30日前に丸める', () => {
    expect(resolveUnreadSince('2026-01-01T00:00:00.000Z', now).getTime()).toBe(now.getTime() - MAX_LOOKBACK_MS);
  });
});
