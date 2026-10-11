// 投稿前チェック（ADR 050）: パネル用トークンとチェック全体の組み立て
jest.mock('../../supabase', () => ({}));
jest.mock('../../lib/precheck/rules', () => {
  const actual = jest.requireActual('../../lib/precheck/rules');
  return {
    ...actual,
    loadRules: jest.fn(async () => actual.parseRules([
      ['No', '対象ファイル', '項目', '指摘内容', '備考', '判定方法', '誤', '正'],
      ['42', '動画編集', 'テロップ専門用語誤字', '帯金→帯筋', '', '辞書', '帯金', '帯筋'],
      ['8', '動画編集', 'テロップ', '口語体はNG', '', 'AI', '', ''],
      ['34', '動画編集', '切り抜き箇所', 'コアな部分のみ', '', '人', '', ''],
    ])),
    loadVideoInfo: jest.fn(async (set, code) => (code === 'K-002-1' ? { code, field: '建築' } : null)),
  };
});
jest.mock('../../lib/precheck/ai', () => ({
  judge: jest.fn(async () => ({
    findings: [{ rule_no: 8, method: 'AI', severity: 'warn', source: 'telop', telop_index: 1, time_sec: 3, quote: '夏は涼しいのよ', reason: '口語体', suggestion: '夏は涼しい' }],
    model: 'gemini-3.8-flash', costJpy: 1.2,
  })),
}));

const { issueToken, verifyToken, MAX_AGE_SEC } = require('../../lib/precheck/token');
const { runCheck, detectCode, cleanTelops } = require('../../lib/precheck/check');
const ai = require('../../lib/precheck/ai');
const { getSet } = require('../../lib/precheck/sets');

describe('token', () => {
  const now = 1_800_000_000;
  test('発行したトークンは同じ鍵で検証できる', () => {
    const t = issueToken('user-1', 'secret', now);
    expect(t.startsWith('hfpc1.user-1.')).toBe(true);
    expect(verifyToken(t, 'secret', now + 10)).toEqual({ userId: 'user-1', issuedAt: now });
  });
  test('鍵が違う・書き換えられた・期限切れは null', () => {
    const t = issueToken('user-1', 'secret', now);
    expect(verifyToken(t, 'other', now)).toBeNull();
    expect(verifyToken(t.replace('user-1', 'user-2'), 'secret', now)).toBeNull();
    expect(verifyToken(t, 'secret', now + MAX_AGE_SEC + 1)).toBeNull();
    expect(verifyToken('garbage', 'secret', now)).toBeNull();
  });
});

describe('runCheck', () => {
  beforeEach(() => ai.judge.mockClear());

  test('辞書（✕）を先、AI（△）を後に並べ、確認欄も返す', async () => {
    const r = await runCheck({
      set: 'higegoro-clip',
      sequence_name: 'K-002-1_腰壁と垂れ壁_v3',
      telops: [{ index: 0, start: 1, text: '帯金の間隔' }, { index: 1, start: 3, text: '夏は涼しいのよ' }],
    });
    expect(r.code).toBe('K-002-1');
    expect(r.video).toEqual({ code: 'K-002-1', field: '建築' });
    expect(r.counts).toMatchObject({ error: 1, warn: 1, telops: 2 });
    expect(r.findings.map(f => f.rule_no)).toEqual([42, 8]);
    expect(r.manual.map(m => m.rule_no)).toEqual([34]);
    expect(r.ai).toEqual({ model: 'gemini-3.8-flash', cost_jpy: 1.2 });
    expect(ai.judge.mock.calls[0][0].rules.map(x => x.no)).toEqual([8]);
  });

  test('AI が失敗しても辞書の結果は返す', async () => {
    ai.judge.mockRejectedValueOnce(new Error('timeout'));
    const r = await runCheck({ set: 'higegoro-clip', telops: [{ index: 0, text: '帯金' }] });
    expect(r.counts.error).toBe(1);
    expect(r.ai_error).toBe('timeout');
  });

  test('知らない案件は 400', async () => {
    await expect(runCheck({ set: 'nope' })).rejects.toMatchObject({ status: 400 });
  });

  test('空のテロップは捨て、件数の上限で切る', () => {
    expect(cleanTelops([{ text: '' }, { text: 'a' }])).toHaveLength(1);
    expect(cleanTelops(Array.from({ length: 500 }, () => ({ text: 'x' })))).toHaveLength(400);
  });

  test('シーケンス名から管理番号を拾う', () => {
    const set = getSet('higegoro-clip');
    expect(detectCode(set, '【納品】D-012-2 土工')).toBe('D-012-2');
    expect(detectCode(set, 'シーケンス 01')).toBeNull();
    expect(detectCode(set, 'x', 'K-001-1')).toBe('K-001-1');
  });
});
