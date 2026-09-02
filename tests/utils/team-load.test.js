// tests/utils/team-load.test.js
// 📊 チーム状況（utils/team-load.js）の集計純関数テスト。
// - 進行中CR数（担当分・保留除外・クライアント確認待ち除外）
// - クラ確認待ち数（ball_type === 'client' の別カウント）
// - 持ちボール数（複数ホルダー対応）
// - 今週期限数 / 期限超過数（JST日付文字列の比較のみ。Date生成なし）
// - 高負荷判定（isHighLoad の閾値境界）
// DB 非依存。TZ=UTC / TZ=Asia/Tokyo の両方で同結果になること
// （日付は 'YYYY-MM-DD' 文字列比較のみで Date オブジェクトを使わない）。

const {
  ASSIGNEE_ROLES,
  CLIENT_BALL_TYPE,
  computeLoadScore,
  isHighLoad,
  computeTeamLoad,
  extractAssigneeUserIds,
} = require('../../utils/team-load');

const TODAY = '2026-08-21';  // 金曜（JST）
const SUNDAY = '2026-08-23'; // 今週日曜

const member = (id, full_name, nickname) => ({ id, full_name, nickname, roles: ['editor'] });

describe('isHighLoad（負荷レベル判定・合成スコア方式）', () => {
  // スコア = balls×2 + dueThisWeek×1 + overdue×3。high >= 16 / mid >= 8 / それ未満 low
  test('computeLoadScore: 重み balls×2 + due×1 + overdue×3', () => {
    expect(computeLoadScore({ balls: 2, dueThisWeek: 1, overdue: 1 })).toBe(8);
    expect(computeLoadScore({})).toBe(0);
    expect(computeLoadScore()).toBe(0);
  });
  test('少数の件数では負荷にしない（2026-08-22 ユーザー指示: 1〜2件は負荷ではない）', () => {
    // 旧方式では overdue 1件で即 high だったケース → low
    expect(isHighLoad({ balls: 0, dueThisWeek: 0, overdue: 1 })).toBe('low');
    // 超過1件 + ボール2件（score 7）でも low
    expect(isHighLoad({ balls: 2, dueThisWeek: 0, overdue: 1 })).toBe('low');
    expect(isHighLoad({ balls: 3, dueThisWeek: 1, overdue: 0 })).toBe('low'); // score 7
  });
  test('複数要素の積み重なりで mid（score 8〜15）', () => {
    expect(isHighLoad({ balls: 4, dueThisWeek: 0, overdue: 0 })).toBe('mid');  // score 8
    expect(isHighLoad({ balls: 0, dueThisWeek: 0, overdue: 3 })).toBe('mid');  // score 9
    expect(isHighLoad({ balls: 2, dueThisWeek: 2, overdue: 2 })).toBe('mid');  // score 12
    expect(isHighLoad({ balls: 4, dueThisWeek: 7, overdue: 0 })).toBe('mid');  // score 15（境界）
  });
  test('明らかに捌けない水準で high（score >= 16）', () => {
    expect(isHighLoad({ balls: 8, dueThisWeek: 0, overdue: 0 })).toBe('high'); // score 16（境界）
    expect(isHighLoad({ balls: 0, dueThisWeek: 0, overdue: 6 })).toBe('high'); // score 18
    expect(isHighLoad({ balls: 4, dueThisWeek: 2, overdue: 2 })).toBe('high'); // score 16
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

  test('クラ確認待ち: ball_type=client は進行中CRから除外し client_wait に別カウントする', () => {
    const creatives = [
      { id: 'c1', status: '編集',               final_deadline: null, ball_type: 'editor', assignee_user_ids: ['u1'], ball_user_ids: ['u1'] },
      // クライアントチェック中: ボールは向こう（user_ids は空）。active に入れず client_wait に数える
      { id: 'c2', status: 'クライアントチェック中', final_deadline: null, ball_type: CLIENT_BALL_TYPE, assignee_user_ids: ['u1'], ball_user_ids: [] },
      { id: 'c3', status: 'クライアントチェック中', final_deadline: null, ball_type: CLIENT_BALL_TYPE, assignee_user_ids: ['u2'], ball_user_ids: [] },
    ];
    const { members: rows, totals } = computeTeamLoad({ members, creatives, todayStr: TODAY, sundayStr: SUNDAY });
    const u1 = rows.find(r => r.id === 'u1');
    const u2 = rows.find(r => r.id === 'u2');
    expect(u1.active).toBe(1);        // c2 は進行中CRに含めない
    expect(u1.client_wait).toBe(1);
    expect(u1.balls).toBe(1);         // クラ確認待ちは持ちボールにも入らない（user_ids 空）
    expect(u2.active).toBe(0);
    expect(u2.client_wait).toBe(1);
    expect(totals.active).toBe(1);
    expect(totals.client_wait).toBe(2);
  });

  test('クラ確認待ち: 期限系（今週期限・超過）はクラ確認待ちでもカウントする（納期は生きている）', () => {
    const creatives = [
      { id: 'c1', status: 'クライアントチェック中', final_deadline: TODAY,        ball_type: CLIENT_BALL_TYPE, assignee_user_ids: ['u1'], ball_user_ids: [] },
      { id: 'c2', status: 'クライアントチェック中', final_deadline: '2026-08-20', ball_type: CLIENT_BALL_TYPE, assignee_user_ids: ['u1'], ball_user_ids: [] },
    ];
    const { members: rows, totals } = computeTeamLoad({ members, creatives, todayStr: TODAY, sundayStr: SUNDAY });
    const u1 = rows.find(r => r.id === 'u1');
    expect(u1.due_this_week).toBe(1);
    expect(u1.overdue).toBe(1);
    expect(u1.active).toBe(0);
    expect(totals.active).toBe(0);
    expect(totals.due_this_week).toBe(1);
    expect(totals.overdue).toBe(1);
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
    expect(u1.score).toBe(7);    // 超過2×3 + 今週期限1 = 7（score は行に含めて返す）
    expect(u1.load).toBe('low'); // score 7 < 8 → low（超過だけで即 high にはしない）
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

  test('デフォルトソート: 負荷スコア降順 → 持ちボール数降順 → 進行中CR数降順', () => {
    const creatives = [
      { id: 'c1', status: '編集', final_deadline: null, assignee_user_ids: ['u2'], ball_user_ids: ['u2'] },
      { id: 'c2', status: '編集', final_deadline: null, assignee_user_ids: ['u2'], ball_user_ids: ['u2'] },
      { id: 'c3', status: '編集', final_deadline: null, assignee_user_ids: ['u1'], ball_user_ids: ['u1'] },
    ];
    const { members: rows } = computeTeamLoad({ members, creatives, todayStr: TODAY, sundayStr: SUNDAY });
    expect(rows.map(r => r.id)).toEqual(['u2', 'u1']);
  });

  test('デフォルトソート: 持ちボールが少なくても超過が多い（スコアが高い）人が上に来る', () => {
    // u1: ボール1件・超過3件 → score 2+9=11 / u2: ボール2件・超過0 → score 4
    const creatives = [
      { id: 'c1', status: '編集', final_deadline: '2026-08-01', assignee_user_ids: ['u1'], ball_user_ids: ['u1'] },
      { id: 'c2', status: '編集', final_deadline: '2026-08-01', assignee_user_ids: ['u1'], ball_user_ids: [] },
      { id: 'c3', status: '編集', final_deadline: '2026-08-01', assignee_user_ids: ['u1'], ball_user_ids: [] },
      { id: 'c4', status: '編集', final_deadline: null, assignee_user_ids: ['u2'], ball_user_ids: ['u2'] },
      { id: 'c5', status: '編集', final_deadline: null, assignee_user_ids: ['u2'], ball_user_ids: ['u2'] },
    ];
    const { members: rows } = computeTeamLoad({ members, creatives, todayStr: TODAY, sundayStr: SUNDAY });
    expect(rows.map(r => r.id)).toEqual(['u1', 'u2']);
    expect(rows[0].score).toBeGreaterThan(rows[1].score);
  });

  test('creatives が空でも全メンバーがゼロ行で返る（0件で行が消えない）', () => {
    const { members: rows } = computeTeamLoad({ members, creatives: [], todayStr: TODAY, sundayStr: SUNDAY });
    expect(rows).toHaveLength(2);
    expect(rows.every(r => r.load === 'low')).toBe(true);
  });
});
