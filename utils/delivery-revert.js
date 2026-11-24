'use strict';
// 納品の取り消し（「間違って納品完了にした」を現場で戻す）の判定ロジック（純関数・jest テストあり）。
// API: routes/haruka.js の GET /creatives/:id/delivery-revert-eligibility / POST /creatives/:id/delivery-revert
//
// 誰が戻せるか:
//   - 全件戻せる人（canRevertAny）: admin・PD（producer と director を兼任）、または権限管理で
//     「creative.delivery_revert_any」を ON にしたロール。先月以前の納品も戻せる。
//   - その制作の担当 D/P（isLeader）: 案件の director_id / producer_id、creative_assignments の
//     director / producer / producer_director、納品時スナップショット（delivered_director_ids /
//     delivered_producer_ids）の本人。ロールではなく「この制作の担当か」で判定する。
//     戻せるのは今月（JST）に納品完了になった分だけ（先月以前は締め・突合が済んでいる可能性があるため）。
//   - editor / designer 担当は戻せない（帰属・本数に関わる操作の余地を絞る）。
//
// 誰でも止まる条件:
//   - 提出済／承認済の請求書（下書き以外）に載っている（先にその請求書を取り下げる）

const { jstYearMonthOf } = require('./delivery-ledger');

const DELIVERED_STATUSES = ['納品', '完納', '納品済'];
const LEADER_ASSIGNMENT_ROLES = ['director', 'producer', 'producer_director'];
// 戻し先の候補（動画 / 静止画の標準ステータス。QUICK_STATUS_ALL から「納品」を除いたもの）
const REVERT_TARGETS = [
  'クライアントチェック中', 'クライアントチェック後修正',
  'Pチェック', 'Pチェック後修正',
  'Dチェック', 'Dチェック後修正',
  '制作中（初稿提出前）', '未着手',
];

// 本人がまだ直せる請求書の状態（下書き・差し戻し中）。この状態の明細は取り消し時に外してよい。
// それ以外（提出済み・承認済み・支払済み…）に載っていれば戻せない。
const EDITABLE_INVOICE_STATUSES = ['draft', 'rejected'];
function isEditableInvoiceStatus(status) {
  return EDITABLE_INVOICE_STATUSES.includes(status);
}

function isDeliveredCreative(c) {
  if (!c) return false;
  return DELIVERED_STATUSES.includes(c.status) || c.force_delivered === true;
}

// その制作の担当 D/P か（ロールではなく担当で見る）
// @param {object} p
// @param {object} p.creative { delivered_director_ids, delivered_producer_ids }
// @param {object|null} p.project { director_id, producer_id }
// @param {Array<{user_id, role}>} p.assignments creative_assignments（この制作の分）
// @param {string} p.userId
function isCreativeLeader({ creative, project, assignments, userId }) {
  if (!userId) return false;
  if (project && (project.director_id === userId || project.producer_id === userId)) return true;
  // 案件のサブディレクター / サブプロデューサー（詳細画面でも案件の D/P として扱っている）
  if (project && (
    (Array.isArray(project.sub_director_ids) && project.sub_director_ids.includes(userId)) ||
    (Array.isArray(project.sub_producer_ids) && project.sub_producer_ids.includes(userId))
  )) return true;
  const snap = [
    ...(Array.isArray(creative?.delivered_director_ids) ? creative.delivered_director_ids : []),
    ...(Array.isArray(creative?.delivered_producer_ids) ? creative.delivered_producer_ids : []),
  ];
  if (snap.includes(userId)) return true;
  return (assignments || []).some(a => a && a.user_id === userId && LEADER_ASSIGNMENT_ROLES.includes(a.role));
}

const DELIVERY_REVERT_ANY_KEY = 'creative.delivery_revert_any';

// 全件戻せる人か（実効ロールコードの集合で判定・ADR 015）。
//   admin は roleCodesHavePermission が常に true。PD（producer＋director 兼任）は権限行が無くても可。
//   それ以外は権限管理で creative.delivery_revert_any を ON にしたロールだけ。
// @param {string[]} codes getEffectiveRoleCodes(req) の戻り値
// @param {{ roleCodesHavePermission: Function, roleCodesMatchAny: Function }} rolesUtil utils/roles.js
async function resolveCanRevertAny(codes, rolesUtil) {
  if (await rolesUtil.roleCodesHavePermission(codes, DELIVERY_REVERT_ANY_KEY)) return true;
  return rolesUtil.roleCodesMatchAny(codes, ['producer_director']);
}

