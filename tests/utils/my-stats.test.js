// tests/utils/my-stats.test.js
// 🏅 マイ実績（utils/my-stats.js）の純関数テスト。ADR 036。
// - 「自分のクリエイティブ」判定（担当 / 納品時スナップショットD / P・ADR 009）
// - 今月/先月/累計納品・今月初稿（JST 月判定・ADR 026 / 034）
// - 直近3ヶ月 納期遵守率（final_deadline 設定ありのみ分母・JST 日付比較）
// - 今月の👍（自分の like 除外・他人の creative 除外・当月のみ）
// - マイルストーン文言（到達 / あとN本 / 遵守100% / 先月超え・最大2件）
// DB 非依存。`TZ=UTC npx jest` と `TZ=Asia/Tokyo npx jest` の両方で同結果になること。

const {
  snapshotDirectorId,
  snapshotProducerId,
  isCreativeOfUser,
  jstDateStr,
  jstYearMonth,
  addMonths,
  computeMyStats,
  buildMilestones,
  MAX_MILESTONES,
} = require('../../utils/my-stats');

const ME = 'u-me';
const OTHER = 'u-other';
// 基準時刻: JST 2026-09-03 10:00（UTC 01:00）
const NOW = '2026-09-03T01:00:00.000Z';

describe('JST ヘルパー', () => {
  test('jstDateStr: UTC 深夜は JST 翌日になる（月末跨ぎ）', () => {
    expect(jstDateStr('2026-08-31T15:00:00.000Z')).toBe('2026-09-01'); // JST 9/1 00:00
    expect(jstDateStr('2026-08-31T14:59:59.000Z')).toBe('2026-08-31');
    expect(jstDateStr(null)).toBeNull();
    expect(jstDateStr('not-a-date')).toBeNull();
  });
  test('jstYearMonth: 月末深夜の納品は JST 月で判定', () => {
    expect(jstYearMonth('2026-08-31T15:00:00.000Z')).toBe('2026-09');
    expect(jstYearMonth('2026-08-31T14:59:59.000Z')).toBe('2026-08');
  });
  test('addMonths: 年跨ぎ・負方向', () => {
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect(addMonths('2026-01', -2)).toBe('2025-11');
    expect(addMonths('2026-12', 1)).toBe('2027-01');
    expect(addMonths('bad', 1)).toBeNull();
  });
});

describe('isCreativeOfUser（自分のクリエイティブ判定）', () => {
  test('creative_assignments に自分の行（user_id）があれば自分の分（role 問わず）', () => {
    expect(isCreativeOfUser({ creative_assignments: [{ user_id: ME, role: 'wcheck' }] }, ME)).toBe(true);
    expect(isCreativeOfUser({ creative_assignments: [{ users: { id: ME }, role: 'editor' }] }, ME)).toBe(true);
    expect(isCreativeOfUser({ creative_assignments: [{ user_id: OTHER }] }, ME)).toBe(false);
  });
  test('納品時スナップショット delivered_director_ids[0] が自分なら自分の分（ADR 009）', () => {
    const c = { delivered_director_ids: [ME], projects: { director_id: OTHER } };
    expect(snapshotDirectorId(c)).toBe(ME);
    expect(isCreativeOfUser(c, ME)).toBe(true);
    // スナップショットが他人なら projects.director_id が自分でも自分の分ではない（交代後の再帰属を防ぐ）
    const c2 = { delivered_director_ids: [OTHER], projects: { director_id: ME } };
    expect(isCreativeOfUser(c2, ME)).toBe(false);
  });
  test('未納品（スナップショット無し）は projects.director_id / producer_id にフォールバック', () => {
    expect(isCreativeOfUser({ delivered_director_ids: null, projects: { director_id: ME } }, ME)).toBe(true);
    expect(snapshotProducerId({ delivered_producer_ids: [], projects: { producer_id: ME } })).toBe(ME);
    expect(isCreativeOfUser({ projects: { producer_id: ME } }, ME)).toBe(true);
  });
  test('null / uid 無しは false', () => {
    expect(isCreativeOfUser(null, ME)).toBe(false);
    expect(isCreativeOfUser({ creative_assignments: [{ user_id: ME }] }, null)).toBe(false);
  });
});

