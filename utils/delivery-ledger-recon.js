// utils/delivery-ledger-recon.js
//
// ADR 055 追補: 納品カウント（積み上げ台帳）の自動突合。
//
// HFS は案件ごとの Slack チャンネル（projects.slack_channel_url → clients.slack_channel_url）と
// Chatwork ルーム（projects.chatwork_room_id → clients.chatwork_room_id）を既に持っている。
// 人が URL を渡さなくても、HFS 自身が
//   1) DB 側: creatives（status='納品' ∧ delivered_at ∈ JST 月）の件数・一覧
//   2) 投稿記録: delivery_ledger_posts（どこに・どの message_id で・どの数字を投稿したか）
//   3) チャンネル側: Slack conversations.history ／ Chatwork rooms/{id}/messages を読み、
//      本文の [HFS-LEDGER] タグを拾う
// を突き合わせ、案件×月ごとに 一致 / 不一致 / 投稿なし / 取得不可 を判定する。
//
// Slack: bot に channels:history（公開ch）/ groups:history（非公開ch）スコープが必要。
//        無ければ Slack が missing_scope を返すので、判定 'fetch_error' に理由を載せる。
// Chatwork: GET /rooms/{id}/messages?force=1 は最新 100 件のみ。それより古い投稿は
//        投稿記録の message_id で GET /rooms/{id}/messages/{message_id} を 1 件ずつ読む。
//
// 読む場所は「今の設定のチャンネル」だけではない。投稿記録（delivery_ledger_posts.channel_ref）に
// 残っている投稿先（案件ルームが落ちてクライアント共通ルームへ代替投稿した分／当月途中でルームを
// 変更する前の投稿）も全部読む。今の設定だけ読むと、正常な投稿を「投稿なし・不一致」と誤判定する。
//
// 取得に失敗した投稿先が 1 つでもあれば、そのプラットフォームの判定は 'fetch_error'（欠落ではない）。
// 一時的な通信エラーを「投稿なし／記録があるのに無い」として数えない。
//
// 書き込みなし（読むだけ）。呼び出し: workers/delivery-ledger-recon.js（月初）、
// GET /admin/delivery-ledger/recon（手動）、scripts/delivery-ledger-check.js --fetch。

const axios = require('axios');
const L = require('./delivery-ledger');

const SLACK_HISTORY_LIMIT = 200;
const SLACK_MAX_PAGES = 20;          // 200 × 20 = 4,000 件まで
const GRACE_DAYS_AFTER_MONTH = 10;   // 月末の納品が翌月初に投稿されることはないが、手動補正の遅れを拾う余裕

// ---------- チャンネル側の取得 ----------

// Slack: 指定チャンネルの [oldest, latest] 範囲のメッセージを全部読む（ページング）。
// 戻り値: { ok, messages: [{ id, text, at }], reason }
async function fetchSlackHistory({ token, channelId, oldestSec, latestSec, http = axios }) {
  if (!token) return { ok: false, messages: [], reason: 'no_token' };
  if (!channelId) return { ok: false, messages: [], reason: 'no_channel' };
  const messages = [];
  let cursor = null;
  for (let page = 0; page < SLACK_MAX_PAGES; page++) {
    const params = { channel: channelId, limit: SLACK_HISTORY_LIMIT, inclusive: true };
    if (oldestSec != null) params.oldest = String(oldestSec);
    if (latestSec != null) params.latest = String(latestSec);
    if (cursor) params.cursor = cursor;
    let res;
    try {
      res = await http.get('https://slack.com/api/conversations.history', {
        params, headers: { Authorization: `Bearer ${token}` }, timeout: 15000,
      });
    } catch (e) {
      return { ok: false, messages, reason: e?.message || 'request_failed' };
    }
    if (!res.data?.ok) return { ok: false, messages, reason: res.data?.error || 'slack_error' };
    for (const m of (res.data.messages || [])) {
      messages.push({ id: m.ts, text: String(m.text || ''), at: Number(m.ts) * 1000 });
    }
    cursor = res.data.response_metadata?.next_cursor || null;
    if (!res.data.has_more || !cursor) break;
  }
  return { ok: true, messages, reason: null };
}

