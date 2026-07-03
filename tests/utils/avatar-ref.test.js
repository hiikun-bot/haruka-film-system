// tests/utils/avatar-ref.test.js
// utils/avatar-ref.js（アバター base64 → 配信 URL 置換による転送量対策）のユニットテスト。

const {
  isAvatarDataUrl,
  avatarVer,
  avatarRefUrl,
  replaceAvatarDataUrls,
  getAvatarRefMap,
  updateAvatarRefCacheEntry,
  applyAvatarRef,
  invalidateAvatarRefCache,
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

// ==================== avatar 参照キャッシュ（DB→サーバー間転送対策） ====================

describe('getAvatarRefMap / updateAvatarRefCacheEntry / applyAvatarRef', () => {
  // `.from('users').select(...).not('avatar_url','is',null)` の形だけ再現する軽量モック
  const mockSupabase = (rowsOrFn) => {
    const state = { calls: 0 };
    return {
      state,
      from: () => ({
        select: () => ({
          not: () => {
            state.calls++;
            const rows = typeof rowsOrFn === 'function' ? rowsOrFn() : rowsOrFn;
            if (rows instanceof Error) return Promise.resolve({ data: null, error: { message: rows.message } });
            return Promise.resolve({ data: rows, error: null });
          },
        }),
      }),
    };
  };

  beforeEach(() => invalidateAvatarRefCache());
  afterEach(() => invalidateAvatarRefCache());

  test('ウォームで data URL → 配信 URL、非 data 文字列 → 素通し、null 相当 → Map に載らない', async () => {
    const u1 = dataUrl('A'.repeat(1000));
    const sb = mockSupabase([
      { id: 'u1', avatar_url: u1 },
      { id: 'u2', avatar_url: 'https://example.com/a.png' }, // 万一の legacy 値
    ]);
    const map = await getAvatarRefMap(sb);
    expect(map.get('u1')).toBe(`/api/haruka/members/u1/avatar?v=${avatarVer(u1)}`);
    expect(map.get('u2')).toBe('https://example.com/a.png');
    expect(map.has('u3')).toBe(false);
  });

  test('TTL 内の 2 回目以降は DB を引かない（キャッシュヒット）', async () => {
    const sb = mockSupabase([{ id: 'u1', avatar_url: dataUrl('AAA') }]);
    await getAvatarRefMap(sb);
    await getAvatarRefMap(sb);
    await getAvatarRefMap(sb);
    expect(sb.state.calls).toBe(1);
  });

  test('ウォーム中の同時リクエストは同一 Promise を共有する（thundering herd 防止）', async () => {
    let release;
    const gate = new Promise(r => { release = r; });
    const state = { calls: 0 };
    const sb = {
      from: () => ({
        select: () => ({
          not: () => { state.calls++; return gate.then(() => ({ data: [{ id: 'u1', avatar_url: dataUrl('AAA') }], error: null })); },
        }),
      }),
    };
    const p1 = getAvatarRefMap(sb);
    const p2 = getAvatarRefMap(sb);
    release();
    const [m1, m2] = await Promise.all([p1, p2]);
    expect(m1).toBe(m2);
    expect(state.calls).toBe(1);
  });

  test('書き込み経路の即時更新: アップロードで entry 更新・削除で entry 削除', async () => {
    const before = dataUrl('OLD'.repeat(100));
    const sb = mockSupabase([{ id: 'u1', avatar_url: before }]);
    const map = await getAvatarRefMap(sb);
    const after = dataUrl('NEW'.repeat(100));
    updateAvatarRefCacheEntry('u1', after);
    expect(map.get('u1')).toBe(`/api/haruka/members/u1/avatar?v=${avatarVer(after)}`);
    updateAvatarRefCacheEntry('u1', null);
    expect(map.has('u1')).toBe(false);
    // 未ウォーム時は no-op（throw しない）
    invalidateAvatarRefCache();
    expect(() => updateAvatarRefCacheEntry('u1', after)).not.toThrow();
  });

  test('ウォーム失敗: 古い Map があればそれで継続、初回失敗は throw', async () => {
    const sb1 = mockSupabase([{ id: 'u1', avatar_url: dataUrl('AAA') }]);
    const stale = await getAvatarRefMap(sb1);
    // TTL 切れ相当を再現するためキャッシュ有効期限だけ切らせたいが、モジュール内部のため
    // ここでは「失敗クライアントを渡しても stale Map が返る」ことだけ検証する
    // （TTL 内はそもそも DB を引かないので同じ Map が返る）
    const sbErr = mockSupabase(new Error('connection refused'));
    await expect(getAvatarRefMap(sbErr)).resolves.toBe(stale);
    invalidateAvatarRefCache();
    await expect(getAvatarRefMap(sbErr)).rejects.toThrow('connection refused');
  });

  test('applyAvatarRef: Map から注入・未設定ユーザーは null・id 無しは触らない', async () => {
    const u1 = dataUrl('A'.repeat(500));
    const sb = mockSupabase([{ id: 'u1', avatar_url: u1 }]);
    const map = await getAvatarRefMap(sb);
    const a = { id: 'u1', full_name: '山田' };
    applyAvatarRef(a, map);
    expect(a.avatar_url).toBe(`/api/haruka/members/u1/avatar?v=${avatarVer(u1)}`);
    const b = { id: 'u2', full_name: '佐藤' };
    applyAvatarRef(b, map);
    expect(b.avatar_url).toBeNull();
    const c = { full_name: 'idなし' };
    applyAvatarRef(c, map);
    expect('avatar_url' in c).toBe(false);
    expect(applyAvatarRef(null, map)).toBeNull();
  });

  test('注入値は従来の res.json パッチ（replaceAvatarDataUrls）通過後と完全一致する', async () => {
    const raw = dataUrl('Z'.repeat(2000));
    // Before: embed で base64 が乗った行を res.json パッチが置換した結果
    const beforeUser = { id: 'u9', full_name: '高橋', avatar_url: raw };
    replaceAvatarDataUrls(beforeUser);
    // After: select から外し、キャッシュから注入した結果
    const sb = mockSupabase([{ id: 'u9', avatar_url: raw }]);
    const map = await getAvatarRefMap(sb);
    const afterUser = applyAvatarRef({ id: 'u9', full_name: '高橋' }, map);
    expect(afterUser.avatar_url).toBe(beforeUser.avatar_url);
    expect(Object.keys(afterUser).sort()).toEqual(Object.keys(beforeUser).sort());
    // 注入値は data: で始まらないため、res.json パッチをもう一度通しても変化しない（干渉しない）
    const again = JSON.parse(JSON.stringify(afterUser));
    replaceAvatarDataUrls(again);
    expect(again).toEqual(afterUser);
  });
});
