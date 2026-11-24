// lib/supabase-session-store.js のユニットテスト（supabase-js クライアントはモック）
const { SupabaseSessionStore, REVOKED_KEY } = require('../lib/supabase-session-store');

// from(table).select().eq().maybeSingle() / upsert() / update().eq() / delete().eq()|lt() を
// 記録しつつ、あらかじめ仕込んだ結果を返す最小モック。
function makeSupabaseMock() {
  const calls = [];
  const state = { rows: new Map(), failNext: null };
  const result = (data) => ({ data, error: null });
  const chain = (op, payload, opts) => {
    const rec = { op, payload, opts, filters: [], returning: false };
    calls.push(rec);
    const api = {
      eq(col, val) { rec.filters.push(['eq', col, val]); return api; },
      lt(col, val) { rec.filters.push(['lt', col, val]); return api; },
      is(col, val) { rec.filters.push(['is', col, val]); return api; },
      select() { rec.returning = true; return api; },
      maybeSingle() { return api._exec(true); },
      then(onOk, onErr) { return api._exec(false).then(onOk, onErr); },
      _exec(single) {
        if (state.failNext) { const e = state.failNext; state.failNext = null; return Promise.resolve({ data: null, error: e }); }
        if (state.failOn && state.failOn(rec)) return Promise.resolve({ data: null, error: { message: 'boom' } });
        const sidFilter = rec.filters.find(f => f[0] === 'eq' && f[1] === 'sid');
        if (op === 'select') {
          const row = sidFilter ? state.rows.get(sidFilter[2]) : null;
          // 行は呼ばれた時点で読み、応答だけ selectGate まで遅らせられる（DB 待ち中の競合の再現用）
          const res = result(row ? { sess: JSON.parse(JSON.stringify(row.sess)), expired_at: row.expired_at } : null);
          return state.selectGate ? state.selectGate.then(() => res) : Promise.resolve(res);
        }
        // update / upsert は .select() 付きなら書いた行の配列を返す（PostgREST の return=representation 相当）
        const ret = (rows) => Promise.resolve(result(rec.returning ? rows : null));
        if (op === 'upsert') {
          if (opts && opts.ignoreDuplicates && state.rows.has(payload.sid)) return ret([]); // ON CONFLICT DO NOTHING
          state.rows.set(payload.sid, JSON.parse(JSON.stringify(payload)));
          return ret([{ sid: payload.sid }]);
        }
        if (op === 'update') {
          const row = sidFilter && state.rows.get(sidFilter[2]);
          // .is('sess->>key', null) は sess[key] が無い行だけに当たる
          const ok = row && rec.filters.filter(f => f[0] === 'is').every(([, col, val]) => {
            const m = /^sess->>(.+)$/.exec(col);
            return m && val === null ? row.sess == null || row.sess[m[1]] == null : true;
          });
          if (ok) Object.assign(row, JSON.parse(JSON.stringify(payload)));
          return ret(ok ? [{ sid: sidFilter[2] }] : []);
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
        upsert: (payload, opts) => chain('upsert', payload, opts),
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

  test('touch はキャッシュに無い sid でも DB に書く（キャッシュは作らない）', async () => {
    mock.state.rows.set('s2', { sess: { cookie: {} }, expired_at: new Date(Date.now() + 1000).toISOString() });
    await p(cb => store.touch('s2', sessWithMaxAge(60000), cb));
    expect(mock.calls.filter(c => c.op === 'update').length).toBe(1);
    expect(store._cache.has('s2')).toBe(false);
  });

  test('destroy で行は失効の印に置き換わり、キャッシュからも消える（ログアウト後に古いセッションが返らない）', async () => {
    await p(cb => store.set('s1', sessWithMaxAge(60000, { a: 1, passport: { user: 'u1' } }), cb));
    await p(cb => store.destroy('s1', cb));
    const row = mock.state.rows.get('s1');
    expect(row.sess[REVOKED_KEY]).toBe(true);
    expect(row.sess.passport).toBeUndefined();
    expect(await p(cb => store.get('s1', cb))).toBeNull();
    // 否定キャッシュ切れで DB を読み直しても、印の行は「無い」扱い
    store._neg.clear();
    store._cache.clear();
    expect(await p(cb => store.get('s1', cb))).toBeNull();
  });

  test('destroy 後に、logout 前に読み込まれた別リクエストの set が来てもログイン状態は戻らない', async () => {
    const sess = sessWithMaxAge(60000, { passport: { user: 'u1' } });
    await p(cb => store.set('s1', sess, cb));
    const loaded = await p(cb => store.get('s1', cb)); // 別タブのリクエストが読み込み済み
    await p(cb => store.destroy('s1', cb));            // logout
    loaded.flash = 'changed';                          // そのリクエストがセッションを変更して保存
    await p(cb => store.set('s1', loaded, cb));        // エラーにはしない（そのリクエストを 500 にしない）
    expect(mock.state.rows.get('s1').sess[REVOKED_KEY]).toBe(true);
    expect(mock.state.rows.get('s1').sess.passport).toBeUndefined();
    expect(store._cache.has('s1')).toBe(false);
    expect(await p(cb => store.get('s1', cb))).toBeNull();
    store._neg.clear();
    expect(await p(cb => store.get('s1', cb))).toBeNull();
  });

  test('別コンテナで destroy された sid（このプロセスは知らない）への set も DB 側で止まる', async () => {
    mock.state.rows.set('s1', { sess: { [REVOKED_KEY]: true }, expired_at: new Date(Date.now() + 100000).toISOString() });
    await p(cb => store.set('s1', sessWithMaxAge(60000, { passport: { user: 'u1' } }), cb));
    expect(mock.state.rows.get('s1').sess[REVOKED_KEY]).toBe(true);
    expect(store._cache.has('s1')).toBe(false);
    expect(await p(cb => store.get('s1', cb))).toBeNull();
  });

  test('destroy 済みの行は touch でも伸ばさない', async () => {
    const exp = new Date(Date.now() + 100000).toISOString();
    mock.state.rows.set('s1', { sess: { [REVOKED_KEY]: true }, expired_at: exp });
    await p(cb => store.touch('s1', sessWithMaxAge(7 * 24 * 3600 * 1000), cb));
    expect(mock.state.rows.get('s1').expired_at).toBe(exp);
  });

  test('set は既存行を UPDATE し、行が無い新しい sid だけ INSERT する（upsert で上書きしない）', async () => {
    await p(cb => store.set('new', sessWithMaxAge(60000, { v: 1 }), cb));
    expect(mock.calls.filter(c => c.op === 'update').length).toBe(1);
    const ins = mock.calls.filter(c => c.op === 'upsert');
    expect(ins.length).toBe(1);
    expect(ins[0].opts).toEqual({ onConflict: 'sid', ignoreDuplicates: true });
    await p(cb => store.set('new', sessWithMaxAge(60000, { v: 2 }), cb));
    expect(mock.calls.filter(c => c.op === 'upsert').length).toBe(1); // 2 回目は UPDATE だけ
    expect(mock.state.rows.get('new').sess.v).toBe(2);
  });

  test('destroy が DB エラーならエラーを返す（logout を成功扱いにしない）', async () => {
    await p(cb => store.set('s1', sessWithMaxAge(60000, { passport: { user: 'u1' } }), cb));
    mock.state.failNext = { message: 'boom' };
    await expect(p(cb => store.destroy('s1', cb))).rejects.toThrow(/destroy failed: boom/);
    expect(store._cache.has('s1')).toBe(false);
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

  test('キャッシュヒットしたものは後ろへ回る（よく使うセッションほど捨てられにくい）', async () => {
    store.maxCacheEntries = 2;
    await p(cb => store.set('a', sessWithMaxAge(60000), cb));
    await p(cb => store.set('b', sessWithMaxAge(60000), cb));
    await p(cb => store.get('a', cb));
    await p(cb => store.set('c', sessWithMaxAge(60000), cb));
    expect([...store._cache.keys()]).toEqual(['a', 'c']);
  });

  test('DB に無い sid は TTL の間「無し」として覚え、select を繰り返さない', async () => {
    expect(await p(cb => store.get('ghost', cb))).toBeNull();
    expect(await p(cb => store.get('ghost', cb))).toBeNull();
    expect(mock.calls.filter(c => c.op === 'select').length).toBe(1);
    // その後 set されれば普通に返る
    await p(cb => store.set('ghost', sessWithMaxAge(60000, { a: 1 }), cb));
    expect((await p(cb => store.get('ghost', cb))).a).toBe(1);
  });

  test('get の select 待ちの間に destroy されたら、古いセッションをキャッシュに戻さない（logout 直後の競合）', async () => {
    store.cacheTtlMs = 60 * 1000;
    mock.state.rows.set('s1', { sess: { cookie: {}, passport: { user: 'u1' } }, expired_at: new Date(Date.now() + 100000).toISOString() });
    let open;
    mock.state.selectGate = new Promise(r => { open = r; });
    const pending = p(cb => store.get('s1', cb)); // 行は読んだが応答待ち
    await p(cb => store.destroy('s1', cb));        // その間に logout
    mock.state.selectGate = null;
    open();
    const staleSess = await pending;
    expect(store._cache.has('s1')).toBe(false);
    // そのリクエストの終わりに express-session が呼ぶ touch でも、古いセッションをキャッシュに戻さない
    await p(cb => store.touch('s1', staleSess, cb));
    expect(store._cache.has('s1')).toBe(false);
    expect(await p(cb => store.get('s1', cb))).toBeNull();
  });

  test('キャッシュ済みのセッションを destroy した後の touch でも復活しない（別タブの logout）', async () => {
    const sess = sessWithMaxAge(60000, { passport: { user: 'u1' } });
    await p(cb => store.set('s1', sess, cb));
    const loaded = await p(cb => store.get('s1', cb)); // タブ A のリクエストが読み込み済み
    await p(cb => store.destroy('s1', cb));            // タブ B で logout
    store._cache.clear();
    await p(cb => store.touch('s1', loaded, cb));      // タブ A のリクエスト終わり
    expect(store._cache.has('s1')).toBe(false);
    expect(await p(cb => store.get('s1', cb))).toBeNull();
  });

  test('否定キャッシュ中の sid には touch で書かない', async () => {
    expect(await p(cb => store.get('ghost', cb))).toBeNull();
    await p(cb => store.touch('ghost', sessWithMaxAge(60000), cb));
    expect(mock.calls.filter(c => c.op === 'update').length).toBe(0);
    expect(store._cache.has('ghost')).toBe(false);
  });

  test('否定キャッシュは本体キャッシュの枠を使わない', async () => {
    store.maxCacheEntries = 1;
    await p(cb => store.set('live', sessWithMaxAge(60000), cb));
    for (const sid of ['x1', 'x2', 'x3']) await p(cb => store.get(sid, cb));
    expect(store._cache.has('live')).toBe(true);
  });

  test('set が失敗したらキャッシュを消してエラーを返す', async () => {
    await p(cb => store.set('s1', sessWithMaxAge(60000, { v: 1 }), cb));
    mock.state.failNext = { message: 'boom' };
    await expect(p(cb => store.set('s1', sessWithMaxAge(60000, { v: 2 }), cb))).rejects.toThrow(/set failed: boom/);
    expect(store._cache.has('s1')).toBe(false);
  });

  test('get の select 待ちの間に set されたら、set の内容を古い読み取りで上書きしない（再認証直後の競合）', async () => {
    store.cacheTtlMs = 60 * 1000;
    mock.state.rows.set('s1', { sess: { cookie: {}, v: 'old' }, expired_at: new Date(Date.now() + 100000).toISOString() });
    let open;
    mock.state.selectGate = new Promise(r => { open = r; });
    const pending = p(cb => store.get('s1', cb));
    await p(cb => store.set('s1', sessWithMaxAge(60000, { v: 'new' }), cb));
    mock.state.selectGate = null;
    open();
    await pending;
    expect((await p(cb => store.get('s1', cb))).v).toBe('new');
  });

  test('supabase 未指定はエラー', () => {
    expect(() => new SupabaseSessionStore({})).toThrow(/supabase client is required/);
  });
});

// express-session ＋ passport を実際に通した結合テスト（server.js の /auth/logout と同じ書き方）
describe('SupabaseSessionStore × express-session × passport（logout の競合）', () => {
  const express = require('express');
  const session = require('express-session');
  const { Passport } = require('passport');
  let mock, store, server, base, gate, openGate;

  beforeEach(async () => {
    mock = makeSupabaseMock();
    store = new SupabaseSessionStore({ supabase: mock.client, cleanupIntervalMs: 0, cacheTtlMs: 0, logger: { log() {}, warn() {}, error() {} } });
    const passport = new Passport();
    passport.serializeUser((u, done) => done(null, u.id));
    passport.deserializeUser((id, done) => done(null, { id }));
    const app = express();
    app.use(session({ store, secret: 'test', resave: false, saveUninitialized: false, cookie: { maxAge: 60000 } }));
    app.use(passport.initialize());
    app.use(passport.session());
    app.post('/login', (req, res) => req.login({ id: 'u1' }, (err) => (err ? res.status(500).end() : res.json({ ok: true }))));
    app.post('/logout', (req, res) => {
      req.logout((err) => {
        if (err) return res.status(500).json({ error: 'logout failed' });
        res.json({ ok: true });
      });
    });
    // logout の前に読み込まれ、logout の後でセッションを書き換えて保存するリクエスト
    app.get('/slow', async (req, res) => {
      await gate;
      req.session.touched_by_slow = Date.now();
      res.json({ user: req.user ? req.user.id : null });
    });
    app.get('/me', (req, res) => res.json({ user: req.user ? req.user.id : null }));
    gate = new Promise((r) => { openGate = r; });
    await new Promise((r) => { server = app.listen(0, r); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterEach(async () => {
    store.close();
    await new Promise((r) => server.close(r));
  });

  const login = async () => {
    const res = await fetch(`${base}/login`, { method: 'POST' });
    expect(res.status).toBe(200);
    return res.headers.get('set-cookie').split(';')[0];
  };

  test('logout と並んだ別リクエストの保存で、ログイン状態が書き戻されない', async () => {
    const cookie = await login();
    expect((await (await fetch(`${base}/me`, { headers: { cookie } })).json()).user).toBe('u1');
    const slow = fetch(`${base}/slow`, { headers: { cookie } }); // ログイン中として読み込まれ、gate で待つ
    await new Promise((r) => setTimeout(r, 50));
    const out = await fetch(`${base}/logout`, { method: 'POST', headers: { cookie } });
    expect(out.status).toBe(200);
    openGate();
    expect((await (await slow).json()).user).toBe('u1'); // そのリクエスト自体は読み込み時点の状態
    // 古い Cookie のままでも、もうログインしていない
    expect((await (await fetch(`${base}/me`, { headers: { cookie } })).json()).user).toBeNull();
    for (const row of mock.state.rows.values()) expect(row.sess.passport && row.sess.passport.user).toBeFalsy();
  });

  test('保存先で失効に失敗したら logout はエラーを返す', async () => {
    const cookie = await login();
    // destroy（失効の印の upsert）だけを失敗させる
    mock.state.failOn = (rec) => rec.op === 'upsert' && rec.payload && rec.payload.sess && rec.payload.sess[REVOKED_KEY];
    const out = await fetch(`${base}/logout`, { method: 'POST', headers: { cookie } });
    expect(out.status).toBe(500);
  });

  test('ログインは新しい sid を発行し、ログイン前の sid は失効の印になる', async () => {
    // ログイン前にセッションを保存しておく（Google ログインの nonce 保存と同じ）
    const app2Cookie = await login();
    const sid1 = [...mock.state.rows.entries()].find(([, r]) => r.sess.passport)[0];
    const res = await fetch(`${base}/login`, { method: 'POST', headers: { cookie: app2Cookie } });
    const cookie2 = res.headers.get('set-cookie').split(';')[0];
    expect(cookie2).not.toBe(app2Cookie);
    expect(mock.state.rows.get(sid1).sess[REVOKED_KEY]).toBe(true);
    expect((await (await fetch(`${base}/me`, { headers: { cookie: cookie2 } })).json()).user).toBe('u1');
    expect((await (await fetch(`${base}/me`, { headers: { cookie: app2Cookie } })).json()).user).toBeNull();
  });
});
