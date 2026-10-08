// workers/overdue-notifier.js
// =============================================================
// 提出遅れ（最終納品日超過・未納品・ボールが制作側）の日次通知ワーカ（ADR 049）。
//
// ・平日（土日・祝日以外）の JST 10 時台に 1 回だけ実行（30 分ごとに tick。contract-reminder.js の型）
// ・対象は進行ボードの「提出遅れ」と同じ条件（utils/overdue-notify.js selectOverdue）
// ・受信者はクリエイティブを管理しているディレクター／プロデューサー
//   （assignment → projects.director_id / producer_id → 制作担当のチーム代表 D の順。getBallHolder と同じ）
// ・1 人 1 日 1 通のまとめ。通知ベル（type=deadline）＋ Chatwork / Slack DM（utils/member-notify.js）。
//   同じ日に送った記録（notification_logs.meta.digest_date）があれば再送しない（再デプロイ耐性）
// ・OVERDUE_NOTIFY_ENABLED=false で停止できる（既定 ON）。OVERDUE_NOTIFY_HOUR で開始時刻（既定 10）
//
// ログに個人の連絡先（Chatwork/Slack ID）は出さない。
// =============================================================

const supabase = require('../supabase');
const {
  jstToday, isJstBusinessDay, selectOverdue, groupByRecipient, buildOverdueDigest,
} = require('../utils/overdue-notify');
const { createNotification } = require('../utils/notification');
const { notifyMember, NOTIFY_USER_COLUMNS } = require('../utils/member-notify');

const TICK_MS = 30 * 60_000; // 30分
const RUN_HOUR_FROM = Number.isFinite(Number(process.env.OVERDUE_NOTIFY_HOUR)) ? Number(process.env.OVERDUE_NOTIFY_HOUR) : 10;
const RUN_HOUR_TO = 18;
const NOTIFICATION_TYPE = 'deadline';
const PAGE_SIZE = 1000;

let intervalHandle = null;
let isRunning = false;
let lastRunDay = null; // JST 'YYYY-MM-DD'

function isEnabled() {
  const v = String(process.env.OVERDUE_NOTIFY_ENABLED ?? 'true').toLowerCase();
  return !['false', '0', 'off', 'no'].includes(v);
}

function jstHour(now = new Date()) {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tokyo', hour: '2-digit', hourCycle: 'h23' }).format(now));
}

/** その日まだ実行しておらず、平日の実行時間帯なら true（純関数・テスト対象） */
function shouldRunNow({ now = new Date(), lastRunDay: last }) {
  const hour = jstHour(now);
  if (hour < RUN_HOUR_FROM || hour > RUN_HOUR_TO) return false;
  if (!isJstBusinessDay(now)) return false;
  return jstToday(now) !== last;
}

function appUrl(path) {
  const { buildAppUrl } = require('../notifications');
  return buildAppUrl(path);
}

/** 提出遅れ候補を全件取得（final_deadline < today・未納品・クライアントチェック中以外） */
async function loadOverdueCreatives(today) {
  const rows = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('creatives')
      .select(`id, file_name, status, final_deadline, force_delivered, help_flag, project_id,
        projects(id, name, director_id, producer_id, clients(id, name, status)),
        creative_assignments(role, user_id, users(id, full_name, nickname, team_id))`)
      .lt('final_deadline', today)
      .neq('status', '納品')
      .neq('status', 'クライアントチェック中')
      .order('final_deadline', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < PAGE_SIZE) break;
  }
  return rows;
}

/** チーム代表ディレクター逆引き（getBallHolder のフォールバックと同じ） */
async function loadTeamContext() {
  const { data: teams, error } = await supabase
    .from('teams')
    .select('id, director_id, team_members(user_id)');
  if (error) throw error;
  const directorIdByTeamId = new Map();
  const directorIdByUserId = new Map();
  for (const t of teams || []) {
    if (!t.director_id) continue;
    directorIdByTeamId.set(t.id, t.director_id);
    for (const tm of t.team_members || []) {
      if (tm.user_id && !directorIdByUserId.has(tm.user_id)) directorIdByUserId.set(tm.user_id, t.director_id);
    }
  }
  return { directorIdByTeamId, directorIdByUserId };
}

/** 今日すでにまとめを送った受信者（再デプロイで lastRunDay が消えても二重送信しない） */
async function loadAlreadySentToday(userIds, today) {
  const sent = new Set();
  if (!userIds.length) return sent;
  const { data, error } = await supabase
    .from('notification_logs')
    .select('user_id')
    .eq('notification_type', NOTIFICATION_TYPE)
    .contains('meta', { digest_date: today })
    .in('user_id', userIds);
  if (error) {
    console.warn('[overdue-notifier] 送信済み確認に失敗（送信は続行）:', error.message);
    return sent;
  }
  for (const r of data || []) sent.add(r.user_id);
  return sent;
}

