const { normalizeDriveFolderUrl, safeDriveFolderHref } = require('../utils/drive-folder-url');

describe('normalizeDriveFolderUrl', () => {
  test('空は null として通す', () => {
    expect(normalizeDriveFolderUrl(null)).toEqual({ ok: true, value: null });
    expect(normalizeDriveFolderUrl(undefined)).toEqual({ ok: true, value: null });
    expect(normalizeDriveFolderUrl('   ')).toEqual({ ok: true, value: null });
  });

  test('Google ドライブのフォルダURLは通す（前後の空白は落とす）', () => {
    const url = 'https://drive.google.com/drive/folders/1AbCdEf?usp=sharing';
    expect(normalizeDriveFolderUrl(`  ${url}  `)).toEqual({ ok: true, value: url });
    expect(normalizeDriveFolderUrl('https://drive.google.com/drive/u/0/folders/1x').ok).toBe(true);
    expect(normalizeDriveFolderUrl('https://drive.google.com/open?id=1x').ok).toBe(true);
  });

  test('http は https に直す・ホストの大文字は許す', () => {
    expect(normalizeDriveFolderUrl('http://Drive.Google.com/drive/folders/1x'))
      .toEqual({ ok: true, value: 'https://drive.google.com/drive/folders/1x' });
  });

  test.each([
    'javascript:alert(1)',
    'JavaScript:alert(1)//drive.google.com',
    'data:text/html,<script>alert(1)</script>',
    'https://evil.example.com/drive.google.com',
    'https://drive.google.com.evil.example.com/x',
    'https://user:pass@drive.google.com/x',
    'https://drive.google.com:8443/x',
    'https://docs.google.com/spreadsheets/d/1x',
    'drive.google.com/drive/folders/1x',
    'https://drive.google.com/drive/folders/1x https://drive.google.com/drive/folders/2y',
    'https://drive.google.com/a\nb',
    ['https://drive.google.com/x'],
    123,
  ])('弾く: %p', (v) => {
    const r = normalizeDriveFolderUrl(v);
    expect(r.ok).toBe(false);
    expect(typeof r.error).toBe('string');
  });

  test('長すぎる値は弾く', () => {
    const r = normalizeDriveFolderUrl('https://drive.google.com/' + 'a'.repeat(2100));
    expect(r.ok).toBe(false);
  });
});

describe('safeDriveFolderHref', () => {
  test('正しい値だけリンクにする', () => {
    expect(safeDriveFolderHref('https://drive.google.com/drive/folders/1x')).toBe('https://drive.google.com/drive/folders/1x');
    expect(safeDriveFolderHref('javascript:alert(1)')).toBeNull();
    expect(safeDriveFolderHref('')).toBeNull();
    expect(safeDriveFolderHref(null)).toBeNull();
  });
});
