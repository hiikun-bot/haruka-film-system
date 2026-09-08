// utils/contract-state.js
// =============================================================
// 契約管理（ADR 035）の状態機械・表示ラベル・署名者名照合・期限計算。
// 純関数のみ（DB・外部API 非依存、jest で直接テスト）。
//
// 日付は「JST のカレンダー日付 'YYYY-MM-DD'」を文字列で扱い、
// 加減算は Date.UTC ベースで行うのでサーバーの TZ（Railway は UTC）に依存しない。
// =============================================================

const CONTRACT_STATUSES = Object.freeze([
  'draft', 'requested', 'submitted', 'revision_requested',
  'active', 'ending', 'ended', 'reconsent_required', 'cancelled',
]);

const REQUEST_STATUSES = Object.freeze(['open', 'submitted', 'completed', 'cancelled']);

// 本人が「まだやることがある」状態
const MEMBER_PENDING_STATUSES = Object.freeze(['requested', 'revision_requested']);
// 有効扱い（再同意待ちも同意→承認までは有効）
const EFFECTIVE_STATUSES = Object.freeze(['active', 'ending', 'reconsent_required']);
// 依頼が open のまま残る状態
const OPEN_CONTRACT_STATUSES = Object.freeze(['requested', 'submitted', 'revision_requested']);

const EXECUTION_METHODS = Object.freeze(['hfs', 'external_esign', 'paper', 'email', 'chat', 'other']);
const DOC_TYPES = Object.freeze([
  'basic_agreement', 'rules_confirmation', 'client_pledge', 'succession_notice',
  'amendment_memo', 'individual_contract', 'termination_notice',
]);
// 「確認書」系は consent_kind = acknowledged、それ以外は agreed
const ACKNOWLEDGE_DOC_TYPES = new Set(['rules_confirmation', 'succession_notice', 'termination_notice']);

// 状態遷移表: from → { to: [許可アクター] }   actor: 'member' | 'admin' | 'system'
const TRANSITIONS = Object.freeze({
  draft:               { requested: ['admin'], cancelled: ['admin'] },
  requested:           { submitted: ['member'], cancelled: ['admin'] },
  revision_requested:  { submitted: ['member'], cancelled: ['admin'] },
  submitted:           { active: ['admin'], revision_requested: ['admin'], cancelled: ['admin'] },
  active:              { ending: ['admin'], ended: ['admin', 'system'], reconsent_required: ['system'] },
  ending:              { ended: ['admin', 'system'], reconsent_required: ['system'], active: ['admin'] },
  reconsent_required:  { ending: ['admin'], ended: ['admin', 'system'] },
  ended:               {},
  cancelled:           {},
});

function canTransition(from, to, actor = 'admin') {
  const row = TRANSITIONS[from];
  if (!row) return false;
  const actors = row[to];
  if (!actors) return false;
  return actors.includes(actor);
}

function consentKindForDocType(docType) {
  return ACKNOWLEDGE_DOC_TYPES.has(docType) ? 'acknowledged' : 'agreed';
}

// ---------- 制作者向け表示ラベル ----------

const MEMBER_STATUS_LABELS = Object.freeze({
  draft: '準備中',
  requested: '未着手',
  requested_in_progress: '入力中',
  submitted: '確認待ち',
  revision_requested: '修正依頼あり',
  active: '契約手続き完了',
  ending: '契約手続き完了（終了予定）',
  ended: '終了',
  reconsent_required: '再同意が必要',
  cancelled: '取消',
});

function hasDraft(request) {
  const d = request && request.draft_state;
  if (!d) return false;
  if (typeof d === 'object') return Object.keys(d).length > 0;
  return String(d).trim() !== '';
}

/**
 * 制作者向けの表示ラベル。
 * @param {{status:string}} contract member_contracts 行
 * @param {{draft_state?:any}} [request] contract_requests 行（requested のとき「入力中」判定に使う）
 * @returns {string}
 */
