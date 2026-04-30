// notifications.js — Slack + Chatwork 通知ユーティリティ
//
// 使い方:
//   const notif = require('./notifications');
//   await notif.notifyCreativeStatusChange({ creative, oldStatus, newStatus, comment, actorUserId });
//
// 環境変数:
//   - CHATWORK_API_TOKEN: Chatwork API トークン (Bot 専用アカウント推奨)
//   - APP_URL          : フロント URL（メッセージに添える）
//
// Slack はワークスペースごとに bot_token が必要。slack_workspaces テーブル参照。
// 失敗してもアプリは止めない（catch して console.warn）。

const axios = require('axios');
const supabase = require('./supabase');
const { postChatworkMessage } = require('./chatwork');

// =============== Slack URL parser ===============
function parseSlackChannelUrl(url) {
  if (!url) return null;
  // https://app.slack.com/client/TXXXX/CXXXX or /client/TXXXX/CXXXX/...
  const m = String(url).match(/\/client\/(T[A-Z0-9]+)\/(C[A-Z0-9]+)/);
  if (!m) return null;
  return { team_id: m[1], channel_id: m[2] };
}

// =============== Slack Bot Token Resolution ===============
async function getSlackBotToken(teamId) {
  if (!teamId) return null;
  const { data } = await supabase.from('slack_workspaces')
    .select('bot_token').eq('team_id', teamId).maybeSingle();
  return data?.bot_token || null;
}

// =============== Slack API ===============
async function slackPost(token, channelOrUserId, text) {
  if (!token) return { ok: false, reason: 'no_token' };
  try {
    const res = await axios.post('https://slack.com/api/chat.postMessage',
      { channel: channelOrUserId, text },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 10000 }
    );
    if (!res.data.ok) {
      console.warn('[notif/slack]', res.data.error, channelOrUserId);
      return { ok: false, reason: res.data.error };
    }
    return { ok: true };
  } catch (e) {
    console.warn('[notif/slack] axios fail:', e.message);
    return { ok: false, reason: e.message };
  }
}

async function sendSlackChannel(channelUrl, text) {
  const parsed = parseSlackChannelUrl(channelUrl);
  if (!parsed) return { ok: false, reason: 'invalid_url' };
  const token = await getSlackBotToken(parsed.team_id);
  if (!token) return { ok: false, reason: 'no_workspace_token' };
  return slackPost(token, parsed.channel_id, text);
}

async function sendSlackDM(slackUserId, channelUrl, text) {
  if (!slackUserId) return { ok: false, reason: 'no_user' };
  const parsed = parseSlackChannelUrl(channelUrl);
  if (!parsed) return { ok: false, reason: 'invalid_url' };
  const token = await getSlackBotToken(parsed.team_id);
  if (!token) return { ok: false, reason: 'no_workspace_token' };
  return slackPost(token, slackUserId, text);
}

// =============== Chatwork API ===============
// Chatwork ルームへの投稿は chatwork.js の postChatworkMessage を直接使う。
async function sendChatworkRoom(roomId, text) {
  return postChatworkMessage(roomId, text);
}

// Chatwork DM = ユーザーごとの DM ルーム ID（users.chatwork_dm_id）に対する投稿。
async function sendChatworkDM(dmRoomId, text) {
  if (!dmRoomId) return { ok: false, reason: 'no_dm_room' };
  return postChatworkMessage(dmRoomId, text);
}

// =============== Helpers ===============
async function loadUser(userId) {
  if (!userId) return null;
  const { data } = await supabase.from('users')
    .select('id, full_name, slack_dm_id, chatwork_dm_id').eq('id', userId).maybeSingle();
  return data || null;
}

function buildChatworkBody({ title, project, creative, editor }) {
  const lines = [`[info][title]${title}[/title]`];
  if (project)  lines.push(`案件: ${project}`);
  if (creative) lines.push(`クリエイティブ: ${creative}`);
  if (editor)   lines.push(`編集者: ${editor}`);
  const appUrl = process.env.APP_URL;
  if (appUrl) lines.push(`URL: ${appUrl}`);
  lines.push('[/info]');
  return lines.join('\n');
}

// =============== Status transition logic ===============

