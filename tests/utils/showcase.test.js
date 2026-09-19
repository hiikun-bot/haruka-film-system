// tests/utils/showcase.test.js
// 🎬 新着納品ショーケース（utils/showcase.js・ADR 042 追補）の純関数テスト。
// - JST の日付境界（起点・納品日）
// - 同一案件 × 同一納品日（JST）で 4 本以上ならまとめスライド
// - 並び（新しい納品が先）・制作担当の重複排除・通知文面
// DB 非依存。TZ=UTC / TZ=Asia/Tokyo の両方で同結果になること。

const S = require('../../utils/showcase');

const cr = (over = {}) => ({
  creative_id: over.id || 'c1',
  project_id: 'project_id' in over ? over.project_id : 'p1',
  project_name: over.project_name || '案件A',
  client_name: over.client_name || 'クラA',
  delivered_at: over.delivered_at || '2026-09-16T03:00:00Z',
  creators: over.creators || [{ id: 'u1', nickname: 'ぴょん' }],
});

describe('utils/showcase 日付（JST 固定）', () => {
  test('jstDateStr: UTC 15:00 は JST 翌日', () => {
    expect(S.jstDateStr('2026-09-16T14:59:59Z')).toBe('2026-09-16');
    expect(S.jstDateStr('2026-09-16T15:00:00Z')).toBe('2026-09-17');
    expect(S.jstDateStr('2026-09-16T12:00:00+09:00')).toBe('2026-09-16');
    expect(S.jstDateStr(null)).toBeNull();
    expect(S.jstDateStr('not-a-date')).toBeNull();
  });

  test('showcaseSinceIso: 7日なら JST 6日前の 0:00（UTC 前日 15:00）', () => {
    // 2026-09-17 10:00 JST = 01:00Z
    const now = new Date('2026-09-17T01:00:00Z');
    expect(S.showcaseSinceIso(7, now)).toBe('2026-09-10T15:00:00.000Z');   // 9/11 0:00 JST
    expect(S.showcaseSinceIso(1, now)).toBe('2026-09-16T15:00:00.000Z');   // 今日 0:00 JST
  });

  test('showcaseSinceIso: JST 深夜 0:30（UTC 前日 15:30）でも「今日」は JST の日付', () => {
    const now = new Date('2026-09-16T15:30:00Z');   // 9/17 00:30 JST
    expect(S.showcaseSinceIso(1, now)).toBe('2026-09-16T15:00:00.000Z');
  });

  test('clampShowcaseDays: 不正値は既定 7、上限 30', () => {
    expect(S.clampShowcaseDays(undefined)).toBe(7);
    expect(S.clampShowcaseDays('abc')).toBe(7);
    expect(S.clampShowcaseDays(0)).toBe(7);
    expect(S.clampShowcaseDays(90)).toBe(30);
    expect(S.clampShowcaseDays('14')).toBe(14);
  });
});

