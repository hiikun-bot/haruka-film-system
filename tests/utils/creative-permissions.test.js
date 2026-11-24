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
  test('担当者の欄はデザイナー（designer 行）も制作担当として比べる（同じ人なら変更なし）', () => {
    const designerCur = { team_id: null, assignments: [{ user_id: 'des', role: 'designer' }] };
    expect(P.diffAssignmentInput({ assignee_id: 'des' }, designerCur, 'des')).toEqual({ changed: [], selfAdds: [] });
    expect(P.diffAssignmentInput({ assignee_id: 'x' }, designerCur, 'x')).toEqual({ changed: ['editor'], selfAdds: ['editor'] });
    // 空は従来どおり editor 行だけを外す（designer 行は残る＝変更なし）
    expect(P.diffAssignmentInput({ assignee_id: '' }, designerCur, 'des')).toEqual({ changed: [], selfAdds: [] });
  });
});

describe('planWorkerAssigneeSync（担当者の欄＝制作担当 1 人）', () => {
  test('同じ人がすでに制作担当（designer）なら何もしない', () => {
    expect(P.planWorkerAssigneeSync([{ id: 'r1', user_id: 'a', role: 'designer' }], 'a'))
      .toEqual({ insert: null, deleteRowIds: [], changed: false });
  });
  test('デザイナー 1 人の作品を別の人に替えると designer として入れ替える（designer＋editor の 2 人にしない）', () => {
    expect(P.planWorkerAssigneeSync([{ id: 'r1', user_id: 'a', role: 'designer' }], 'b'))
      .toEqual({ insert: { user_id: 'b', role: 'designer' }, deleteRowIds: ['r1'], changed: true });
  });
  test('それ以外は従来どおり editor 行を入れ替える（director_as_editor・担当なし）', () => {
    expect(P.planWorkerAssigneeSync([{ id: 'r1', user_id: 'a', role: 'director_as_editor' }], 'b'))
      .toEqual({ insert: { user_id: 'b', role: 'editor' }, deleteRowIds: [], changed: true });
    expect(P.planWorkerAssigneeSync([{ id: 'r1', user_id: 'a', role: 'editor' }], 'b'))
      .toEqual({ insert: { user_id: 'b', role: 'editor' }, deleteRowIds: ['r1'], changed: true });
    expect(P.planWorkerAssigneeSync([], 'b')).toEqual({ insert: { user_id: 'b', role: 'editor' }, deleteRowIds: [], changed: true });
  });
  test('editor と designer が別の人: 担当者を変えない保存（editor の人を送る）では designer の人を消さない', () => {
    const rows = [{ id: 'e1', user_id: 'e', role: 'editor' }, { id: 'g1', user_id: 'g', role: 'designer' }];
    expect(P.planWorkerAssigneeSync(rows, 'e')).toEqual({ insert: null, deleteRowIds: [], changed: false });
    // designer の人を選ぶと、editor 行（ほかの人）だけ外れて designer 行は残る（従来の「editor は選ばれた 1 人」から重複を除いた結果）
    expect(P.planWorkerAssigneeSync(rows, 'g')).toEqual({ insert: null, deleteRowIds: ['e1'], changed: true });
  });
  test('同じ人の重複行（designer＋editor）は最初の 1 行に寄せる', () => {
    expect(P.planWorkerAssigneeSync([
      { id: 'r1', user_id: 'a', role: 'designer' }, { id: 'r2', user_id: 'a', role: 'editor' },
    ], 'a')).toEqual({ insert: null, deleteRowIds: ['r2'], changed: true });
  });
  test('空は従来どおり editor 行だけを外す（designer・director_as_editor・制作以外の行は残す）', () => {
    expect(P.planWorkerAssigneeSync([{ id: 'r1', user_id: 'a', role: 'editor' }, { id: 'd1', user_id: 'd', role: 'director' }], null))
      .toEqual({ insert: null, deleteRowIds: ['r1'], changed: true });
    expect(P.planWorkerAssigneeSync([{ id: 'g1', user_id: 'g', role: 'designer' }], null)).toEqual({ insert: null, deleteRowIds: [], changed: false });
    expect(P.planWorkerAssigneeSync([{ id: 'd1', user_id: 'd', role: 'director' }], '')).toEqual({ insert: null, deleteRowIds: [], changed: false });
  });
  test('大文字・空白の違う同じ ID は同じ人', () => {
    expect(P.planWorkerAssigneeSync([{ id: 'r1', user_id: 'abc', role: 'editor' }], ' ABC ').changed).toBe(false);
  });
});

