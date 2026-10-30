// workers/withholding-monthly-reminder.js
// =============================================================
// 🧾 源泉所得税の月初リマインド（ADR 054 §5 Stage D）
//
// 毎月1日 10:00 JST 以降に 1 回、前月分（支払日ベース）の集計
// （人数・支払金額・源泉徴収税額・差引・要確認件数）と「納付期限は翌月10日。
// 納期の特例の適用可否は税理士に確認」を管理者の Chatwork マイチャットへ送る。
//
// 二重送信ガード: system_settings 'withholding_reminder_last_month'（'YYYY-MM' ＝ 送った対象月）。
//   1日に送れなかった場合（デプロイ・障害等）は 5日まで翌 tick でリカバリ送信する。
// 無効化: env WITHHOLDING_REMINDER_ENABLED=false
// =============================================================

const supabase = require('../supabase');
const { jstToday } = require('../utils/overdue-notify');
const { buildWithholdingReminderText, prevMonthOf } = require('../utils/withholding-ledger');

const TICK_MS = 30 * 60_000; // 30分
const SEND_HOUR_JST = 10;    // 10時以降
const SEND_DAY = 1;          // 毎月1日
const RECOVERY_LAST_DAY = 5; // 1日に送れなかった場合のリカバリ期限
const LAST_MONTH_KEY = 'withholding_reminder_last_month';

let intervalHandle = null;
let isRunning = false;
// メモリ上の送信済みガード（markSent が失敗しても 30 分ごとに再送しない。pricing-pending-reminder の lastRunDay と同じ方式）
let lastSentMonthMem = null;

function isEnabled() {
  const v = String(process.env.WITHHOLDING_REMINDER_ENABLED ?? 'true').toLowerCase();
  return !['false', '0', 'off', 'no'].includes(v);
}

function jstHour(now = new Date()) {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tokyo', hour: '2-digit', hourCycle: 'h23' }).format(now));
}

/**
 * この tick で送るべき対象月を返す（純関数・テスト対象）。
 * @param {{ jstDate: string, jstHour: number, lastSentMonth: string|null }} p
 * @returns {{ action: 'send', year: number, month: number, monthKey: string } | { action: 'skip' }}
 */
function decideWithholdingReminderAction({ jstDate, jstHour: hour, lastSentMonth }) {
  const day = Number(jstDate.slice(8, 10));
  if (day < SEND_DAY || day > RECOVERY_LAST_DAY) return { action: 'skip' };
  if (hour < SEND_HOUR_JST) return { action: 'skip' };
  const y = Number(jstDate.slice(0, 4));
  const m = Number(jstDate.slice(5, 7));
  const target = prevMonthOf(y, m);
  const monthKey = `${target.year}-${String(target.month).padStart(2, '0')}`;
  if (lastSentMonth && lastSentMonth >= monthKey) return { action: 'skip' };
  return { action: 'send', year: target.year, month: target.month, monthKey };
}

async function loadLastSentMonth() {
  const { data } = await supabase.from('system_settings').select('value').eq('key', LAST_MONTH_KEY).maybeSingle();
  return data?.value || null;
}

async function markSent(monthKey) {
  const { error } = await supabase.from('system_settings').upsert(
    { key: LAST_MONTH_KEY, value: monthKey, updated_at: new Date().toISOString() },
    { onConflict: 'key' },
  );
  if (error) console.warn('[withholding-reminder] 送信月の記録に失敗:', error.message);
}

/**
 * 対象月の集計を管理者マイチャットへ送る（手動実行にも使える）。
 */
async function sendWithholdingReminder({ year, month, trigger = 'auto' }) {
  const { buildMonthReport } = require('../utils/withholding-ledger-source');
  const { buildAppUrl, sendChatworkRoom, resolveAdminMyChatRoomId, notifyAutoError } = require('../notifications');
  const rep = await buildMonthReport(year, month);
  const monthKey = `${year}-${String(month).padStart(2, '0')}`;
  const text = buildWithholdingReminderText({
    year, month,
    summary: rep.summary,
    rows: rep.rows,
    warnings: rep.warnings,
    pageUrl: buildAppUrl(`haruka.html?page=payout&withholding=${monthKey}`),
  });
  const token = process.env.CHATWORK_API_TOKEN;
  const roomId = token ? await resolveAdminMyChatRoomId(token) : null;
  const r = !token ? { ok: false, reason: 'no_token' }
    : !roomId ? { ok: false, reason: 'no_room' }
    : await sendChatworkRoom(roomId, text, { token });
  if (!r.ok) {
    notifyAutoError({
      source: 'server',
      kind: 'chatwork.withholding_reminder_failed',
      apiPath: `chatwork:room:${roomId || '-'}`,
      message: `源泉所得税の納付リマインド（${monthKey} 支払分）を Chatwork マイチャットへ送れませんでした（${r.reason}）。CHATWORK_API_TOKEN / ADMIN_MYCHAT_CHATWORK_ROOM_ID を確認してください。`,
    }).catch(() => {});
    throw new Error(`send failed: ${r.reason}`);
  }
  await markSent(monthKey);
  console.log(`[withholding-reminder] ${monthKey} 支払分（${trigger}）: ${rep.summary.payee_count}名・源泉 ${rep.summary.withholding_total}円 をマイチャットへ送信`);
  return { monthKey, summary: rep.summary, sent: true };
}

async function tick(now = new Date()) {
  if (isRunning) return;
  isRunning = true;
  try {
    const decision = decideWithholdingReminderAction({
      jstDate: jstToday(now),
      jstHour: jstHour(now),
      lastSentMonth: await loadLastSentMonth(),
    });
    if (decision.action !== 'send') return;
    if (lastSentMonthMem === decision.monthKey) return; // 今プロセスで送信済み（markSent 失敗時の再送防止）
    const r = await sendWithholdingReminder({ year: decision.year, month: decision.month, trigger: 'auto' });
    if (r?.sent) lastSentMonthMem = decision.monthKey;
  } catch (e) {
    console.error('[withholding-reminder] 実行失敗（次の tick で再試行）:', e.message);
  } finally {
    isRunning = false;
  }
}

function startWithholdingMonthlyReminder() {
  if (intervalHandle) return;
  if (!isEnabled()) {
    console.log('[withholding-reminder] WITHHOLDING_REMINDER_ENABLED=false のため停止中');
    return;
  }
  console.log(`[withholding-reminder] 起動（${TICK_MS}ms 周期・毎月${SEND_DAY}日 ${SEND_HOUR_JST}時 JST 以降に前月分を送信）`);
  intervalHandle = setInterval(() => { tick().catch(() => {}); }, TICK_MS);
  if (intervalHandle && typeof intervalHandle.unref === 'function') intervalHandle.unref();
  setTimeout(() => { tick().catch(() => {}); }, 30_000);
}

function stopWithholdingMonthlyReminder() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    console.log('[withholding-reminder] 停止しました');
  }
}

module.exports = {
  startWithholdingMonthlyReminder,
  stopWithholdingMonthlyReminder,
  sendWithholdingReminder,
  // テスト用
  decideWithholdingReminderAction,
  LAST_MONTH_KEY,
};
