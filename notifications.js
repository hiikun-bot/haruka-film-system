// notifications.js — Slack + Chatwork 通知ユーティリティ
//
// 使い方:
//   const notif = require('./notifications');
//   await notif.notifyCreativeStatusChange({ creative, oldStatus, newStatus, comment, actorUserId });
//
// 環境変数:
//   - CHATWORK_API_TOKEN: Chatwork API トークン (アカウント単位で発行)
//   - CHATWORK_USER_TOKENS_JSON: Chatwork account_id ごとのAPIトークンJSON
//       例: {"123456":"token_for_user_a","789012":"token_for_user_b"}
//     または CHATWORK_API_TOKEN_<account_id> でも個別指定可。
//
// Slack はワークスペースごとに bot_token が必要。slack_workspaces テーブル参照。
// 失敗してもアプリは止めない（catch して console.warn）。

const axios = require('axios');
const supabase = require('./supabase');
const { createBulkNotifications } = require('./utils/notification');

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

// Slack files V2 API でファイル付き投稿。bot に files:write + chat:write が必要。
// legacy files.upload は 2025-03 廃止のため使わない。
// 流れ: getUploadURLExternal → upload_url へ PUT → completeUploadExternal
async function sendSlackChannelWithFile(channelUrl, text, fileBuffer, filename) {
  const parsed = parseSlackChannelUrl(channelUrl);
  if (!parsed) return { ok: false, reason: 'invalid_url' };
  const token = await getSlackBotToken(parsed.team_id);
  if (!token) return { ok: false, reason: 'no_workspace_token' };
  if (!fileBuffer || !fileBuffer.length) return { ok: false, reason: 'empty_file' };
  // Slack initial_comment は 4000 字制限。安全側で 3500 字に丸める。
  const initial = String(text || '').slice(0, 3500);
  try {
    // 1) upload URL を取得
    const step1 = await axios.post(
      'https://slack.com/api/files.getUploadURLExternal',
      new URLSearchParams({ filename: filename || 'file.bin', length: String(fileBuffer.length) }),
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 }
    );
    if (!step1.data.ok) {
      console.warn('[notif/slack] getUploadURLExternal:', step1.data.error);
      return { ok: false, reason: step1.data.error };
    }
    const { upload_url, file_id } = step1.data;
    // 2) 本体を upload_url に POST（raw body 推奨）
    await axios.post(upload_url, fileBuffer, {
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': fileBuffer.length },
      maxBodyLength: Infinity, maxContentLength: Infinity, timeout: 30000,
    });
    // 3) チャンネルへ投稿完了
    const step3 = await axios.post(
      'https://slack.com/api/files.completeUploadExternal',
      { files: [{ id: file_id, title: filename || 'file' }], channel_id: parsed.channel_id, initial_comment: initial },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 10000 }
    );
    if (!step3.data.ok) {
      console.warn('[notif/slack] completeUploadExternal:', step3.data.error);
      return { ok: false, reason: step3.data.error };
    }
    return { ok: true };
  } catch (e) {
    console.warn('[notif/slack] file upload fail:', e.message);
    return { ok: false, reason: e.message };
  }
}

// =============== Chatwork API ===============
let _chatworkUserTokensCache = null;
let _chatworkUserTokensRaw = null;
let _chatworkUserTokensWarned = false;
const _chatworkRoomMemberCache = new Map();

function getChatworkUserTokens() {
  const raw = process.env.CHATWORK_USER_TOKENS_JSON || '';
  if (_chatworkUserTokensCache && raw === _chatworkUserTokensRaw) return _chatworkUserTokensCache;
  _chatworkUserTokensRaw = raw;
  _chatworkUserTokensCache = {};
  if (!raw.trim()) return _chatworkUserTokensCache;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      _chatworkUserTokensCache = parsed;
    }
  } catch (e) {
    if (!_chatworkUserTokensWarned) {
      console.warn('[notif/chatwork] CHATWORK_USER_TOKENS_JSON parse failed:', e.message);
      _chatworkUserTokensWarned = true;
    }
  }
  return _chatworkUserTokensCache;
}

function getChatworkTokenForAccount(accountId) {
  if (!accountId) return null;
  const key = String(accountId).trim();
  if (!key) return null;
  const envKey = `CHATWORK_API_TOKEN_${key.replace(/[^A-Za-z0-9_]/g, '_')}`;
  return process.env[envKey] || getChatworkUserTokens()[key] || null;
}

async function isChatworkAccountInRoom(roomId, accountId, token) {
  if (!roomId || !accountId || !token) return false;
  const cacheKey = `${roomId}:${accountId}`;
  if (_chatworkRoomMemberCache.has(cacheKey)) return _chatworkRoomMemberCache.get(cacheKey);
  try {
    const res = await axios.get(`https://api.chatwork.com/v2/rooms/${roomId}/members`, {
      headers: { 'X-ChatWorkToken': token },
      timeout: 10000,
      validateStatus: () => true,
    });
    if (res.status !== 200 || !Array.isArray(res.data)) {
      _chatworkRoomMemberCache.set(cacheKey, false);
      return false;
    }
    const found = res.data.some(m => String(m.account_id) === String(accountId));
    _chatworkRoomMemberCache.set(cacheKey, found);
    return found;
  } catch (e) {
    console.warn('[notif/chatwork] member check failed:', e.message);
    _chatworkRoomMemberCache.set(cacheKey, false);
    return false;
  }
}

async function resolveChatworkPostToken(roomId, actor) {
  const defaultToken = process.env.CHATWORK_API_TOKEN;
  const actorAccountId = actor?.chatwork_dm_id;
  const actorToken = getChatworkTokenForAccount(actorAccountId);
  if (actorAccountId && actorToken) {
    const isMember = await isChatworkAccountInRoom(roomId, actorAccountId, actorToken);
    if (isMember) return { token: actorToken, sender: 'actor' };
  }
  return { token: defaultToken, sender: 'default' };
}

