// utils/member-notify.js
// =============================================================
// メンバー個人への DM 送信チェーン（振込管理 routes/haruka.js の /admin/payouts/:id/pay と同じ挙動）。
//
// 送信先の優先順:
//   1) users.chatwork_direct_room_id（Chatwork 個別チャット）
//   2) system_settings.contract_notify_chatwork_room_id（無ければ payout_notify_chatwork_room_id、
//      それも無ければ【HF】全体チャット）に [To:chatwork_dm_id]（数字IDのみ。非数字は To が silent 失敗する）
//   3) users.slack_dm_id に Slack DM（system_settings.payout_slack_user_token があれば本人名義、
//      無ければ / 失敗時は bot 名義）
// メールは送らない（基盤なし）。
//
// 公開API:
//   notifyMember(user, { chatwork, slack }) → { ok, channel, reason, body }
//     channel: 'chatwork_direct' | 'chatwork_room' | 'slack_dm' | 'none'
//   notifyAdmins({ chatwork, slack }, { permissionKey }) → [{ user_id, ok, channel, reason }]
//   loadContractNotifyRoomId() / loadSlackUserToken()
// =============================================================

const supabase = require('../supabase');
const { getUsersRolesMap, roleCodesHavePermission } = require('./roles');

const CONTRACT_ROOM_SETTING_KEY = 'contract_notify_chatwork_room_id';
const PAYOUT_ROOM_SETTING_KEY = 'payout_notify_chatwork_room_id';
const SLACK_USER_TOKEN_SETTING_KEY = 'payout_slack_user_token';
const DEFAULT_CHATWORK_ROOM_ID = '365971239'; // 【HF】全体チャット（振込管理・請求書案内と同じ既定）

// DM 送信に必要な users 列（PII は含めない）
const NOTIFY_USER_COLUMNS = 'id, full_name, nickname, is_active, chatwork_dm_id, chatwork_direct_room_id, slack_dm_id';

async function readSetting(key) {
  const { data } = await supabase.from('system_settings').select('value').eq('key', key).maybeSingle();
  return data && data.value ? String(data.value).trim() : '';
}

async function loadContractNotifyRoomId() {
  return (await readSetting(CONTRACT_ROOM_SETTING_KEY))
    || (await readSetting(PAYOUT_ROOM_SETTING_KEY))
    || DEFAULT_CHATWORK_ROOM_ID;
}

async function loadSlackUserToken() {
  return (await readSetting(SLACK_USER_TOKEN_SETTING_KEY)) || null;
}

function isDigits(v) { return /^\d+$/.test(String(v || '').trim()); }
function isSlackUserId(v) { return /^[UW][A-Z0-9]+$/i.test(String(v || '').trim()); }

/**
 * @param {object} user users 行（id, chatwork_dm_id, chatwork_direct_room_id, slack_dm_id）
 * @param {{chatwork:string, slack:string}} message
 * @returns {Promise<{ok:boolean, channel:string, reason:string|null, body:string|null, sender?:string}>}
 */
async function notifyMember(user, message) {
  const text = message || {};
  const chatworkText = text.chatwork || text.slack || '';
  const slackText = text.slack || text.chatwork || '';
  if (!user) return { ok: false, channel: 'none', reason: 'メンバーが見つからないため送信していません', body: null };
  if (!chatworkText && !slackText) return { ok: false, channel: 'none', reason: '送信本文が空です', body: null };

  const { sendChatworkRoom, sendSlackDm, sendSlackDmAsUser } = require('../notifications');
  const dm = String(user.chatwork_dm_id || '').trim();
  const directRoom = String(user.chatwork_direct_room_id || '').trim();
  const slackId = String(user.slack_dm_id || '').trim();
  const reasons = [];

  if (isDigits(directRoom)) {
    const r = await sendChatworkRoom(directRoom, chatworkText);
    if (r.ok) return { ok: true, channel: 'chatwork_direct', reason: null, body: chatworkText };
    reasons.push(`Chatwork DM 送信に失敗（${r.reason || r.status}）`);
  }
  if (isDigits(dm)) {
    const roomId = await loadContractNotifyRoomId();
    const body = `[To:${dm}]${chatworkText}`;
    const r = await sendChatworkRoom(roomId, body);
    if (r.ok) return { ok: true, channel: 'chatwork_room', reason: null, body };
    reasons.push(`Chatwork 送信に失敗（${r.reason || r.status}）`);
  }
  if (isSlackUserId(slackId)) {
    const userToken = await loadSlackUserToken();
    if (userToken) {
      const r = await sendSlackDmAsUser(userToken, slackId, slackText);
      if (r.ok) return { ok: true, channel: 'slack_dm', sender: 'user', reason: null, body: slackText };
      console.warn('[contract-notify] 本人名義Slack送信に失敗、bot名義へフォールバック:', r.reason);
    }
    const r = await sendSlackDm(slackId, slackText);
    if (r.ok) return { ok: true, channel: 'slack_dm', sender: 'bot', reason: null, body: slackText };
    reasons.push(`Slack DM 送信に失敗（${r.reason || r.status}）`);
  }
  if (reasons.length === 0) reasons.push('Chatwork・Slack とも未登録のため送信していません');
  return { ok: false, channel: 'none', reason: reasons.join(' / '), body: null };
}

/**
 * 指定 permission（既定 contract.page）を持つ有効メンバー全員に通知する（Slack DM / Chatwork）。
 * ロール判定は user_roles 集合（roleCodesHavePermission）。user_roles が空なら users.role で代替。
 * @param {{chatwork:string, slack:string}} message
 * @param {{permissionKey?:string, slackUserIds?:string[]}} [opts] slackUserIds を渡すとその Slack ID 宛のみ（日次サマリ用）
 */
async function notifyAdmins(message, opts = {}) {
  const permissionKey = opts.permissionKey || 'contract.page';
  const results = [];
  if (Array.isArray(opts.slackUserIds) && opts.slackUserIds.length > 0) {
    const { sendSlackDm } = require('../notifications');
    for (const sid of opts.slackUserIds) {
      if (!isSlackUserId(sid)) continue;
      const r = await sendSlackDm(sid, (message && (message.slack || message.chatwork)) || '');
      results.push({ user_id: null, slack_user_id: sid, ok: !!r.ok, channel: r.ok ? 'slack_dm' : 'none', reason: r.ok ? null : (r.reason || null) });
    }
    return results;
  }
  const { data: users, error } = await supabase
    .from('users')
    .select(`${NOTIFY_USER_COLUMNS}, role`)
    .eq('is_active', true);
  if (error) {
    console.warn('[contract-notify] 管理者一覧の取得に失敗:', error.message);
    return results;
  }
  const rolesMap = await getUsersRolesMap((users || []).map(u => u.id));
  for (const u of users || []) {
    const codes = (rolesMap.get(u.id) || []).map(r => (typeof r === 'string' ? r : r.code)).filter(Boolean);
    const effective = codes.length > 0 ? codes : (u.role ? [u.role] : []);
    if (effective.length === 0) continue;
    if (!(await roleCodesHavePermission(effective, permissionKey))) continue;
    const r = await notifyMember(u, message);
    results.push({ user_id: u.id, ok: r.ok, channel: r.channel, reason: r.reason });
  }
  return results;
}

module.exports = {
  notifyMember,
  notifyAdmins,
  loadContractNotifyRoomId,
  loadSlackUserToken,
  NOTIFY_USER_COLUMNS,
  CONTRACT_ROOM_SETTING_KEY,
  DEFAULT_CHATWORK_ROOM_ID,
};
