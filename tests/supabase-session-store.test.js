// lib/supabase-session-store.js のユニットテスト（supabase-js クライアントはモック）
const { SupabaseSessionStore } = require('../lib/supabase-session-store');

// from(table).select().eq().maybeSingle() / upsert() / update().eq() / delete().eq()|lt() を
// 記録しつつ、あらかじめ仕込んだ結果を返す最小モック。
function makeSupabaseMock() {
  const calls = [];
  const state = { rows: new Map(), failNext: null };
  const result = (data) => ({ data, error: null });
  const chain = (op, payload) => {
    const rec = { op, payload, filters: [] };
    calls.push(rec);
    const api = {
      eq(col, val) { rec.filters.push(['eq', col, val]); return api; },
      lt(col, val) { rec.filters.push(['lt', col, val]); return api; },
      maybeSingle() { return api._exec(true); },
      then(onOk, onErr) { return api._exec(false).then(onOk, onErr); },
      _exec(single) {
        if (state.failNext) { const e = state.failNext; state.failNext = null; return Promise.resolve({ data: null, error: e }); }
        const sidFilter = rec.filters.find(f => f[0] === 'eq' && f[1] === 'sid');
        if (op === 'select') {
          const row = sidFilter ? state.rows.get(sidFilter[2]) : null;
          return Promise.resolve(result(row ? { sess: row.sess, expired_at: row.expired_at } : null));
        }
        if (op === 'upsert') { state.rows.set(payload.sid, { ...payload }); return Promise.resolve(result(null)); }
        if (op === 'update') {
          const row = sidFilter && state.rows.get(sidFilter[2]);
          if (row) Object.assign(row, payload);
          return Promise.resolve(result(null));
        }
        if (op === 'delete') {
          if (sidFilter) state.rows.delete(sidFilter[2]);
          const lt = rec.filters.find(f => f[0] === 'lt');
          if (lt) for (const [sid, row] of state.rows) if (row.expired_at < lt[2]) state.rows.delete(sid);
          return Promise.resolve(result(null));
        }
        return Promise.resolve(result(null));
      },
    };
    return api;
  };
  const client = {
    from(table) {
      return {
        select: () => chain('select'),
        upsert: (payload) => chain('upsert', payload),
        update: (payload) => chain('update', payload),
        delete: () => chain('delete'),
      };
    },
  };
  return { client, calls, state };
}

const p = (fn) => new Promise((resolve, reject) => fn((err, val) => (err ? reject(err) : resolve(val))));

function sessWithMaxAge(ms, extra = {}) {
  return { cookie: { originalMaxAge: ms, maxAge: ms, httpOnly: true, path: '/' }, ...extra };
}