// Chatwork: ルームの最新 100 件。戻り値: { ok, messages: [{ id, text, at }], reason }
async function fetchChatworkRecent({ token, roomId, http = axios }) {
  if (!token) return { ok: false, messages: [], reason: 'no_token' };
  if (!roomId) return { ok: false, messages: [], reason: 'no_room' };
  try {
    const res = await http.get(`https://api.chatwork.com/v2/rooms/${roomId}/messages`, {
      params: { force: 1 }, headers: { 'X-ChatWorkToken': token }, timeout: 15000, validateStatus: () => true,
    });
    if (res.status === 204) return { ok: true, messages: [], reason: null };
    if (res.status < 200 || res.status >= 300) {
      const apiErrors = Array.isArray(res.data?.errors) ? res.data.errors.join(' / ') : '';
      return { ok: false, messages: [], reason: `HTTP ${res.status}${apiErrors ? `: ${apiErrors}` : ''}` };
    }
    const messages = (Array.isArray(res.data) ? res.data : []).map(m => ({
      id: String(m.message_id), text: String(m.body || ''), at: Number(m.send_time) * 1000,
    }));
    return { ok: true, messages, reason: null };
  } catch (e) {
    return { ok: false, messages: [], reason: e?.message || 'request_failed' };
  }
}

// Chatwork: message_id を指定して 1 件読む（最新 100 件に入っていない古い投稿用）。
// 戻り値: { ok, message: { id, text, at } | null, reason }
async function fetchChatworkMessage({ token, roomId, messageId, http = axios }) {
  if (!token || !roomId || !messageId) return { ok: false, message: null, reason: 'bad_args' };
  try {
    const res = await http.get(`https://api.chatwork.com/v2/rooms/${roomId}/messages/${messageId}`, {
      headers: { 'X-ChatWorkToken': token }, timeout: 15000, validateStatus: () => true,
    });
    if (res.status === 404) return { ok: true, message: null, reason: 'not_found' };
    if (res.status < 200 || res.status >= 300) return { ok: false, message: null, reason: `HTTP ${res.status}` };
    const m = res.data || {};
    return { ok: true, message: { id: String(m.message_id), text: String(m.body || ''), at: Number(m.send_time) * 1000 }, reason: null };
  } catch (e) {
    return { ok: false, message: null, reason: e?.message || 'request_failed' };
  }
}

// ---------- 判定（純関数） ----------

