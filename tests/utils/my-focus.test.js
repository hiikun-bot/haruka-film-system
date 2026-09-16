// tests/utils/my-focus.test.js
// 🎯 ホーム「いま、あなたにボールがあるもの」（utils/my-focus.js・ADR 040）の集計純関数テスト。
// - ボール抽出（getBallHolder().user_ids に自分が含まれるものだけ）
// - 関与CR の納期カウント（超過 / 今週期限は「手元に無くても」数える）
// - クラ確認待ちの別カウント（ボール一覧には出さない）
// - 3経路 union の重複排除
// - 並び順（超過が先頭・納期未設定は末尾）と limit / has_more
// DB 非依存。TZ=UTC / TZ=Asia/Tokyo の両方で同結果になること
// （日付は 'YYYY-MM-DD' 文字列比較と UTC 固定パースのみで、ローカル TZ に依存しない）。

const { computeMyFocus, diffDays, CLIENT_BALL_TYPE } = require('../../utils/my-focus');

const ME = 'u-me';
const OTHER = 'u-other';
const TODAY = '2026-09-15';    // 火曜（JST）
const WEEK_END = '2026-09-20'; // 今週日曜（JST）

// creatives 要素のひな形。ball/member は明示したものだけが入る。
const cr = (over = {}) => ({
  id: over.id || 'c1',
  file_name: over.file_name || 'file.mp4',
  status: over.status || '編集',
  final_deadline: 'final_deadline' in over ? over.final_deadline : TODAY,
  draft_deadline: over.draft_deadline ?? null,
  help_flag: over.help_flag ?? false,
  project_id: over.project_id || 'p1',
  project_name: over.project_name || '案件A',
  client_name: over.client_name || 'クライアントA',
  sheet_url: over.sheet_url ?? null,
  regulation_url: over.regulation_url ?? null,
  ball_type: over.ball_type || 'editor',
  ball_user_ids: over.ball_user_ids || [],
  member_user_ids: over.member_user_ids || [],
});

const run = (creatives, limit = 5) =>
  computeMyFocus({ creatives, userId: ME, todayStr: TODAY, weekEndStr: WEEK_END, limit });

describe('diffDays', () => {
  test('日数差を UTC 固定で返す（ローカル TZ に依存しない）', () => {
    expect(diffDays('2026-09-15', '2026-09-18')).toBe(3);
    expect(diffDays('2026-09-15', '2026-09-13')).toBe(-2);
    expect(diffDays('2026-09-15', '2026-09-15')).toBe(0);
  });
  test('月またぎ・年またぎ', () => {
    expect(diffDays('2026-09-30', '2026-10-01')).toBe(1);
    expect(diffDays('2026-12-31', '2027-01-01')).toBe(1);
  });
  test('不正な値は null', () => {
    expect(diffDays('', '2026-09-15')).toBeNull();
    expect(diffDays('2026-09-15', null)).toBeNull();
    expect(diffDays('2026-09-15', 'あした')).toBeNull();
  });
});

describe('computeMyFocus — ボール抽出', () => {
  test('ボールが自分のものだけ items に載る', () => {
    const r = run([
      cr({ id: 'mine', ball_user_ids: [ME] }),
      cr({ id: 'others', ball_user_ids: [OTHER], member_user_ids: [ME] }),
    ]);
    expect(r.items.map(i => i.id)).toEqual(['mine']);
    expect(r.counts.balls).toBe(1);
  });

  test('複数ホルダー（Dチェック複数アサイン）でも自分が含まれれば数える', () => {
    const r = run([cr({ id: 'multi', ball_type: 'director', ball_user_ids: [OTHER, ME] })]);
    expect(r.counts.balls).toBe(1);
    expect(r.items[0].ball_type).toBe('director');
  });

  test('関与していない CR（取得経路の巻き込み）は完全に無視する', () => {
    const r = run([cr({ id: 'x', ball_user_ids: [OTHER], member_user_ids: [OTHER] })]);
    expect(r.counts).toEqual({ balls: 0, overdue: 0, due_this_week: 0, client_wait: 0 });
    expect(r.items).toHaveLength(0);
  });

  test('member にだけ居る（ボールは他人）でも納期カウントには入る', () => {
    const r = run([cr({ id: 'a', final_deadline: '2026-09-10', ball_user_ids: [OTHER], member_user_ids: [ME] })]);
    expect(r.counts.balls).toBe(0);
    expect(r.counts.overdue).toBe(1);
  });

  test('userId 未指定なら空を返す', () => {
    const r = computeMyFocus({ creatives: [cr({ ball_user_ids: [ME] })], todayStr: TODAY, weekEndStr: WEEK_END });
    expect(r.counts.balls).toBe(0);
    expect(r.items).toHaveLength(0);
  });
});

