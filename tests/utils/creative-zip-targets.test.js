const { fetchAllRows, pickLatestFileByCreative, summarizeZipTargets } = require('../../utils/creative-zip-targets');

describe('fetchAllRows', () => {
  test('1000 行で切らず、最後のページまで取る', async () => {
    const all = Array.from({ length: 2345 }, (_, i) => ({ id: i }));
    const calls = [];
    const rows = await fetchAllRows(async (from, to) => {
      calls.push([from, to]);
      return { data: all.slice(from, to + 1), error: null };
    });
    expect(rows).toHaveLength(2345);
    expect(calls).toEqual([[0, 999], [1000, 1999], [2000, 2999], [2345, 3344]]);
  });
  test('サーバーの上限が 1000 より小さくても（500 行ずつしか返さない）最後まで取る', async () => {
    const all = Array.from({ length: 1200 }, (_, i) => ({ id: i }));
    const rows = await fetchAllRows(async (from, to) => ({ data: all.slice(from, Math.min(to + 1, from + 500)), error: null }));
    expect(rows.map(r => r.id)).toEqual(all.map(r => r.id));
  });
  test('エラーは投げる（途中までの結果で ZIP を作らない）', async () => {
    await expect(fetchAllRows(async (from) => (from === 0
      ? { data: Array.from({ length: 1000 }, () => ({})), error: null }
      : { data: null, error: { message: 'timeout' } }))).rejects.toThrow('timeout');
  });
});

describe('pickLatestFileByCreative', () => {
  test('version 最大 → uploaded_at 新しい順に最新版を選ぶ（並び順に依らない）', () => {
    const files = [
      { id: 'a', creative_id: 'c1', drive_file_id: 'd1', version: 3, uploaded_at: '2026-11-01T00:00:00Z' },
      { id: 'b', creative_id: 'c1', drive_file_id: 'd2', version: 5, uploaded_at: '2026-10-01T00:00:00Z' },
      { id: 'c', creative_id: 'c1', drive_file_id: 'd3', version: 5, uploaded_at: '2026-10-02T00:00:00Z' },
      { id: 'd', creative_id: 'c2', drive_file_id: 'd4', version: 1, uploaded_at: null },
      { id: 'e', creative_id: 'c2', drive_file_id: null, version: 9 },
    ];
    const m1 = pickLatestFileByCreative(files);
    const m2 = pickLatestFileByCreative([...files].reverse());
    expect(m1.get('c1').id).toBe('c');
    expect(m2.get('c1').id).toBe('c');
    expect(m1.get('c2').id).toBe('d');
  });
});

describe('summarizeZipTargets', () => {
  const GB = 1024 * 1024 * 1024;
  test('容量が分からないファイルがあれば止める（0 と数えない）', () => {
    const s = summarizeZipTargets([
      { file_size: 100, downloadName: 'a.mp4' },
      { size_unknown: true, downloadName: 'b.mp4' },
      { file_size: null, downloadName: 'c.mp4' },
    ], { creatives: 4, maxBytes: GB });
    expect(s).toMatchObject({ files: 3, without_file: 1, total_bytes: 100, unreadable: 2, blocked: true });
    expect(s.unreadable_names).toEqual(['b.mp4', 'c.mp4']);
  });
  test('Drive で確かめた 0 バイト（Google ドキュメント等）は止めない', () => {
    expect(summarizeZipTargets([{ file_size: 0 }, { file_size: 5 }], { creatives: 2, maxBytes: GB })).toMatchObject({ blocked: false, total_bytes: 5 });
  });
  test('全部分かっていて 1GB 以下なら通す・超えたら too_large', () => {
    expect(summarizeZipTargets([{ file_size: 10 }], { creatives: 1, maxBytes: GB })).toMatchObject({ blocked: false, too_large: false });
    expect(summarizeZipTargets([{ file_size: GB }, { file_size: 1 }], { creatives: 2, maxBytes: GB }).too_large).toBe(true);
  });
});

describe('lookupDriveSize', () => {
  const { lookupDriveSize } = require('../../utils/creative-zip-targets');
  const sleep = async () => {};
  test('レート制限・5xx は取り直す', async () => {
    let n = 0;
    const r = await lookupDriveSize(async () => {
      n += 1;
      if (n === 1) { const e = new Error('rate'); e.code = 403; e.errors = [{ reason: 'userRateLimitExceeded' }]; throw e; }
      if (n === 2) { const e = new Error('oops'); e.code = 503; throw e; }
      return { data: { size: '123' } };
    }, { sleep });
    expect(r).toEqual({ known: true, size: 123 });
    expect(n).toBe(3);
  });
  test('404 は取り直さず容量不明', async () => {
    let n = 0;
    const r = await lookupDriveSize(async () => { n += 1; const e = new Error('nf'); e.code = 404; throw e; }, { sleep });
    expect(r).toEqual({ known: false });
    expect(n).toBe(1);
  });
  test('size が無い（Google ドキュメント等）は 0 として分かっている扱い', async () => {
    expect(await lookupDriveSize(async () => ({ data: {} }), { sleep })).toEqual({ known: true, size: 0 });
  });
});
