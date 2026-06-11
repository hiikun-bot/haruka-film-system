// tests/utils/ttl-cache.test.js
// utils/ttl-cache.js（マスタ系 GET 用の汎用 in-memory TTL キャッシュ）のユニットテスト。

const {
  ttlCache,
  invalidateByKey,
  invalidateByPrefix,
  invalidateAll,
} = require('../../utils/ttl-cache');

beforeEach(() => {
  invalidateAll();
  jest.useRealTimers();
});

describe('ttlCache', () => {
  test('TTL 内は loader を再実行せずキャッシュ値を返す', async () => {
    const loader = jest.fn().mockResolvedValue([1, 2, 3]);
    const a = await ttlCache('k1', 1000, loader);
    const b = await ttlCache('k1', 1000, loader);
    expect(a).toEqual([1, 2, 3]);
    expect(b).toBe(a); // 同一参照
    expect(loader).toHaveBeenCalledTimes(1);
  });

  test('TTL 経過後は loader を再実行する', async () => {
    jest.useFakeTimers();
    const loader = jest.fn()
      .mockResolvedValueOnce('v1')
      .mockResolvedValueOnce('v2');
    expect(await ttlCache('k2', 1000, loader)).toBe('v1');
    jest.advanceTimersByTime(1001);
    expect(await ttlCache('k2', 1000, loader)).toBe('v2');
    expect(loader).toHaveBeenCalledTimes(2);
  });

  test('loader が throw した場合はキャッシュせず伝播する', async () => {
    const failing = jest.fn().mockRejectedValue(new Error('db down'));
    await expect(ttlCache('k3', 1000, failing)).rejects.toThrow('db down');
    // 失敗はキャッシュされないので、次の呼び出しで loader が再実行される
    const ok = jest.fn().mockResolvedValue('recovered');
    expect(await ttlCache('k3', 1000, ok)).toBe('recovered');
    expect(ok).toHaveBeenCalledTimes(1);
  });

  test('キーが異なれば別キャッシュになる', async () => {
    expect(await ttlCache('list:a', 1000, async () => 'A')).toBe('A');
    expect(await ttlCache('list:b', 1000, async () => 'B')).toBe('B');
  });
});

describe('invalidate', () => {
  test('invalidateByKey は完全一致キーのみ破棄する', async () => {
    await ttlCache('teams:list', 1000, async () => 'teams-v1');
    await ttlCache('categories:active', 1000, async () => 'cats-v1');
    invalidateByKey('teams:list');
    expect(await ttlCache('teams:list', 1000, async () => 'teams-v2')).toBe('teams-v2');
    expect(await ttlCache('categories:active', 1000, async () => 'cats-v2')).toBe('cats-v1'); // 残っている
  });

  test('invalidateByPrefix は前方一致の全キーを破棄する', async () => {
    await ttlCache('master-items:all:', 1000, async () => 1);
    await ttlCache('master-items:active:x:', 1000, async () => 2);
    await ttlCache('master-categories:list', 1000, async () => 3);
    invalidateByPrefix('master-items:');
    expect(await ttlCache('master-items:all:', 1000, async () => 10)).toBe(10);
    expect(await ttlCache('master-items:active:x:', 1000, async () => 20)).toBe(20);
    expect(await ttlCache('master-categories:list', 1000, async () => 30)).toBe(3); // 残っている
  });

  test('invalidateAll は全キーを破棄する', async () => {
    await ttlCache('a', 1000, async () => 1);
    await ttlCache('b', 1000, async () => 2);
    invalidateAll();
    expect(await ttlCache('a', 1000, async () => 10)).toBe(10);
    expect(await ttlCache('b', 1000, async () => 20)).toBe(20);
  });
});