// チャンネルから読んだメッセージ群と DB 台帳・投稿記録を突き合わせる（1 プラットフォーム分）。
// @param {object} p
// @param {{ok:boolean, messages:Array<{id,text,at}>, reason:string|null}} p.fetched
// @param {object} p.db loadProjectDeliveryLedger() の戻り値
// @param {Array<{message_id:string|null, month_total:number}>} p.posts 投稿記録（このプラットフォーム分）
// @param {string} p.projectId
// @param {string} p.ym
// 戻り値: { verdict, reason, tag_count, last_month_total, tagged_creatives, only_in_log, unmentioned_in_db, missing_posts }
//   verdict: 'match' | 'mismatch' | 'no_posts' | 'fetch_error'
function judgePlatform({ fetched, db, posts, projectId, ym }) {
  const out = {
    verdict: null, reason: null, tag_count: 0, last_month_total: null,
    tagged_creatives: [], only_in_log: [], unmentioned_in_db: [], missing_posts: [],
  };
  if (!fetched || !fetched.ok) {
    out.verdict = 'fetch_error';
    out.reason = fetched?.reason || 'unknown';
    return out;
  }
  // 投稿先が複数（代替投稿・ルーム変更前）で一部だけ読めなかった場合も取得不可。
  // 読めなかった先の投稿を「無い」と数えると正常な投稿を欠落扱いしてしまう。
  if (Array.isArray(fetched.failures) && fetched.failures.length) {
    out.verdict = 'fetch_error';
    out.reason = fetched.failures.map(f => `${f.ref}: ${f.reason}`).join('／');
    return out;
  }
  // タグ付きメッセージ（この案件・この月のものだけ）を時刻順に
  const tagged = [];
  for (const m of fetched.messages) {
    for (const t of L.parseLedgerTags(m.text)) {
      if (t.project === projectId && t.month === ym) tagged.push({ ...t, message_id: m.id, at: m.at });
    }
  }
  tagged.sort((a, b) => (a.at || 0) - (b.at || 0));
  out.tag_count = tagged.length;

  // 投稿記録にあるのにチャンネルで見つからない（削除された・投稿失敗を ok と誤記録 など）
  const foundIds = new Set(fetched.messages.map(m => String(m.id)));
  out.missing_posts = (posts || [])
    .filter(p => p.message_id && !foundIds.has(String(p.message_id)))
    .map(p => String(p.message_id));

  if (tagged.length === 0) {
    out.verdict = db.monthTotal === 0 ? 'match' : 'no_posts';
    out.reason = db.monthTotal === 0 ? null : 'チャンネルに [HFS-LEDGER] の投稿が見つかりません';
    return out;
  }
  const last = tagged[tagged.length - 1];
  out.last_month_total = Number.isFinite(last.month_total) ? last.month_total : null;

  const dbIds = new Set(db.items.map(it => it.id));
  const taggedIds = new Set(tagged.map(t => t.creative).filter(Boolean));
  out.tagged_creatives = [...taggedIds];
  out.only_in_log = [...taggedIds].filter(id => !dbIds.has(id));
  // DB にあるがタグに creative として出てこない（一括納品分は added= なので creative 無し → 正常）
  const hasBulk = tagged.some(t => t.added != null);
  out.unmentioned_in_db = hasBulk ? [] : db.items.filter(it => !taggedIds.has(it.id)).map(it => it.id);

  const totalOk = out.last_month_total === db.monthTotal;
  const ok = totalOk && out.only_in_log.length === 0 && out.unmentioned_in_db.length === 0 && out.missing_posts.length === 0;
  out.verdict = ok ? 'match' : 'mismatch';
  if (!ok) {
    const why = [];
    if (!totalOk) why.push(`最後の投稿は当月 ${out.last_month_total}件、DB は ${db.monthTotal}件`);
    if (out.only_in_log.length) why.push(`投稿にあるが DB の当月納品に無い: ${out.only_in_log.length}件`);
    if (out.unmentioned_in_db.length) why.push(`DB にあるが投稿に出てこない: ${out.unmentioned_in_db.length}件`);
    if (out.missing_posts.length) why.push(`投稿記録があるのにチャンネルに無い: ${out.missing_posts.length}件`);
    out.reason = why.join('／');
  }
  return out;
}

// 案件×月の総合判定（Slack / Chatwork の個別判定から）。
//   どちらかが mismatch → 'mismatch'、どちらかが match → 'match'（読めた側で一致の証拠がある）、
//   チャンネル設定なし → 'no_channel'、
//   fetch_error が混ざり match が無い → 'fetch_error'（読めていないのに「投稿なし」とは言わない）、
//   全部 no_posts → 'no_posts'
function overallVerdict({ slack, chatwork }) {
  const vs = [slack, chatwork].filter(Boolean).map(x => x.verdict);
  if (vs.length === 0) return 'no_channel';
  if (vs.includes('mismatch')) return 'mismatch';
  if (vs.includes('match')) return 'match';
  if (vs.includes('fetch_error')) return 'fetch_error';
  if (vs.includes('no_posts')) return 'no_posts';
  return 'fetch_error';
}

// 案件の結果に 1 つでも取得不可（Slack / Chatwork いずれか、または例外）が含まれるか。
// 総合判定が match でも、読めなかった側がある月は「突合完了」として記録しない（翌日に再突合）。
function hasFetchError(r) {
  return !!(r?.error || r?.slack?.verdict === 'fetch_error' || r?.chatwork?.verdict === 'fetch_error');
}

// ---------- 案件×月の突合 ----------

// 'YYYY-MM' → 取得範囲（UTC 秒）。月初（JST）〜 翌月 GRACE_DAYS_AFTER_MONTH 日（JST）か now の早い方。
function fetchWindowSec(ym, now = new Date()) {
  const r = L.jstMonthRangeIso(ym);
  if (!r) return null;
  const oldest = Math.floor(new Date(r.startIso).getTime() / 1000);
  const graceEnd = new Date(r.endIso).getTime() + GRACE_DAYS_AFTER_MONTH * 24 * 3600 * 1000;
  const latest = Math.floor(Math.min(graceEnd, now.getTime()) / 1000);
  return { oldestSec: oldest, latestSec: latest };
}

