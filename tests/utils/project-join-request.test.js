const {
  normalizeJoinMessage,
  buildRecipientCandidates,
  validateRecipientIds,
  canDecideJoinRequest,
  buildJoinRequestMessage,
  buildJoinDecisionMessage,
  MESSAGE_MAX_LENGTH,
} = require('../../utils/project-join-request');

const users = new Map([
  ['p1', { id: 'p1', full_name: '川崎かおり', nickname: 'たごん', is_active: true }],
  ['d1', { id: 'd1', full_name: '髙橋聖', nickname: '', is_active: true }],
  ['a1', { id: 'a1', full_name: '管理 太郎', is_active: true }],
  ['a2', { id: 'a2', full_name: '退職 花子', is_active: false }],
  ['me', { id: 'me', full_name: '申請 者', is_active: true }],
]);

describe('normalizeJoinMessage', () => {
  test('必須で空は error', () => {
    expect(normalizeJoinMessage('   ').error).toBeTruthy();
    expect(normalizeJoinMessage(null).error).toBeTruthy();
  });
  test('任意なら空は空文字', () => {
    expect(normalizeJoinMessage('', { required: false })).toEqual({ value: '' });
  });
  test('CRLF を LF にして前後空白を除く（FormData の CRLF 化対策）', () => {
    expect(normalizeJoinMessage('  a\r\nb\rc ').value).toBe('a\nb\nc');
  });
  test('上限超過は error、ちょうどは OK', () => {
    expect(normalizeJoinMessage('x'.repeat(MESSAGE_MAX_LENGTH)).value).toHaveLength(MESSAGE_MAX_LENGTH);
    expect(normalizeJoinMessage('x'.repeat(MESSAGE_MAX_LENGTH + 1)).error).toMatch(/文字以内/);
  });
});

describe('buildRecipientCandidates', () => {
  test('P・D・管理者を並べ、P・D を既定チェック', () => {
    const list = buildRecipientCandidates({ project: { producer_id: 'p1', director_id: 'd1' }, users, adminIds: ['a1'] });
    expect(list.map(c => c.user_id)).toEqual(['d1', 'p1', 'a1']);
    expect(list.map(c => c.is_default)).toEqual([true, true, false]);
    expect(list[1].name).toBe('たごん（川崎かおり）');
  });
  test('同一人物は肩書きを連結して 1 件', () => {
    const list = buildRecipientCandidates({ project: { producer_id: 'd1', director_id: 'd1' }, users, adminIds: ['d1', 'a1'] });
    expect(list).toHaveLength(2);
    expect(list[0].label).toBe('D・P・管理者');
  });
  test('P・D 未設定の案件は管理者を既定に', () => {
    const list = buildRecipientCandidates({ project: {}, users, adminIds: ['a1'] });
    expect(list).toEqual([expect.objectContaining({ user_id: 'a1', is_default: true })]);
  });
  test('無効ユーザーと申請者本人は除く', () => {
    const list = buildRecipientCandidates({ project: { director_id: 'me' }, users, adminIds: ['a1', 'a2'], excludeUserId: 'me' });
    expect(list.map(c => c.user_id)).toEqual(['a1']);
  });
});

describe('validateRecipientIds', () => {
  const cands = [{ user_id: 'p1' }, { user_id: 'a1' }];
  test('空は error', () => {
    expect(validateRecipientIds([], cands).error).toBeTruthy();
    expect(validateRecipientIds(undefined, cands).error).toBeTruthy();
  });
  test('候補外は error', () => {
    expect(validateRecipientIds(['p1', 'zz'], cands).error).toBeTruthy();
  });
  test('重複を除いて返す', () => {
    expect(validateRecipientIds(['p1', 'p1', 'a1'], cands).value).toEqual(['p1', 'a1']);
  });
});

describe('canDecideJoinRequest', () => {
  const request = { recipient_ids: ['p1'] };
  test('宛先なら可', () => expect(canDecideJoinRequest({ request, userId: 'p1', isAdmin: false })).toBe(true));
  test('宛先外は不可', () => expect(canDecideJoinRequest({ request, userId: 'd1', isAdmin: false })).toBe(false));
  test('管理者は宛先外でも可', () => expect(canDecideJoinRequest({ request, userId: 'a1', isAdmin: true })).toBe(true));
});

describe('文面', () => {
  test('申請文面に申請者・案件・理由・URL', () => {
    const m = buildJoinRequestMessage({ requesterName: '山田', clientName: 'HGE', projectName: 'YouTube動画', message: '編集で入りたいです', url: 'https://x/y' });
    expect(m.title).toContain('YouTube動画');
    expect(m.body).toContain('山田さん');
    expect(m.body).toContain('申請理由: 編集で入りたいです');
    expect(m.chatwork).toMatch(/^\[info\]\[title\]/);
    expect(m.body.endsWith('https://x/y')).toBe(true);
  });
  test('承認文面（登録あり）', () => {
    const m = buildJoinDecisionMessage({ approved: true, deciderName: '髙橋', projectName: 'A', registered: true });
    expect(m.title).toContain('承認');
    expect(m.body).toContain('支払先メンバーとして登録済み');
  });
  test('却下文面にひとこと', () => {
    const m = buildJoinDecisionMessage({ approved: false, deciderName: '髙橋', projectName: 'A', note: '今回は人数が足りています' });
    expect(m.title).toContain('見送り');
    expect(m.body).toContain('ひとこと: 今回は人数が足りています');
  });
});
