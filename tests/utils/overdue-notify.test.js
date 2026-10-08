// tests/utils/overdue-notify.test.js — 提出遅れ日次通知（ADR 049）の純関数テスト
// TZ=UTC / TZ=Asia/Tokyo どちらで実行しても同じ結果になること（Railway は UTC 動作）。

const {
  daysOverdue,
  isJstBusinessDay,
  selectOverdue,
  resolveManagerIds,
  groupByRecipient,
  buildOverdueDigest,
  buildSosMessage,
  MAX_ITEMS_IN_MESSAGE,
} = require('../../utils/overdue-notify');

describe('daysOverdue', () => {
  test('超過日数（当日は 0、未来は負）', () => {
    expect(daysOverdue('2026-10-01', '2026-10-08')).toBe(7);
    expect(daysOverdue('2026-10-08', '2026-10-08')).toBe(0);
    expect(daysOverdue('2026-10-09', '2026-10-08')).toBe(-1);
    expect(daysOverdue(null, '2026-10-08')).toBeNull();
  });
  test('TIMESTAMP 付きの文字列も日付部分だけで比較する', () => {
    expect(daysOverdue('2026-09-30T00:00:00+09:00', '2026-10-08')).toBe(8);
  });
});

describe('isJstBusinessDay', () => {
  // 2026-10-08 (木) 平日 / 2026-10-10 (土) / 2026-10-12 (月・スポーツの日)
  test('平日は true', () => {
    expect(isJstBusinessDay(new Date('2026-10-08T01:00:00Z'))).toBe(true); // JST 10:00
  });
  test('土曜は false（UTC 金曜 23 時 = JST 土曜 8 時）', () => {
    expect(isJstBusinessDay(new Date('2026-10-09T23:00:00Z'))).toBe(false);
  });
  test('祝日は false', () => {
    expect(isJstBusinessDay(new Date('2026-10-12T01:00:00Z'))).toBe(false);
  });
});

const today = '2026-10-08';
const base = (over) => ({
  id: `c-${Math.random()}`,
  file_name: 'x.mp4',
  status: '編集',
  final_deadline: '2026-10-01',
  force_delivered: false,
  projects: { director_id: null, producer_id: null, clients: { name: 'hertech', status: '進行中' } },
  creative_assignments: [],
  ...over,
});

describe('selectOverdue（進行ボードの提出遅れと同じ条件）', () => {
  test('納品日超過・未納品・制作側ボール だけ残る', () => {
    const rows = [
      base({ id: 'late' }),
      base({ id: 'delivered', status: '納品' }),
      base({ id: 'forced', force_delivered: true }),
      base({ id: 'client', status: 'クライアントチェック中' }),
      base({ id: 'today', final_deadline: today }),
      base({ id: 'future', final_deadline: '2026-10-20' }),
      base({ id: 'nodate', final_deadline: null }),
      base({ id: 'ended', projects: { clients: { status: 'クライアント取引終了' } } }),
      base({ id: 'dcheck', status: 'Dチェック' }),
      base({ id: 'hold', status: '保留' }),
    ];
    expect(selectOverdue(rows, today).map(c => c.id)).toEqual(['late', 'dcheck', 'hold']);
  });
});

describe('resolveManagerIds（getBallHolder と同じ優先順）', () => {
  const ctx = {
    directorIdByTeamId: new Map([['team-A', 'dir-team']]),
    directorIdByUserId: new Map([['ed-2', 'dir-team-by-user']]),
  };
  test('assignment の director / producer が最優先', () => {
    const c = base({
      projects: { director_id: 'dir-proj', producer_id: 'prod-proj' },
      creative_assignments: [
        { role: 'director', user_id: 'dir-a' }, { role: 'director', user_id: 'dir-b' },
        { role: 'producer', user_id: 'prod-a' },
        { role: 'editor', user_id: 'ed-1', users: { team_id: 'team-A' } },
      ],
    });
    const r = resolveManagerIds(c, ctx);
    expect(r.directorIds).toEqual(['dir-a', 'dir-b']);
    expect(r.producerIds).toEqual(['prod-a']);
    expect(r.all).toEqual(['dir-a', 'dir-b', 'prod-a']);
  });
  test('assignment が無ければ projects.director_id / producer_id', () => {
    const c = base({ projects: { director_id: 'dir-proj', producer_id: 'prod-proj' } });
    expect(resolveManagerIds(c, ctx).all).toEqual(['dir-proj', 'prod-proj']);
  });
  test('それも無ければ制作担当のチーム代表ディレクター（team_id → user_id の順）', () => {
    const viaTeam = base({ creative_assignments: [{ role: 'editor', user_id: 'ed-1', users: { team_id: 'team-A' } }] });
    expect(resolveManagerIds(viaTeam, ctx).all).toEqual(['dir-team']);
    const viaUser = base({ creative_assignments: [{ role: 'designer', user_id: 'ed-2', users: { team_id: null } }] });
    expect(resolveManagerIds(viaUser, ctx).all).toEqual(['dir-team-by-user']);
  });
  test('D と P が同一人物なら 1 回だけ', () => {
    const c = base({ projects: { director_id: 'same', producer_id: 'same' } });
    expect(resolveManagerIds(c).all).toEqual(['same']);
  });
  test('誰も解決できなければ空', () => {
    expect(resolveManagerIds(base()).all).toEqual([]);
  });
});

