const S = require('../../utils/safe-image');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(8)]);
const JPEG = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xDB]), Buffer.alloc(12)]);
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(10)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
const du = (mime, buf) => `data:${mime};base64,${buf.toString('base64')}`;

describe('sniffImageMime', () => {
  test.each([[PNG, 'image/png'], [JPEG, 'image/jpeg'], [GIF, 'image/gif'], [WEBP, 'image/webp']])('%#', (buf, mime) => {
    expect(S.sniffImageMime(buf)).toBe(mime);
  });
  test('SVG / HTML / 短すぎ / 空は null', () => {
    expect(S.sniffImageMime(SVG)).toBeNull();
    expect(S.sniffImageMime(Buffer.from('<html><body>xxxxxxxx</body></html>'))).toBeNull();
    expect(S.sniffImageMime(Buffer.from([0x89, 0x50]))).toBeNull();
    expect(S.sniffImageMime(null)).toBeNull();
  });
  test('RIFF でも WEBP でなければ null（WAV など）', () => {
    expect(S.sniffImageMime(Buffer.from('RIFF0000WAVEfmt '))).toBeNull();
  });
});

describe('parseImageDataUrl', () => {
  test('申告と中身が違えば中身の種類で組み立て直す', () => {
    const r = S.parseImageDataUrl(du('image/svg+xml', PNG));
    expect(r.mime).toBe('image/png');
    expect(r.dataUrl).toBe(du('image/png', PNG));
  });
  test('中身が SVG なら null', () => {
    expect(S.parseImageDataUrl(du('image/png', SVG))).toBeNull();
  });
  test('base64 以外・余計な文字（引用符など）は null', () => {
    expect(S.parseImageDataUrl(`data:image/png;base64,${PNG.toString('base64')}" onerror="x`)).toBeNull();
    expect(S.parseImageDataUrl('data:image/png,abc')).toBeNull();
    expect(S.parseImageDataUrl('https://example.com/a.png')).toBeNull();
    expect(S.parseImageDataUrl(123)).toBeNull();
  });
  test('パラメータ付きの data URL も読める', () => {
    expect(S.parseImageDataUrl(`data:image/jpeg;name=a.jpg;base64,${JPEG.toString('base64')}`).mime).toBe('image/jpeg');
  });
  test('maxBytes を超えたら null', () => {
    expect(S.parseImageDataUrl(du('image/png', PNG), { maxBytes: 4 })).toBeNull();
  });
});

describe('imageBufferToDataUrl', () => {
  test('中身で判定', () => {
    expect(S.imageBufferToDataUrl(GIF)).toEqual({ mime: 'image/gif', dataUrl: du('image/gif', GIF) });
    expect(S.imageBufferToDataUrl(SVG)).toBeNull();
  });
});

describe('safeProxyContentType', () => {
  test.each([
    ['video/mp4', 'video/mp4'], ['video/quicktime', 'video/quicktime'], ['audio/mpeg', 'audio/mpeg'],
    ['image/png', 'image/png'], ['image/svg+xml', 'image/svg+xml'], ['application/pdf', 'application/pdf'],
    ['text/html', 'application/octet-stream'], ['application/xhtml+xml', 'application/octet-stream'],
    ['text/xml', 'application/octet-stream'], ['application/javascript', 'application/octet-stream'],
    ['', 'application/octet-stream'], [null, 'application/octet-stream'], ['Video/MP4; codecs=x', 'video/mp4'],
  ])('%s → %s', (inp, out) => expect(S.safeProxyContentType(inp)).toBe(out));
});

describe('applyProxySafetyHeaders', () => {
  const fakeRes = () => {
    const h = {};
    return { h, setHeader: (k, v) => { h[k.toLowerCase()] = v; }, getHeader: (k) => h[k.toLowerCase()] };
  };
  test('HTML は attachment + sandbox', () => {
    const res = fakeRes();
    expect(S.applyProxySafetyHeaders(res, 'text/html')).toBe('application/octet-stream');
    expect(res.h['content-disposition']).toBe('attachment');
    expect(res.h['content-security-policy']).toBe('sandbox');
    expect(res.h['x-content-type-options']).toBe('nosniff');
  });
  test('既存の Content-Disposition は上書きしない', () => {
    const res = fakeRes();
    res.setHeader('Content-Disposition', 'attachment; filename="a.zip"');
    S.applyProxySafetyHeaders(res, 'application/zip');
    expect(res.h['content-disposition']).toBe('attachment; filename="a.zip"');
  });
  test('PDF は CSP を付けない（ビューアが開けなくなるため）', () => {
    const res = fakeRes();
    S.applyProxySafetyHeaders(res, 'application/pdf');
    expect(res.h['content-security-policy']).toBeUndefined();
  });
});

test('setSafeImageHeaders は許可リスト外を拒む', () => {
  expect(() => S.setSafeImageHeaders({ setHeader() {} }, 'image/svg+xml')).toThrow();
});