async function sendChatworkRoom(roomId, text, opts={}) {
  const token = opts.token || process.env.CHATWORK_API_TOKEN;
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
async function sendChatworkMention(roomId, accountId, text, opts={}) {
  if (!roomId || !accountId) return { ok: false, reason: 'missing_room_or_account' };
  const body = `[To:${accountId}]\n${text}`;
  return sendChatworkRoom(roomId, body, opts);
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

// 起動時に APP_URL 未設定なら一度だけ警告。
// （URL が含まれない通知は受信者がクリエイティブを特定する手がかりが減るため）
if (!process.env.APP_URL) {
  console.warn('[notif] APP_URL 未設定: 通知 URL が含まれません');
}

// 通知本文テンプレート: D/P チェック 系（クライアント確認・納品は別テンプレ）
// kind: 通知の見出し（例: "Dチェック依頼" / "Pチェック修正依頼"）
// emoji: 見出し前のアイコン（既存パターン: 📥 / 🔁）
// project / client: detail.projects / detail.projects.clients
// fileName: クリエイティブのファイル名（プレーン）
// slackName: Slack 用ファイル名（リンク化済み）
// actor: 操作した人（ログインユーザー）。未解決なら null。
// recipient: 受信者（director / producer / 担当者）。未解決なら null。
//            複数受信者を1メッセージにまとめる場合は配列を渡す（カンマ区切りで表示）。
// comment: ステータス遷移時に付与されたコメント。空なら「（コメントなし）」表示。
// creativeUrl: ディープリンク URL。未設定なら URL 行を出さない。
function buildCreativeNotifBody({ kind, emoji, project, client, fileName, slackName, actor, recipient, comment, creativeUrl }) {
  const projectLabel = (() => {
    const cn = client?.name ? `【${client.name}】` : '';
    const pn = project?.name || '';
    if (cn || pn) return `${cn}${pn}` || '-';
    return '-';
  })();
  const actorName = actor?.full_name || '不明';
  // recipient は単一ユーザーオブジェクト or 配列を許容
  const recipientName = (() => {
    if (Array.isArray(recipient)) {
      const names = recipient.map(r => r?.full_name).filter(Boolean);
      return names.length ? names.join(', ') : '担当者';
    }
    return recipient?.full_name || '担当者';
  })();
  const fromTo = `${actorName} → ${recipientName}`;
  const commentBlock = (comment && String(comment).trim())
    ? String(comment).trim()
    : '（コメントなし）';

  // Slack 本文（mrkdwn）。ファイル名は <url|name> 形式で青リンク化済み。
  // 見出しを区切り線で挟み、本文項目は装飾なしで1行ずつ並べる（バグ報告 #82b1c20d）。
  // メンション行は呼び出し側が body の前に `${mentions}\n\n` で連結する。
  // URL 行はファイル名リンクとは別に立てる。Slack 上で全角文字混じりのリンクが
  // 切れて見えるケース（モバイル等）でも、平文 URL を1行載せておけばコピペで飛べる。
  // バグ報告 #8d97a0e7「動画への URL もあるとそのまま飛べる」要望対応。
  const SEP = '━━━━━━━━━━━━━━━';
  const slackLines = [
    SEP,
    `${emoji} *${kind}*`,
    SEP,
    '',
    `案件: ${projectLabel}`,
    `ファイル: ${slackName}`,
    `担当者: ${fromTo}`,
    `コメント: ${commentBlock}`,
  ];
  if (creativeUrl) slackLines.push(`URL: ${creativeUrl}`);
  const slackBody = slackLines.join('\n');

  // Chatwork 本文（[info][title]...[/title]...[/info]）。
  // URL 行は info ブロック内に置く（クリック可能）。
  const cwLines = [
    `[info][title]${emoji} ${kind}[/title]`,
    `案件: ${projectLabel}`,
    `ファイル: ${fileName}`,
    `担当者: ${fromTo}`,
    `コメント:`,
    commentBlock,
  ];
  if (creativeUrl) cwLines.push(`URL: ${creativeUrl}`);
  cwLines.push('[/info]');
  const cwBody = cwLines.join('\n');

  return { slackBody, cwBody };
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
      id, file_name, memo, team_id, client_review_url,
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
  // role 別に分離:
  //   - editorAssignees:   編集者・デザイナー（製作者側）。修正依頼・納品通知の宛先
  //   - directorAssignees: ディレクター（チェッカー側）。Dチェック依頼の宛先
  //   - producerAssignees: プロデューサー（チェッカー側）。Pチェック依頼の宛先
  // 旧 `assignees` は editorAssignees にエイリアス（製作者側に通知する意図に統一）
  const editorAssignees = (detail.creative_assignments || [])
    .filter(a => ['editor', 'designer', 'director_as_editor'].includes(a.role))
    .map(a => a.users)
    .filter(Boolean);
  const directorAssignees = (detail.creative_assignments || [])
    .filter(a => a.role === 'director')
    .map(a => a.users)
    .filter(Boolean);
  const producerAssignees = (detail.creative_assignments || [])
    .filter(a => a.role === 'producer')
    .map(a => a.users)
    .filter(Boolean);
  // 互換: 既存コードで `assignees` を参照している箇所は editorAssignees の意図
  const assignees = editorAssignees;
  // 案件レベル優先 → 無ければクリエイティブの team レベルにフォールバック
  // （ユーザーが teams.director_id だけ設定して projects.director_id を設定し忘れる UX 問題への対策）
  const directorId = project?.director_id || detail.teams?.director_id || null;
  const producerId = project?.producer_id || detail.teams?.producer_id || null;
  const director = await loadUser(directorId);
  const producer = await loadUser(producerId);
  const actor    = await loadUser(actorUserId);
  const chatworkPost = roomId
    ? await resolveChatworkPostToken(roomId, actor)
    : { token: null, sender: 'none' };

  // 通知メッセージにクリエイティブ詳細モーダルへのディープリンクを埋め込む
  // （URL クリックで該当クリエイティブを直接開ける）
  const creativeUrl = buildCreativeUrl(detail.id);
  const slackName = slackFileLink(fileName, creativeUrl);
  const cwUrlLine = creativeUrl ? `\nURL: ${creativeUrl}` : '';

  // 共通テンプレ生成ヘルパ（D/P 系で共有）
  const tpl = (kind, emoji, recipient) => buildCreativeNotifBody({
    kind, emoji, project, client, fileName, slackName,
    actor, recipient, comment, creativeUrl,
  });

  // 遷移ごとの処理
  // Slack / Chatwork ともに「個人宛通知」として扱うため、
  // 対象ユーザーに DM ID が設定されていない場合はその通知をスキップする。
  // （ID 未設定の人にメンションなし投稿をしても本人は気づかず、
  //   関係ないチームメンバーに通知が飛ぶだけで意味がないため）
  const sendNotif = async (user, slackBody, cwBody) => {
    if (!user) return;
    if (channelUrl && user.slack_dm_id) {
      await sendSlackChannel(channelUrl, `<@${user.slack_dm_id}>\n\n${slackBody}`);
    }
    if (roomId && user.chatwork_dm_id) {
      await sendChatworkMention(roomId, user.chatwork_dm_id, cwBody, { token: chatworkPost.token });
    }
  };

  // 集約版: 複数 user 宛に同じ本文を「1回だけ」投稿する。
  // 重複は id ベースで除外。Slack は <@id> をスペース区切りで連結、
  // Chatwork は [To:id][To:id] を連結（仕様上複数 To 可）。
  // DM ID 未設定者はそのプラットフォームでスキップ（届かない人にメンションしても無音のため）。
  // 戻り値: { reachableSlackCount, reachableCwCount, anyReachable }
  const sendNotifMulti = async (users, slackBody, cwBody) => {
    const result = { reachableSlackCount: 0, reachableCwCount: 0, anyReachable: false };
    if (!Array.isArray(users) || users.length === 0) return result;
    const seen = new Set();
    const uniq = users.filter(u => {
      if (!u || !u.id || seen.has(u.id)) return false;
      seen.add(u.id);
      return true;
    });
    if (uniq.length === 0) return result;
    if (channelUrl) {
      const slackUsers = uniq.filter(u => u.slack_dm_id);
      result.reachableSlackCount = slackUsers.length;
      if (slackUsers.length) {
        const mentions = slackUsers.map(u => `<@${u.slack_dm_id}>`).join(' ');
        await sendSlackChannel(channelUrl, `${mentions}\n\n${slackBody}`);
      }
    }
    if (roomId) {
      const cwUsers = uniq.filter(u => u.chatwork_dm_id);
      result.reachableCwCount = cwUsers.length;
      if (cwUsers.length) {
        const mentions = cwUsers.map(u => `[To:${u.chatwork_dm_id}]`).join('');
        await sendChatworkRoom(roomId, `${mentions}\n${cwBody}`, { token: chatworkPost.token });
      }
    }
    result.anyReachable = result.reachableSlackCount > 0 || result.reachableCwCount > 0;
    return result;
  };

  // ディレクター不在時のフォールバック投稿（CR提出時のチャンネルメンション機能）
  // - Slack: <!here> でチャンネル内のオンライン全員に通知
  // - Chatwork: [toall] でルーム全員に通知
  // ディレクターが任命されていない / DM ID 未設定の案件で、誰かが必ず気づける状態にする。
  const sendChannelMention = async (slackBody, cwBody) => {
    if (channelUrl) {
      await sendSlackChannel(channelUrl, `<!here>\n\n${slackBody}`);
    }
    if (roomId) {
      await sendChatworkRoom(roomId, `[toall]\n${cwBody}`, { token: chatworkPost.token });
    }
  };

  // 修正依頼系の in-app 通知ヘルパ（Dチェック後修正 / Pチェック後修正 / クライアントチェック後修正 で共通利用）。
  //
  // 背景（バグ報告 #8d97a0e7 対応）:
  //   旧実装は notify_ball_returned (DBトリガー) 任せで、ball_holder_id が単一 UUID なので
  //   複数 editor / 複数 director の場合に 2人目以降が bell 通知を取りこぼしていた。
  //   Dチェック依頼 (1-e) / Pチェック依頼 (2-e) と同じ枠組み (notification_type='creative_status')
  //   で全宛先に明示 INSERT する。
  //
  // recipients: 通知ログを入れるユーザー配列。actor 自身と id 重複は除外。
  const insertModifyRequestInApp = async (kindLabel, recipients, newStatusLabel) => {
    try {
      const projectName = project?.name || '';
      const inAppBody = projectName ? `${fileName}（${projectName}）` : fileName;
      const inAppLink = `/creatives/${detail.id}`;
      const filtered = (recipients || []).filter(u => u && u.id && (!actor || u.id !== actor.id));
      const seenIds = new Set();
      const rows = [];
      for (const u of filtered) {
        if (seenIds.has(u.id)) continue;
        seenIds.add(u.id);
        rows.push({
          user_id: u.id,
          notification_type: 'creative_status',
          title: kindLabel,
          body: inAppBody,
          link_url: inAppLink,
          meta: {
            creative_id: detail.id,
            project_id: detail.project_id || null,
            file_name: fileName,
            new_status: newStatusLabel,
          },
          sender_id: actor?.id || null,
        });
      }
      if (rows.length > 0) {
        await createBulkNotifications(rows);
      }
    } catch (e) {
      console.warn(`[notif] in-app ${kindLabel} notify failed:`, e?.message || e);
    }
  };

  // 1) → Dチェック
  //    PR #218 で複数ディレクター（creative_assignments.role='director'）対応。
  //    creative_assignments の role='director' に登録されている全員へ個別 DM 送信。
  //    旧仕様（projects.director_id / teams.director_id の単一ディレクター）は
  //    creative_assignments が空のときのフォールバックとして残す。
  //    全員 DM ID 未設定だった場合のみ、チャンネル/ルームに @here / [toall] で
  //    フォールバック投稿する（CR提出が誰にも届かない事態を防ぐ）。
  //
  //    オプション: NOTIFY_DCHECK_SECRETARY_CC=true のとき、チームの secretary
  //    （users.role='secretary' かつ team_id 一致 かつ is_active=true）にも個別 DM。
  //    重複（ディレクター兼任など）は seen Set で除外。
  if (newStatus === 'Dチェック') {
    // 1-a) Dチェック宛先: assignments の director を最優先
    //   旧仕様（projects.director_id / teams.director_id）はフォールバック。
    const dCheckTargets = directorAssignees.length > 0
      ? directorAssignees.slice()
      : [director].filter(Boolean);

    // 1-a-2) リバイスからの再提出 (Dチェック後修正 → Dチェック) では、
    //   案件ディレクター (projects.director_id) も必ず宛先に含める。
    //   背景: 「連絡・確認事項」(editor → director) の宛先は案件ディレクター
    //   であるべき (#TBD)。Dチェック assignment が案件D 以外（サブD・秘書 等）
    //   になっているケースで、案件D に編集者からの返信が届かない不具合があった。
    //   重複は sendNotifMulti / notification_logs INSERT 側で id ベース除外される。
    if (oldStatus === 'Dチェック後修正' && director) {
      dCheckTargets.push(director);
    }

    // 1-b) 秘書 CC（ENV フラグで有効化、デフォルト OFF）
    //   ディレクター宛と「同じ1メッセージ」にまとめてTOメンションするため、
    //   先に秘書を取得してから sendNotifMulti で一括送信する。
    if (String(process.env.NOTIFY_DCHECK_SECRETARY_CC || '').toLowerCase() === 'true' && detail.team_id) {
      const { data: secretaries, error: secErr } = await supabase.from('users')
        .select('id, full_name, slack_dm_id, chatwork_dm_id, role, team_id, is_active')
        .eq('team_id', detail.team_id)
        .eq('role', 'secretary')
        .eq('is_active', true);
      if (secErr) console.warn('[notif] secretary select failed:', secErr.message);
      for (const s of (secretaries || [])) {
        if (s) dCheckTargets.push(s);
      }
    }

    // 1-c) 集約版で1メッセージ送信（複数メンションを連結）
    const { slackBody, cwBody } = tpl('Dチェック依頼', '📥', dCheckTargets);
    const sendResult = await sendNotifMulti(dCheckTargets, slackBody, cwBody);

    // 1-d) 全員 DM ID 未設定 → チャンネルフォールバック
    if (!sendResult.anyReachable) {
      const { slackBody: fbSlack, cwBody: fbCw } = tpl('Dチェック依頼', '📥', null);
      const note = '\n（ディレクター未設定または DM ID 未登録のため関係者にメンションしています）';
      const slackFallback = fbSlack + note;
      const cwFallback = fbCw.replace('[/info]', note + '[/info]');
      await sendChannelMention(slackFallback, cwFallback);
    }

    // 1-e) in-app 通知（通知ベル / notification_logs）
    //   背景:
    //     アプリ内通知ベルは notify_ball_returned (DB トリガー) が
    //     creatives.ball_holder_id 列の変化で1件だけ INSERT する仕組み。
    //     ball_holder_id は単一 UUID なので「最初のディレクターだけ」しか
    //     bell 通知を受け取れず、複数ディレクター指定時に2人目以降が
    //     アプリ内通知を取りこぼす不具合があった (#TBD)。
    //   修正:
    //     dCheckTargets 全員に対して明示的に notification_logs を INSERT。
    //     notification_type='creative_status' を使い（クライアントチェック中遷移と同じ枠組み）、
    //     trigger 由来の 'ball_returned' 行とは型が違うので bell 上で重複を意識せずに済む。
    //     actor 自身は除外（操作者は本人なので通知不要）。
    //   冪等性:
    //     Slack/CW DM はメッセージなので冪等は気にしない（同じ操作で2回 PUT すれば
    //     2回投稿されるが、それは正しい挙動）。bell も同様にステータス変更ごとに1件追加で良い。
    try {
      const projectName = project?.name || '';
      const inAppBody = projectName ? `${fileName}（${projectName}）` : fileName;
      const inAppLink = `/creatives/${detail.id}`;
      const recipients = dCheckTargets.filter(u => u && u.id && (!actor || u.id !== actor.id));
      // 同一ユーザー重複を除去（director 兼任 + 秘書 CC 等）
      const seenIds = new Set();
      const rows = [];
      for (const u of recipients) {
        if (seenIds.has(u.id)) continue;
        seenIds.add(u.id);
        rows.push({
          user_id: u.id,
          notification_type: 'creative_status',
          title: 'Dチェック依頼',
          body: inAppBody,
          link_url: inAppLink,
          meta: {
            creative_id: detail.id,
            project_id: detail.project_id || null,
            file_name: fileName,
            new_status: 'Dチェック',
          },
          sender_id: actor?.id || null,
        });
      }
      if (rows.length > 0) {
        await createBulkNotifications(rows);
      }
    } catch (e) {
      // 主処理（Slack/CW DM 送信）を止めないように握りつぶす
      console.warn('[notif] in-app Dチェック notify failed:', e?.message || e);
    }
  }
  // 2) → Pチェック
  //    PR (this PR) で複数プロデューサー（creative_assignments.role='producer'）対応。
  //    Dチェックと同じパターン:
  //      creative_assignments role='producer' に登録されている全員へ個別 DM 送信。
  //      旧仕様（projects.producer_id の単一プロデューサー）は assignments が空のときのフォールバック。
  //      全員 DM ID 未設定だった場合のみ、チャンネル/ルームに @here / [toall] でフォールバック投稿。
  //
  //    オプション: NOTIFY_PCHECK_SECRETARY_CC=true のとき、チームの secretary
  //    （users.role='secretary' かつ team_id 一致 かつ is_active=true）にも個別 DM CC。
  else if (newStatus === 'Pチェック') {
    // 2-a) Pチェック宛先: assignments の producer を最優先、無ければ projects.producer_id にフォールバック
    const pCheckTargets = producerAssignees.length > 0
      ? producerAssignees.slice()
      : [producer].filter(Boolean);

    // 2-b) 秘書 CC（ENV フラグで有効化、デフォルト OFF）— Dチェックと同じパターン
    if (String(process.env.NOTIFY_PCHECK_SECRETARY_CC || '').toLowerCase() === 'true' && detail.team_id) {
      const { data: secretaries, error: secErr } = await supabase.from('users')
        .select('id, full_name, slack_dm_id, chatwork_dm_id, role, team_id, is_active')
        .eq('team_id', detail.team_id)
        .eq('role', 'secretary')
        .eq('is_active', true);
      if (secErr) console.warn('[notif] secretary select failed:', secErr.message);
      for (const s of (secretaries || [])) {
        if (s) pCheckTargets.push(s);
      }
    }

    // 2-c) 集約版で1メッセージ送信
    const { slackBody, cwBody } = tpl('Pチェック依頼', '📥', pCheckTargets);
    const sendResult = await sendNotifMulti(pCheckTargets, slackBody, cwBody);

    // 2-d) 全員 DM ID 未設定 → チャンネルフォールバック
    if (!sendResult.anyReachable) {
      const { slackBody: fbSlack, cwBody: fbCw } = tpl('Pチェック依頼', '📥', null);
      const note = '\n（プロデューサー未設定または DM ID 未登録のため関係者にメンションしています）';
      const slackFallback = fbSlack + note;
      const cwFallback = fbCw.replace('[/info]', note + '[/info]');
      await sendChannelMention(slackFallback, cwFallback);
    }

    // 2-e) in-app 通知（通知ベル / notification_logs）
    //   Dチェック (1-e) と同じ理由: ball_holder_id ベースのトリガーは1人にしか
    //   届かないため、Pチェックでも複数プロデューサー指定時に2人目以降が
    //   アプリ内通知を取りこぼす。明示的に全員へ INSERT する。
    try {
      const projectName = project?.name || '';
      const inAppBody = projectName ? `${fileName}（${projectName}）` : fileName;
      const inAppLink = `/creatives/${detail.id}`;
      const recipients = pCheckTargets.filter(u => u && u.id && (!actor || u.id !== actor.id));
      const seenIds = new Set();
      const rows = [];
      for (const u of recipients) {
        if (seenIds.has(u.id)) continue;
        seenIds.add(u.id);
        rows.push({
          user_id: u.id,
          notification_type: 'creative_status',
          title: 'Pチェック依頼',
          body: inAppBody,
          link_url: inAppLink,
          meta: {
            creative_id: detail.id,
            project_id: detail.project_id || null,
            file_name: fileName,
            new_status: 'Pチェック',
          },
          sender_id: actor?.id || null,
        });
      }
      if (rows.length > 0) {
        await createBulkNotifications(rows);
      }
    } catch (e) {
      console.warn('[notif] in-app Pチェック notify failed:', e?.message || e);
    }
  }
  // 3) → Dチェック後修正（ボールが製作者側に戻る）
  //    宛先は editorAssignees（編集者・デザイナー）。ディレクターは除外
  //    （旧 assignees だと director も含まれていて、editor 側に「修正してください」が
  //     届かないバグがあった。PR #?）
  //    バグ報告 #8d97a0e7: editorAssignees 全員 DM 未到達でも、チャンネルに
  //    必ずフォールバック投稿し、in-app 通知も全員に明示 INSERT する。
  else if (newStatus === 'Dチェック後修正') {
    const targets = editorAssignees.slice();
    const { slackBody, cwBody } = tpl('Dチェック修正依頼', '🔁', targets);
    const sendResult = await sendNotifMulti(targets, slackBody, cwBody);

    // 全員 DM ID 未設定 / 担当 editor 不在 → チャンネルフォールバック
    if (!sendResult.anyReachable) {
      const { slackBody: fbSlack, cwBody: fbCw } = tpl('Dチェック修正依頼', '🔁', null);
      const note = '\n（編集者未設定または DM ID 未登録のため関係者にメンションしています）';
      const slackFallback = fbSlack + note;
      const cwFallback = fbCw.replace('[/info]', note + '[/info]');
      await sendChannelMention(slackFallback, cwFallback);
    }

    await insertModifyRequestInApp('Dチェック修正依頼', targets, 'Dチェック後修正');
  }
  // 4) → Pチェック後修正（プロデューサーから戻る → editor + director の両方が修正対象）
  //    多重ディレクター対応: directorAssignees があればそれを使う（無ければ projects.director_id を1人だけ）。
  //    sendNotifMulti は id 重複を内部で除外するので二重メンションにはならない。
  else if (newStatus === 'Pチェック後修正') {
    const directorTargets = directorAssignees.length > 0
      ? directorAssignees
      : [director].filter(Boolean);
    const targets = [...editorAssignees, ...directorTargets];
    const { slackBody, cwBody } = tpl('Pチェック修正依頼', '🔁', targets);
    const sendResult = await sendNotifMulti(targets, slackBody, cwBody);

    // 全員 DM ID 未設定 / 関係者不在 → チャンネルフォールバック
    if (!sendResult.anyReachable) {
      const { slackBody: fbSlack, cwBody: fbCw } = tpl('Pチェック修正依頼', '🔁', null);
      const note = '\n（編集者・ディレクター未設定または DM ID 未登録のため関係者にメンションしています）';
      const slackFallback = fbSlack + note;
      const cwFallback = fbCw.replace('[/info]', note + '[/info]');
      await sendChannelMention(slackFallback, cwFallback);
    }

    await insertModifyRequestInApp('Pチェック修正依頼', targets, 'Pチェック後修正');
  }
  // 4-b) → クライアントチェック後修正（クライアントから戻る → editor + director の両方が修正対象）
  //    Pチェック後修正と同じパターン。クライアントからの戻りも編集者だけでなくディレクター層にも共有が必要。
  //    （旧実装はこの分岐自体が欠落しており Slack/CW DM が一切飛ばないバグだった）
  else if (newStatus === 'クライアントチェック後修正') {
    const directorTargets = directorAssignees.length > 0
      ? directorAssignees
      : [director].filter(Boolean);
    const targets = [...editorAssignees, ...directorTargets];
    const { slackBody, cwBody } = tpl('クライアントチェック後修正依頼', '🔁', targets);
    const sendResult = await sendNotifMulti(targets, slackBody, cwBody);

    // 全員 DM ID 未設定 / 関係者不在 → チャンネルフォールバック
    if (!sendResult.anyReachable) {
      const { slackBody: fbSlack, cwBody: fbCw } = tpl('クライアントチェック後修正依頼', '🔁', null);
      const note = '\n（編集者・ディレクター未設定または DM ID 未登録のため関係者にメンションしています）';
      const slackFallback = fbSlack + note;
      const cwFallback = fbCw.replace('[/info]', note + '[/info]');
      await sendChannelMention(slackFallback, cwFallback);
    }

    await insertModifyRequestInApp('クライアントチェック後修正依頼', targets, 'クライアントチェック後修正');
  }
  // 5) → クライアントチェック中（操作した本人にテンプレ案内）
  //    メンション方式によりチームにも見える形になるが、ミス防止のため第三者レビュー可能な
  //    状態は許容する仕様。
  else if (newStatus === 'クライアントチェック中') {
    if (actor) {
      // クライアント確認版URL: ユーザーが creatives.client_review_url に手動入力。
      // 未設定時はプレースホルダ行を出して送信前に手動補完してもらう。
      // （旧実装は "https://drive.google.com/..." をハードコードしており404の原因だった）
      const reviewUrl = (detail.client_review_url && String(detail.client_review_url).trim()) || null;
      const slackUrlLine = reviewUrl
        ? `> ${reviewUrl}`
        : '> （URL未設定。確認版のシェアリンクを下に追記してください）';
      const cwUrlLine2 = reviewUrl
        ? reviewUrl
        : '（URL未設定。確認版のシェアリンクを下に追記してください）';
      const slackTpl =
`✅ クライアント確認に進めました
ファイル: ${slackName}

📝 クライアントへ送るメッセージ案（コピペして調整してください）:

> 〇〇様、いつもお世話になっております。
> 「${fileName}」のクライアント確認版を共有いたします。
${slackUrlLine}
> ご確認のほどよろしくお願いいたします。

⚠️ 送信前に必ず内容を確認してください。`;
      const cwTpl =
`[info][title]✅ クライアント確認に進めました[/title]ファイル: ${fileName}${cwUrlLine}

クライアントへ送るメッセージ案:
〇〇様、いつもお世話になっております。
「${fileName}」のクライアント確認版を共有いたします。
${cwUrlLine2}
ご確認のほどよろしくお願いいたします。

※送信前に必ず内容を確認してください。[/info]`;
      await sendNotif(actor, slackTpl, cwTpl);
    }
    // 編集者・デザイナーへの「クライアントチェックに進みました！」お知らせ
    // actor は既にテンプレ案内を受け取っているので重複送信を避ける
    // 統一フォーマット（buildCreativeNotifBody 経由）に揃える（バグ報告 #82b1c20d）。
    const assigneeTargets = editorAssignees.filter(ed => ed && (!actor || ed.id !== actor.id));
    if (assigneeTargets.length > 0) {
      const { slackBody, cwBody } = tpl('クライアントチェックに進みました', '🎉', assigneeTargets);
      await sendNotifMulti(assigneeTargets, slackBody, cwBody);
    }

    // 5-b) in-app 通知（通知ベル / notification_logs）
    // PR #257 で Slack/CW DM は editor/designer/director_as_editor に届くようにしたが、
    // アプリ内通知ベルは tweets 系と DBトリガー notify_ball_returned からしか発火していなかった。
    // クライアントチェック中遷移時は ball_holder_id が NULL（クライアント=非ユーザー）になり
    // notify_ball_returned トリガーは走らないので重複の心配なし。
    //
    // 受信者: editorAssignees（編集者・デザイナー・director_as_editor）。actor 自身は除外。
    // link_url は /creatives/<id> 形式（notification-card.js の activateCard が
    // この形式を openCreativeDetail() に流してモーダル展開する）。
    try {
      const projectName = project?.name || '';
      const inAppBody = projectName ? `${fileName}（${projectName}）` : fileName;
      const inAppLink = `/creatives/${detail.id}`;
      const recipients = editorAssignees.filter(ed => ed && (!actor || ed.id !== actor.id));
      const rows = recipients.map(ed => ({
        user_id: ed.id,
        notification_type: 'creative_status',
        title: 'クライアントチェックに進みました',
        body: inAppBody,
        link_url: inAppLink,
        meta: {
          creative_id: detail.id,
          project_id: detail.project_id || null,
          file_name: fileName,
          new_status: 'クライアントチェック中',
        },
        sender_id: actor?.id || null,
      }));
      if (rows.length > 0) {
        await createBulkNotifications(rows);
      }
    } catch (e) {
      // 主処理（status 更新・Slack/CW 送信）を止めないように握りつぶす
      console.warn('[notif] in-app creative_status notify failed:', e?.message || e);
    }
  }
  // 6) → 納品（クリエイター向けにお祝いメッセージ）
  //    PR #67 で削除されていたが、クリエイターは「クライアントOKが出たかどうか」を
  //    把握する手段がほぼ唯一この通知のため復活。assignees（担当者全員）に送る。
  //    バグ報告 #82b1c20d で統一フォーマットへ揃える。クライアント承認コメントは
  //    buildCreativeNotifBody の comment フィールドにそのまま流し込む。
  else if (newStatus === '納品') {
    const { slackBody, cwBody } = tpl('クライアントOK！納品完了', '🎉', editorAssignees);
    // 担当者全員（editor・designer）に1メッセージで通知
    await sendNotifMulti(editorAssignees, slackBody, cwBody);
  }
}

// =============== 自動エラー通知 ===============
// PR #188 の手動エラー報告（🐛 FAB）と並行する「自動」通知ヘルパ。
// サーバ側 5xx / uncaughtException / unhandledRejection、
// フロント側 window.onerror / unhandledrejection / fetch 5xx を Slack に流す。
//
// 設計メモ:
// - 送信先は同じ ERROR_REPORT_SLACK_CHANNEL_URL を使う（環境変数を増やさない）
// - 未設定なら no-op（CI / 開発環境で誤発火しない）
// - サーバ内で同一 signature（kind+message先頭+url）は 5 分に 1 回だけ送る
// - Slack 投稿失敗もログのみ（throw しない）
//
// signature ハッシュは crypto を使わず素の文字列で十分（in-memory dedupe 用）。

const _autoErrorLastSentAt = new Map(); // signature -> ms（古いキーは _gcAutoErrorMap で掃除）
const AUTO_ERROR_DEDUP_WINDOW_MS = 5 * 60 * 1000; // 5 分
const AUTO_ERROR_MAP_MAX = 500;

function _gcAutoErrorMap() {
  if (_autoErrorLastSentAt.size <= AUTO_ERROR_MAP_MAX) return;
  // 単純に古い 1/3 を消す（厳密な LRU は不要）
  const cutoff = Date.now() - AUTO_ERROR_DEDUP_WINDOW_MS;
  for (const [k, v] of _autoErrorLastSentAt) {
    if (v < cutoff) _autoErrorLastSentAt.delete(k);
    if (_autoErrorLastSentAt.size <= AUTO_ERROR_MAP_MAX * 0.7) break;
  }
}

// Slack 通知の dedupe signature。message / apiPath に含まれる UUID や
// 数値 ID を `:id` に正規化してから比較することで、同じ原因のエラーが
// 「リソース ID 違いで N 通来る」現象を防ぐ。
// 例: PR #338 デプロイ前に `column users_1.name does not exist` が
// 5 本の line_id 分 Slack に流れた事故 (#TBD) の再発防止。
function _normalizeIdsInPath(s) {
  if (!s) return s;
  return String(s)
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id')
    .replace(/\/\d{3,}(?=\/|$|\?)/g, '/:id');
}
function _autoErrorSignature({ kind, message, url, apiPath }) {
  const k = String(kind || '').slice(0, 64);
  const m = _normalizeIdsInPath(String(message || '')).slice(0, 200);
  const u = String(url || '').slice(0, 200);
  const a = _normalizeIdsInPath(String(apiPath || '')).slice(0, 200);
  return `${k}::${m}::${a}::${u}`;
}

function _truncate(s, max) {
  if (s == null) return '';
  s = String(s);
  return s.length > max ? s.slice(0, max) + '…(truncated)' : s;
}

function _formatAutoErrorText(payload) {
  const {
    source, kind, message, stack, url, userAgent,
    statusCode, apiPath, userEmail, ts,
    filename, lineno, colno, trace, serverBuild, clientBuild, breadcrumbs,
  } = payload || {};
  const lines = [];
  const head = source === 'server' ? '🚨 サーバーエラー（自動）' : '⚠️ フロントエラー（自動）';
  lines.push(`${head}`);
  lines.push(`*種別*: \`${kind || 'unknown'}\``);
  if (statusCode) lines.push(`*Status*: ${statusCode}`);
  if (apiPath) lines.push(`*API*: \`${_truncate(apiPath, 200)}\``);
  if (url) lines.push(`*URL*: ${_truncate(url, 300)}`);
  if (filename) {
    // lineno/colno は 0 が有効値の可能性があるため、null/'' のみ除外（false 系を一律弾かない）
    const loc = [filename, lineno != null ? lineno : null, colno != null ? colno : null]
      .filter(v => v !== null && v !== '').join(':');
    lines.push(`*発生箇所*: \`${_truncate(loc, 500)}\``);
  }
  if (userEmail) lines.push(`*ユーザー*: ${_truncate(userEmail, 100)}`);
  if (userAgent) lines.push(`*UA*: ${_truncate(userAgent, 200)}`);
  // ビルド情報（クライアント / サーバー両方を併記。差異があればバージョンずれを即座に判別できる）
  if (serverBuild) lines.push(`*Server Build*: \`${_truncate(serverBuild, 80)}\``);
  if (clientBuild) lines.push(`*Client Build*: \`${_truncate(clientBuild, 80)}\``);
  const tsDate = ts ? new Date(ts) : new Date();
  const jstStr = tsDate.toLocaleString('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
  lines.push(`*発生時刻*: ${jstStr} JST`);
  // 原因特定トレース: フロントが収集した実行環境情報（navigation timing / viewport / lastScript 等）
  if (trace && typeof trace === 'object') {
    const nav = trace.navigation || {};
    const lastScript = trace.lastScript || {};
    const vp = trace.viewport || {};
    const ps = trace.pageshow || {};
    const em = trace.errorMeta || {};
    const rt = trace.resourceTarget || {};
    const traceLines = [
      `readyState=${trace.readyState || '-'}`,
      `visibility=${trace.visibilityState || '-'}`,
      `online=${trace.online}`,
      `viewport=${vp.w || '-'}x${vp.h || '-'}@${vp.dpr || '-'}`,
      `scriptCount=${trace.scriptCount || '-'}`,
      `lastScript=${lastScript.src || '-'}`,
      `navType=${nav.type || '-'}`,
      `pageshow.persisted=${ps.persisted ?? '-'}`,
      `msSincePageshow=${ps.msSincePageshow ?? '-'}`,
      `transfer=${nav.transferSize || 0}`,
      `encoded=${nav.encodedBodySize || 0}`,
      `decoded=${nav.decodedBodySize || 0}`,
      `responseStatus=${nav.responseStatus || '-'}`,
      `responseEnd=${nav.responseEnd || '-'}`,
      `domInteractive=${nav.domInteractive || '-'}`,
      `domComplete=${nav.domComplete || '-'}`,
    ];
    // 自前プロパティ判定にしないと、素の `em.toString` は Object.prototype.toString
    // (native function) が常に truthy で、resource.error 等 errorMeta 無しケースでも
    // "function toString() { [native code] }" を吐く（PR #332 デプロイ後に観測）。
    const emHas = (k) => em && Object.prototype.hasOwnProperty.call(em, k);
    if (emHas('name') || emHas('toString') || emHas('messageProp')) {
      traceLines.push(
        `error.name=${em.name || '-'}`,
        `error.toString=${(emHas('toString') ? em.toString : null) || '-'}`,
        `error.messageProp=${em.messageProp || '-'}`,
      );
    }
    if (rt && (rt.tagName || rt.src || rt.href)) {
      traceLines.push(
        `resource.tag=<${rt.tagName || '?'}>`,
        `resource.src=${rt.src || rt.href || rt.currentSrc || '-'}`,
        `resource.id=${rt.id || '-'}`,
        `resource.crossOrigin=${rt.crossOrigin || '-'}`,
      );
    }
    lines.push('*原因特定トレース*:');
    lines.push('```' + _truncate(traceLines.join('\n'), 1800) + '```');

    // ソーススナップショット: window.onerror が報告した lineno/colno の実際の中身。
    // 「2433:84 が </div> に見える」系の謎エラーを実体で特定するための切り札。
    if (trace.sourceSnippet && typeof trace.sourceSnippet === 'object') {
      const ss = trace.sourceSnippet;
      const ssLines = [
        `totalLines=${ss.totalLines || '-'}`,
        `lineLen=${ss.lineLen || '-'}`,
        `col=${ss.col || '-'}`,
        `prevLine: ${ss.prevLine || ''}`,
        `THIS:     ${ss.excerpt || ''}`,
        `nextLine: ${ss.nextLine || ''}`,
      ];
      lines.push('*該当行スナップショット*:');
      lines.push('```' + _truncate(ssLines.join('\n'), 1500) + '```');
    }
  }
  // breadcrumbs: ユーザーの直前行動（最大 8 件、新→古の順で表示）
  if (Array.isArray(breadcrumbs) && breadcrumbs.length) {
    const crumbLines = breadcrumbs.slice().reverse().map(b => {
      try {
        const dt = b && b.ts ? new Date(b.ts).toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour12: false }) : '-';
        const type = String(b && b.type || '-').slice(0, 30);
        let data = '';
        if (b && b.data != null) {
          data = typeof b.data === 'string' ? b.data : JSON.stringify(b.data);
        }
        return `${dt} ${type}: ${data}`.slice(0, 240);
      } catch (_) { return '-'; }
    });
    lines.push('*直前の行動（新→古）*:');
    lines.push('```' + _truncate(crumbLines.join('\n'), 1800) + '```');
  }
  lines.push('');
  lines.push('*メッセージ*:');
  lines.push('```' + _truncate(message, 1500) + '```');
  if (stack) {
    lines.push('*スタック*:');
    lines.push('```' + _truncate(stack, 2000) + '```');
  }
  return lines.join('\n');
}

// 自動エラー通知の本体。例外が起きても上位に投げない（uncaughtException 内から呼ばれるため）。
// 戻り値:
//   { ok: true }                          送信成功
//   { ok: true, skipped: 'no-channel' }   ENV 未設定（no-op）
//   { ok: true, skipped: 'rate-limited' } 同一シグネチャ抑制
//   { ok: false, reason: '...' }          Slack 失敗
async function notifyAutoError(payload) {
  try {
    const channelUrl = process.env.ERROR_REPORT_SLACK_CHANNEL_URL;
    if (!channelUrl) return { ok: true, skipped: 'no-channel' };

    const sig = _autoErrorSignature(payload || {});
    const now = Date.now();
    const last = _autoErrorLastSentAt.get(sig) || 0;
    if (now - last < AUTO_ERROR_DEDUP_WINDOW_MS) {
      return { ok: true, skipped: 'rate-limited' };
    }
    // 送信前に予約（並行 throw でも 1 回しか送らないように）
    _autoErrorLastSentAt.set(sig, now);
    _gcAutoErrorMap();

    const text = _formatAutoErrorText({ ...payload, ts: payload?.ts || new Date().toISOString() });
    const result = await sendSlackChannel(channelUrl, text);
    if (!result?.ok) {
      console.warn('[notif/auto-error] slack send failed:', result?.reason);
      return { ok: false, reason: result?.reason || 'unknown' };
    }
    return { ok: true };
  } catch (e) {
    // notify 自体の失敗で uncaughtException ループに入らないよう、必ず握りつぶす
    try { console.warn('[notif/auto-error] internal error:', e?.message || e); } catch (_) {}
    return { ok: false, reason: 'internal' };
  }
}

module.exports = {
  notifyCreativeStatusChange,
  parseSlackChannelUrl,
  sendSlackChannel,
  sendSlackChannelWithFile,
  sendChatworkRoom,
  // テスト・他モジュールから再利用可能にするためエクスポート
  buildCreativeNotifBody,
  buildCreativeUrl,
  // 自動エラー通知（PR ?: routes と server.js の両方から呼ぶ）
  notifyAutoError,
  _formatAutoErrorText,         // テスト用
  _autoErrorSignature,          // テスト用
};
