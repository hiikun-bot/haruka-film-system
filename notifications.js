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
  const { data, error } = await supabase.from('slack_workspaces')
    .select('bot_token').eq('team_id', teamId).maybeSingle();
  if (error) console.warn('[notif] slack_workspaces select failed:', error.message);
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
  const { data, error } = await supabase.from('users')
    .select('id, full_name, slack_dm_id, chatwork_dm_id').eq('id', userId).maybeSingle();
  if (error) console.warn('[notif] users select failed:', error.message);
  return data || null;
}

// クリエイティブ詳細モーダルを開くディープリンク URL を生成
// APP_URL が未設定の場合は null を返す（呼び出し側でフォールバック）
function buildCreativeUrl(creativeId) {
  const baseUrl = (process.env.APP_URL || '').replace(/\/$/, '');
  if (!baseUrl || !creativeId) return null;
  return `${baseUrl}/haruka.html?creative=${creativeId}`;
}

// Slack 用: ファイル名をクリッカブルなリンクに変換
// Slack の mrkdwn 仕様 `<URL|表示テキスト>` で青いリンクとして表示される
function slackFileLink(fileName, url) {
  if (url) return `<${url}|${fileName}>`;
  return `*${fileName}*`;
}

// =============== Status transition logic ===============

// 関係者を解決して通知を送る
async function notifyCreativeStatusChange({ creative, oldStatus, newStatus, comment, actorUserId }) {
  if (!creative || !newStatus || oldStatus === newStatus) return;

  // 関連データ取得（薄く）
  // projects.slack_channel_url / projects.chatwork_room_id が設定されていれば
  // クライアント設定より優先する（案件ごとに通知先を分けたいケース）
  const { data: detail, error: detailErr } = await supabase.from('creatives')
    .select(`
      id, file_name, memo, team_id,
      project_id,
      teams(id, director_id, producer_id),
      projects(id, name, producer_id, director_id, slack_channel_url, chatwork_room_id, clients(id, name, slack_channel_url, chatwork_room_id)),
      creative_assignments(role, users(id, full_name, slack_dm_id, chatwork_dm_id))
    `).eq('id', creative.id).maybeSingle();
  // SELECT が失敗した場合（スキーマ不一致・RLS違反・接続失敗等）は必ずログを出す。
  // 2026-04-30: projects.slack_channel_url 列欠落で通知が無音失敗していた件への対策。
  if (detailErr) console.warn('[notif] creatives select failed:', detailErr.message);
  if (!detail) return;
  const project = detail.projects;
  const client  = project?.clients;
  // 案件レベル優先 → なければクライアント設定にフォールバック
  const channelUrl = project?.slack_channel_url || client?.slack_channel_url;
  const roomId    = project?.chatwork_room_id || client?.chatwork_room_id;
  const fileName  = detail.file_name;

  // 担当者の解決
  // 担当者全員（role に関わらず）。重複排除はしない（後段で seen Set で一括管理）
  const assignees = (detail.creative_assignments || [])
    .map(a => a.users)
    .filter(Boolean);
  // 案件レベル優先 → 無ければクリエイティブの team レベルにフォールバック
  // （ユーザーが teams.director_id だけ設定して projects.director_id を設定し忘れる UX 問題への対策）
  const directorId = project?.director_id || detail.teams?.director_id || null;
  const producerId = project?.producer_id || detail.teams?.producer_id || null;
  const director = await loadUser(directorId);
  const producer = await loadUser(producerId);
  const actor    = await loadUser(actorUserId);

  // 通知メッセージにクリエイティブ詳細モーダルへのディープリンクを埋め込む
  // （URL クリックで該当クリエイティブを直接開ける）
  const creativeUrl = buildCreativeUrl(detail.id);
  const slackName = slackFileLink(fileName, creativeUrl);
  const cwUrlLine = creativeUrl ? `\nURL: ${creativeUrl}` : '';

  // 遷移ごとの処理
  // Slack / Chatwork ともに「個人宛通知」として扱うため、
  // 対象ユーザーに DM ID が設定されていない場合はその通知をスキップする。
  // （ID 未設定の人にメンションなし投稿をしても本人は気づかず、
  //   関係ないチームメンバーに通知が飛ぶだけで意味がないため）
  const sendNotif = async (user, slackBody, cwBody) => {
    if (!user) return;
    if (channelUrl && user.slack_dm_id) {
      await sendSlackChannel(channelUrl, `<@${user.slack_dm_id}> ${slackBody}`);
    }
    if (roomId && user.chatwork_dm_id) {
      await sendChatworkMention(roomId, user.chatwork_dm_id, cwBody);
    }
  };

  // ディレクター不在時のフォールバック投稿（CR提出時のチャンネルメンション機能）
  // - Slack: <!here> でチャンネル内のオンライン全員に通知
  // - Chatwork: [toall] でルーム全員に通知
  // ディレクターが任命されていない / DM ID 未設定の案件で、誰かが必ず気づける状態にする。
  const sendChannelMention = async (slackBody, cwBody) => {
    if (channelUrl) {
      await sendSlackChannel(channelUrl, `<!here> ${slackBody}`);
    }
    if (roomId) {
      await sendChatworkRoom(roomId, `[toall]\n${cwBody}`);
    }
  };

  // 1) → Dチェック
  //    通常はディレクター個人にDM。
  //    ディレクター未設定 or DM ID 未設定（slack_dm_id・chatwork_dm_id 両方とも無い）の
  //    場合は、チャンネル/ルームに @here / [toall] でフォールバック投稿する。
  //    （ディレクターがいない案件でもCR提出が誰にも届かない事態を防ぐ）
  if (newStatus === 'Dチェック') {
    const slackBody = `📥 Dチェック依頼\nファイル: ${slackName}${comment ? `\n💬 ${comment}` : ''}`;
    const cwBody = `[info][title]📥 Dチェック依頼[/title]ファイル: ${fileName}${cwUrlLine}${comment ? `\nコメント: ${comment}` : ''}[/info]`;
    const directorReachable = director && (director.slack_dm_id || director.chatwork_dm_id);
    if (directorReachable) {
      await sendNotif(director, slackBody, cwBody);
    } else {
      // フォールバック: チャンネル/ルーム全員にメンション
      const note = '\n（ディレクター未設定のため関係者にメンションしています）';
      const slackFallback = slackBody + note;
      const cwFallback = cwBody.replace('[/info]', note + '[/info]');
      await sendChannelMention(slackFallback, cwFallback);
    }
  }
  // 2) → Pチェック
  else if (newStatus === 'Pチェック') {
    const slackBody = `📥 Pチェック依頼\nファイル: ${slackName}${comment ? `\n💬 ${comment}` : ''}`;
    const cwBody = `[info][title]📥 Pチェック依頼[/title]ファイル: ${fileName}${cwUrlLine}${comment ? `\nコメント: ${comment}` : ''}[/info]`;
    await sendNotif(producer, slackBody, cwBody);
  }
  // 3) → Dチェック後修正
  else if (newStatus === 'Dチェック後修正') {
    const slackBody = `🔁 Dチェック修正依頼\nファイル: ${slackName}${comment ? `\n💬 ${comment}` : ''}`;
    const cwBody = `[info][title]🔁 Dチェック修正依頼[/title]ファイル: ${fileName}${cwUrlLine}${comment ? `\nコメント: ${comment}` : ''}[/info]`;
    for (const ed of assignees) await sendNotif(ed, slackBody, cwBody);
  }
  // 4) → Pチェック後修正
  else if (newStatus === 'Pチェック後修正') {
    const slackBody = `🔁 Pチェック修正依頼\nファイル: ${slackName}${comment ? `\n💬 ${comment}` : ''}`;
    const cwBody = `[info][title]🔁 Pチェック修正依頼[/title]ファイル: ${fileName}${cwUrlLine}${comment ? `\nコメント: ${comment}` : ''}[/info]`;
    const targets = [...assignees, director].filter(Boolean);
    const seen = new Set();
    for (const t of targets) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      await sendNotif(t, slackBody, cwBody);
    }
  }
  // 5) → クライアントチェック中（操作した本人にテンプレ案内）
  //    メンション方式によりチームにも見える形になるが、ミス防止のため第三者レビュー可能な
  //    状態は許容する仕様。
  else if (newStatus === 'クライアントチェック中') {
    if (actor) {
      const slackTpl =
`✅ クライアント確認に進めました
ファイル: ${slackName}

📝 クライアントへ送るメッセージ案（コピペして調整してください）:

> 〇〇様、いつもお世話になっております。
> 「${fileName}」のクライアント確認版を共有いたします。
> https://drive.google.com/...
> ご確認のほどよろしくお願いいたします。

⚠️ 送信前に必ず内容を確認してください。`;
      const cwTpl =
`[info][title]✅ クライアント確認に進めました[/title]ファイル: ${fileName}${cwUrlLine}

クライアントへ送るメッセージ案:
〇〇様、いつもお世話になっております。
「${fileName}」のクライアント確認版を共有いたします。
https://drive.google.com/...
ご確認のほどよろしくお願いいたします。

※送信前に必ず内容を確認してください。[/info]`;
      await sendNotif(actor, slackTpl, cwTpl);
    }
  }
  // 6) → 納品（クリエイター向けにお祝いメッセージ）
  //    PR #67 で削除されていたが、クリエイターは「クライアントOKが出たかどうか」を
  //    把握する手段がほぼ唯一この通知のため復活。assignees（担当者全員）に送る。
  else if (newStatus === '納品') {
    const slackBody = `🎉 クライアントOK！納品完了\nファイル: ${slackName}\nお疲れ様でした！クライアントから承認をいただき納品となりました ☺️✨`;
    const cwBody = `[info][title]🎉 クライアントOK！納品完了[/title]ファイル: ${fileName}${cwUrlLine}\nお疲れ様でした！\nクライアントから承認をいただき納品となりました ☺️✨[/info]`;
    for (const ed of assignees) await sendNotif(ed, slackBody, cwBody);
  }
}

module.exports = {
  notifyCreativeStatusChange,
  parseSlackChannelUrl,
  sendSlackChannel,
  sendChatworkRoom,
};