const mineCreative = (over = {}) => ({
  id: over.id || `c-${Math.random().toString(36).slice(2, 8)}`,
  creative_assignments: [{ user_id: ME }],
  projects: { director_id: OTHER, producer_id: OTHER },
  delivered_at: null,
  final_deadline: null,
  first_draft_submitted_at: null,
  ...over,
});

describe('computeMyStats（集計）', () => {
  test('今月/先月/累計納品は delivered_at の JST 月で判定（ADR 026）', () => {
    const creatives = [
      mineCreative({ delivered_at: '2026-08-31T15:30:00.000Z' }), // JST 9/1 → 今月
      mineCreative({ delivered_at: '2026-09-02T00:00:00.000Z' }), // 今月
      mineCreative({ delivered_at: '2026-08-31T14:00:00.000Z' }), // JST 8/31 → 先月
      mineCreative({ delivered_at: '2026-06-10T00:00:00.000Z' }), // 6月 → 累計のみ
      mineCreative({ delivered_at: null, status: '編集' }),        // 未納品
      { id: 'c-x', creative_assignments: [{ user_id: OTHER }], projects: {}, delivered_at: '2026-09-01T00:00:00.000Z' }, // 他人
    ];
    const s = computeMyStats({ creatives, likes: [], uid: ME, now: NOW });
    expect(s.month).toBe('2026-09');
    expect(s.delivered_this_month).toBe(2);
    expect(s.delivered_last_month).toBe(1);
    expect(s.delivered_total).toBe(4);
  });

  test('今月初稿は first_draft_submitted_at の JST 月（ADR 034）', () => {
    const creatives = [
      mineCreative({ first_draft_submitted_at: '2026-08-31T15:00:00.000Z' }), // JST 9/1
      mineCreative({ first_draft_submitted_at: '2026-08-15T00:00:00.000Z' }),
      mineCreative({ first_draft_submitted_at: null }),
    ];
    const s = computeMyStats({ creatives, likes: [], uid: ME, now: NOW });
    expect(s.first_draft_this_month).toBe(1);
  });

  test('納期遵守率: 直近3ヶ月（7〜9月）・final_deadline ありのみ分母・JST 日付 <= 締切', () => {
    const creatives = [
      mineCreative({ delivered_at: '2026-09-01T10:00:00.000Z', final_deadline: '2026-09-01' }), // 遵守（当日）
      mineCreative({ delivered_at: '2026-08-31T15:00:00.000Z', final_deadline: '2026-08-31' }), // JST 9/1 > 8/31 → 遅延
      mineCreative({ delivered_at: '2026-07-05T00:00:00.000Z', final_deadline: '2026-07-10' }), // 遵守（7月＝窓内）
      mineCreative({ delivered_at: '2026-06-30T00:00:00.000Z', final_deadline: '2026-06-01' }), // 6月＝窓外
      mineCreative({ delivered_at: '2026-08-10T00:00:00.000Z', final_deadline: null }),         // 締切なし＝分母外
    ];
    const s = computeMyStats({ creatives, likes: [], uid: ME, now: NOW });
    expect(s.on_time_denominator).toBe(3);
    expect(s.on_time_numerator).toBe(2);
    expect(s.on_time_rate_3m).toBeCloseTo(2 / 3);
  });

  test('分母 0 なら on_time_rate_3m は null', () => {
    const s = computeMyStats({ creatives: [mineCreative({ delivered_at: '2026-09-01T00:00:00.000Z' })], likes: [], uid: ME, now: NOW });
    expect(s.on_time_rate_3m).toBeNull();
    expect(s.on_time_denominator).toBe(0);
  });

  test('今月の👍: 自分の creative × 他人 × 当月のみ', () => {
    const creatives = [mineCreative({ id: 'c-1' }), mineCreative({ id: 'c-2' })];
    const likes = [
      { creative_id: 'c-1', user_id: OTHER, created_at: '2026-09-02T00:00:00.000Z' }, // ○
      { creative_id: 'c-2', user_id: 'u-3', created_at: '2026-08-31T15:00:00.000Z' }, // ○ JST 9/1
      { creative_id: 'c-1', user_id: ME, created_at: '2026-09-02T00:00:00.000Z' },    // × 自分
      { creative_id: 'c-1', user_id: OTHER, created_at: '2026-08-20T00:00:00.000Z' }, // × 先月
      { creative_id: 'c-zzz', user_id: OTHER, created_at: '2026-09-02T00:00:00.000Z' }, // × 他人の creative
    ];
    const s = computeMyStats({ creatives, likes, uid: ME, now: NOW });
    expect(s.likes_this_month).toBe(2);
  });

  test('全部ゼロ（新人）でも例外にならず 0 / null / 空配列', () => {
    const s = computeMyStats({ creatives: [], likes: [], uid: ME, now: NOW });
    expect(s).toMatchObject({
      delivered_this_month: 0, delivered_last_month: 0, delivered_total: 0,
      first_draft_this_month: 0, on_time_rate_3m: null, on_time_denominator: 0, likes_this_month: 0,
      milestones: [],
    });
    expect(computeMyStats({ uid: ME, now: NOW }).delivered_total).toBe(0);
  });
});