// Slack の投稿先 ref（投稿記録の channel_ref は channel_id か URL、未取得は '-'）→ channel_id。解釈不能は null。
function slackChannelIdOf(ref, notifications) {
  const v = String(ref || '').trim();
  if (!v || v === '-') return null;
  if (/^[CDG][A-Z0-9]+$/i.test(v)) return v.toUpperCase();
  const parsed = notifications?.parseSlackChannelUrl ? notifications.parseSlackChannelUrl(v) : null;
  return parsed?.channel_id || null;
}

// Chatwork の投稿先 ref → room_id（数字のみ）。解釈不能は null。
function chatworkRoomIdOf(ref) {
  const v = String(ref || '').trim();
  return /^\d+$/.test(v) ? v : null;
}

// 読むべき投稿先の一覧: 今の設定 ∪ 投稿記録に残っている投稿先（重複除去・順序は今の設定が先）。
// 戻り値: { refs: string[], unresolved: string[]（解釈できなかった channel_ref） }
function collectRefs({ current, posts, toId }) {
  const refs = [];
  const unresolved = [];
  const push = (id) => { if (id && !refs.includes(id)) refs.push(id); };
  push(current);
  for (const p of posts || []) {
    const id = toId(p.channel_ref);
    if (id) push(id);
    else if (p.channel_ref && p.channel_ref !== '-') unresolved.push(String(p.channel_ref));
  }
  return { refs, unresolved };
}

// Slack の bot token を決める。今の設定 URL（team_id / domain）が最優先。
// 今の設定が無い（通知先を外した）場合は、投稿記録の channel_ref が URL ならそれで、
// それも無ければ登録ワークスペースが 1 つだけのときにその token を使う。
async function resolveSlackTokenFor({ channelUrl, posts, notifications, supabase }) {
  const tryUrl = async (url) => {
    const parsed = notifications.parseSlackChannelUrl(url);
    if (!parsed) return { token: null, reason: 'invalid_url' };
    return notifications.resolveSlackWorkspace(parsed);
  };
  let lastReason = null;
  if (channelUrl) {
    const r = await tryUrl(channelUrl);
    if (r.token) return r;
    lastReason = r.reason;
  }
  for (const p of posts || []) {
    if (/^https?:\/\//i.test(String(p.channel_ref || ''))) {
      const r = await tryUrl(p.channel_ref);
      if (r.token) return r;
    }
  }
  try {
    const { data, error } = await supabase.from('slack_workspaces').select('team_id, bot_token');
    if (error) return { token: null, reason: 'workspace_lookup_failed' };
    const rows = (data || []).filter(w => w.bot_token);
    if (rows.length === 1) return { token: rows[0].bot_token, reason: null };
  } catch (_) { /* fallthrough */ }
  return { token: null, reason: lastReason || 'no_workspace_token' };
}

// Slack: 複数チャンネルを読んで 1 つの fetched にまとめる。
// 1 つでも失敗したら failures に積む（judgePlatform が fetch_error にする）。
async function fetchSlackAll({ token, channelIds, oldestSec, latestSec, http }) {
  const out = { ok: true, messages: [], failures: [], reason: null };
  for (const channelId of channelIds) {
    const r = await fetchSlackHistory({ token, channelId, oldestSec, latestSec, http });
    if (!r.ok) { out.failures.push({ ref: channelId, reason: r.reason || 'request_failed' }); continue; }
    for (const m of r.messages) out.messages.push({ ...m, channel_ref: channelId });
  }
  return out;
}