describe('computeMyFocus — 納期カウント', () => {
  test('超過 / 今週期限 / 週外 を切り分ける', () => {
    const r = run([
      cr({ id: 'over', final_deadline: '2026-09-14', ball_user_ids: [ME] }),
      cr({ id: 'today', final_deadline: TODAY, ball_user_ids: [ME] }),
      cr({ id: 'sun', final_deadline: WEEK_END, ball_user_ids: [ME] }),
      cr({ id: 'next', final_deadline: '2026-09-21', ball_user_ids: [ME] }),
    ]);
    expect(r.counts.overdue).toBe(1);
    expect(r.counts.due_this_week).toBe(2); // 今日と日曜（両端を含む）
  });

  test('納期未設定は超過にも今週にも数えない', () => {
    const r = run([cr({ id: 'nd', final_deadline: null, ball_user_ids: [ME] })]);
    expect(r.counts.overdue).toBe(0);
    expect(r.counts.due_this_week).toBe(0);
    expect(r.items[0].days_left).toBeNull();
  });

  test('days_left は超過を負、今日を 0 で返す', () => {
    const r = run([
      cr({ id: 'o', final_deadline: '2026-09-13', ball_user_ids: [ME] }),
      cr({ id: 't', final_deadline: TODAY, ball_user_ids: [ME] }),
      cr({ id: 'f', final_deadline: '2026-09-18', ball_user_ids: [ME] }),
    ]);
    const byId = Object.fromEntries(r.items.map(i => [i.id, i.days_left]));
    expect(byId).toEqual({ o: -2, t: 0, f: 3 });
  });

  test('タイムスタンプ付きの日付文字列でも先頭10桁で判定する', () => {
    const r = run([cr({ id: 'ts', final_deadline: '2026-09-10T00:00:00+09:00', ball_user_ids: [ME] })]);
    expect(r.counts.overdue).toBe(1);
    expect(r.items[0].final_deadline).toBe('2026-09-10');
  });
});

describe('computeMyFocus — クラ確認待ち', () => {
  test('ボール一覧には出さず client_wait として別に数える', () => {
    const r = run([
      cr({ id: 'cw', status: 'クライアントチェック中', ball_type: CLIENT_BALL_TYPE, ball_user_ids: [], member_user_ids: [ME] }),
      cr({ id: 'mine', ball_user_ids: [ME] }),
    ]);
    expect(r.counts.client_wait).toBe(1);
    expect(r.counts.balls).toBe(1);
    expect(r.items.map(i => i.id)).toEqual(['mine']);
  });

  test('クラ確認待ちでも納期が過ぎていれば超過に数える', () => {
    const r = run([cr({ id: 'cw', final_deadline: '2026-09-01', ball_type: CLIENT_BALL_TYPE, member_user_ids: [ME] })]);
    expect(r.counts.overdue).toBe(1);
  });
});

describe('computeMyFocus — 重複排除・並び順・limit', () => {
  test('同じ id が複数経路で来ても 1 件として数える', () => {
    const same = { id: 'dup', final_deadline: '2026-09-10', ball_user_ids: [ME], member_user_ids: [ME] };
    const r = run([cr(same), cr(same), cr(same)]);
    expect(r.counts.balls).toBe(1);
    expect(r.counts.overdue).toBe(1);
    expect(r.items).toHaveLength(1);
  });

  test('納期昇順（超過が先頭）・納期未設定は末尾', () => {
    const r = run([
      cr({ id: 'none', file_name: 'z.mp4', final_deadline: null, ball_user_ids: [ME] }),
      cr({ id: 'far', final_deadline: '2026-09-30', ball_user_ids: [ME] }),
      cr({ id: 'over', final_deadline: '2026-09-01', ball_user_ids: [ME] }),
      cr({ id: 'soon', final_deadline: '2026-09-16', ball_user_ids: [ME] }),
    ], 0);
    expect(r.items.map(i => i.id)).toEqual(['over', 'soon', 'far', 'none']);
  });

  test('納期同着はファイル名で安定ソートする', () => {
    const r = run([
      cr({ id: 'b', file_name: 'b.mp4', ball_user_ids: [ME] }),
      cr({ id: 'a', file_name: 'a.mp4', ball_user_ids: [ME] }),
    ], 0);
    expect(r.items.map(i => i.id)).toEqual(['a', 'b']);
  });

  test('limit で切り、has_more が立つ。counts は切る前の全件', () => {
    const list = ['1', '2', '3', '4', '5', '6', '7'].map(n =>
      cr({ id: `c${n}`, final_deadline: `2026-09-${n.padStart(2, '0')}`, ball_user_ids: [ME] }));
    const r = run(list, 5);
    expect(r.items).toHaveLength(5);
    expect(r.has_more).toBe(true);
    expect(r.counts.balls).toBe(7);
  });

  test('limit=0 は全件返し has_more は false', () => {
    const list = ['1', '2', '3'].map(n => cr({ id: `c${n}`, ball_user_ids: [ME] }));
    const r = run(list, 0);
    expect(r.items).toHaveLength(3);
    expect(r.has_more).toBe(false);
  });

  test('空配列・null 入力でも落ちない', () => {
    expect(run([]).counts.balls).toBe(0);
    expect(computeMyFocus({ creatives: null, userId: ME, todayStr: TODAY, weekEndStr: WEEK_END }).items).toEqual([]);
    expect(computeMyFocus().items).toEqual([]);
  });

  test('表示用フィールド（案件名・クライアント名・SOS）をそのまま返す', () => {
    const r = run([cr({ id: 'x', project_name: '秋LP', client_name: 'JTG', help_flag: true, ball_user_ids: [ME] })]);
    expect(r.items[0]).toMatchObject({ project_name: '秋LP', client_name: 'JTG', help_flag: true });
  });

  test('管理シート・レギュレーションのURLを通す（未設定は空文字）', () => {
    const r = run([
      cr({ id: 'a', file_name: 'a.mp4', sheet_url: 'https://docs.google.com/s/1', regulation_url: 'https://example.com/reg', ball_user_ids: [ME] }),
      cr({ id: 'b', file_name: 'b.mp4', ball_user_ids: [ME] }),
    ], 0);
    expect(r.items[0]).toMatchObject({ sheet_url: 'https://docs.google.com/s/1', regulation_url: 'https://example.com/reg' });
    expect(r.items[1]).toMatchObject({ sheet_url: '', regulation_url: '' });
  });
});
