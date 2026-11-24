// クリエイティブの「削除」「担当者の変更」「素材フォルダURL などの編集」を誰に許すかの判定（純関数・ADR 015）。
// DB の読み出しは routes/haruka.js 側（loadCreativePermContext）。ここは受け取った値だけで判定する。
//
// 用語
//   canManageAll … 実効ロールが案件編集の権限（project.create_edit / 削除は project.delete）を持つ。
//                  roleCodesHavePermission の集合判定で求める（currentUser.role / req.user.role は見ない）
//   leader       … 案件の担当 D/P（projects.director_id / producer_id / sub_director_ids / sub_producer_ids）
//   teamLeader   … クリエイティブのチーム（creatives.team_id）のリーダー（teams.director_id / producer_id）
//   myRoles      … そのクリエイティブでの自分の担当行（creative_assignments.role）の一覧

const LEADER_ASSIGN_ROLES = new Set(['director', 'producer', 'producer_director']);
const DELIVERED_STATUSES = new Set(['納品', '完納', '納品済']);

function inArr(arr, id) {
  return Array.isArray(arr) && !!id && arr.includes(id);
}

// 案件の担当 D/P か
function isProjectLeader(project, userId) {
  if (!userId || !project) return false;
  return project.director_id === userId || project.producer_id === userId
    || inArr(project.sub_director_ids, userId) || inArr(project.sub_producer_ids, userId);
}

// クリエイティブのチームのリーダーか
function isTeamLeader(team, userId) {
  if (!userId || !team) return false;
  return team.director_id === userId || team.producer_id === userId;
}

function isDeliveredCreative(c) {
  return !!c && (DELIVERED_STATUSES.has(c.status) || !!c.delivered_at || !!c.force_delivered);
}

// 削除してよい ids の検証。文字列で、空でなく、重複を除いた一覧を返す。
// 1 件でもおかしな値があれば ok:false（何も消さない）。
function normalizeCreativeIds(ids, { max = Infinity } = {}) {
  if (!Array.isArray(ids) || ids.length === 0) return { ok: false, error: 'ids は必須です' };
  const out = [];
  const seen = new Set();
  for (const raw of ids) {
    if (typeof raw !== 'string' || !raw.trim()) return { ok: false, error: 'ids に不正な値が含まれています' };
    const v = raw.trim();
    if (!seen.has(v)) { seen.add(v); out.push(v); }
  }
  if (out.length > max) return { ok: false, error: `一度に削除できるのは ${max} 件までです` };
  return { ok: true, ids: out };
}

// 削除の判定（複数件）。
//   canManageAll=true なら全件可。それ以外は、確認できた全件が許可されたときだけ allowed。
//   ・見つからない id（missing）が 1 件でもあれば allowed=false（確認できない対象を混ぜて進めない）
//   ・許可: 案件の担当 D/P／そのクリエイティブの D/P 担当／担当者（納品前だけ）
function judgeCreativeDelete({ canManageAll, userId, ids, creatives, myRolesByCreative }) {
  const list = Array.isArray(creatives) ? creatives : [];
  const foundIds = new Set(list.map(c => c && c.id).filter(Boolean));
  const missing = (ids || []).filter(id => !foundIds.has(id));
  if (canManageAll) {
    // 権限者でも「無い id」は確認できていないので止める（指定どおりに消えたかが分からなくなるため）
    return { allowed: missing.length === 0, notAllowed: [], missing };
  }
  const notAllowed = [];
  for (const c of list) {
    const roles = (myRolesByCreative && myRolesByCreative.get(c.id)) || [];
    const leader = isProjectLeader(c.projects, userId);
    const dp = roles.some(r => LEADER_ASSIGN_ROLES.has(r));
    const delivered = isDeliveredCreative(c);
    const worker = roles.length > 0 && !delivered;
    if (!userId || (!leader && !dp && !worker)) {
      notAllowed.push((c.file_name || c.id) + (roles.length > 0 && delivered ? '（納品済み）' : ''));
    }
  }
  return { allowed: !!userId && missing.length === 0 && notAllowed.length === 0, notAllowed, missing };
}

// クリエイティブの中身（素材フォルダURL など）を変更してよいか。
//   案件編集の権限者／案件の担当 D/P／チームのリーダー／そのクリエイティブの担当者（役割は問わない）
function judgeCreativeEdit({ canManageAll, userId, project, team, myRoles }) {
  if (canManageAll) return { allowed: true };
  if (!userId) return { allowed: false };
  if (isProjectLeader(project, userId) || isTeamLeader(team, userId)) return { allowed: true };
  if (Array.isArray(myRoles) && myRoles.length > 0) return { allowed: true };
  return { allowed: false };
}