describe('SupabaseSessionStore', () => {
  let mock, store;
  beforeEach(() => {
    mock = makeSupabaseMock();
    store = new SupabaseSessionStore({ supabase: mock.client, cleanupIntervalMs: 0, logger: { log() {}, warn() {}, error() {} } });
  });
  afterEach(() => store.close());

  test('set → get で同じ内容が返り、expired_at は cookie.maxAge から計算される', async () => {
    const before = Date.now();
    await p(cb => store.set('s1', sessWithMaxAge(7 * 24 * 3600 * 1000, { passport: { user: 'u1' } }), cb));
    const row = mock.state.rows.get('s1');
    expect(row.sess.passport.user).toBe('u1');
    const exp = new Date(row.expired_at).getTime();
    expect(exp).toBeGreaterThanOrEqual(before + 7 * 24 * 3600 * 1000 - 5);
    const got = await p(cb => store.get('s1', cb));
    expect(got.passport.user).toBe('u1');
  });

  test('get はキャッシュ TTL 内なら Supabase を読まない（毎リクエストの往復を減らす）', async () => {
    await p(cb => store.set('s1', sessWithMaxAge(60000, { a: 1 }), cb));
    const selectsBefore = mock.calls.filter(c => c.op === 'select').length;
    await p(cb => store.get('s1', cb));
    await p(cb => store.get('s1', cb));
    expect(mock.calls.filter(c => c.op === 'select').length).toBe(selectsBefore); // 0 回追加
  });

  test('get が返すオブジェクトはキャッシュと参照を共有しない', async () => {
    await p(cb => store.set('s1', sessWithMaxAge(60000, { nested: { v: 1 } }), cb));
    const a = await p(cb => store.get('s1', cb));
    a.nested.v = 999;
    const b = await p(cb => store.get('s1', cb));
    expect(b.nested.v).toBe(1);
  });

  test('キャッシュ TTL を過ぎたら Supabase を読み直す', async () => {
    store.cacheTtlMs = 0;
    await p(cb => store.set('s1', sessWithMaxAge(60000, { a: 1 }), cb));
    mock.state.rows.get('s1').sess = { cookie: { maxAge: 60000 }, a: 2 }; // 裏で別コンテナが更新した想定
    const got = await p(cb => store.get('s1', cb));
    expect(got.a).toBe(2);
  });

  test('存在しない sid は null', async () => {
    expect(await p(cb => store.get('nope', cb))).toBeNull();
  });

  test('DB 上で失効している行は null を返し削除を投げる', async () => {
    mock.state.rows.set('old', { sess: { cookie: {} }, expired_at: new Date(Date.now() - 1000).toISOString() });
    expect(await p(cb => store.get('old', cb))).toBeNull();
    await new Promise(r => setImmediate(r));
    expect(mock.calls.some(c => c.op === 'delete' && c.filters.some(f => f[2] === 'old'))).toBe(true);
  });

  test('touch は sid ごとに間引かれ、間引き中もキャッシュ上の寿命は伸びる', async () => {
    store.touchThrottleMs = 10 * 60 * 1000;
    await p(cb => store.set('s1', sessWithMaxAge(60000), cb));
    const updatesBefore = mock.calls.filter(c => c.op === 'update').length;
    await p(cb => store.touch('s1', sessWithMaxAge(60000), cb));
    await p(cb => store.touch('s1', sessWithMaxAge(60000), cb));
    expect(mock.calls.filter(c => c.op === 'update').length).toBe(updatesBefore); // set 直後なので書込なし
    // 間引き時間を過ぎた扱いにすると 1 回だけ書く
    store._cache.get('s1').lastTouchWriteAt = Date.now() - 11 * 60 * 1000;
    await p(cb => store.touch('s1', sessWithMaxAge(60000), cb));
    await p(cb => store.touch('s1', sessWithMaxAge(60000), cb));
    expect(mock.calls.filter(c => c.op === 'update').length).toBe(updatesBefore + 1);
  });

  test('touch はキャッシュに無い sid でも DB に書く', async () => {
    mock.state.rows.set('s2', { sess: { cookie: {} }, expired_at: new Date(Date.now() + 1000).toISOString() });
    await p(cb => store.touch('s2', sessWithMaxAge(60000), cb));
    expect(mock.calls.filter(c => c.op === 'update').length).toBe(1);
  });

  test('destroy で DB とキャッシュから消える（ログアウト後に古いセッションが返らない）', async () => {
    await p(cb => store.set('s1', sessWithMaxAge(60000, { a: 1 }), cb));
    await p(cb => store.destroy('s1', cb));
    expect(mock.state.rows.has('s1')).toBe(false);
    expect(await p(cb => store.get('s1', cb))).toBeNull();
  });

  test('Supabase エラーは callback の err に載る', async () => {
    mock.state.failNext = { message: 'boom' };
    await expect(p(cb => store.get('s1', cb))).rejects.toThrow(/get failed: boom/);
  });

  test('cleanupExpired は失効行を消しキャッシュも掃除する', async () => {
    mock.state.rows.set('old', { sess: {}, expired_at: new Date(Date.now() - 1000).toISOString() });
    mock.state.rows.set('live', { sess: {}, expired_at: new Date(Date.now() + 100000).toISOString() });
    store._cache.set('oldc', { json: '{}', expiredAt: Date.now() - 1, cachedAt: Date.now(), lastTouchWriteAt: 0 });
    await store.cleanupExpired();
    expect(mock.state.rows.has('old')).toBe(false);
    expect(mock.state.rows.has('live')).toBe(true);
    expect(store._cache.has('oldc')).toBe(false);
  });

  test('キャッシュ上限を超えたら古い順に捨てる', async () => {
    store.maxCacheEntries = 2;
    for (const sid of ['a', 'b', 'c']) await p(cb => store.set(sid, sessWithMaxAge(60000), cb));
    expect([...store._cache.keys()]).toEqual(['b', 'c']);
  });

  test('supabase 未指定はエラー', () => {
    expect(() => new SupabaseSessionStore({})).toThrow(/supabase client is required/);
  });
});
