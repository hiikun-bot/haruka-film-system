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
function normalizeCreativeIds(ids, { max = 500 } = {}) {
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
function judgeAssignmentChange({ canManageAll, userId, project, team, myRoles, myRoleCodes, selfAdds }) {
  if (canManageAll) return { allowed: true };
  if (!userId) return { allowed: false, reason: 'not_related' };
  const roles = Array.isArray(myRoles) ? myRoles : [];
  if (isProjectLeader(project, userId) || isTeamLeader(team, userId) || roles.some(r => LEADER_ASSIGN_ROLES.has(r))) {
    return { allowed: true };
  }
  if (roles.length === 0) return { allowed: false, reason: 'not_related' };
  const codes = new Set(Array.isArray(myRoleCodes) ? myRoleCodes : []);
  if (codes.has('producer_director')) { codes.add('producer'); codes.add('director'); }
  for (const r of (selfAdds || [])) {
    if (roles.includes(r)) continue;
    if ((r === 'director' || r === 'producer') && !codes.has(r)) {
      return { allowed: false, reason: 'self_leader', role: r };
    }
  }
  return { allowed: true };
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
};
