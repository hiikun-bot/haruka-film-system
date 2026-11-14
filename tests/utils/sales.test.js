// 🤝 営業・名刺管理（ADR 056）の純関数テスト
const S = require('../../utils/sales');

describe('メールアドレス', () => {
  test('1 件だけを受け付ける', () => {
    expect(S.normalizeEmail(' yamada@example.co.jp ')).toBe('yamada@example.co.jp');
    expect(S.normalizeEmail('a@example.com, b@example.com')).toBeNull();
    expect(S.normalizeEmail('a@example.com b@example.com')).toBeNull();
    expect(S.normalizeEmail('a@example.com\nBcc: x@example.com')).toBeNull();
    expect(S.normalizeEmail('山田 <a@example.com>')).toBeNull();
    expect(S.normalizeEmail('no-at.example.com')).toBeNull();
    expect(S.normalizeEmail('')).toBeNull();
  });
  test('大文字小文字・前後の空白を無視して比べる', () => {
    expect(S.sameEmail('A@Example.com', ' a@example.com')).toBe(true);
    expect(S.sameEmail('a@example.com', 'b@example.com')).toBe(false);
    expect(S.sameEmail('a@example.com', undefined)).toBe(false);
  });
});

describe('連絡先の入力', () => {
  test('氏名が無ければエラー', () => {
    expect(S.sanitizeContactInput({ company: 'x' }).error).toMatch(/氏名/);
  });
  test('メール・日付・金額を整える', () => {
    const { values } = S.sanitizeContactInput({ name: ' 山田 太郎 ', email: 'Yamada@example.co.jp', met_on: '2026-11-14', expected_amount: '300,000円', website: 'example.co.jp' });
    expect(values.name).toBe('山田 太郎');
    expect(values.email).toBe('Yamada@example.co.jp');
    expect(values.met_on).toBe('2026-11-14');
    expect(values.expected_amount).toBe(300000);
    expect(values.website).toBe('https://example.co.jp');
    expect(values.do_not_email).toBe(false);
  });
  test('形式の悪いメール・日付は弾く', () => {
    expect(S.sanitizeContactInput({ name: 'a', email: 'a@b, c@d.jp' }).error).toMatch(/メール/);
    expect(S.sanitizeContactInput({ name: 'a', met_on: '11/14' }).error).toMatch(/日付/);
  });
  test('更新は渡された項目だけ', () => {
    const { values } = S.sanitizeContactInput({ next_action: '電話' }, { partial: true });
    expect(values).toEqual({ next_action: '電話' });
    expect(S.sanitizeContactInput({ name: ' ' }, { partial: true }).error).toMatch(/氏名/);
  });
});

describe('名刺画像', () => {
  test('JPEG / PNG / WebP の data URL だけ', () => {
    const jpeg = `data:image/jpeg;base64,${Buffer.from('x').toString('base64')}`;
    expect(S.parseImageDataUrl(jpeg).mimeType).toBe('image/jpeg');
    expect(S.parseImageDataUrl('data:image/svg+xml;base64,AAAA')).toBeNull();
    expect(S.parseImageDataUrl('data:text/html;base64,AAAA')).toBeNull();
    expect(S.parseImageDataUrl('https://example.com/a.jpg')).toBeNull();
  });
});

describe('差出人として動けるか', () => {
  test('本人は可・他人は不可・代理を認められた相手なら可', () => {
    expect(S.canActAsSender({ actorId: 'u1', senderId: 'u1', delegateOwnerIds: [] })).toBe(true);
    expect(S.canActAsSender({ actorId: 'u2', senderId: 'u1', delegateOwnerIds: [] })).toBe(false);
    expect(S.canActAsSender({ actorId: 'u2', senderId: 'u1', delegateOwnerIds: ['u1'] })).toBe(true);
    expect(S.canActAsSender({ actorId: 'u2', senderId: 'u3', delegateOwnerIds: ['u1'] })).toBe(false);
    expect(S.canActAsSender({ actorId: null, senderId: 'u1' })).toBe(false);
  });
});

