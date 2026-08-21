// tests/utils/team-load.test.js
// 📊 チーム状況（utils/team-load.js）の集計純関数テスト。
// - 進行中CR数（担当分・保留除外）
// - 持ちボール数（複数ホルダー対応）
// - 今週期限数 / 期限超過数（JST日付文字列の比較のみ。Date生成なし）
// - 高負荷判定（isHighLoad の閾値境界）
// DB 非依存。TZ=UTC / TZ=Asia/Tokyo の両方で同結果になること
// （日付は 'YYYY-MM-DD' 文字列比較のみで Date オブジェクトを使わない）。

const {
  ASSIGNEE_ROLES,
  isHighLoad,
  computeTeamLoad,
  extractAssigneeUserIds,
} = require('../../utils/team-load');

const TODAY = '2026-08-21';  // 金曜（JST）
const SUNDAY = '2026-08-23'; // 今週日曜

const member = (id, full_name, nickname) => ({ id, full_name, nickname, roles: ['editor'] });

describe('isHighLoad（負荷レベル判定）', () => {
  test('期限超過が1件でもあれば high', () => {
    expect(isHighLoad({ balls: 0, dueThisWeek: 0, overdue: 1 })).toBe('high');
  });
  test('ボール4件以上で high、2〜3件で mid、1件以下は low', () => {
    expect(isHighLoad({ balls: 4, dueThisWeek: 0, overdue: 0 })).toBe('high');
    expect(isHighLoad({ balls: 3, dueThisWeek: 0, overdue: 0 })).toBe('mid');
    expect(isHighLoad({ balls: 2, dueThisWeek: 0, overdue: 0 })).toBe('mid');
    expect(isHighLoad({ balls: 1, dueThisWeek: 0, overdue: 0 })).toBe('low');
  });
  test('今週期限5件以上で high、3〜4件で mid', () => {
    expect(isHighLoad({ balls: 0, dueThisWeek: 5, overdue: 0 })).toBe('high');
    expect(isHighLoad({ balls: 0, dueThisWeek: 4, overdue: 0 })).toBe('mid');
    expect(isHighLoad({ balls: 0, dueThisWeek: 3, overdue: 0 })).toBe('mid');
    expect(isHighLoad({ balls: 0, dueThisWeek: 2, overdue: 0 })).toBe('low');
  });
  test('全部ゼロ・引数なしは low', () => {
    expect(isHighLoad({})).toBe('low');
    expect(isHighLoad()).toBe('low');
  });
});

describe('extractAssigneeUserIds（担当 user_id 抽出）', () => {
  test('editor / designer / director_as_editor のみを担当として抽出する', () => {
    const assignments = [
      { role: 'editor',             users: { id: 'u1' } },
      { role: 'designer',           users: { id: 'u2' } },
      { role: 'director_as_editor', users: { id: 'u3' } },
      { role: 'director',           users: { id: 'u4' } }, // チェック担当は含めない
      { role: 'producer',           users: { id: 'u5' } },
      { role: 'wcheck',             users: { id: 'u6' } },
    ];
    expect(extractAssigneeUserIds(assignments).sort()).toEqual(['u1', 'u2', 'u3']);
  });
  test('users embed が無い形（user_id 直持ち）もサポート・重複は除去', () => {
    const assignments = [
      { role: 'editor', user_id: 'u1' },
      { role: 'designer', user_id: 'u1' },
      { role: 'editor', user_id: null },
    ];
    expect(extractAssigneeUserIds(assignments)).toEqual(['u1']);
    expect(extractAssigneeUserIds(null)).toEqual([]);
  });
  test('ASSIGNEE_ROLES は getBallHolder の editor 判定と同一集合', () => {
    expect([...ASSIGNEE_ROLES].sort()).toEqual(['designer', 'director_as_editor', 'editor']);
  });
});

