// tests/utils/avatar-ref.test.js
// utils/avatar-ref.js（アバター base64 → 配信 URL 置換による転送量対策）のユニットテスト。

const {
  isAvatarDataUrl,
  avatarVer,
  avatarRefUrl,
  replaceAvatarDataUrls,
} = require('../../utils/avatar-ref');

// 300x300 JPEG 想定のダミー data URL（実物より短いがロジックは同じ）
const dataUrl = (body) => `data:image/jpeg;base64,${body}`;

describe('isAvatarDataUrl', () => {
  test('data URL を判定する', () => {
    expect(isAvatarDataUrl(dataUrl('AAAA'))).toBe(true);
    expect(isAvatarDataUrl('data:image/png;base64,BBBB')).toBe(true);
  });
  test('通常 URL / null / 非文字列は false', () => {
    expect(isAvatarDataUrl('/api/haruka/members/u1/avatar?v=abc')).toBe(false);
    expect(isAvatarDataUrl('https://example.com/a.png')).toBe(false);
    expect(isAvatarDataUrl(null)).toBe(false);
    expect(isAvatarDataUrl(undefined)).toBe(false);
    expect(isAvatarDataUrl(123)).toBe(false);
  });
});

describe('avatarVer', () => {
  test('同じ data URL からは常に同じ ver（決定的）', () => {
    const u = dataUrl('A'.repeat(1000));
    expect(avatarVer(u)).toBe(avatarVer(u));
    expect(typeof avatarVer(u)).toBe('string');
    expect(avatarVer(u).length).toBeGreaterThan(0);
  });
  test('内容が変わると ver も変わる', () => {
    expect(avatarVer(dataUrl('A'.repeat(1000)))).not.toBe(avatarVer(dataUrl('B'.repeat(1000))));
    // 長さ同一・先頭一致でも末尾が違えば変わる（先頭256 + 末尾64 をサンプリング）
    const a = dataUrl('C'.repeat(990) + 'X'.repeat(10));
    const b = dataUrl('C'.repeat(990) + 'Y'.repeat(10));
    expect(avatarVer(a)).not.toBe(avatarVer(b));
  });
  test('data URL でなければ null', () => {
    expect(avatarVer(null)).toBeNull();
    expect(avatarVer('/api/haruka/members/u1/avatar?v=abc')).toBeNull();
  });
});

describe('avatarRefUrl', () => {
  test('配信エンドポイント URL を ?v 付きで組み立てる', () => {
    expect(avatarRefUrl('u1', 'abc')).toBe('/api/haruka/members/u1/avatar?v=abc');
  });
  test('ver 無しなら ?v を付けない', () => {
    expect(avatarRefUrl('u1', null)).toBe('/api/haruka/members/u1/avatar');
  });
});

describe('replaceAvatarDataUrls', () => {
  test('id と同階層の avatar_url（base64）を配信 URL に置換する', () => {
    const u = { id: 'u1', full_name: '山田', avatar_url: dataUrl('A'.repeat(500)) };
    replaceAvatarDataUrls(u);
    expect(u.avatar_url).toBe(`/api/haruka/members/u1/avatar?v=${avatarVer(dataUrl('A'.repeat(500)))}`);
    expect(u.full_name).toBe('山田'); // 他フィールドは触らない
  });

  test('ネストした users 埋め込み・配列も再帰的に置換する（一覧 API 形）', () => {
    const rows = [
      { id: 't1', body: 'hi', users: { id: 'u1', avatar_url: dataUrl('AAA') } },
      { id: 't2', body: 'yo', users: { id: 'u2', avatar_url: null } },
      { id: 'c1', director: { id: 'u3', avatar_url: dataUrl('BBB') }, producer: null },
    ];
    replaceAvatarDataUrls(rows);
    expect(rows[0].users.avatar_url).toMatch(/^\/api\/haruka\/members\/u1\/avatar\?v=/);
    expect(rows[1].users.avatar_url).toBeNull();
    expect(rows[2].director.avatar_url).toMatch(/^\/api\/haruka\/members\/u3\/avatar\?v=/);
  });

  test('base64 が JSON のどこにも残らない', () => {
    const payload = {
      list: [{ id: 'u1', avatar_url: dataUrl('Z'.repeat(2000)) }],
      nested: { deep: [{ editor: { id: 'u2', avatar_url: dataUrl('Q'.repeat(2000)) } }] },
    };
    replaceAvatarDataUrls(payload);
    expect(JSON.stringify(payload)).not.toContain('base64');
  });

  test('id が無い場合は null（base64 を漏らさない）', () => {
    const o = { avatar_url: dataUrl('AAA') };
    replaceAvatarDataUrls(o);
    expect(o.avatar_url).toBeNull();
  });

  test('既に URL / null の avatar_url はそのまま（冪等）', () => {
    const o = { id: 'u1', avatar_url: '/api/haruka/members/u1/avatar?v=abc' };
    replaceAvatarDataUrls(o);
    expect(o.avatar_url).toBe('/api/haruka/members/u1/avatar?v=abc');
    const n = { id: 'u1', avatar_url: null };
    replaceAvatarDataUrls(n);
    expect(n.avatar_url).toBeNull();
  });

  test('プリミティブ / null / undefined はそのまま返す', () => {
    expect(replaceAvatarDataUrls(null)).toBeNull();
    expect(replaceAvatarDataUrls(undefined)).toBeUndefined();
    expect(replaceAvatarDataUrls('str')).toBe('str');
    expect(replaceAvatarDataUrls(42)).toBe(42);
  });

  test('Buffer は走査しない（バイナリ payload を壊さない・無駄に歩かない）', () => {
    const buf = Buffer.from('hello');
    expect(replaceAvatarDataUrls(buf)).toBe(buf);
    const o = { id: 'u1', file: Buffer.from('x'), avatar_url: dataUrl('AAA') };
    replaceAvatarDataUrls(o);
    expect(o.file.toString()).toBe('x');
    expect(o.avatar_url).toMatch(/^\/api\/haruka\/members\/u1\/avatar\?v=/);
  });
});