describe('送信の最終判定', () => {
  const base = () => ({
    mail: { sender_user_id: 'u1', status: 'draft', to_email: 'yamada@example.co.jp', subject: '件名', body: '本文' },
    contact: { do_not_email: false, archived_at: null },
    actorId: 'u1', delegateOwnerIds: [], viewAs: false, confirmToEmail: 'yamada@example.co.jp', sentToday: 0,
  });
  const code = (over) => S.checkSendable({ ...base(), ...over }).code;

  test('そろっていれば送れる', () => {
    expect(S.checkSendable(base())).toEqual({ ok: true, to: 'yamada@example.co.jp' });
  });
  test('他人の名前では送れない（代理を認められていれば送れる）', () => {
    expect(code({ actorId: 'u2' })).toBe('not_allowed');
    expect(S.checkSendable({ ...base(), actorId: 'u2', delegateOwnerIds: ['u1'] }).ok).toBe(true);
  });
  test('VIEW AS 中は送れない', () => expect(code({ viewAs: true })).toBe('view_as'));
  test('確認した宛先と違えば送らない', () => {
    expect(code({ confirmToEmail: 'other@example.co.jp' })).toBe('recipient_mismatch');
    expect(code({ confirmToEmail: undefined })).toBe('recipient_mismatch');
  });
  test('送信済み・送信中は送らない', () => {
    expect(code({ mail: { ...base().mail, status: 'sent' } })).toBe('already_sent');
    expect(code({ mail: { ...base().mail, status: 'sending' } })).toBe('already_sent');
  });
  test('「今後メールを送らない」の相手・アーカイブ済みには送らない', () => {
    expect(code({ contact: { do_not_email: true } })).toBe('do_not_email');
    expect(code({ contact: { archived_at: '2026-11-14T00:00:00Z' } })).toBe('archived');
  });
  test('件名・本文が空、宛先が不正なら送らない', () => {
    expect(code({ mail: { ...base().mail, subject: ' ' } })).toBe('empty_subject');
    expect(code({ mail: { ...base().mail, body: '' } })).toBe('empty_body');
    expect(code({ mail: { ...base().mail, to_email: 'a@b.jp, c@d.jp' } })).toBe('invalid_to');
  });
  test('1 日の上限', () => expect(code({ sentToday: 50 })).toBe('daily_limit'));
});

describe('プロモ動画の URL', () => {
  test('YouTube の各形式', () => {
    for (const url of [
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10',
      'https://youtu.be/dQw4w9WgXcQ?si=abc',
      'https://www.youtube.com/shorts/dQw4w9WgXcQ',
      'https://m.youtube.com/watch?v=dQw4w9WgXcQ',
    ]) {
      expect(S.parseVideoUrl(url)).toMatchObject({ provider: 'youtube', embed_id: 'dQw4w9WgXcQ' });
    }
    expect(S.videoEmbedUrl({ provider: 'youtube', embed_id: 'dQw4w9WgXcQ' })).toBe('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=0');
    expect(S.videoThumbnailUrl({ provider: 'youtube', embed_id: 'dQw4w9WgXcQ' })).toContain('/vi/dQw4w9WgXcQ/');
  });
  test('Vimeo（限定公開の hash つきも）', () => {
    expect(S.parseVideoUrl('https://vimeo.com/123456789')).toMatchObject({ provider: 'vimeo', embed_id: '123456789' });
    expect(S.parseVideoUrl('https://vimeo.com/123456789/abcdef1234')).toMatchObject({ provider: 'vimeo', embed_id: '123456789?h=abcdef1234' });
  });
  test('その他の https はリンク扱い・http(s) 以外は不可', () => {
    expect(S.parseVideoUrl('https://example.com/movie')).toMatchObject({ provider: 'link', embed_id: null });
    expect(S.parseVideoUrl('javascript:alert(1)')).toBeNull();
    expect(S.parseVideoUrl('not a url')).toBeNull();
  });
  test('紹介ページの token', () => {
    const t = S.generatePageToken();
    expect(S.isValidPageToken(t)).toBe(true);
    expect(S.generatePageToken()).not.toBe(t);
    expect(S.isValidPageToken('../etc')).toBe(false);
  });
});