// 関係者を解決して通知を送る
async function notifyCreativeStatusChange({ creative, oldStatus, newStatus, comment, actorUserId }) {
  if (!creative || !newStatus || oldStatus === newStatus) return;

  // 関連データ取得（薄く）。projects.chatwork_room_id を使うため projects 側から取る。
  const { data: detail } = await supabase.from('creatives')
    .select(`
      id, file_name, memo,
      project_id,
      projects(id, name, producer_id, director_id, chatwork_room_id, clients(id, name, slack_channel_url)),
      creative_assignments(role, users(id, full_name, slack_dm_id, chatwork_dm_id))
    `).eq('id', creative.id).maybeSingle();
  if (!detail) return;

  const project    = detail.projects;
  const client     = project?.clients;
  const channelUrl = client?.slack_channel_url;
  const projectRoomId = project?.chatwork_room_id || null;
  const fileName   = detail.file_name || '(無題)';
  const projectName = project?.name || '(案件名なし)';

  // 担当者の解決
  const editors = (detail.creative_assignments || [])
    .filter(a => a.role === 'editor' || a.role === 'designer' || a.role === 'director_as_editor')
    .map(a => a.users)
    .filter(Boolean);
  const director = await loadUser(project?.director_id);
  const producer = await loadUser(project?.producer_id);
  const actor    = await loadUser(actorUserId);

  const editorName = editors.map(e => e?.full_name).filter(Boolean).join(', ') || null;

  // メッセージビルダ
  const slackLink = `*${fileName}* のステータス: \`${oldStatus}\` → \`${newStatus}\``;
  const commentLine = comment ? `\n💬 ${comment}` : '';

  // 共通: ユーザー宛 DM 送信（Slack DM + Chatwork DM）
  const sendDM = async (user, slackBody, cwBody) => {
    if (!user) return;
    if (user.slack_dm_id && channelUrl) {
      await sendSlackDM(user.slack_dm_id, channelUrl, slackBody).catch(() => {});
    }
    if (user.chatwork_dm_id) {
      await sendChatworkDM(user.chatwork_dm_id, cwBody).catch(() => {});
    }
  };

  // ====== 通知マッピング (仕様に合わせる) ======
  // 1) → Dチェック（director_id ユーザー or role='director' のアサイン）
  if (newStatus === 'Dチェック') {
    const targets = [];
    const directorAssignees = (detail.creative_assignments || [])
      .filter(a => a.role === 'director')
      .map(a => a.users).filter(Boolean);
    if (directorAssignees.length) targets.push(...directorAssignees);
    else if (director) targets.push(director);
    const cwBody = buildChatworkBody({
      title: '🎬 Dチェック依頼',
      project: projectName, creative: fileName, editor: editorName,
    });
    const slackBody = `📥 *🎬 Dチェック依頼*\n${slackLink}${commentLine}`;
    const seen = new Set();
    for (const u of targets) {
      if (!u || seen.has(u.id)) continue;
      seen.add(u.id);
      await sendDM(u, slackBody, cwBody);
    }
    return;
  }

  // 2) → Dチェック後修正（editor / designer / director_as_editor）
  if (newStatus === 'Dチェック後修正') {
    const cwBody = buildChatworkBody({
      title: '✏️ Dチェック後修正依頼',
      project: projectName, creative: fileName, editor: editorName,
    });
    const slackBody = `🔁 *✏️ Dチェック後修正依頼*\n${slackLink}${commentLine}`;
    const seen = new Set();
    for (const u of editors) {
      if (!u || seen.has(u.id)) continue;
      seen.add(u.id);
      await sendDM(u, slackBody, cwBody);
    }
    return;
  }

  // 3) → Pチェック（producer_id ユーザー）
  if (newStatus === 'Pチェック') {
    const cwBody = buildChatworkBody({
      title: '🎬 Pチェック依頼',
      project: projectName, creative: fileName, editor: editorName,
    });
    const slackBody = `📥 *🎬 Pチェック依頼*\n${slackLink}${commentLine}`;
    if (producer) await sendDM(producer, slackBody, cwBody);
    return;
  }

  // 4) → Pチェック後修正（editor 系）
  if (newStatus === 'Pチェック後修正') {
    const cwBody = buildChatworkBody({
      title: '✏️ Pチェック後修正依頼',
      project: projectName, creative: fileName, editor: editorName,
    });
    const slackBody = `🔁 *✏️ Pチェック後修正依頼*\n${slackLink}${commentLine}`;
    const seen = new Set();
    for (const u of editors) {
      if (!u || seen.has(u.id)) continue;
      seen.add(u.id);
      await sendDM(u, slackBody, cwBody);
    }
    return;
  }

  // 5) → クライアントチェック後修正（editor + director + producer 全員）
  if (newStatus === 'クライアントチェック後修正') {
    const cwBody = buildChatworkBody({
      title: '✏️ クライアント修正依頼',
      project: projectName, creative: fileName, editor: editorName,
    });
    const slackBody = `🔁 *✏️ クライアント修正依頼*\n${slackLink}${commentLine}`;
    const everyone = [...editors, director, producer].filter(Boolean);
    const seen = new Set();
    for (const u of everyone) {
      if (!u || seen.has(u.id)) continue;
      seen.add(u.id);
      await sendDM(u, slackBody, cwBody);
    }
    return;
  }

  // 6) → 納品（projects.chatwork_room_id があればそこに投稿）
  if (newStatus === '納品') {
    const cwBody = buildChatworkBody({
      title: '✅ 納品完了',
      project: projectName, creative: fileName, editor: editorName,
    });
    if (projectRoomId) {
      await sendChatworkRoom(projectRoomId, cwBody).catch(() => {});
    }
    // Slack 既存挙動（チャンネルあれば投稿）
    if (channelUrl) {
      await sendSlackChannel(channelUrl, `🎉 *納品完了*: \`${fileName}\``).catch(() => {});
    }
    return;
  }

  // それ以外のステータスは通知しない
}

module.exports = {
  notifyCreativeStatusChange,
  parseSlackChannelUrl,
  sendSlackChannel,
  sendChatworkRoom,
  sendChatworkDM,
};