async function runOnce(now = new Date()) {
  const today = jstToday(now);
  const [candidates, ctx] = await Promise.all([loadOverdueCreatives(today), loadTeamContext()]);
  const overdue = selectOverdue(candidates, today);
  if (overdue.length === 0) {
    console.log(`[overdue-notifier] ${today}: 提出遅れなし`);
    return { today, overdue: 0, recipients: 0, sent: 0 };
  }
  const byRecipient = groupByRecipient(overdue, ctx, today);
  const recipientIds = Array.from(byRecipient.keys());

  const [{ data: users, error: uErr }, alreadySent] = await Promise.all([
    supabase.from('users').select(NOTIFY_USER_COLUMNS).in('id', recipientIds),
    loadAlreadySentToday(recipientIds, today),
  ]);
  if (uErr) throw uErr;
  const userById = new Map((users || []).map(u => [u.id, u]));

  const boardUrl = appUrl('haruka.html?delayed=1');
  const creativeUrl = id => appUrl(`haruka.html?creative=${id}`);
  let sent = 0;
  let forwarded = 0;
  let unassigned = 0;

  for (const [userId, items] of byRecipient) {
    const user = userById.get(userId);
    if (!user || user.is_active === false) continue;
    if (alreadySent.has(userId)) continue;

    const msg = buildOverdueDigest({ recipient: user, items, todayYmd: today, creativeUrl, boardUrl });
    // 個別 DM（privateOnly: 共有ルームへは送らない。届かなければ管理者マイチャットへ転送依頼）。
    // ベルより先に送り、DM の結果を meta に残す（ADR 049 追補）。
    const r = await notifyMember(user, { chatwork: msg.chatwork, slack: msg.slack }, { privateOnly: true });
    if (r.ok && !r.forwarded) sent++;
    else if (r.ok) { forwarded++; console.log(`[overdue-notifier] 管理者マイチャットへ転送依頼 user=${userId} 件数=${items.length}: ${r.reason}`); }
    else console.log(`[overdue-notifier] DM 未送信 user=${userId} 件数=${items.length}: ${r.reason}`);
    // 通知ベル（遅延一覧へのリンク。1 日 1 件・meta.digest_date で再送ガード）
    await createNotification({
      userId,
      type: NOTIFICATION_TYPE,
      title: msg.title,
      body: `${items.length}件。日付の変更・ステータス更新・SOS のいずれかで対応してください`,
      linkUrl: '/haruka.html?delayed=1',
      meta: { digest_date: today, creative_ids: items.map(c => c.id).slice(0, 100), count: items.length, dm_channel: r.channel, dm_ok: !!r.ok },
    });
  }

  // 管理者が誰も解決できなかったクリエイティブは件数だけログに残す（担当未設定の洗い出し用）
  for (const c of overdue) {
    const hit = recipientIds.some(id => (byRecipient.get(id) || []).includes(c));
    if (!hit) unassigned++;
  }
  console.log(`[overdue-notifier] ${today}: 提出遅れ ${overdue.length}件 / 受信者 ${byRecipient.size}人 / DM 送信 ${sent}件 / マイチャット転送 ${forwarded}件 / D・P 未解決 ${unassigned}件`);
  return { today, overdue: overdue.length, recipients: byRecipient.size, sent, forwarded, unassigned };
}

async function tick(now = new Date()) {
  if (isRunning) return;
  isRunning = true;
  try {
    if (!shouldRunNow({ now, lastRunDay })) return;
    await runOnce(now);
    // 成功したときだけ「今日は実行済み」にする。途中で失敗したら次の tick（30 分後）で再試行する。
    // 送信済みの受信者は notification_logs.meta.digest_date で守られるので二重送信にはならない。
    lastRunDay = jstToday(now);
  } catch (e) {
    console.error('[overdue-notifier] 実行失敗（次の tick で再試行）:', e.message);
  } finally {
    isRunning = false;
  }
}

function startOverdueNotifier() {
  if (intervalHandle) return;
  if (!isEnabled()) {
    console.log('[overdue-notifier] OVERDUE_NOTIFY_ENABLED=false のため停止中');
    return;
  }
  console.log(`[overdue-notifier] 起動（${TICK_MS}ms 周期・平日 JST ${RUN_HOUR_FROM}時台に日次実行）`);
  intervalHandle = setInterval(() => { tick().catch(() => {}); }, TICK_MS);
  // 起動直後にも 1 回判定（デプロイが実行時間帯に当たったときに当日分を落とさない）
  setTimeout(() => { tick().catch(() => {}); }, 15_000);
}

function stopOverdueNotifier() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

module.exports = {
  startOverdueNotifier,
  stopOverdueNotifier,
  runOnce,
  tick,
  shouldRunNow,
  __test: {
    loadOverdueCreatives, loadTeamContext, loadAlreadySentToday,
    getLastRunDay: () => lastRunDay,
    setLastRunDay: (v) => { lastRunDay = v; },
  },
};