describe('buildMilestones（文言・最大2件）', () => {
  test('今月の納品でマイルストーンを跨いだら「達成」', () => {
    const m = buildMilestones({ delivered_total: 101, delivered_this_month: 3, delivered_last_month: 5 });
    expect(m[0]).toBe('🎉 累計100本達成！');
  });
  test('次のマイルストーンまで 10 本以内なら「あと N 本」', () => {
    const m = buildMilestones({ delivered_total: 97, delivered_this_month: 0, delivered_last_month: 0 });
    expect(m).toEqual(['🎯 累計100本まであと3本！']);
    // 11本以上離れていれば出ない
    expect(buildMilestones({ delivered_total: 60, delivered_this_month: 0, delivered_last_month: 0 })).toEqual([]);
    // 累計 0 は出さない（🌱 空状態はフロント側）
    expect(buildMilestones({ delivered_total: 0, delivered_this_month: 0, delivered_last_month: 0 })).toEqual([]);
  });
  test('納期遵守100% は分母 3 以上のときだけ', () => {
    expect(buildMilestones({ delivered_total: 15, on_time_rate_3m: 1, on_time_denominator: 3 })).toContain('✨ 直近3ヶ月 納期遵守100%');
    expect(buildMilestones({ delivered_total: 15, on_time_rate_3m: 1, on_time_denominator: 2 })).toEqual([]);
    expect(buildMilestones({ delivered_total: 15, on_time_rate_3m: 0.9, on_time_denominator: 10 })).toEqual([]);
  });
  test('今月納品が先月超え（今月 0 本は出さない）', () => {
    expect(buildMilestones({ delivered_total: 15, delivered_this_month: 4, delivered_last_month: 3 })).toEqual(['📈 今月の納品は先月超え（4本 > 3本）']);
    expect(buildMilestones({ delivered_total: 15, delivered_this_month: 0, delivered_last_month: 0 })).toEqual([]);
    expect(buildMilestones({ delivered_total: 15, delivered_this_month: 3, delivered_last_month: 3 })).toEqual([]);
  });
  test('最大 2 件（優先順: 到達 > 遵守100% > 先月超え）', () => {
    const m = buildMilestones({ delivered_total: 100, delivered_this_month: 6, delivered_last_month: 4, on_time_rate_3m: 1, on_time_denominator: 5 });
    expect(m).toHaveLength(MAX_MILESTONES);
    expect(m).toEqual(['🎉 累計100本達成！', '✨ 直近3ヶ月 納期遵守100%']);
  });
  test('computeMyStats 経由でも milestones が付く', () => {
    const creatives = Array.from({ length: 98 }, (_, i) =>
      mineCreative({ id: `c-${i}`, delivered_at: i < 96 ? '2026-05-01T00:00:00.000Z' : '2026-09-02T00:00:00.000Z' }));
    const s = computeMyStats({ creatives, likes: [], uid: ME, now: NOW });
    expect(s.delivered_total).toBe(98);
    expect(s.milestones).toEqual(['🎯 累計100本まであと2本！', '📈 今月の納品は先月超え（2本 > 0本）']);
  });
});
