const { isPrivateAddress, isBlockedHostname, assertPublicUrl, safeFetch } = require('../../utils/safe-outbound-url');

describe('isPrivateAddress', () => {
  test.each([
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254',
    '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255',
    '::1', '::', 'fe80::1', 'fd12:3456::1', '::ffff:10.0.0.1', '::ffff:a00:1', '::ffff:7f00:1',
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
