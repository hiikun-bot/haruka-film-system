// notifications.js — Slack + Chatwork 通知ユーティリティ
//
// 使い方:
//   const notif = require('./notifications');
//   await notif.notifyCreativeStatusChange({ creative, oldStatus, newStatus, comment, actorUserId });
//
// 環境変数:
//   - CHATWORK_API_TOKEN: Chatwork API トークン (アカウント単位で発行)
//
// Slack はワークスペースごとに bot_token が必要。slack_workspaces テーブル参照。
// 失敗してもアプリは止めない（catch して console.warn）。

const axios = require('axios');
const supabase = require('./supabase');

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
  // DM 先 user の Slack ID は workspace ごとに発行される。クライアントの workspace に
  // 所属する slack_dm_id を使う前提。複数 workspace 環境では workspace 別 ID が必要。
  // 本実装では、clients.slack_channel_url の workspace に DM するため、その workspace の bot を使う。
  if (!slackUserId) return { ok: false, reason: 'no_user' };
  const parsed = parseSlackChannelUrl(channelUrl);
  if (!parsed) return { ok: false, reason: 'invalid_url' };
  const token = await getSlackBotToken(parsed.team_id);
  if (!token) return { ok: false, reason: 'no_workspace_token' };
  return slackPost(token, slackUserId, text);
}

// =============== Chatwork API ===============
async function sendChatworkRoom(roomId, text) {
  const token = process.env.CHATWORK_API_TOKEN;
  if (!token) return { ok: false, reason: 'no_token' };
  if (!roomId) return { ok: false, reason: 'no_room' };
  try {
    await axios.post(`https://api.chatwork.com/v2/rooms/${roomId}/messages`,
      new URLSearchParams({ body: text, self_unread: '0' }),
      { headers: { 'X-ChatWorkToken': token }, timeout: 10000 }
    );
    return { ok: true };
  } catch (e) {
    console.warn('[notif/chatwork]', e.message);
    return { ok: false, reason: e.message };
  }
}

// ルーム内で特定ユーザーをメンション付きで投稿。
// roomId は送信先のルーム（プロジェクトの chatwork_room_id 等）。
// accountId は宛先ユーザーの Chatwork account ID（[To:NNN] 形式）。
// Chatwork API は「他人のマイチャットへ投稿」をサポートしないため、
// 旧 sendChatworkDM (accountId を roomId 扱い) は実質動作せず、本方式に置換。
async function sendChatworkMention(roomId, accountId, text) {
  if (!roomId || !accountId) return { ok: false, reason: 'missing_room_or_account' };
  const body = `[To:${accountId}]\n${text}`;
  return sendChatworkRoom(roomId, body);
}

// =============== Helpers ===============
async function loadUser(userId) {
  if (!userId) return null;
  const { data } = await supabase.from('users')
    .select('id, full_name, slack_dm_id, chatwork_dm_id').eq('id', userId).maybeSingle();
  return data || null;
}

// =============== Status transition logic ===============

