const {
  PORTFOLIO_NOTIFY_TYPES,
  PORTFOLIO_NOTIFY_WINDOW_MS,
  summarizeReactions,
  buildPortfolioSocialMap,
  emptyPortfolioSocial,
  resolvePortfolioNotifyRecipients,
  isPortfolioNotifySuppressed,
  portfolioNotifyWindowStart,
  buildPortfolioNotification,
} = require('../../utils/portfolio-reactions');
const { REACTIONS, REACTION_TYPES, isReactionType } = require('../../utils/reactions');

describe('utils/reactions（つぶやきと作品で共通の 5 種）', () => {
  test('5 種が定義され、type / emoji / label を持つ', () => {
    expect(REACTIONS).toHaveLength(5);
    expect(REACTION_TYPES).toEqual(['good', 'heart', 'clap', 'smile', 'surprised']);
    REACTIONS.forEach(r => {
      expect(r.type).toBeTruthy();
      expect(r.emoji).toBeTruthy();
      expect(r.label).toBeTruthy();
    });
  });

  test('isReactionType は 5 種以外を弾く', () => {
    expect(isReactionType('clap')).toBe(true);
    expect(isReactionType('like')).toBe(false);
    expect(isReactionType('')).toBe(false);
    expect(isReactionType(null)).toBe(false);
  });
});

describe('summarizeReactions', () => {
  test('種別ごとの件数と自分の押したものを返す（未使用の種別は 0）', () => {
    const rows = [
      { user_id: 'u1', reaction_type: 'clap' },
      { user_id: 'u2', reaction_type: 'clap' },
      { user_id: 'u1', reaction_type: 'heart' },
    ];
    const s = summarizeReactions(rows, 'u1');
    expect(s.counts).toEqual({ good: 0, heart: 1, clap: 2, smile: 0, surprised: 0 });
    expect(s.my_reactions).toEqual(['heart', 'clap']);   // 定義順で返す
    expect(s.total).toBe(3);
  });

  test('未知の種別は無視する・自分が居なければ my_reactions は空', () => {
    const s = summarizeReactions([{ user_id: 'u2', reaction_type: 'like' }], 'u1');
    expect(s.total).toBe(0);
    expect(s.my_reactions).toEqual([]);
  });

  test('空・null でも壊れない', () => {
    expect(summarizeReactions(null, 'u1').total).toBe(0);
    expect(summarizeReactions([], null).my_reactions).toEqual([]);
  });
});

describe('buildPortfolioSocialMap（一覧 API 用の一括集計）', () => {
  test('creative ごとに reactions / my_reactions / comment_count をまとめる', () => {
    const reactions = [
      { creative_id: 'c1', user_id: 'u1', reaction_type: 'clap' },
      { creative_id: 'c1', user_id: 'u2', reaction_type: 'clap' },
      { creative_id: 'c2', user_id: 'u2', reaction_type: 'heart' },
    ];
    const comments = [{ creative_id: 'c1' }, { creative_id: 'c1' }, { creative_id: 'c3' }];
    const m = buildPortfolioSocialMap(reactions, comments, 'u1');
    expect(m.get('c1')).toEqual({
      reactions: { good: 0, heart: 0, clap: 2, smile: 0, surprised: 0 },
      my_reactions: ['clap'],
      reaction_total: 2,
      comment_count: 2,
    });
    expect(m.get('c2').my_reactions).toEqual([]);
    expect(m.get('c2').reaction_total).toBe(1);
    // ひとことだけの作品もエントリを持つ
    expect(m.get('c3').comment_count).toBe(1);
    expect(m.get('c3').reaction_total).toBe(0);
    expect(m.has('c9')).toBe(false);
  });

  test('emptyPortfolioSocial は全 0 の既定値', () => {
    expect(emptyPortfolioSocial()).toEqual({
      reactions: { good: 0, heart: 0, clap: 0, smile: 0, surprised: 0 },
      my_reactions: [],
      reaction_total: 0,
      comment_count: 0,
    });
  });
});

