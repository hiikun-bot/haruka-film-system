// utils/creative-permissions.js（クリエイティブの削除・担当者の変更・編集の権限判定）
const P = require('../../utils/creative-permissions');

const project = { director_id: 'dir', producer_id: 'prd', sub_director_ids: ['subd'], sub_producer_ids: ['subp'] };

describe('normalizeCreativeIds', () => {
  test('重複を除き、前後の空白を落とす', () => {
    expect(P.normalizeCreativeIds(['a', ' a ', 'b'])).toEqual({ ok: true, ids: ['a', 'b'] });
  });
  test('空・配列でない・文字列でない値は 1 件でも ok:false', () => {
    expect(P.normalizeCreativeIds([]).ok).toBe(false);
    expect(P.normalizeCreativeIds('a').ok).toBe(false);
    expect(P.normalizeCreativeIds(['a', null]).ok).toBe(false);
    expect(P.normalizeCreativeIds(['a', { id: 'b' }]).ok).toBe(false);
    expect(P.normalizeCreativeIds(['a', '  ']).ok).toBe(false);
  });
  test('上限を超えると ok:false', () => {
    expect(P.normalizeCreativeIds(['a', 'b', 'c'], { max: 2 }).ok).toBe(false);
  });
});

describe('judgeCreativeDelete', () => {
  const creatives = [
    { id: 'c1', file_name: 'A', status: '制作中', projects: project },
    { id: 'c2', file_name: 'B', status: '納品', projects: project },
  ];
  test('権限者（admin 等）は全件見つかれば可', () => {
    expect(P.judgeCreativeDelete({ canManageAll: true, userId: 'adm', ids: ['c1', 'c2'], creatives, myRolesByCreative: new Map() }).allowed).toBe(true);
  });
  test('権限者でも見つからない id が混ざれば不可（何も消さない）', () => {
    const j = P.judgeCreativeDelete({ canManageAll: true, userId: 'adm', ids: ['c1', 'zz'], creatives: [creatives[0]], myRolesByCreative: new Map() });
    expect(j.allowed).toBe(false);
    expect(j.missing).toEqual(['zz']);
  });
  test('案件の担当 D（サブDも）は納品済みも可', () => {
    expect(P.judgeCreativeDelete({ canManageAll: false, userId: 'dir', ids: ['c1', 'c2'], creatives, myRolesByCreative: new Map() }).allowed).toBe(true);
    expect(P.judgeCreativeDelete({ canManageAll: false, userId: 'subd', ids: ['c1', 'c2'], creatives, myRolesByCreative: new Map() }).allowed).toBe(true);
  });
  test('担当の編集者は納品前だけ。納品済みが混ざれば全体を不可', () => {
    const roles = new Map([['c1', ['editor']], ['c2', ['editor']]]);
    expect(P.judgeCreativeDelete({ canManageAll: false, userId: 'ed', ids: ['c1'], creatives: [creatives[0]], myRolesByCreative: roles }).allowed).toBe(true);
    const j = P.judgeCreativeDelete({ canManageAll: false, userId: 'ed', ids: ['c1', 'c2'], creatives, myRolesByCreative: roles });
    expect(j.allowed).toBe(false);
    expect(j.notAllowed).toEqual(['B（納品済み）']);
  });
  test('担当でない人は不可。見つからない id が混ざっても不可', () => {
    expect(P.judgeCreativeDelete({ canManageAll: false, userId: 'x', ids: ['c1'], creatives: [creatives[0]], myRolesByCreative: new Map() }).allowed).toBe(false);
    const roles = new Map([['c1', ['editor']]]);
    const j = P.judgeCreativeDelete({ canManageAll: false, userId: 'ed', ids: ['c1', 'zz'], creatives: [creatives[0]], myRolesByCreative: roles });
    expect(j.allowed).toBe(false);
    expect(j.missing).toEqual(['zz']);
  });
  test('ログインユーザーが分からなければ不可', () => {
    expect(P.judgeCreativeDelete({ canManageAll: false, userId: null, ids: ['c1'], creatives: [creatives[0]], myRolesByCreative: new Map() }).allowed).toBe(false);
  });
});