// Chatwork: 複数ルームの最新 100 件 ＋ そこに無い投稿記録を message_id で 1 件ずつ。
// 1 件取得の失敗（404 以外）も failures に積む。404（削除済み）だけは「無い」として扱う。
async function fetchChatworkAll({ token, roomIds, posts, oldestMs, http }) {
  const out = { ok: true, messages: [], failures: [], reason: null };
  const have = new Set();
  for (const roomId of roomIds) {
    const r = await fetchChatworkRecent({ token, roomId, http });
    if (!r.ok) { out.failures.push({ ref: roomId, reason: r.reason || 'request_failed' }); continue; }
    for (const m of r.messages) {
      const key = `${roomId}:${m.id}`;
      if (have.has(key)) continue;
      have.add(key);
      out.messages.push({ ...m, channel_ref: roomId });
    }
  }
  for (const p of posts || []) {
    if (!p.message_id) continue;
    // 投稿記録に残っている投稿先（代替投稿先・変更前のルーム）を優先。無ければ今の設定の先頭ルーム
    const roomId = chatworkRoomIdOf(p.channel_ref) || roomIds[0];
    if (!roomId) continue;
    if (out.failures.some(f => f.ref === roomId)) continue; // そのルーム自体が読めていない（既に failure）
    const key = `${roomId}:${p.message_id}`;
    if (have.has(key)) continue;
    const one = await fetchChatworkMessage({ token, roomId, messageId: p.message_id, http });
    if (!one.ok) { out.failures.push({ ref: `${roomId}/${p.message_id}`, reason: one.reason || 'request_failed' }); continue; }
    if (one.message) { have.add(key); out.messages.push({ ...one.message, channel_ref: roomId }); }
    // one.message === null（404）は削除済み → judgePlatform の missing_posts で拾う
  }
  // 範囲外（当月より前）の古いメッセージは判定に使わない
  if (oldestMs != null) out.messages = out.messages.filter(m => !m.at || m.at >= oldestMs);
  return out;
}

// @param {object} deps { supabase, notifications（parseSlackChannelUrl / resolveSlackWorkspace）, chatworkToken, http }
// @param {object} p { project（id, name, slack_channel_url, chatwork_room_id, clients{...}）, ym, now }
async function reconProjectMonth(deps, { project, ym, now = new Date() }) {
  const { supabase, notifications, http = axios } = deps;
  const chatworkToken = deps.chatworkToken ?? process.env.CHATWORK_API_TOKEN;
  const projectId = project.id;
  const client = project.clients || null;

  const db = await L.loadProjectDeliveryLedger(supabase, { projectId, ym });

  let posts = [];
  try {
    const { data, error } = await supabase
      .from('delivery_ledger_posts')
      .select('id, platform, channel_ref, message_id, kind, creative_ids, seq, added, month_total, project_total, posted_at')
      .eq('project_id', projectId).eq('ym', ym).order('posted_at', { ascending: true });
    if (error) console.warn('[ledger-recon] posts select failed:', error.message);
    posts = data || [];
  } catch (e) { console.warn('[ledger-recon] posts select failed:', e?.message || e); }

  const channelUrl = project.slack_channel_url || client?.slack_channel_url || null;
  const roomId = project.chatwork_room_id || client?.chatwork_room_id || null;
  const win = fetchWindowSec(ym, now);
  const slackPosts = posts.filter(p => p.platform === 'slack');
  const cwPosts = posts.filter(p => p.platform === 'chatwork');

  // Slack: 今の設定のチャンネル ∪ 投稿記録に残っている投稿先（代替投稿・変更前）を全部読む
  let slack = null;
  const slackRefs = collectRefs({
    current: channelUrl ? slackChannelIdOf(channelUrl, notifications) : null,
    posts: slackPosts, toId: (ref) => slackChannelIdOf(ref, notifications),
  });
  if (channelUrl || slackRefs.refs.length) {
    let fetched;
    if (channelUrl && !notifications.parseSlackChannelUrl(channelUrl) && slackRefs.refs.length === 0) {
      fetched = { ok: false, messages: [], reason: 'invalid_url' };
    } else {
      const { token, reason } = await resolveSlackTokenFor({ channelUrl, posts: slackPosts, notifications, supabase });
      fetched = token
        ? await fetchSlackAll({ token, channelIds: slackRefs.refs, oldestSec: win.oldestSec, latestSec: win.latestSec, http })
        : { ok: false, messages: [], reason: reason || 'no_workspace_token' };
    }
    slack = {
      channel: slackRefs.refs[0] || channelUrl,
      channels: slackRefs.refs,
      unresolved_refs: slackRefs.unresolved,
      ...judgePlatform({ fetched, db, posts: slackPosts, projectId, ym }),
    };
  }

  // Chatwork: 今の設定のルーム ∪ 投稿記録に残っている投稿先
  let chatwork = null;
  const cwRefs = collectRefs({ current: chatworkRoomIdOf(roomId), posts: cwPosts, toId: chatworkRoomIdOf });
  if (roomId || cwRefs.refs.length) {
    const fetched = cwRefs.refs.length
      ? await fetchChatworkAll({ token: chatworkToken, roomIds: cwRefs.refs, posts: cwPosts, oldestMs: win.oldestSec * 1000, http })
      : { ok: false, messages: [], reason: 'no_room' };
    chatwork = {
      room: cwRefs.refs[0] || String(roomId),
      rooms: cwRefs.refs,
      unresolved_refs: cwRefs.unresolved,
      ...judgePlatform({ fetched, db, posts: cwPosts, projectId, ym }),
    };
  }

  return {
    project_id: projectId,
    project_name: project.name || '(案件不明)',
    client_name: client?.name || null,
    month: ym,
    db: { month_total: db.monthTotal, project_total: db.projectTotal, items: db.items },
    posts: posts.map(p => ({ platform: p.platform, channel_ref: p.channel_ref, message_id: p.message_id, kind: p.kind, month_total: p.month_total, posted_at: p.posted_at })),
    slack,
    chatwork,
    verdict: overallVerdict({ slack, chatwork }),
  };
}