// 関係者を解決して通知を送る
async function notifyCreativeStatusChange({ creative, oldStatus, newStatus, comment, actorUserId }) {
  if (!creative || !newStatus || oldStatus === newStatus) return;

  // 関連データ取得（薄く）
  // projects.slack_channel_url / projects.chatwork_room_id が設定されていれば
  // クライアント設定より優先する（案件ごとに通知先を分けたいケース）
  const { data: detail } = await supabase.from('creatives')
    .select(`
      id, file_name, memo,
      project_id,
      projects(id, name, producer_id, director_id, slack_channel_url, chatwork_room_id, clients(id, name, slack_channel_url, chatwork_room_id)),
      creative_assignments(role, users(id, full_name, slack_dm_id, chatwork_dm_id))
    `).eq('id', creative.id).maybeSingle();
  if (!detail) return;
  const project = detail.projects;
  const client  = project?.clients;
  // 案件レベル優先 → なければクライアント設定にフォールバック
  const channelUrl = project?.slack_channel_url || client?.slack_channel_url;
  const roomId    = project?.chatwork_room_id || client?.chatwork_room_id;
  const fileName  = detail.file_name;

  // 担当者の解決
  const editors  = (detail.creative_assignments || [])
    .filter(a => a.role === 'editor' || a.role === 'designer' || a.role === 'director_as_editor')
    .map(a => a.users)
    .filter(Boolean);
  const director = await loadUser(project?.director_id);
  const producer = await loadUser(project?.producer_id);
  const actor    = await loadUser(actorUserId);

  // メッセージビルダ
  const slackLink = `*${fileName}* のステータス: \`${oldStatus}\` → \`${newStatus}\``;
  const commentLine = comment ? `\n💬 ${comment}` : '';
  const cwCommentLine = comment ? `\nコメント: ${comment}` : '';

  // 遷移ごとの処理
  const sendDM = async (user, slackBody, cwBody) => {
    if (!user) return;
    if (user.slack_dm_id) await sendSlackDM(user.slack_dm_id, channelUrl, slackBody);
    // Chatwork は「ルーム内 [To:account] メンション」方式に変更。
    // roomId は project / client の chatwork_room_id（フォールバック解決済の `roomId` を再利用）
    if (user.chatwork_dm_id && roomId) {
      await sendChatworkMention(roomId, user.chatwork_dm_id, cwBody);
    }
  };

  // 1) → Dチェック
  if (newStatus === 'Dチェック') {
    await sendDM(director,
      `📥 *Dチェック依頼*\n${slackLink}${commentLine}`,
      `[info][title]Dチェック依頼[/title]${fileName}${cwCommentLine}[/info]`);
  }
  // 2) → Pチェック
  else if (newStatus === 'Pチェック') {
    await sendDM(producer,
      `📥 *Pチェック依頼*\n${slackLink}${commentLine}`,
      `[info][title]Pチェック依頼[/title]${fileName}${cwCommentLine}[/info]`);
  }
  // 3) → Dチェック後修正
  else if (newStatus === 'Dチェック後修正') {
    for (const ed of editors) {
      await sendDM(ed,
        `🔁 *Dチェック修正依頼*\n${slackLink}${commentLine}`,
        `[info][title]Dチェック修正依頼[/title]${fileName}${cwCommentLine}[/info]`);
    }
  }
  // 4) → Pチェック後修正
  else if (newStatus === 'Pチェック後修正') {
    const targets = [...editors, director].filter(Boolean);
    const seen = new Set();
    for (const t of targets) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      await sendDM(t,
        `🔁 *Pチェック修正依頼*\n${slackLink}${commentLine}`,
        `[info][title]Pチェック修正依頼[/title]${fileName}${cwCommentLine}[/info]`);
    }
  }
  // 5) → クライアントチェック中（操作した本人にテンプレ案内）
  else if (newStatus === 'クライアントチェック中') {
    if (actor) {
      const slackTpl =
`✅ *クライアント確認に進めました*: \`${fileName}\`

📝 *クライアントへ送るメッセージ案*（コピペして調整してください）:

> 〇〇様、いつもお世話になっております。
> 「${fileName}」のクライアント確認版を共有いたします。
>
> https://drive.google.com/...
>
> ご確認のほどよろしくお願いいたします。

⚠️ 送信前に必ず内容を確認してから送ってください。誤った報告はミスにつながります。`;
      const cwTpl =
`[info][title]クライアント確認に進めました[/title]${fileName}

クライアントへ送るメッセージ案:
〇〇様、いつもお世話になっております。
「${fileName}」のクライアント確認版を共有いたします。
https://drive.google.com/...
ご確認のほどよろしくお願いいたします。

※送信前に必ず内容を確認してください。[/info]`;
      await sendDM(actor, slackTpl, cwTpl);
    }
  }
  // 6) → 納品
  else if (newStatus === '納品') {
    const ann = `🎉 *納品完了*: \`${fileName}\``;
    const annCw = `[info][title]🎉 納品完了[/title]${fileName}[/info]`;
    if (channelUrl) await sendSlackChannel(channelUrl, ann);
    if (roomId)    await sendChatworkRoom(roomId, annCw);
    // チーム全員にもDM
    const allMembers = [...editors, director, producer].filter(Boolean);
    const seen = new Set();
    for (const m of allMembers) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      await sendDM(m,
        `🎉 *納品完了*: \`${fileName}\`\nお疲れ様でした！`,
        `[info][title]🎉 納品完了[/title]${fileName}\nお疲れ様でした！[/info]`);
    }
  }
}

module.exports = {
  notifyCreativeStatusChange,
  parseSlackChannelUrl,
  sendSlackChannel,
  sendChatworkRoom,
};