describe('メール本文', () => {
  test('紹介ページ URL と署名を足す（本文に URL があれば重ねない）', () => {
    const footer = S.buildMailFooter({ senderName: '髙橋 聖', senderEmail: 'me@example.com' });
    expect(footer).toContain('HARUKA FILM　髙橋 聖');
    expect(footer).toContain('ご案内が不要な場合');
    const out = S.buildFinalBody({ body: '山田様\n先日は…\n', promoUrl: 'https://hfs.example/pv/abc', footer });
    expect(out).toBe(`山田様\n先日は…\n\n▼ 作品のご紹介（動画をご覧いただけます）\nhttps://hfs.example/pv/abc\n\n${footer}`);
    const already = S.buildFinalBody({ body: '動画はこちら https://hfs.example/pv/abc', promoUrl: 'https://hfs.example/pv/abc', footer: '' });
    expect(already.match(/pv\/abc/g)).toHaveLength(1);
  });

  test('Gmail に渡す raw: 日本語の件名・差出人名を符号化し、ヘッダに改行を入れない', () => {
    const raw = S.buildRawMessage({
      fromName: '髙橋 聖', fromEmail: 'me@example.com', to: 'yamada@example.co.jp',
      subject: '先日はありがとうございました\r\nBcc: evil@example.com', body: '山田様\nこんにちは',
    });
    const text = Buffer.from(raw, 'base64url').toString('utf8');
    const [head, body] = text.split('\r\n\r\n');
    expect(head).toContain('To: yamada@example.co.jp');
    expect(head).toContain('<me@example.com>');
    expect(head).not.toMatch(/^Bcc:/m);
    expect(head).toMatch(/^Subject: =\?UTF-8\?B\?/m);
    // 件名を復号すると、改行は空白に置き換わっている
    const subjectLines = head.split('\r\n').slice(head.split('\r\n').findIndex((l) => l.startsWith('Subject:')));
    const words = subjectLines.join('').match(/=\?UTF-8\?B\?([^?]+)\?=/g).map((w) => Buffer.from(w.slice(10, -2), 'base64').toString('utf8'));
    expect(words.join('')).toContain('先日はありがとうございました Bcc: evil@example.com');
    expect(Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8')).toBe('山田様\r\nこんにちは');
  });
  test('宛先・差出人が不正なら作らない', () => {
    expect(() => S.buildRawMessage({ fromName: 'a', fromEmail: 'me@example.com', to: 'a@b.jp,c@d.jp', subject: 's', body: 'b' })).toThrow();
    expect(() => S.buildRawMessage({ fromName: 'a', fromEmail: '', to: 'a@b.jp', subject: 's', body: 'b' })).toThrow();
  });
});

describe('表示・日付', () => {
  test('ニックネーム（名前）', () => {
    expect(S.displayName({ nickname: 'さとる', full_name: '髙橋 聖' })).toBe('さとる（髙橋 聖）');
    expect(S.displayName({ nickname: '', full_name: '髙橋 聖' })).toBe('髙橋 聖');
  });
  test('JST の日・月の始まり（UTC で返す）', () => {
    // 2026-11-14 08:00 JST = 2026-11-13 23:00 UTC
    const now = new Date('2026-11-13T23:00:00Z');
    expect(S.jstDayStartIso(now)).toBe('2026-11-13T15:00:00.000Z');
    expect(S.jstMonthStartIso(now)).toBe('2026-10-31T15:00:00.000Z');
  });
  test('ロボットの閲覧は数えない', () => {
    expect(S.isBotUserAgent('Slackbot-LinkExpanding 1.0')).toBe(true);
    expect(S.isBotUserAgent('')).toBe(true);
    expect(S.isBotUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1')).toBe(false);
  });
});