function memberFacingStatus(contract, request) {
  const status = contract && contract.status;
  if (status === 'requested') {
    return hasDraft(request) ? MEMBER_STATUS_LABELS.requested_in_progress : MEMBER_STATUS_LABELS.requested;
  }
  return MEMBER_STATUS_LABELS[status] || status || '';
}

// ---------- 署名者名 ----------

// NFKC 正規化（全角英数→半角、半角カナ→全角カナ）＋ 空白（全角スペース含む）除去 ＋ 小文字化
function normalizeName(v) {
  if (v === null || v === undefined) return '';
  return String(v)
    .normalize('NFKC')
    .replace(/[\s　 ]+/g, '')
    .toLowerCase();
}

function signerNameMatches(typed, registered) {
  const a = normalizeName(typed);
  const b = normalizeName(registered);
  return a !== '' && a === b;
}

// ---------- 日付（JST カレンダー） ----------

const DAY_MS = 86_400_000;

// JST の今日 'YYYY-MM-DD'（サーバー TZ に依存しない）
function jstToday(now = new Date()) {
  return new Date(now).toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
}

function parseYmd(s) {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const y = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const t = Date.UTC(y, mo - 1, d);
  const dt = new Date(t);
  if (dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null; // 2/30 等を弾く
  return { y, m: mo, d, utcMs: t };
}

function isValidYmd(s) {
  return parseYmd(s) !== null;
}

function formatUtcYmd(ms) {
  const dt = new Date(ms);
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function addDays(ymd, n) {
  const p = parseYmd(ymd);
  if (!p) return null;
  return formatUtcYmd(p.utcMs + Number(n || 0) * DAY_MS);
}

// 月末補正あり（2028-02-29 + 1年 → 2029-02-28）
function addYears(ymd, n) {
  const p = parseYmd(ymd);
  if (!p) return null;
  const targetY = p.y + Number(n || 0);
  const lastDay = new Date(Date.UTC(targetY, p.m, 0)).getUTCDate();
  return formatUtcYmd(Date.UTC(targetY, p.m - 1, Math.min(p.d, lastDay)));
}

// b - a（日数・整数）。どちらか不正なら null
function daysBetween(a, b) {
  const pa = parseYmd(a); const pb = parseYmd(b);
  if (!pa || !pb) return null;
  return Math.round((pb.utcMs - pa.utcMs) / DAY_MS);
}

// 依頼URLトークンの期限（既定 90日後）。ISO 文字列
function computeTokenExpiry(now = new Date(), days = 90) {
  return new Date(new Date(now).getTime() + Number(days) * DAY_MS).toISOString();
}

function isTokenExpired(tokenExpiresAt, now = new Date()) {
  if (!tokenExpiresAt) return false;
  const t = new Date(tokenExpiresAt).getTime();
  return Number.isFinite(t) && t < new Date(now).getTime();
}

// 契約開始日から 1年契約の終了日（開始日 + 1年 − 1日）
function defaultEndDate(startYmd) {
  const plus = addYears(startYmd, 1);
  return plus ? addDays(plus, -1) : null;
}

// 更新拒絶の申し出期限 = end_date − renew_notice_days
function renewDeadline(endYmd, renewNoticeDays) {
  return addDays(endYmd, -Number(renewNoticeDays || 0));
}

// ---------- ワーカー判定（純関数） ----------

/**
 * 未対応催促: 基準時刻（last_reminded_at → sent_at → requested_at の順で最新にあるもの）から
 * intervalDays 経過していれば true。基準が無ければ false。
 */
function needsReminder({ nowMs, lastRemindedAt, sentAt, requestedAt, intervalDays }) {
  const base = lastRemindedAt || sentAt || requestedAt;
  if (!base) return false;
  const t = new Date(base).getTime();
  if (!Number.isFinite(t)) return false;
  const days = Number(intervalDays);
  if (!Number.isFinite(days) || days < 1) return false;
  return nowMs - t >= days * DAY_MS;
}

/**
 * 回答期限の通知種別: 'before'（noticeDays 前）/ 'due'（当日）/ 'overdue'（超過）/ null
 */
function dueNoticeKind({ dueDate, today, noticeDays }) {
  const left = daysBetween(today, dueDate);
  if (left === null) return null;
  if (left === 0) return 'due';
  if (left < 0) return 'overdue';
  if (Number(noticeDays) > 0 && left === Number(noticeDays)) return 'before';
  return null;
}

// expiry_notice_stage（'60' / '60,30' / '60,renew' のようなカンマ区切り集合）をパース
function parseStages(v) {
  return new Set(String(v || '').split(',').map(s => s.trim()).filter(Boolean));
}
function joinStages(set) {
  return Array.from(set).join(',') || null;
}

/**
 * 有効期限の次の通知段階。stages（例 [60,30]）のうち残日数が段階以下で未送信の最小段階を返す。
 * 残日数が負（期限超過）なら null。
 * @returns {string|null} '60' | '30' | null
 */
function nextExpiryStage({ endDate, today, sentStages, stages = [60, 30] }) {
  const left = daysBetween(today, endDate);
  if (left === null || left < 0) return null;
  const sent = sentStages instanceof Set ? sentStages : parseStages(sentStages);
  const sorted = Array.from(new Set(stages.map(Number).filter(n => Number.isFinite(n) && n >= 0))).sort((a, b) => a - b);
  // 小さい段階（30）が該当していれば 60 を飛ばして 30 を送る（60 は送らない）
  for (const st of sorted) {
    if (left <= st) {
      if (sent.has(String(st))) return null;
      // すでに「より小さい段階」を送っていれば送らない
      if (sorted.some(s => s < st && sent.has(String(s)))) return null;
      return String(st);
    }
  }
  return null;
}

/**
 * 更新拒絶期限の管理者通知: renew_notice_days の締切（end − renew_notice_days）の adminLeadDays 前以内で未送信なら true
 */
function needsRenewNotice({ endDate, today, renewNoticeDays, sentStages, adminLeadDays = 30 }) {
  const sent = sentStages instanceof Set ? sentStages : parseStages(sentStages);
  if (sent.has('renew')) return false;
  const deadline = renewDeadline(endDate, renewNoticeDays);
  if (!deadline) return false;
  const left = daysBetween(today, deadline);
  if (left === null) return false;
  return left >= 0 && left <= Number(adminLeadDays);
}

/**
 * 終了日到来の処理内容: 'renew'（自動更新: end_date +1年）/ 'end'（ended に）/ null（未到来）
 */
function endDateAction({ status, endDate, today, autoRenew }) {
  const left = daysBetween(today, endDate);
  if (left === null || left > 0) return null;
  if (status === 'ending') return 'end';
  if (status === 'active' || status === 'reconsent_required') return autoRenew ? 'renew' : 'end';
  return null;
}

module.exports = {
  CONTRACT_STATUSES,
  REQUEST_STATUSES,
  MEMBER_PENDING_STATUSES,
  EFFECTIVE_STATUSES,
  OPEN_CONTRACT_STATUSES,
  EXECUTION_METHODS,
  DOC_TYPES,
  TRANSITIONS,
  MEMBER_STATUS_LABELS,
  canTransition,
  consentKindForDocType,
  memberFacingStatus,
  normalizeName,
  signerNameMatches,
  jstToday,
  isValidYmd,
  addDays,
  addYears,
  daysBetween,
  computeTokenExpiry,
  isTokenExpired,
  defaultEndDate,
  renewDeadline,
  needsReminder,
  dueNoticeKind,
  parseStages,
  joinStages,
  nextExpiryStage,
  needsRenewNotice,
  endDateAction,
};
