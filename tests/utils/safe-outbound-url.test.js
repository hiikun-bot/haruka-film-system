const { isPrivateAddress, isBlockedHostname, assertPublicUrl, safeFetch } = require('../../utils/safe-outbound-url');

describe('isPrivateAddress', () => {
  test.each([
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254',
    '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255',
    '::1', '::', 'fe80::1', 'fd12:3456::1', '::ffff:10.0.0.1', '::ffff:a00:1', '::ffff:7f00:1',
    '::127.0.0.1', '::a9fe:a9fe', '::ffff:0:a9fe:a9fe',
    'not-an-ip',
  ])('%s は外に出ないアドレス', (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });
  test.each(['8.8.8.8', '142.250.196.110', '172.32.0.1', '2404:6800:4004:80a::200e'])('%s は外部のアドレス', (ip) => {
    expect(isPrivateAddress(ip)).toBe(false);
  });
});

describe('isBlockedHostname', () => {
  test.each(['localhost', 'foo.localhost', 'printer.local', 'api.railway.internal', 'metadata.google.internal', 'intranet', ''])('%s は断る', (h) => {
    expect(isBlockedHostname(h)).toBe(true);
  });
  test.each(['example.com', 'www.youtube.com', 'sub.example.co.jp'])('%s は通す', (h) => {
    expect(isBlockedHostname(h)).toBe(false);
  });
});

describe('assertPublicUrl', () => {
  const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
  test('外部の https は通す', async () => {
    await expect(assertPublicUrl('https://example.com/a', { lookup: publicLookup })).resolves.toBeInstanceOf(URL);
  });
  test('名前解決の結果が社内アドレスなら断る（1 つでも混ざっていたら）', async () => {
    const lookup = async () => [{ address: '93.184.216.34' }, { address: '10.0.0.5' }];
    await expect(assertPublicUrl('https://evil.example.com/', { lookup })).rejects.toMatchObject({ code: 'blocked_url' });
  });
  test.each([
    'http://127.0.0.1/', 'http://[::1]/', 'http://169.254.169.254/latest/meta-data/', 'http://2130706433/',
    'http://0x7f.1/', 'ftp://example.com/', 'file:///etc/passwd', 'http://user:pw@example.com/',
    'http://example.com:22/', 'http://localhost:8080/', 'not a url',
  ])('%s は断る', async (url) => {
    await expect(assertPublicUrl(url, { lookup: publicLookup })).rejects.toMatchObject({ code: 'blocked_url' });
  });
  test('名前解決できなければ断る', async () => {
    const lookup = async () => { throw new Error('ENOTFOUND'); };
    await expect(assertPublicUrl('https://nope.example.com/', { lookup })).rejects.toMatchObject({ code: 'blocked_url' });
  });
});