// 月全体: DB に当月納品がある案件 ∪ 当月の投稿記録がある案件 を順番に突合する（API のレート制限を避けて直列）。
// @param {object} deps { supabase, notifications, chatworkToken?, http? }
// @param {object} p { ym, projectIds?（指定時はその案件だけ）, now? }
async function reconMonth(deps, { ym, projectIds = null, now = new Date() }) {
  const { supabase } = deps;
  const range = L.jstMonthRangeIso(ym);
  if (!range) throw new Error(`ledger-recon: month は YYYY-MM 形式で指定してください（${ym}）`);

  let ids = new Set(projectIds || []);
  if (!projectIds) {
    const { data: rows, error } = await supabase
      .from('creatives').select('project_id')
      .eq('status', '納品').gte('delivered_at', range.startIso).lt('delivered_at', range.endIso)
      .not('project_id', 'is', null);
    if (error) throw new Error(`ledger-recon: creatives select failed: ${error.message}`);
    (rows || []).forEach(r => r.project_id && ids.add(r.project_id));
    try {
      const { data: posts } = await supabase.from('delivery_ledger_posts').select('project_id').eq('ym', ym);
      (posts || []).forEach(r => r.project_id && ids.add(r.project_id));
    } catch (_) { /* テーブル未作成でも続行 */ }
  }
  ids = [...ids];
  const projects = [];
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await supabase
      .from('projects')
      .select('id, name, slack_channel_url, chatwork_room_id, clients(id, name, slack_channel_url, chatwork_room_id)')
      .in('id', ids.slice(i, i + 100));
    if (error) throw new Error(`ledger-recon: projects select failed: ${error.message}`);
    projects.push(...(data || []));
  }
  projects.sort((a, b) => `${a.clients?.name || ''}${a.name || ''}`.localeCompare(`${b.clients?.name || ''}${b.name || ''}`, 'ja'));

  const results = [];
  for (const project of projects) {
    try {
      results.push(await reconProjectMonth(deps, { project, ym, now }));
    } catch (e) {
      results.push({
        project_id: project.id, project_name: project.name || '(案件不明)', client_name: project.clients?.name || null,
        month: ym, db: null, posts: [], slack: null, chatwork: null, verdict: 'fetch_error', error: e?.message || String(e),
      });
    }
  }
  return { month: ym, results, summary: summarize(results) };
}

function summarize(results) {
  const s = { total: results.length, match: 0, mismatch: 0, no_posts: 0, no_channel: 0, fetch_error: 0, incomplete: 0 };
  for (const r of results) {
    if (s[r.verdict] != null) s[r.verdict]++;
    if (hasFetchError(r)) s.incomplete++; // 一部でも読めなかった案件（この月は完了扱いにしない）
  }
  return s;
}

