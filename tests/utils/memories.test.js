const M = require('../../utils/memories');

describe('classifyMemoryFile', () => {
  test('mime で判定', () => {
    expect(M.classifyMemoryFile('a.bin', 'image/jpeg')).toBe('image');
    expect(M.classifyMemoryFile('a.bin', 'video/quicktime')).toBe('video');
  });
  test('mime が空でも拡張子で判定（iPhone の HEIC / MOV）', () => {
    expect(M.classifyMemoryFile('IMG_0001.HEIC', '')).toBe('image');
    expect(M.classifyMemoryFile('IMG_0002.MOV', 'application/octet-stream')).toBe('video');
  });
  test('写真・動画以外は null', () => {
    expect(M.classifyMemoryFile('memo.pdf', 'application/pdf')).toBeNull();
    expect(M.classifyMemoryFile('noext', '')).toBeNull();
  });
});

describe('sanitizeMemoryFileName', () => {
  test('元の名前はそのまま', () => {
    expect(M.sanitizeMemoryFileName('IMG_1234.JPG')).toBe('IMG_1234.JPG');
    expect(M.sanitizeMemoryFileName('淡路島 夕日.mov')).toBe('淡路島 夕日.mov');
  });
  test('制御文字・前後空白を落とし、空なら untitled', () => {
    expect(M.sanitizeMemoryFileName('  a\u0000b.jpg ')).toBe('ab.jpg');
    expect(M.sanitizeMemoryFileName('   ')).toBe('untitled');
  });
  test('長すぎる名前は拡張子を残して切る', () => {
    const out = M.sanitizeMemoryFileName('x'.repeat(300) + '.mp4');
    expect(out.endsWith('.mp4')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(200);
  });
});

describe('normalizeAlbumName', () => {
  test('空白を整えて 60 文字まで', () => {
    expect(M.normalizeAlbumName('  淡路島   合宿 ')).toBe('淡路島 合宿');
    expect(M.normalizeAlbumName('a'.repeat(80))).toHaveLength(60);
    expect(M.normalizeAlbumName('  ')).toBeNull();
  });
});

describe('撮影日時', () => {
  test('EXIF 時刻は JST とみなす', () => {
    expect(M.parseExifTime('2026:10:24 15:30:12')).toBe('2026-10-24T06:30:12.000Z');
    expect(M.parseExifTime('0000:00:00 00:00:00')).toBeNull();
    expect(M.parseExifTime('')).toBeNull();
  });
  test('lastModified はありえない値を捨てる', () => {
    const now = Date.UTC(2026, 9, 26);
    expect(M.lastModifiedToIso(Date.UTC(2026, 9, 24, 6), now)).toBe('2026-10-24T06:00:00.000Z');
    expect(M.lastModifiedToIso(0, now)).toBeNull();
    expect(M.lastModifiedToIso(Date.UTC(1999, 0, 1), now)).toBeNull();
    expect(M.lastModifiedToIso(now + 3 * 86400000, now)).toBeNull();
  });
  test('優先順位: EXIF → hfs_taken_at → createdTime', () => {
    const base = { createdTime: '2026-10-26T01:00:00.000Z' };
    expect(M.takenAtOf(base)).toBe('2026-10-26T01:00:00.000Z');
    expect(M.takenAtOf({ ...base, appProperties: { hfs_taken_at: '2026-10-25T01:00:00.000Z' } })).toBe('2026-10-25T01:00:00.000Z');
    expect(M.takenAtOf({ ...base, appProperties: { hfs_taken_at: '2026-10-25T01:00:00.000Z' }, imageMediaMetadata: { time: '2026:10:24 09:00:00' } }))
      .toBe('2026-10-24T00:00:00.000Z');
  });
  test('日付キーは JST（UTC 23時台は翌日）', () => {
    expect(M.jstDateKey('2026-10-24T15:30:00.000Z')).toBe('2026-10-25');
    expect(M.jstDateKey('2026-10-24T14:59:00.000Z')).toBe('2026-10-24');
    expect(M.jstDateKey(null)).toBe('');
  });
});

describe('toMemoryItem / sort / summarize', () => {
  const folders = new Map([
    ['f1', { uploader_id: 'u1', uploader_name: 'さとる' }],
    ['f2', { uploader_id: null, uploader_name: 'Driveから直接' }],
  ]);
  const raw = [
    { id: 'a', name: 'IMG_1.JPG', mimeType: 'image/jpeg', size: '100', createdTime: '2026-10-26T00:00:00Z', parents: ['f1'], thumbnailLink: 'https://x', appProperties: { hfs_uploader_id: 'u1' }, imageMediaMetadata: { time: '2026:10:24 10:00:00' } },
    { id: 'b', name: 'IMG_2.MOV', mimeType: 'video/quicktime', size: '2000', createdTime: '2026-10-26T00:00:00Z', parents: ['f2'], videoMediaMetadata: { durationMillis: '32000' } },
    { id: 'c', name: 'note.txt', mimeType: 'text/plain', parents: ['f1'] },
  ];
  const items = raw.map((f) => M.toMemoryItem(f, folders)).filter(Boolean);

  test('写真・動画だけを変換し、投稿者はフォルダから補う', () => {
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ id: 'a', kind: 'image', size: 100, uploader_id: 'u1', uploader_name: 'さとる', has_thumb: true, date_key: '2026-10-24' });
    expect(items[1]).toMatchObject({ id: 'b', kind: 'video', duration_ms: 32000, uploader_id: null, uploader_name: 'Driveから直接', has_thumb: false });
  });
  test('撮影日時の新しい順', () => {
    expect(M.sortMemoryItems(items).map((i) => i.id)).toEqual(['b', 'a']);
  });
  test('投稿者ごとの件数', () => {
    const s = M.summarizeUploaders([...items, { ...items[0], id: 'a2' }]);
    expect(s[0]).toMatchObject({ folder_id: 'f1', uploader_name: 'さとる', count: 2 });
    expect(s[1]).toMatchObject({ folder_id: 'f2', count: 1 });
  });
});