describe('creativeUiPermissions（画面の出し分け・judge* と同じ条件）', () => {
  const cr = { id: 'c1', file_name: 'C1', status: '制作中' };
  const delivered = { id: 'c2', file_name: 'C2', status: '納品', delivered_at: '2026-11-01T00:00:00Z' };
  test('admin（案件編集＋削除の権限）: 全部 true', () => {
    expect(P.creativeUiPermissions({ canManageAll: true, canDeleteAll: true, userId: 'adm', project, team: null, myRoles: [], creative: delivered }))
      .toEqual({ can_edit: true, can_edit_assignees: true, can_delete: true });
  });
  test('案件の担当 D: 全部 true（納品済みも削除できる）', () => {
    expect(P.creativeUiPermissions({ canManageAll: false, canDeleteAll: false, userId: 'dir', project, team: null, myRoles: [], creative: delivered }))
      .toEqual({ can_edit: true, can_edit_assignees: true, can_delete: true });
  });
  test('担当の編集者: 編集・担当者は true、削除は納品前だけ', () => {
    const base = { canManageAll: false, canDeleteAll: false, userId: 'ed', project, team: null, myRoles: ['editor'] };
    expect(P.creativeUiPermissions({ ...base, creative: cr })).toEqual({ can_edit: true, can_edit_assignees: true, can_delete: true });
    expect(P.creativeUiPermissions({ ...base, creative: delivered })).toEqual({ can_edit: true, can_edit_assignees: true, can_delete: false });
  });
  test('チームのリーダー（担当外）: 編集・担当者は true、削除は false', () => {
    expect(P.creativeUiPermissions({ canManageAll: false, canDeleteAll: false, userId: 'tl', project, team: { director_id: 'tl' }, myRoles: [], creative: cr }))
      .toEqual({ can_edit: true, can_edit_assignees: true, can_delete: false });
  });
  test('担当外: 全部 false。ログインしていなければ全部 false', () => {
    expect(P.creativeUiPermissions({ canManageAll: false, canDeleteAll: false, userId: 'x', project, team: null, myRoles: [], creative: cr }))
      .toEqual({ can_edit: false, can_edit_assignees: false, can_delete: false });
    expect(P.creativeUiPermissions({ canManageAll: false, canDeleteAll: false, userId: null, project, team: null, myRoles: [], creative: cr }))
      .toEqual({ can_edit: false, can_edit_assignees: false, can_delete: false });
  });
  test('案件編集の権限はあるが削除の権限が無い（project.create_edit のみ）: 削除は false', () => {
    expect(P.creativeUiPermissions({ canManageAll: true, canDeleteAll: false, userId: 'sec', project, team: null, myRoles: [], creative: cr }))
      .toEqual({ can_edit: true, can_edit_assignees: true, can_delete: false });
  });
});

describe('normId / sameId（本人判定の ID 正規化）', () => {
  test('文字列化して前後の空白を落とす。空は null', () => {
    expect(P.normId(' u1 ')).toBe('u1');
    expect(P.normId(12)).toBe('12');
    expect(P.normId('  ')).toBeNull();
    expect(P.normId(null)).toBeNull();
    expect(P.sameId(' u1', 'u1 ')).toBe(true);
    expect(P.sameId(null, null)).toBe(false);
  });
  test('案件の D/P・チームのリーダー・差分判定も正規化して比べる', () => {
    expect(P.isProjectLeader({ director_id: 'dir ' }, ' dir')).toBe(true);
    expect(P.isProjectLeader({ sub_director_ids: [' subd'] }, 'subd')).toBe(true);
    expect(P.isTeamLeader({ producer_id: 'p1' }, ' p1 ')).toBe(true);
    const d = P.diffAssignmentInput({ assignee_id: ' ed ', director_ids: ['dir '] },
      { assignments: [{ user_id: 'ed', role: 'editor' }, { user_id: 'dir', role: 'director' }] }, 'ed');
    expect(d).toEqual({ changed: [], selfAdds: [] });
    const d2 = P.diffAssignmentInput({ director_ids: [' me '] }, { assignments: [] }, 'me');
    expect(d2.selfAdds).toEqual(['director']);
  });
});

describe('planAssignmentSync（担当行の差分だけ書く）', () => {
  const rows = [{ id: 'r1', user_id: 'a' }, { id: 'r2', user_id: 'b' }];
  test('顔ぶれが同じなら何も書かない（順番・重複・空白は無視）', () => {
    expect(P.planAssignmentSync(rows, ['b ', 'a', 'a', ''])).toEqual({ insertUserIds: [], deleteRowIds: [], changed: false });
  });
  test('足す人・外す人だけ', () => {
    expect(P.planAssignmentSync(rows, ['a', 'c'])).toEqual({ insertUserIds: ['c'], deleteRowIds: ['r2'], changed: true });
  });
  test('空なら全員外す', () => {
    expect(P.planAssignmentSync(rows, [])).toEqual({ insertUserIds: [], deleteRowIds: ['r1', 'r2'], changed: true });
  });
  test('同じ人の重複行は 1 行に寄せる（最初の行を残す）', () => {
    expect(P.planAssignmentSync([{ id: 'r1', user_id: 'a' }, { id: 'r9', user_id: 'a' }], ['a']))
      .toEqual({ insertUserIds: [], deleteRowIds: ['r9'], changed: true });
  });
});
