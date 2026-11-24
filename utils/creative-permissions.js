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

// ID の正規化（文字列化して前後の空白を落とし、小文字にそろえる。ID は UUID なので大文字小文字は同じ人）。
// null / undefined / 空文字は null。
// 本人判定・担当の差分は必ずこれを通して比べる（数値や空白混じり・大文字の ID が「別人」扱いになるのを防ぐ）
function normId(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().toLowerCase();
  return s ? s : null;
}

function sameId(a, b) {
  const na = normId(a);
  return na !== null && na === normId(b);
}

function inArr(arr, id) {
  return Array.isArray(arr) && arr.some(v => sameId(v, id));
}

// 案件の担当 D/P か
function isProjectLeader(project, userId) {
  if (!normId(userId) || !project) return false;
  return sameId(project.director_id, userId) || sameId(project.producer_id, userId)
    || inArr(project.sub_director_ids, userId) || inArr(project.sub_producer_ids, userId);
}

// クリエイティブのチームのリーダーか
function isTeamLeader(team, userId) {
  if (!normId(userId) || !team) return false;
  return sameId(team.director_id, userId) || sameId(team.producer_id, userId);
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
  const sa = new Set((a || []).map(normId).filter(Boolean));
  const sb = new Set((b || []).map(normId).filter(Boolean));
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
  const usersOf = (role) => asn.filter(a => a.role === role).map(a => normId(a.user_id)).filter(Boolean);
  const me = normId(userId);
  const has = (list, id) => list.some(v => sameId(v, id));
  const changed = [];
  const selfAdds = [];
  if (input.assignee_id !== undefined) {
    // 制作担当（editor / designer / director_as_editor）の欄として比べる（planWorkerAssigneeSync と同じ意味）
    const plan = planWorkerAssigneeSync(workerRowsOf(asn), input.assignee_id);
    if (plan.changed) {
      changed.push('editor');
      if (me && plan.insert && sameId(plan.insert.user_id, me)) selfAdds.push('editor');
    }
  }
  for (const [key, role] of [['director_ids', 'director'], ['producer_ids', 'producer'], ['wcheck_ids', 'wcheck']]) {
    const want = input[key];
    if (!Array.isArray(want)) continue;
    const have = usersOf(role);
    if (!sameUserSet(want, have)) {
      changed.push(role);
      if (me && has(want, me) && !has(have, me)) selfAdds.push(role);
    }
  }
  if (input.team_id !== undefined && normId(input.team_id) !== normId(current && current.team_id)) {
    changed.push('team');
  }
  return { changed, selfAdds };
}

// ある役割の担当行を「選ばれた顔ぶれ」に合わせるための最小の書き込み計画。
//   existingRows … 今のその役割の行 [{ id, user_id, rank_applied? }]
//   desiredIds   … 選ばれたユーザー ID（順番・重複・空値・前後の空白は無視）
// 返り値: { insertUserIds, deleteRowIds, changed }
//   ・顔ぶれが同じなら何も書かない（changed=false）。行を作り直さないので rank_applied（報酬計算のランク）は保たれる
//   ・残る人の行はそのまま。同じ人の重複行だけは 1 行に寄せる（最初の行を残す）
//   ・呼び出し側は「足す → 成功したら消す」の順で書く（足すのに失敗しても担当が消えないように）
function planAssignmentSync(existingRows, desiredIds) {
  const desired = [];
  const seen = new Set();
  for (const raw of (desiredIds || [])) {
    const id = normId(raw);
    if (id && !seen.has(id)) { seen.add(id); desired.push(id); }
  }
  const kept = new Set();
  const deleteRowIds = [];
  for (const r of (existingRows || [])) {
    const uid = normId(r && r.user_id);
    if (uid && seen.has(uid) && !kept.has(uid)) { kept.add(uid); continue; }
    if (r && r.id) deleteRowIds.push(r.id);
  }
  const insertUserIds = desired.filter(id => !kept.has(id));
  return { insertUserIds, deleteRowIds, changed: insertUserIds.length > 0 || deleteRowIds.length > 0 };
}