// ---------- 管理者マイチャット向けの本文（純関数） ----------

const VERDICT_LABEL = {
  match: '✅ 一致', mismatch: '❌ 不一致', no_posts: '⚠️ 投稿なし', no_channel: '➖ 通知先なし', fetch_error: '🚫 取得不可',
};
const VERDICT_ORDER = ['mismatch', 'no_posts', 'fetch_error', 'match', 'no_channel'];
const MAX_PROJECT_LINES = 40;

function buildReconDigestText({ month, results, summary, pageUrl }) {
  const label = L.monthLabelOf(month);
  const s = summary || summarize(results);
  const lines = [
    `[info][title]📊 納品カウントの自動突合（${label}）: ${s.total}案件 ／ ✅${s.match} ❌${s.mismatch} ⚠️${s.no_posts} 🚫${s.fetch_error} ➖${s.no_channel}[/title]`,
    'Slack / Chatwork の案件チャンネルに積み上げた [HFS-LEDGER] と、HFS の納品データ（納品完了日の JST 月）を HFS が自動で読み比べた結果です。',
    '',
  ];
  const sorted = [...results].sort((a, b) => VERDICT_ORDER.indexOf(a.verdict) - VERDICT_ORDER.indexOf(b.verdict));
  const shown = sorted.slice(0, MAX_PROJECT_LINES);
  for (const r of shown) {
    const name = `${r.client_name ? `${r.client_name} / ` : ''}${r.project_name}`;
    const dbPart = r.db ? `DB ${r.db.month_total}件` : 'DB -';
    const parts = [dbPart];
    if (r.slack) parts.push(`Slack ${r.slack.verdict === 'fetch_error' ? '取得不可' : (r.slack.last_month_total ?? '投稿なし')}`);
    if (r.chatwork) parts.push(`Chatwork ${r.chatwork.verdict === 'fetch_error' ? '取得不可' : (r.chatwork.last_month_total ?? '投稿なし')}`);
    lines.push(`${VERDICT_LABEL[r.verdict] || r.verdict} ${name}：${parts.join(' ／ ')}`);
    const reasons = [r.slack?.reason && `Slack: ${r.slack.reason}`, r.chatwork?.reason && `Chatwork: ${r.chatwork.reason}`, r.error && `エラー: ${r.error}`].filter(Boolean);
    if (r.verdict !== 'match' && r.verdict !== 'no_channel' && reasons.length) lines.push(`　└ ${reasons.join(' ／ ')}`);
  }
  if (sorted.length > shown.length) lines.push(`…ほか ${sorted.length - shown.length}案件（画面で確認）`);
  const hints = [];
  if (results.some(r => (r.slack?.reason || '').includes('missing_scope'))) {
    hints.push('※ Slack が missing_scope: Slack アプリに channels:history（非公開は groups:history）スコープを追加して再インストールしてください');
  }
  if (results.some(r => r.verdict === 'mismatch')) {
    hints.push('※ 不一致は DB（HFS）が正です。納品完了日を後から補正した案件は投稿側が古いままになります');
  }
  if (s.incomplete > 0) {
    hints.push(`※ 読めなかった投稿先がある案件が ${s.incomplete}件あります。この月はまだ「突合完了」にせず、月初 1〜3 日の間は翌日にもう一度自動で突合します（手動: 管理者 API の recon/notify）`);
  }
  if (hints.length) { lines.push(''); lines.push(...hints); }
  if (pageUrl) { lines.push(''); lines.push(`詳細（JSON）: ${pageUrl}`); }
  lines.push('[/info]');
  return lines.join('\n');
}

module.exports = {
  fetchSlackHistory,
  fetchChatworkRecent,
  fetchChatworkMessage,
  fetchSlackAll,
  fetchChatworkAll,
  collectRefs,
  slackChannelIdOf,
  chatworkRoomIdOf,
  judgePlatform,
  overallVerdict,
  hasFetchError,
  fetchWindowSec,
  reconProjectMonth,
  reconMonth,
  summarize,
  buildReconDigestText,
  VERDICT_LABEL,
};
