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
  test('権限者（削除権限あり）・案件の D/P・D/P 担当は何でも可（自分を D に入れるのも可）。チームのリーダーは他の人なら可', () => {
    expect(P.judgeAssignmentChange({ canManageAll: true, canDeleteAll: true, userId: 'x', selfAdds: ['director'] }).allowed).toBe(true);
    expect(P.judgeAssignmentChange({ canManageAll: false, userId: 'dir', project, myRoles: [], selfAdds: ['producer'] }).allowed).toBe(true);
    expect(P.judgeAssignmentChange({ canManageAll: false, userId: 'tl', project, team: { producer_id: 'tl' }, myRoles: [], selfAdds: [] }).allowed).toBe(true);
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
  test('producer_director として自分を足すには director・producer の両方が要る', () => {
    expect(P.judgeAssignmentChange({ canManageAll: false, userId: 'ed', project, myRoles: ['editor'], myRoleCodes: ['editor'], selfAdds: ['producer_director'] }).allowed).toBe(false);
    expect(P.judgeAssignmentChange({ canManageAll: false, userId: 'd', project, myRoles: ['editor'], myRoleCodes: ['director'], selfAdds: ['producer_director'] }).allowed).toBe(false);
    expect(P.judgeAssignmentChange({ canManageAll: false, userId: 'pd', project, myRoles: ['editor'], myRoleCodes: ['producer_director'], selfAdds: ['producer_director'] }).allowed).toBe(true);
  });
  test('担当に入っていないチームのリーダーは他の人の担当は決められるが、自分を入れることはできない', () => {
    const team = { director_id: 'tl' };
    expect(P.judgeAssignmentChange({ canManageAll: false, userId: 'tl', project, team, myRoles: [], myRoleCodes: ['editor'], selfAdds: [] }).allowed).toBe(true);
    expect(P.judgeAssignmentChange({ canManageAll: false, userId: 'tl', project, team, myRoles: [], myRoleCodes: ['director'], selfAdds: ['director'] }).allowed).toBe(false);
    expect(P.judgeAssignmentChange({ canManageAll: false, userId: 'tl', project, team, myRoles: [], myRoleCodes: ['editor'], selfAdds: ['designer'] }).allowed).toBe(false);
    expect(P.judgeAssignmentChange({ canManageAll: false, userId: 'tl', project, team, myRoles: [], myRoleCodes: ['editor'], selfAdds: ['editor'] }).allowed).toBe(false);
  });
  test('Wチェック担当は自分を制作担当（editor）にできない。デザイナー担当は自分の行の付け替え（editor）なら可', () => {
    expect(P.judgeAssignmentChange({ canManageAll: false, userId: 'w', project, myRoles: ['wcheck'], myRoleCodes: ['designer'], selfAdds: ['editor'] }))
      .toEqual({ allowed: false, reason: 'self_add', role: 'editor' });
    expect(P.judgeAssignmentChange({ canManageAll: false, userId: 'ds', project, myRoles: ['designer'], myRoleCodes: ['designer'], selfAdds: ['editor'] }).allowed).toBe(true);
    expect(P.judgeAssignmentChange({ canManageAll: false, userId: 'ds', project, myRoles: ['designer'], myRoleCodes: ['designer'], selfAdds: ['wcheck'] }).allowed).toBe(false);
  });
  test('案件編集の権限があっても削除の権限が無い人は、実効ロールが D/P でなければ自分を D/P に足せない', () => {
    expect(P.judgeAssignmentChange({ canManageAll: true, canDeleteAll: false, userId: 's', myRoles: [], myRoleCodes: ['secretary'], selfAdds: ['director'] }).allowed).toBe(false);
    expect(P.judgeAssignmentChange({ canManageAll: true, canDeleteAll: true, userId: 's', myRoles: [], myRoleCodes: ['secretary'], selfAdds: ['director'] }).allowed).toBe(true);
    expect(P.judgeAssignmentChange({ canManageAll: true, canDeleteAll: false, userId: 's', myRoles: [], myRoleCodes: ['secretary'], selfAdds: ['editor'] }).allowed).toBe(true);
  });
  test('実効ロールが director の担当者（director_as_editor 等）は自分を D に入れられる。PD は P も可', () => {
    expect(P.judgeAssignmentChange({ canManageAll: false, userId: 'de', project, myRoles: ['director_as_editor'], myRoleCodes: ['director'], selfAdds: ['director'] }).allowed).toBe(true);
    expect(P.judgeAssignmentChange({ canManageAll: false, userId: 'pd', project, myRoles: ['editor'], myRoleCodes: ['producer_director'], selfAdds: ['producer'] }).allowed).toBe(true);
  });
});

describe('diffAssignmentInput（PUT の担当者入力を今の担当行と比べる）', () => {
  const current = {
    team_id: 't1',
    assignments: [
      { user_id: 'ed', role: 'editor' },
      { user_id: 'dir', role: 'director' },
    ],
  };
  test('同じ担当者・同じ顔ぶれ・同じチームを送っても変更なし', () => {
    expect(P.diffAssignmentInput({ assignee_id: 'ed', director_ids: ['dir', 'dir'], team_id: 't1' }, current, 'x'))
      .toEqual({ changed: [], selfAdds: [] });
  });
  test('P 担当がいないときの空配列は変更なし。D がいるときの空配列は「全員外す」変更', () => {
    expect(P.diffAssignmentInput({ producer_ids: [] }, current, 'x').changed).toEqual([]);
    expect(P.diffAssignmentInput({ director_ids: [] }, current, 'x').changed).toEqual(['director']);
  });
  test('担当者の入れ替え・チームの付け替えは変更。自分が新しく入る役割を selfAdds に出す', () => {
    expect(P.diffAssignmentInput({ assignee_id: 'me' }, current, 'me')).toEqual({ changed: ['editor'], selfAdds: ['editor'] });
    expect(P.diffAssignmentInput({ assignee_id: null }, current, 'me')).toEqual({ changed: ['editor'], selfAdds: [] });
    expect(P.diffAssignmentInput({ director_ids: ['dir', 'me'], wcheck_ids: ['me'] }, current, 'me'))
      .toEqual({ changed: ['director', 'wcheck'], selfAdds: ['director', 'wcheck'] });
    expect(P.diffAssignmentInput({ team_id: 't2' }, current, 'me').changed).toEqual(['team']);
    expect(P.diffAssignmentInput({ team_id: '' }, { assignments: [], team_id: null }, 'me').changed).toEqual([]);
  });
  test('送られていない項目（undefined）は比べない', () => {
    expect(P.diffAssignmentInput({}, current, 'me')).toEqual({ changed: [], selfAdds: [] });
  });
});