// ── 担当者（assignee_id）＝「制作担当」1 人の欄 ──
// 画面の「担当者」欄は editor / designer / director_as_editor のどれか（最初の 1 行）を表示し、選び直すと assignee_id を送る。
// 以前のサーバーは role='editor' の行だけを見ていたので、デザイナー（designer 行）の作品で同じ人がそのまま送られると
// editor 行が増え、同じ人が同じ作品に designer＋editor の 2 行（制作担当の二重）になっていた（2026-11-24 修正）。
// 今は「選ばれた人がすでに制作担当（どの役割でも）なら editor 行を足さない」。ほかの役割の行は従来どおり触らない
// （画面は担当者を変えていない保存でも assignee_id を送るため、従来より多く消すと別の担当者が黙って外れる）。
//   workerRows … 今の制作担当の行 [{ id, user_id, role }]（WORKER_ROLES のもの）
//   assigneeId … 選ばれた人（null / 空は従来どおり「editor 行を外す」。designer・director_as_editor の行は残す）
// 返り値: { insert: null | { user_id, role }, deleteRowIds, changed }
//   ・選ばれた人がすでに制作担当の行を持つ → その行（最初の 1 行）を役割ごと残す。ほかの人の editor 行と、
//     その人自身の重複行（designer＋editor 等）だけ消す（従来の「editor は選ばれた 1 人」と同じ結果から重複を除いたもの）
//   ・選ばれた人が制作担当でない → 従来どおり editor 行を入れ替える。ただし editor 行が無く、制作担当が
//     designer 1 行だけのとき（デザイナーの作品の付け替え）は designer として入れ替える（designer＋editor の 2 人にしない）
//   ・呼び出し側は「足す → 成功したら消す」の順で書く
function workerRowsOf(assignments) {
  return (assignments || []).filter(a => a && WORKER_ROLES.has(a.role));
}

function planWorkerAssigneeSync(workerRows, assigneeId) {
  const rows = (workerRows || []).filter(r => r && WORKER_ROLES.has(r.role));
  const want = normId(assigneeId);
  const editorRows = rows.filter(r => r.role === 'editor');
  // changed は「消す行があるか」で決める（権限判定では id を読まない行を渡すことがあるため、id の有無で決めない）
  const result = (insert, drop) => ({ insert, deleteRowIds: drop.map(r => r.id).filter(Boolean), changed: !!insert || drop.length > 0 });
  if (!want) return result(null, editorRows);
  const keep = rows.find(r => sameId(r.user_id, want)) || null;
  if (keep) {
    return result(null, rows.filter(r => r !== keep && (r.role === 'editor' || sameId(r.user_id, want))));
  }
  if (editorRows.length === 0 && rows.length === 1 && rows[0].role === 'designer') {
    return result({ user_id: want, role: 'designer' }, rows);
  }
  return result({ user_id: want, role: 'editor' }, editorRows);
}

// 画面の出し分け用（GET /creatives・GET /creatives/:id が返す）。サーバーの判定（judge*）と同じ条件で、
// 「このボタン・欄を押して通るか」を返す。最終判断はいつもサーバー（PUT・DELETE 側の判定）。
//   canManageAll … project.create_edit（担当者・中身の編集）
//   canDeleteAll … project.delete（削除）
//   creative     … { id, file_name, status, delivered_at, force_delivered }（削除の「納品前だけ」判定に使う）
// 返り値: { can_edit, can_edit_assignees, can_delete }
//   can_edit_assignees は「担当者の欄を出すか」。自分を新しく D/P に入れられるかなど、役割ごとの細かい可否は
//   保存時にサーバーが判定する（ここでは自分を足さない変更が通るか＝selfAdds なしで判定）
function creativeUiPermissions({ canManageAll, canDeleteAll, userId, project, team, myRoles, creative }) {
  const base = { canManageAll: !!canManageAll, userId, project, team, myRoles };
  const can_edit = judgeCreativeEdit(base).allowed;
  const can_edit_assignees = judgeAssignmentChange({ ...base, canDeleteAll: !!canDeleteAll, myRoleCodes: [], selfAdds: [] }).allowed;
  let can_delete = false;
  if (creative && creative.id) {
    const j = judgeCreativeDelete({
      canManageAll: !!canDeleteAll, userId, ids: [creative.id],
      creatives: [{ ...creative, projects: project || null }],
      myRolesByCreative: new Map([[creative.id, Array.isArray(myRoles) ? myRoles : []]]),
    });
    can_delete = j.allowed;
  }
  return { can_edit, can_edit_assignees, can_delete };
}

module.exports = {
  workerRowsOf,
  planWorkerAssigneeSync,
  creativeUiPermissions,
  WORKER_ROLES,
  normId,
  sameId,
  planAssignmentSync,
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