describe('resolvePortfolioNotifyRecipients（通知の宛先＝制作担当）', () => {
  const assignments = [
    { role: 'editor',    users: { id: 'ed1' } },
    { role: 'designer',  user_id: 'ds1' },
    { role: 'director',  users: { id: 'dir1' } },
    { role: 'producer',  users: { id: 'pr1' } },   // チェック側 → 対象外
    { role: 'wcheck',    users: { id: 'wc1' } },   // チェック側 → 対象外
    { role: 'director_as_editor', users: { id: 'dae1' } },
  ];

  test('editor / designer / director / director_as_editor に届き、producer / wcheck には届かない', () => {
    const ids = resolvePortfolioNotifyRecipients({ assignments, deliveredDirectorIds: null, actorId: 'someone' });
    expect(ids).toEqual(['ed1', 'ds1', 'dir1', 'dae1']);
  });

  test('納品時スナップショットの director も加える（重複は除く）', () => {
    const ids = resolvePortfolioNotifyRecipients({
      assignments, deliveredDirectorIds: ['dir1', 'dir_old'], actorId: 'someone',
    });
    expect(ids).toEqual(['ed1', 'ds1', 'dir1', 'dae1', 'dir_old']);
  });

  test('アクター本人は除外する（自分の作品に自分で押しても通知しない）', () => {
    const ids = resolvePortfolioNotifyRecipients({ assignments, deliveredDirectorIds: ['ed1'], actorId: 'ed1' });
    expect(ids).not.toContain('ed1');
    expect(ids).toEqual(['ds1', 'dir1', 'dae1']);
  });

  test('担当が居なければ空', () => {
    expect(resolvePortfolioNotifyRecipients({ assignments: [], deliveredDirectorIds: [], actorId: 'x' })).toEqual([]);
    expect(resolvePortfolioNotifyRecipients({ assignments: null, deliveredDirectorIds: null, actorId: 'x' })).toEqual([]);
  });
});

describe('isPortfolioNotifySuppressed（連打対策: 同じ人×同じ作品×同じ種別は 1 日 1 回）', () => {
  const now = new Date('2026-09-03T12:00:00+09:00');

  test('直近 24 時間以内に送っていれば抑制する', () => {
    expect(isPortfolioNotifySuppressed({ lastSentAt: '2026-09-03T11:00:00+09:00', now })).toBe(true);
    expect(isPortfolioNotifySuppressed({ lastSentAt: '2026-09-02T12:00:01+09:00', now })).toBe(true);
  });

  test('24 時間を過ぎていれば送る', () => {
    expect(isPortfolioNotifySuppressed({ lastSentAt: '2026-09-02T12:00:00+09:00', now })).toBe(false);
    expect(isPortfolioNotifySuppressed({ lastSentAt: '2026-08-01T00:00:00Z', now })).toBe(false);
  });

  test('履歴が無い / 不正な日時なら送る', () => {
    expect(isPortfolioNotifySuppressed({ lastSentAt: null, now })).toBe(false);
    expect(isPortfolioNotifySuppressed({ lastSentAt: 'not-a-date', now })).toBe(false);
  });

  test('portfolioNotifyWindowStart は now − 24h の ISO', () => {
    expect(portfolioNotifyWindowStart(now)).toBe(new Date(now.getTime() - PORTFOLIO_NOTIFY_WINDOW_MS).toISOString());
    expect(portfolioNotifyWindowStart(now)).toBe('2026-09-02T03:00:00.000Z');
  });
});

describe('buildPortfolioNotification（通知の文面とリンク）', () => {
  test('拍手: 絵文字入りの見出しと作品ページへのディープリンク', () => {
    const n = buildPortfolioNotification({
      kind: 'reaction', actorName: '川崎かおり', creativeId: 'c1',
      fileName: '◯◯商事 縦動画 v3', reactionType: 'clap',
    });
    expect(n.type).toBe(PORTFOLIO_NOTIFY_TYPES.reaction);
    expect(n.title).toBe('川崎かおりさんが「◯◯商事 縦動画 v3」に👏');
    expect(n.body).toBeNull();
    expect(n.linkUrl).toBe('/haruka.html?portfolio=c1');
  });

  test('ひとこと: 本文を 80 字で省略して body に載せる', () => {
    const long = 'あ'.repeat(100);
    const n = buildPortfolioNotification({
      kind: 'comment', actorName: 'ぴょん', creativeId: 'c2', fileName: 'テロップ動画', commentBody: long,
    });
    expect(n.type).toBe(PORTFOLIO_NOTIFY_TYPES.comment);
    expect(n.title).toBe('ぴょんさんが「テロップ動画」にひとこと');
    expect(n.body).toBe('あ'.repeat(80) + '…');
  });

  test('作品名が長ければ見出し側も省略、名前が無ければ「誰か」', () => {
    const n = buildPortfolioNotification({
      kind: 'reaction', actorName: '', creativeId: 'c3', fileName: 'x'.repeat(60), reactionType: 'heart',
    });
    expect(n.title.startsWith('誰かさんが「' + 'x'.repeat(40) + '…」に')).toBe(true);
  });
});