describe('safeFetch', () => {
  const lookup = async (host) => [{ address: host === 'internal.example.com' ? '10.0.0.9' : '93.184.216.34' }];
  const resp = (status, headers = {}) => ({ status, headers: { get: (k) => headers[k.toLowerCase()] || null }, body: null });
  test('リダイレクトを手で追い、行き先が社内なら断る', async () => {
    const fetchImpl = jest.fn(async (url) => {
      if (url.startsWith('https://example.com/')) return resp(302, { location: 'https://internal.example.com/admin' });
      return resp(200);
    });
    await expect(safeFetch('https://example.com/', {}, { lookup, fetchImpl })).rejects.toMatchObject({ code: 'blocked_url' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][1].redirect).toBe('manual');
  });
  test('外部同士のリダイレクトは追う（相対 Location も）', async () => {
    const fetchImpl = jest.fn(async (url) => (url === 'https://example.com/a' ? resp(301, { location: '/b' }) : resp(200)));
    const r = await safeFetch('https://example.com/a', {}, { lookup, fetchImpl });
    expect(r.status).toBe(200);
    expect(fetchImpl.mock.calls[1][0]).toBe('https://example.com/b');
  });
  test('リダイレクトが多すぎたら断る', async () => {
    const fetchImpl = jest.fn(async () => resp(302, { location: 'https://example.com/loop' }));
    await expect(safeFetch('https://example.com/', {}, { lookup, fetchImpl, maxRedirects: 2 })).rejects.toMatchObject({ code: 'blocked_url' });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});

// DNS rebinding 対策（#1198 レビュー対応）: 事前判定のあとに DNS の答えが内部アドレスへ変わっても、
// 実際の接続に使う名前解決（lookup）で止まること
describe('createSafeLookup（接続時の名前解決）', () => {
  const { createSafeLookup } = require('../../utils/safe-outbound-url');
  const call = (lookup, host, opts) => new Promise((resolve) => {
    lookup(host, opts, (err, address, family) => resolve({ err, address, family }));
  });
  test('外部アドレスだけなら通す（all:true / 1 件の両方）', async () => {
    const lookup = createSafeLookup(async () => [{ address: '93.184.216.34', family: 4 }, { address: '2606:2800:220:1::1', family: 6 }]);
    const all = await call(lookup, 'example.com', { all: true });
    expect(all.err).toBeNull();
    expect(all.address).toEqual([{ address: '93.184.216.34', family: 4 }, { address: '2606:2800:220:1::1', family: 6 }]);
    const one = await call(lookup, 'example.com', {});
    expect(one).toMatchObject({ err: null, address: '93.184.216.34', family: 4 });
    const v6 = await call(lookup, 'example.com', 6);
    expect(v6).toMatchObject({ err: null, address: '2606:2800:220:1::1', family: 6 });
  });
  test.each(['10.0.0.5', '127.0.0.1', '169.254.169.254', '::1', '::ffff:10.0.0.1'])('接続先が %s なら断る', async (ip) => {
    const lookup = createSafeLookup(async () => [{ address: '93.184.216.34', family: 4 }, { address: ip, family: ip.includes(':') ? 6 : 4 }]);
    const r = await call(lookup, 'rebind.example.com', { all: true });
    expect(r.err).toMatchObject({ code: 'blocked_url' });
  });
  test('名前解決できなければ断る', async () => {
    const lookup = createSafeLookup(async () => { throw new Error('ENOTFOUND'); });
    expect((await call(lookup, 'nope.example.com', {})).err).toMatchObject({ code: 'blocked_url' });
  });
});

describe('pinnedFetch / safeFetch（実際の接続）', () => {
  const http = require('http');
  const zlib = require('zlib');
  const { createSafeLookup, pinnedFetch } = require('../../utils/safe-outbound-url');
  let server; let port; let hits = 0; let closedSockets = 0;
  const { discardBody } = require('../../utils/safe-outbound-url');
  const waitFor = async (cond, ms = 2000) => {
    const end = Date.now() + ms;
    while (!cond() && Date.now() < end) await new Promise(r => setTimeout(r, 20));
    return cond();
  };
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      hits += 1;
      if (req.url === '/gz') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-encoding': 'gzip' });
        res.end(zlib.gzipSync('<title>圧縮</title>'));
        return;
      }
      if (req.url === '/redirect') { res.writeHead(302, { location: '/plain' }); res.end(); return; }
      if (req.url === '/empty-gz') { res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' }); res.end(); return; }
      if (req.url === '/endless-gz') {
        // 延々と続く gzip 本文（読む側が途中でやめたらソケットが閉じるか）
        res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
        const gz = zlib.createGzip({ flush: zlib.constants.Z_SYNC_FLUSH });
        gz.pipe(res);
        const timer = setInterval(() => gz.write('x'.repeat(1024)), 5);
        req.socket.on('close', () => { clearInterval(timer); closedSockets += 1; });
        return;
      }
      if (req.url === '/endless-404') {
        res.writeHead(404, { 'content-type': 'text/html' });
        const timer = setInterval(() => res.write('x'), 5);
        req.socket.on('close', () => { clearInterval(timer); closedSockets += 1; });
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<title>ok</title>');
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    port = server.address().port;
  });
  afterAll(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }));
  // テストでは 127.0.0.1 のローカルサーバーへ繋ぐため、許可する lookup を渡す
  const allowLocal = (host, opts, cb) => (opts && opts.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4));

  test('Response 形で返し、本文を読める（gzip も展開する）', async () => {
    const r = await pinnedFetch(`http://site.test:${port}/gz`, { headers: { 'User-Agent': 'jest' } }, { lookup: allowLocal });
    expect(r.ok).toBe(true);
    expect(r.headers.get('content-type')).toContain('text/html');
    expect(await r.text()).toBe('<title>圧縮</title>');
  });
  test('リダイレクトは追わずにそのまま返す（safeFetch が行き先を確かめて追う）', async () => {
    const r = await pinnedFetch(`http://site.test:${port}/redirect`, {}, { lookup: allowLocal });
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('/plain');
  });
  test('接続時の名前解決が内部アドレスなら、リクエストを送らずに断る', async () => {
    const before = hits;
    const lookup = createSafeLookup(async () => [{ address: '127.0.0.1', family: 4 }]);
    await expect(pinnedFetch(`http://site.test:${port}/plain`, {}, { lookup })).rejects.toMatchObject({ code: 'blocked_url' });
    expect(hits).toBe(before);
  });
  test('空の gzip 本文でもエラーにしない', async () => {
    const r = await pinnedFetch(`http://site.test:${port}/empty-gz`, {}, { lookup: allowLocal });
    expect(await r.text()).toBe('');
  });
  test('圧縮本文を途中で cancel したらソケットを閉じる', async () => {
    const before = closedSockets;
    const r = await pinnedFetch(`http://site.test:${port}/endless-gz`, {}, { lookup: allowLocal });
    const reader = r.body.getReader();
    await reader.read();
    await reader.cancel();
    expect(await waitFor(() => closedSockets > before)).toBe(true);
  });
  test('読まずに捨てた応答（404）も discardBody でソケットを閉じる', async () => {
    const before = closedSockets;
    const r = await pinnedFetch(`http://site.test:${port}/endless-404`, {}, { lookup: allowLocal });
    expect(r.status).toBe(404);
    discardBody(r);
    expect(await waitFor(() => closedSockets > before)).toBe(true);
  });
  test('読まれないまま放っておかれても寿命タイマーで閉じる', async () => {
    const before = closedSockets;
    const r = await pinnedFetch(`http://site.test:${port}/endless-404`, {}, { lookup: allowLocal, maxLifetimeMs: 100 });
    expect(r.status).toBe(404);
    expect(await waitFor(() => closedSockets > before)).toBe(true);
  });
  test('GET 以外は送らない', async () => {
    await expect(pinnedFetch(`http://site.test:${port}/plain`, { method: 'POST', body: 'x' }, { lookup: allowLocal })).rejects.toThrow('GET');
  });
  test('safeFetch: 事前判定は外部でも、接続時に内部へ変わったら断る（DNS rebinding）', async () => {
    const precheck = async () => [{ address: '93.184.216.34', family: 4 }];
    const connectLookup = createSafeLookup(async () => [{ address: '10.0.0.5', family: 4 }]);
    await expect(safeFetch('https://rebind.example.com/', {}, { lookup: precheck, connectLookup })).rejects.toMatchObject({ code: 'blocked_url' });
  });
});
