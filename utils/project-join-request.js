// utils/project-join-request.js — 案件への参加申請（ADR 051）
// =============================================================
// 純関数のみ（DB・外部 API 非依存。jest で直接テストする）。DB と送信は routes/haruka.js が担う。
//
//   normalizeJoinMessage(raw)                  申請理由・却下理由の正規化（改行 CRLF→LF・前後空白除去・上限）
//   buildRecipientCandidates({project, admins})  宛先候補（案件の P・D ＋ 管理者）を重複なく並べる
//   validateRecipientIds(ids, candidates)      申請者が選んだ宛先が候補内か
//   canDecideJoinRequest({request, userId, isAdmin})  承認・却下できるか（宛先 or 管理者）
//   buildJoinRequestMessage(...)               申請が届いたときの文面 { title, body, chatwork, slack }
//   buildJoinDecisionMessage(...)              承認・却下を申請者へ知らせる文面
// =============================================================

const MESSAGE_MAX_LENGTH = 1000;
// 申請できない（＝支払先を直接登録できる）権限。どちらか一つでも持っていれば申請ボタンは出さない
const DIRECT_REGISTER_PERMISSIONS = ['project.create_edit', 'project.pricing_edit'];

function normalizeJoinMessage(raw, { required = true } = {}) {
  const text = String(raw == null ? '' : raw).replace(/\r\n?/g, '\n').trim();
  if (!text) {
    return required ? { error: '申請理由を入力してください' } : { value: '' };
  }
  if (text.length > MESSAGE_MAX_LENGTH) {
    return { error: `${MESSAGE_MAX_LENGTH}文字以内で入力してください（現在 ${text.length}文字）` };
  }
  return { value: text };
}

function userLabel(u) {
  if (!u) return '';
  const nick = String(u.nickname || '').trim();
  const full = String(u.full_name || '').trim();
  if (nick && full && nick !== full) return `${nick}（${full}）`;
  return nick || full || '';
}

/**
 * 宛先候補: 案件の P・D ＋ 管理者（有効ユーザーのみ）。同一人物はまとめて肩書きを連結する。
 * 既定チェックは案件の P・D。P・D が誰もいない案件は管理者を既定にする。
 * @param {{project:{producer_id?,director_id?}, users:Map<string,object>|object, adminIds:string[], excludeUserId?:string}} p
 * @returns {Array<{user_id, name, roles:string[], label, is_default:boolean}>}
 */
function buildRecipientCandidates({ project, users, adminIds = [], excludeUserId = null }) {
  const getUser = (id) => (users instanceof Map ? users.get(id) : (users || {})[id]);
  const byId = new Map();
  const add = (id, role) => {
    if (!id || id === excludeUserId) return;
    const u = getUser(id);
    if (!u || u.is_active === false) return;
    const cur = byId.get(id) || { user_id: id, name: userLabel(u) || '（名前未設定）', roles: [] };
    if (!cur.roles.includes(role)) cur.roles.push(role);
    byId.set(id, cur);
  };
  add(project?.producer_id, 'P');
  add(project?.director_id, 'D');
  for (const id of adminIds) add(id, '管理者');

  const ORDER = { D: 0, P: 1, 管理者: 2 };
  const list = Array.from(byId.values()).map(c => {
    const roles = c.roles.slice().sort((a, b) => ORDER[a] - ORDER[b]);
    return { ...c, roles, label: roles.join('・') };
  });
  const hasProjectManager = list.some(c => c.roles.includes('P') || c.roles.includes('D'));
  for (const c of list) {
    c.is_default = hasProjectManager ? (c.roles.includes('P') || c.roles.includes('D')) : true;
  }
  // 案件の P・D を先に、管理者だけの人は後ろ（名前順）
  list.sort((a, b) => {
    const ra = Math.min(...a.roles.map(r => ORDER[r]));
    const rb = Math.min(...b.roles.map(r => ORDER[r]));
    return ra - rb || a.name.localeCompare(b.name, 'ja');
  });
  return list;
}

function validateRecipientIds(ids, candidates) {
  const arr = Array.isArray(ids) ? ids : [];
  const uniq = [...new Set(arr.map(v => String(v || '').trim()).filter(Boolean))];
  if (!uniq.length) return { error: '通知先を1人以上選んでください' };
  const allowed = new Set((candidates || []).map(c => c.user_id));
  const bad = uniq.filter(id => !allowed.has(id));
  if (bad.length) return { error: '通知先に選べない人が含まれています（案件のプロデューサー・ディレクター・管理者から選んでください）' };
  return { value: uniq };
}

function canDecideJoinRequest({ request, userId, isAdmin }) {
  if (!request || !userId) return false;
  if (isAdmin) return true;
  return Array.isArray(request.recipient_ids) && request.recipient_ids.includes(userId);
}

function truncate(s, n) {
  const t = String(s || '').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

function toMessage(title, lines) {
  const body = lines.filter(Boolean).join('\n');
  return {
    title,
    body,
    chatwork: `[info][title]${title}[/title]${body}[/info]`,
    slack: `*${title}*\n${body}`,
  };
}

function buildJoinRequestMessage({ requesterName, clientName, projectName, message, url }) {
  const who = requesterName || 'メンバー';
  return toMessage(`🙋 案件への参加申請: ${projectName || '(案件名なし)'}`, [
    `${who}さんから案件への参加申請が届きました。内容を確認して承認・却下してください。`,
    `クライアント: ${clientName || '-'} / 案件: ${projectName || '-'}`,
    `申請理由: ${truncate(message, 300)}`,
    url || '',
  ]);
}

function buildJoinDecisionMessage({ approved, deciderName, clientName, projectName, note, registered, url }) {
  const title = approved
    ? `✅ 参加申請が承認されました: ${projectName || '(案件名なし)'}`
    : `↩️ 参加申請は見送りになりました: ${projectName || '(案件名なし)'}`;
  const lines = [
    approved
      ? `${deciderName || '担当者'}さんが参加申請を承認しました。${registered ? '支払先メンバーとして登録済みです。' : ''}`
      : `${deciderName || '担当者'}さんが参加申請を見送りました。`,
    `クライアント: ${clientName || '-'} / 案件: ${projectName || '-'}`,
  ];
  if (String(note || '').trim()) lines.push(`ひとこと: ${truncate(note, 300)}`);
  if (url) lines.push(url);
  return toMessage(title, lines);
}

module.exports = {
  MESSAGE_MAX_LENGTH,
  DIRECT_REGISTER_PERMISSIONS,
  normalizeJoinMessage,
  buildRecipientCandidates,
  validateRecipientIds,
  canDecideJoinRequest,
  buildJoinRequestMessage,
  buildJoinDecisionMessage,
};