describe('judgeCreativeEdit（素材フォルダURL など）', () => {
  test('権限者・案件の D/P・チームのリーダー・担当者は可', () => {
    expect(P.judgeCreativeEdit({ canManageAll: true, userId: 'x' }).allowed).toBe(true);
    expect(P.judgeCreativeEdit({ canManageAll: false, userId: 'subp', project }).allowed).toBe(true);
    expect(P.judgeCreativeEdit({ canManageAll: false, userId: 'tl', project, team: { director_id: 'tl' } }).allowed).toBe(true);
    expect(P.judgeCreativeEdit({ canManageAll: false, userId: 'ed', project, myRoles: ['editor'] }).allowed).toBe(true);
  });
  test('担当外は不可', () => {
    expect(P.judgeCreativeEdit({ canManageAll: false, userId: 'x', project, team: null, myRoles: [] }).allowed).toBe(false);
  });
});

describe('judgeAssignmentChange', () => {
  test('権限者・案件の D/P・チームのリーダー・D/P 担当は何でも可（自分を D に入れるのも可）', () => {
    expect(P.judgeAssignmentChange({ canManageAll: true, userId: 'x', selfAdds: ['director'] }).allowed).toBe(true);
    expect(P.judgeAssignmentChange({ canManageAll: false, userId: 'dir', project, myRoles: [], selfAdds: ['producer'] }).allowed).toBe(true);
    expect(P.judgeAssignmentChange({ canManageAll: false, userId: 'tl', project, team: { producer_id: 'tl' }, myRoles: [], selfAdds: ['editor'] }).allowed).toBe(true);
    expect(P.judgeAssignmentChange({ canManageAll: false, userId: 'd2', project, myRoles: ['director'], selfAdds: ['director'] }).allowed).toBe(true);
  });
  test('担当でも案件の D/P でもない人は、自分を担当に足すことも含めて不可', () => {
    const j = P.judgeAssignmentChange({ canManageAll: false, userId: 'x', project, myRoles: [], myRoleCodes: ['editor'], selfAdds: ['editor'] });
    expect(j).toEqual({ allowed: false, reason: 'not_related' });
    expect(P.judgeAssignmentChange({ canManageAll: false, userId: 'x', project, myRoles: [], myRoleCodes: ['director'], selfAdds: [] }).allowed).toBe(false);
  });
  test('担当の編集者は Dチェック依頼先（他人）の指定や担当の付け替えは可', () => {
    expect(P.judgeAssignmentChange({ canManageAll: false, userId: 'ed', project, myRoles: ['editor'], myRoleCodes: ['editor'], selfAdds: [] }).allowed).toBe(true);
    expect(P.judgeAssignmentChange({ canManageAll: false, userId: 'ed', project, myRoles: ['editor'], myRoleCodes: ['editor'], selfAdds: ['editor'] }).allowed).toBe(true);
  });
  test('担当の編集者は自分を D/P 担当に足せない', () => {
    expect(P.judgeAssignmentChange({ canManageAll: false, userId: 'ed', project, myRoles: ['editor'], myRoleCodes: ['editor'], selfAdds: ['director'] }))
      .toEqual({ allowed: false, reason: 'self_leader', role: 'director' });
    expect(P.judgeAssignmentChange({ canManageAll: false, userId: 'ed', project, myRoles: ['designer'], myRoleCodes: ['designer'], selfAdds: ['producer'] }).allowed).toBe(false);
  });
  test('実効ロールが director の担当者（director_as_editor 等）は自分を D に入れられる。PD は P も可', () => {
    expect(P.judgeAssignmentChange({ canManageAll: false, userId: 'de', project, myRoles: ['director_as_editor'], myRoleCodes: ['director'], selfAdds: ['director'] }).allowed).toBe(true);
    expect(P.judgeAssignmentChange({ canManageAll: false, userId: 'pd', project, myRoles: ['editor'], myRoleCodes: ['producer_director'], selfAdds: ['producer'] }).allowed).toBe(true);
  });
});