// 担当者（creative_assignments）を変更してよいか。
//   selfAdds … この変更で自分が新しく入る役割（'editor' / 'director' / 'producer' / 'wcheck'）
//   myRoleCodes … 自分の実効ロールコード（director / producer かどうかの確認だけに使う）
// 許可:
//   ・案件編集の権限者・案件の担当 D/P・チームのリーダー・そのクリエイティブの D/P 担当 … 何でも可
//   ・そのクリエイティブの担当者（編集者・デザイナー等）… Dチェック・Pチェック・Wチェックの依頼先や担当の付け替えは可。
//     ただし自分を D/P 担当に足せるのは、自分の実効ロールが director / producer のときだけ
//     （D/P 担当になると納品後も削除できるため。編集者が自分を D に入れて削除する抜け道を塞ぐ）
//   ・それ以外（担当でも案件の D/P でもない人）… 不可（自分を担当に足すこともできない）
//   ・チームのリーダーは他の人の担当は決められるが、自分を D/P に足すときは担当者と同じ制限
//     （チームのリーダーには削除の権限が無いので、D/P 担当を経由して削除できるようにしない）
// 自分を D/P 担当に足すのに必要な実効ロール（producer_director は両方）
const SELF_LEADER_REQUIRED_CODES = {
  director: ['director'],
  producer: ['producer'],
  producer_director: ['director', 'producer'],
};
// 自分で入ってよい「制作担当」の役割（担当の付け替えで自分が editor 行になるのは、すでに制作担当のときだけ）
const WORKER_ROLES = new Set(['editor', 'designer', 'director_as_editor']);
//   canDeleteAll … 削除の権限（project.delete）。案件編集の権限者でも、これが無ければ自分を D/P に足すのは
//                  実効ロールが D/P のときだけ（D/P 担当になると削除できてしまうため）
function judgeAssignmentChange({ canManageAll, canDeleteAll, userId, project, team, myRoles, myRoleCodes, selfAdds }) {
  if (!userId) return { allowed: false, reason: 'not_related' };
  const roles = Array.isArray(myRoles) ? myRoles : [];
  const codes = new Set(Array.isArray(myRoleCodes) ? myRoleCodes : []);
  if (codes.has('producer_director')) { codes.add('producer'); codes.add('director'); }
  const leaderCodesOk = (r) => (SELF_LEADER_REQUIRED_CODES[r] || []).every(c => codes.has(c));
  if (canManageAll) {
    for (const r of (selfAdds || [])) {
      if (roles.includes(r)) continue;
      if (SELF_LEADER_REQUIRED_CODES[r] && !canDeleteAll && !leaderCodesOk(r)) {
        return { allowed: false, reason: 'self_leader', role: r };
      }
    }
    return { allowed: true };
  }
  if (isProjectLeader(project, userId) || roles.some(r => LEADER_ASSIGN_ROLES.has(r))) {
    return { allowed: true };
  }
  if (roles.length === 0 && !isTeamLeader(team, userId)) return { allowed: false, reason: 'not_related' };
  // ここから先は「そのクリエイティブの担当者（D/P 以外）」か「担当に入っていないチームのリーダー」。
  // 他の人の担当は決められるが、自分が新しく入るのは次の場合だけ:
  //   ・D/P 担当 … すでに担当に入っていて、実効ロールが director / producer（producer_director は両方）
  //   ・editor 行 … すでに制作担当（編集者・デザイナー等）として入っている（自分の行の付け替え）
  //   それ以外（担当に入っていないチームのリーダーが自分を入れる、Wチェック担当が自分を制作担当にする等）は不可
  for (const r of (selfAdds || [])) {
    if (roles.includes(r)) continue;
    if (SELF_LEADER_REQUIRED_CODES[r]) {
      if (roles.length > 0 && leaderCodesOk(r)) continue;
      return { allowed: false, reason: 'self_leader', role: r };
    }
    if (r === 'editor' && roles.some(x => WORKER_ROLES.has(x))) continue;
    return { allowed: false, reason: 'self_add', role: r };
  }
  return { allowed: true };
}

// creative_assignments.role として受け付ける値（creative_assignments_role_check と同じ並び）
const ASSIGNMENT_ROLES = new Set(['editor', 'designer', 'director', 'producer', 'producer_director', 'director_as_editor', 'wcheck']);

// 同じ顔ぶれか（順番・重複・空値は無視）
function sameUserSet(a, b) {
  const sa = new Set((a || []).filter(Boolean));
  const sb = new Set((b || []).filter(Boolean));
  if (sa.size !== sb.size) return false;
  for (const v of sa) if (!sb.has(v)) return false;
  return true;
}

// PUT /creatives/:id の担当者まわりの入力を、今の担当行と比べて「本当に変わるもの」だけにする。
//   input   … { assignee_id?, director_ids?, producer_ids?, wcheck_ids?, team_id? }
//             undefined だけが「送られていない」。null / 空文字 / 空配列は「外す」（サーバーの更新処理と同じ）
//   current … { assignments:[{user_id, role}], team_id }
//   userId  … ログイン中の人（自分が新しく入る役割 selfAdds を求める）
// サーバーの更新処理と同じ意味で比べる:
//   assignee_id … role='editor' の行を入れ替える（空なら外す）
//   director / producer / wcheck … 配列の顔ぶれに同期する（空配列は全員外す）
function diffAssignmentInput(input, current, userId) {
  const asn = (current && current.assignments) || [];
  const usersOf = (role) => asn.filter(a => a.role === role).map(a => a.user_id);
  const changed = [];
  const selfAdds = [];
  if (input.assignee_id !== undefined) {
    const want = input.assignee_id ? [input.assignee_id] : [];
    const have = usersOf('editor');
    if (!sameUserSet(want, have)) {
      changed.push('editor');
      if (userId && want.includes(userId) && !have.includes(userId)) selfAdds.push('editor');
    }
  }
  for (const [key, role] of [['director_ids', 'director'], ['producer_ids', 'producer'], ['wcheck_ids', 'wcheck']]) {
    const want = input[key];
    if (!Array.isArray(want)) continue;
    const have = usersOf(role);
    if (!sameUserSet(want, have)) {
      changed.push(role);
      if (userId && want.includes(userId) && !have.includes(userId)) selfAdds.push(role);
    }
  }
  if (input.team_id !== undefined && (input.team_id || null) !== ((current && current.team_id) || null)) {
    changed.push('team');
  }
  return { changed, selfAdds };
}

module.exports = {
  LEADER_ASSIGN_ROLES,
  isProjectLeader,
  isTeamLeader,
  isDeliveredCreative,
  normalizeCreativeIds,
  judgeCreativeDelete,
  judgeCreativeEdit,
  judgeAssignmentChange,
  ASSIGNMENT_ROLES,
  sameUserSet,
  diffAssignmentInput,
};