describe('computeTeamLoad（メンバー別集計）', () => {
  const members = [member('u1', '片山紗季', 'ぴょん'), member('u2', '髙橋聖', 'はる')];

  test('進行中CR数: 担当分のみ・保留は除外', () => {
    const creatives = [
      { id: 'c1', status: '編集',   final_deadline: null, assignee_user_ids: ['u1'], ball_user_ids: [] },
      { id: 'c2', status: '保留',   final_deadline: null, assignee_user_ids: ['u1'], ball_user_ids: [] },
      { id: 'c3', status: 'Dチェック', final_deadline: null, assignee_user_ids: ['u2'], ball_user_ids: [] },
    ];
    const { members: rows, totals } = computeTeamLoad({ members, creatives, todayStr: TODAY, sundayStr: SUNDAY });
    const u1 = rows.find(r => r.id === 'u1');
    const u2 = rows.find(r => r.id === 'u2');
    expect(u1.active).toBe(1); // 保留の c2 は数えない
    expect(u2.active).toBe(1);
    expect(totals.active).toBe(2);
  });

  test('持ちボール数: user_ids[] の複数ホルダー全員にカウントされる', () => {
    const creatives = [
      { id: 'c1', status: 'Dチェック', final_deadline: null, assignee_user_ids: [], ball_user_ids: ['u1', 'u2'] },
      { id: 'c2', status: '編集',     final_deadline: null, assignee_user_ids: [], ball_user_ids: ['u1'] },
    ];
    const { members: rows } = computeTeamLoad({ members, creatives, todayStr: TODAY, sundayStr: SUNDAY });
    expect(rows.find(r => r.id === 'u1').balls).toBe(2);
    expect(rows.find(r => r.id === 'u2').balls).toBe(1);
  });

  test('今週期限数: 今日〜今週日曜（JST）の担当CR。境界日を含む', () => {
    const creatives = [
      { id: 'c1', status: '編集', final_deadline: TODAY,        assignee_user_ids: ['u1'], ball_user_ids: [] }, // 今日 → 含む
      { id: 'c2', status: '編集', final_deadline: SUNDAY,       assignee_user_ids: ['u1'], ball_user_ids: [] }, // 日曜 → 含む
      { id: 'c3', status: '編集', final_deadline: '2026-08-24', assignee_user_ids: ['u1'], ball_user_ids: [] }, // 来週月曜 → 含まない
      { id: 'c4', status: '編集', final_deadline: null,         assignee_user_ids: ['u1'], ball_user_ids: [] }, // 期限なし → 含まない
    ];
    const { members: rows, totals } = computeTeamLoad({ members, creatives, todayStr: TODAY, sundayStr: SUNDAY });
    expect(rows.find(r => r.id === 'u1').due_this_week).toBe(2);
    expect(totals.due_this_week).toBe(2);
  });

  test('期限超過数: final_deadline < 今日。保留でも期限系はカウントする', () => {
    const creatives = [
      { id: 'c1', status: '編集', final_deadline: '2026-08-20', assignee_user_ids: ['u1'], ball_user_ids: [] }, // 昨日 → 超過
      { id: 'c2', status: '保留', final_deadline: '2026-08-01', assignee_user_ids: ['u1'], ball_user_ids: [] }, // 保留でも超過に含む
      { id: 'c3', status: '編集', final_deadline: TODAY,        assignee_user_ids: ['u1'], ball_user_ids: [] }, // 今日 → 超過ではない
    ];
    const { members: rows, totals } = computeTeamLoad({ members, creatives, todayStr: TODAY, sundayStr: SUNDAY });
    const u1 = rows.find(r => r.id === 'u1');
    expect(u1.overdue).toBe(2);
    expect(u1.load).toBe('high'); // overdue >= 1 → high
    expect(totals.overdue).toBe(2);
  });

  test('対象外ユーザー（members に居ない担当・ホルダー）は無視する', () => {
    const creatives = [
      { id: 'c1', status: '編集', final_deadline: TODAY, assignee_user_ids: ['ghost'], ball_user_ids: ['ghost'] },
    ];
    const { members: rows, totals } = computeTeamLoad({ members, creatives, todayStr: TODAY, sundayStr: SUNDAY });
    expect(rows.every(r => r.active === 0 && r.balls === 0)).toBe(true);
    // 全体KPIはCR単位なので ghost 分もカウントされる（メンバー別と定義が異なる点に注意）
    expect(totals.active).toBe(1);
  });

  test('デフォルトソート: 持ちボール数降順 → 進行中CR数降順', () => {
    const creatives = [
      { id: 'c1', status: '編集', final_deadline: null, assignee_user_ids: ['u2'], ball_user_ids: ['u2'] },
      { id: 'c2', status: '編集', final_deadline: null, assignee_user_ids: ['u2'], ball_user_ids: ['u2'] },
      { id: 'c3', status: '編集', final_deadline: null, assignee_user_ids: ['u1'], ball_user_ids: ['u1'] },
    ];
    const { members: rows } = computeTeamLoad({ members, creatives, todayStr: TODAY, sundayStr: SUNDAY });
    expect(rows.map(r => r.id)).toEqual(['u2', 'u1']);
  });

  test('creatives が空でも全メンバーがゼロ行で返る（0件で行が消えない）', () => {
    const { members: rows } = computeTeamLoad({ members, creatives: [], todayStr: TODAY, sundayStr: SUNDAY });
    expect(rows).toHaveLength(2);
    expect(rows.every(r => r.load === 'low')).toBe(true);
  });
});