describe('groupByRecipient', () => {
  test('受信者ごとにまとめ、超過日数の大きい順', () => {
    const a = base({ id: 'a', final_deadline: '2026-10-05', projects: { director_id: 'd1', producer_id: 'p1' } });
    const b = base({ id: 'b', final_deadline: '2026-09-01', projects: { director_id: 'd1', producer_id: null } });
    const m = groupByRecipient([a, b], {}, today);
    expect(m.get('d1').map(c => c.id)).toEqual(['b', 'a']);
    expect(m.get('p1').map(c => c.id)).toEqual(['a']);
  });
});

describe('buildOverdueDigest', () => {
  const items = [
    base({ id: 'c1', file_name: '2609_GCI_01.mp4', status: 'Dチェック', final_deadline: '2026-09-30',
      creative_assignments: [{ role: 'editor', users: { nickname: 'パンセ', full_name: '山田 太郎' } }] }),
  ];
  const msg = buildOverdueDigest({
    recipient: { nickname: 'かおり', full_name: '川崎 かおり' },
    items, todayYmd: today,
    creativeUrl: id => `https://app.example/haruka.html?creative=${id}`,
    boardUrl: 'https://app.example/haruka.html?delayed=1',
  });
  test('件数・日付・3 つの対応・リンクを含む', () => {
    expect(msg.title).toBe('⏰ 提出遅れのクリエイティブ 1件（10/8時点）');
    expect(msg.count).toBe(1);
    expect(msg.body).toContain('かおりさん、お疲れさまです。');
    expect(msg.body).toContain('■ hertech / 2609_GCI_01.mp4');
    expect(msg.body).toContain('最終納品日 9/30（8日超過）・ステータス: Dチェック・担当: パンセ');
    expect(msg.body).toContain('https://app.example/haruka.html?creative=c1');
    expect(msg.body).toContain('① 日程が変わっただけ');
    expect(msg.body).toContain('② 実際は進んでいる');
    expect(msg.body).toContain('③ 問題があって進められない');
    expect(msg.body).toContain('進行ボード（遅延のみ表示）: https://app.example/haruka.html?delayed=1');
    expect(msg.chatwork.startsWith('[info][title]')).toBe(true);
    expect(msg.slack.startsWith('*⏰')).toBe(true);
  });
  test('件数が多いときは上限で切って「ほか N件」', () => {
    const many = Array.from({ length: MAX_ITEMS_IN_MESSAGE + 3 }, (_, i) => base({ id: `m${i}`, file_name: `f${i}` }));
    const m = buildOverdueDigest({ recipient: {}, items: many, todayYmd: today, creativeUrl: () => null, boardUrl: null });
    expect(m.count).toBe(MAX_ITEMS_IN_MESSAGE + 3);
    expect(m.body).toContain(`…ほか 3件`);
    expect(m.body).not.toContain(`f${MAX_ITEMS_IN_MESSAGE}`);
    expect(m.body).not.toContain('進行ボード（遅延のみ表示）');
  });
});

describe('buildSosMessage', () => {
  test('誰が・どの案件で・コメント付きで', () => {
    const m = buildSosMessage({ actorName: 'パンセ', clientName: '東大松尾研究所', projectName: 'GCI社会人', fileName: '2609_GCI_01.mp4', status: '編集', comment: '素材が届きません', url: 'https://x/haruka.html?creative=1' });
    expect(m.title).toBe('🆘 SOS: 2609_GCI_01.mp4');
    expect(m.body).toContain('パンセさんがクリエイティブに SOS を立てました');
    expect(m.body).toContain('クライアント: 東大松尾研究所 / 案件: GCI社会人');
    expect(m.body).toContain('コメント: 素材が届きません');
    expect(m.body).toContain('https://x/haruka.html?creative=1');
  });
});