describe('bundleDeliveries', () => {
  test('同一案件 × 同一納品日で 4 本以上ならまとめる、3 本以下は single', () => {
    const list = [
      cr({ id: 'a1', delivered_at: '2026-09-16T01:00:00Z' }),
      cr({ id: 'a2', delivered_at: '2026-09-16T02:00:00Z' }),
      cr({ id: 'a3', delivered_at: '2026-09-16T03:00:00Z' }),
      cr({ id: 'a4', delivered_at: '2026-09-16T04:00:00Z' }),
      cr({ id: 'b1', project_id: 'p2', project_name: '案件B', delivered_at: '2026-09-16T05:00:00Z' }),
      cr({ id: 'b2', project_id: 'p2', project_name: '案件B', delivered_at: '2026-09-16T06:00:00Z' }),
    ];
    const items = S.bundleDeliveries(list);
    expect(items.map(i => i.type)).toEqual(['single', 'single', 'bundle']);
    const b = items[2];
    expect(b.count).toBe(4);
    expect(b.project.id).toBe('p1');
    expect(b.date).toBe('2026-09-16');
    expect(b.creatives.map(c => c.creative_id)).toEqual(['a4', 'a3', 'a2', 'a1']);   // 新しい順
    expect(b.key).toBe('bundle:p1:2026-09-16');
  });

  test('納品日は JST で区切る（UTC 15:00 を跨ぐと別の日）', () => {
    const list = [
      cr({ id: 'a1', delivered_at: '2026-09-16T14:00:00Z' }),   // 9/16 23:00 JST
      cr({ id: 'a2', delivered_at: '2026-09-16T14:30:00Z' }),
      cr({ id: 'a3', delivered_at: '2026-09-16T14:45:00Z' }),
      cr({ id: 'a4', delivered_at: '2026-09-16T15:10:00Z' }),   // 9/17 00:10 JST → 別の日
    ];
    const items = S.bundleDeliveries(list);
    expect(items.every(i => i.type === 'single')).toBe(true);
    expect(items.length).toBe(4);
  });

  test('案件なし（project_id null）はまとめない', () => {
    const list = ['x1', 'x2', 'x3', 'x4', 'x5'].map(id => cr({ id, project_id: null }));
    expect(S.bundleDeliveries(list).every(i => i.type === 'single')).toBe(true);
  });

  test('並びは新しい納品が先（bundle は最新の納品日時で比較）', () => {
    const list = [
      cr({ id: 's1', project_id: 'p9', delivered_at: '2026-09-15T00:00:00Z' }),
      ...['a1', 'a2', 'a3', 'a4'].map((id, i) => cr({ id, delivered_at: `2026-09-14T0${i}:00:00Z` })),
      cr({ id: 's2', project_id: 'p9', delivered_at: '2026-09-13T00:00:00Z' }),
    ];
    const items = S.bundleDeliveries(list);
    expect(items.map(i => i.type)).toEqual(['single', 'bundle', 'single']);
    expect(items[0].creative.creative_id).toBe('s1');
    expect(items[2].creative.creative_id).toBe('s2');
  });

  test('bundle の creators は重複排除して出現順', () => {
    const list = [
      cr({ id: 'a1', creators: [{ id: 'u1', nickname: 'さきこ' }] }),
      cr({ id: 'a2', creators: [{ id: 'u2', nickname: 'くるみ' }, { id: 'u1', nickname: 'さきこ' }] }),
      cr({ id: 'a3', creators: [{ id: 'u3', nickname: 'たごん' }] }),
      cr({ id: 'a4', creators: [] }),
    ];
    const b = S.bundleDeliveries(list)[0];
    expect(b.type).toBe('bundle');
    expect(b.creators.map(c => c.id)).toEqual(['u1', 'u2', 'u3']);
  });

  test('minBundle を変えられる', () => {
    const list = ['a1', 'a2'].map(id => cr({ id }));
    expect(S.bundleDeliveries(list, { minBundle: 2 })[0].type).toBe('bundle');
    expect(S.bundleDeliveries([], { minBundle: 2 })).toEqual([]);
  });
});

describe('buildBulkNiceNotification', () => {
  test('宛先 1 人 1 通の文面とリンク', () => {
    const n = S.buildBulkNiceNotification({ actorName: 'たろ', projectName: '◯◯商事 バナー一式', count: 12, firstCreativeId: 'c-1' });
    expect(n.type).toBe('portfolio_reaction');
    expect(n.title).toBe('たろさんが「◯◯商事 バナー一式」12本にまとめて👏');
    expect(n.linkUrl).toBe('/haruka.html?portfolio=c-1');
  });
  test('長い案件名は省略、名前が無ければ「誰か」', () => {
    const n = S.buildBulkNiceNotification({ projectName: 'あ'.repeat(60), count: 4, emoji: '❤️' });
    expect(n.title.startsWith('誰かさんが「' + 'あ'.repeat(40) + '…」4本にまとめて❤️')).toBe(true);
    expect(n.linkUrl).toBe('/haruka.html');
  });
});
