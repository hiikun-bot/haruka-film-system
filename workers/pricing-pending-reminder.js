// workers/pricing-pending-reminder.js
// =============================================================
// 単価の承認待ちリマインド（ADR 037 追補 2026-10-28）
//
// 承認待ち（project_estimate_lines.pricing_approval = 'pending'）が 1 件でも残っていれば、
// 平日 JST 10時台に管理者の Chatwork マイチャットへまとめて 1 通送る（1 件ごとには鳴らさない）。
// 発生時の一報（notifyPricingPendingMyChat）を見落としても、残っている限り毎朝気づけるようにする。
//
// 二重送信ガード: system_settings 'pricing_pending_reminder_last_date'（JST 日付）。
// 無効化: env PRICING_PENDING_REMINDER_ENABLED=false
// =============================================================

const supabase = require('../supabase');
const { jstToday, isJstBusinessDay } = require('../utils/overdue-notify');
const { buildPricingPendingReminderText } = require('../utils/pricing-pending-reminder');

const TICK_MS = 30 * 60_000; // 30分
const RUN_HOUR_FROM = 10;
const RUN_HOUR_TO = 18;
const LAST_DATE_KEY = 'pricing_pending_reminder_last_date';

let intervalHandle = null;
let isRunning = false;
let lastRunDay = null;

function isEnabled() {
  const v = String(process.env.PRICING_PENDING_REMINDER_ENABLED ?? 'true').toLowerCase();
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

async function loadPendingItems() {
  const { data: lines, error } = await supabase
    .from('project_estimate_lines')
    .select('id, project_id, pricing_requested_by, pricing_requested_at')
    .eq('pricing_approval', 'pending')
    .limit(500);
  if (error) throw error;
  const rows = lines || [];
  if (!rows.length) return [];
  const projectIds = [...new Set(rows.map(r => r.project_id).filter(Boolean))];
  const userIds = [...new Set(rows.map(r => r.pricing_requested_by).filter(Boolean))];
  const [{ data: projects }, { data: users }] = await Promise.all([
    projectIds.length ? supabase.from('projects').select('id, name, clients(name)').in('id', projectIds) : { data: [] },
    userIds.length ? supabase.from('users').select('id, full_name, nickname').in('id', userIds) : { data: [] },
  ]);
  const projById = new Map((projects || []).map(p => [p.id, p]));
  const userById = new Map((users || []).map(u => [u.id, u]));
  return rows.map(r => {
    const p = projById.get(r.project_id);
    const u = userById.get(r.pricing_requested_by);
    return {
      project_id: r.project_id,
      client_name: p?.clients?.name || '',
      project_name: p?.name || '',
      requester_label: u ? (u.nickname || u.full_name || '') : '',
      requested_at: r.pricing_requested_at || null,
    };
  });
}

async function alreadySentOn(today) {
  const { data } = await supabase.from('system_settings').select('value').eq('key', LAST_DATE_KEY).maybeSingle();
  return data?.value === today;
}

async function markSent(today) {
  const { error } = await supabase.from('system_settings').upsert(
    { key: LAST_DATE_KEY, value: today, updated_at: new Date().toISOString() },
    { onConflict: 'key' },
  );
  if (error) console.warn('[pricing-pending-reminder] 送信日の記録に失敗:', error.message);
}

async function runOnce(now = new Date()) {
  const today = jstToday(now);
  if (await alreadySentOn(today)) return { today, skipped: 'already_sent' };
  const items = await loadPendingItems();
  if (!items.length) {
    console.log(`[pricing-pending-reminder] ${today}: 承認待ちなし`);
    return { today, pending: 0 };
  }
  const { buildAppUrl, sendChatworkRoom, resolveAdminMyChatRoomId, notifyAutoError } = require('../notifications');
  const token = process.env.CHATWORK_API_TOKEN;
  const roomId = token ? await resolveAdminMyChatRoomId(token) : null;
  const text = buildPricingPendingReminderText({ items, todayYmd: today, pageUrl: buildAppUrl('haruka.html?page=pricing-approvals') });
  const r = !token ? { ok: false, reason: 'no_token' }
    : !roomId ? { ok: false, reason: 'no_room' }
    : await sendChatworkRoom(roomId, text, { token });
  if (!r.ok) {
    notifyAutoError({
      source: 'server',
      kind: 'chatwork.pricing_pending_reminder_failed',
      apiPath: `chatwork:room:${roomId || '-'}`,
      message: `単価の承認待ちリマインド（${items.length}件）を Chatwork マイチャットへ送れませんでした（${r.reason}）。CHATWORK_API_TOKEN / ADMIN_MYCHAT_CHATWORK_ROOM_ID を確認してください。`,
    }).catch(() => {});
    throw new Error(`send failed: ${r.reason}`);
  }
  await markSent(today);
  console.log(`[pricing-pending-reminder] ${today}: 承認待ち ${items.length}件をマイチャットへ送信`);
  return { today, pending: items.length, sent: true };
}

async function tick(now = new Date()) {
  if (isRunning) return;
  isRunning = true;
  try {
    if (!shouldRunNow({ now, lastRunDay })) return;
    await runOnce(now);
    lastRunDay = jstToday(now);
  } catch (e) {
    console.error('[pricing-pending-reminder] 実行失敗（次の tick で再試行）:', e.message);
  } finally {
    isRunning = false;
  }
}

function startPricingPendingReminder() {
  if (intervalHandle) return;
  if (!isEnabled()) {
    console.log('[pricing-pending-reminder] PRICING_PENDING_REMINDER_ENABLED=false のため停止中');
    return;
  }
  console.log(`[pricing-pending-reminder] 起動（${TICK_MS}ms 周期・平日 JST ${RUN_HOUR_FROM}時台に日次実行）`);
  intervalHandle = setInterval(() => { tick().catch(() => {}); }, TICK_MS);
  setTimeout(() => { tick().catch(() => {}); }, 20_000);
}

function stopPricingPendingReminder() {
  if (intervalHandle) { clearInterval(intervalHandle); intervalHandle = null; }
}

module.exports = { startPricingPendingReminder, stopPricingPendingReminder, runOnce, tick, shouldRunNow };