// 戻し先の候補と初期値。P がいない案件は Pチェック系を出さない。
// previousStatus（納品になる直前のステータス）が標準外の値でも候補の先頭に入れて選べるようにする。
function buildRevertTargets({ hasProducer, previousStatus }) {
  let list = REVERT_TARGETS.filter(s => hasProducer || !s.startsWith('Pチェック'));
  const prev = previousStatus && !DELIVERED_STATUSES.includes(previousStatus) ? previousStatus : null;
  if (prev && !list.includes(prev)) list = [prev, ...list];
  const defaultTarget = prev || 'クライアントチェック中';
  return { targets: list, defaultTarget };
}

// 戻してよいかの総合判定。
// @param {object} p
// @param {object} p.creative { status, force_delivered, delivered_at }
// @param {boolean} p.canRevertAny 全件戻せる人か（admin / PD / 権限 ON）
// @param {boolean} p.isLeader その制作の担当 D/P か
// @param {Array<{invoice_number, status}>} p.issuedInvoices 下書き以外の請求書（この制作が載っているもの）
// @param {Date} [p.now]
// 戻り値: { canRevert, reason, scope: 'any'|'own'|null, pastMonth, unknownDate }
function decideDeliveryRevert({ creative, canRevertAny, isLeader, issuedInvoices, now = new Date() }) {
  if (!isDeliveredCreative(creative)) {
    return { canRevert: false, reason: '納品完了になっていません', scope: null, pastMonth: false, unknownDate: false };
  }
  const deliveredYm = jstYearMonthOf(creative.delivered_at);
  const nowYm = jstYearMonthOf(now.toISOString());
  // 納品完了日が無い（古いデータ・force_delivered だけ）ときは「先月以前」ではなく「不明」。
  // 担当 D/P は月を確かめられないので戻せない扱いにするが、管理者・PD への警告文は分ける（unknownDate）。
  const unknownDate = !deliveredYm;
  const pastMonth = !unknownDate && deliveredYm !== nowYm;

  let scope = null;
  if (canRevertAny) scope = 'any';
  else if (isLeader) scope = 'own';
  if (!scope) {
    return {
      canRevert: false,
      reason: '納品の取り消しは、この制作の担当ディレクター・プロデューサー、管理者、PD だけができます',
      scope: null, pastMonth, unknownDate,
    };
  }
  if (scope === 'own' && (pastMonth || unknownDate)) {
    return {
      canRevert: false,
      reason: deliveredYm
        ? `先月以前（${deliveredYm}）に納品完了になった分は、締め・請求に関わるため管理者か PD に依頼してください`
        : '納品完了日が記録されていないため、管理者か PD に依頼してください',
      scope, pastMonth, unknownDate,
    };
  }
  const issued = (issuedInvoices || []).filter(Boolean);
  if (issued.length) {
    const nums = [...new Set(issued.map(i => `${i.invoice_number || '(番号なし)'}（${invoiceStatusLabel(i.status)}）`))];
    return {
      canRevert: false,
      reason: `提出済み・承認済みの請求書に載っているため戻せません。先に請求書を差し戻してください（対象: ${nums.join('、')}）`,
      scope, pastMonth, unknownDate,
    };
  }
  return { canRevert: true, reason: null, scope, pastMonth, unknownDate };
}

function invoiceStatusLabel(status) {
  if (status === 'submitted') return '提出済み';
  if (status === 'approved') return '承認済み';
  if (status === 'paid') return '支払済み';
  if (status === 'rejected') return '差し戻し中';
  return String(status || '');
}

// 理由の検証（必須・500 文字まで）
function normalizeRevertReason(raw) {
  const r = String(raw ?? '').trim();
  if (!r) return { ok: false, error: '取り消しの理由を入力してください' };
  if (r.length > 500) return { ok: false, error: '理由は 500 文字以内で入力してください' };
  return { ok: true, reason: r };
}

module.exports = {
  DELIVERED_STATUSES,
  LEADER_ASSIGNMENT_ROLES,
  REVERT_TARGETS,
  DELIVERY_REVERT_ANY_KEY,
  EDITABLE_INVOICE_STATUSES,
  isEditableInvoiceStatus,
  resolveCanRevertAny,
  isDeliveredCreative,
  isCreativeLeader,
  buildRevertTargets,
  decideDeliveryRevert,
  invoiceStatusLabel,
  normalizeRevertReason,
};
