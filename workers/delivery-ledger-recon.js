// workers/delivery-ledger-recon.js
// =============================================================
// 納品カウント（積み上げ台帳）の月初 自動突合（ADR 055 追補 2026-10-31）
//
// 毎月 1〜3 日の JST 10時台に 1 回、前月分について
//   DB の納品数（creatives.delivered_at の JST 月） と
//   Slack / Chatwork の案件チャンネルに積み上げた [HFS-LEDGER] 投稿
// を HFS 自身が読み比べ、結果を管理者の Chatwork マイチャットへ 1 通にまとめて送る。
// 人が URL を渡す工程は無い（全自動）。
//
// 二重送信ガード: system_settings 'delivery_ledger_recon_last_ym'（突合「完了」した対象月 'YYYY-MM'）。
//   完了＝読めなかった投稿先（取得不可）が 1 件も無かったとき。Slack / Chatwork の一時的な通信エラーで
//   取得不可が混ざった月は完了として記録せず、'delivery_ledger_recon_last_attempt'（'YYYY-MM|YYYY-MM-DD'）
//   に「その日に 1 回送った」ことだけ残して、1〜3 日の翌日にもう一度突合する（1 日 1 通まで）。
// 無効化: env DELIVERY_LEDGER_RECON_ENABLED=false
// 手動実行: GET /api/haruka/admin/delivery-ledger/recon?month=YYYY-MM（結果 JSON）
//           POST /api/haruka/admin/delivery-ledger/recon/notify { month }（今すぐマイチャットへ）
// =============================================================

const supabase = require('../supabase');
const { jstToday } = require('../utils/overdue-notify');
const { reconMonth, buildReconDigestText } = require('../utils/delivery-ledger-recon');

const TICK_MS = 30 * 60_000; // 30分
const RUN_HOUR_FROM = 10;
const RUN_HOUR_TO = 18;
const RUN_DAYS = [1, 2, 3];  // 1 日に失敗しても 2〜3 日に再試行できる
const LAST_YM_KEY = 'delivery_ledger_recon_last_ym';
const LAST_ATTEMPT_KEY = 'delivery_ledger_recon_last_attempt';

let intervalHandle = null;
let isRunning = false;
let lastRunYm = null;        // 完了した対象月
let lastAttemptDay = null;   // 未完了のまま送った日（'YYYY-MM-DD'）。同日は再送しない

function isEnabled() {
  const v = String(process.env.DELIVERY_LEDGER_RECON_ENABLED ?? 'true').toLowerCase();
  return !['false', '0', 'off', 'no'].includes(v);
}

function jstHour(now = new Date()) {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tokyo', hour: '2-digit', hourCycle: 'h23' }).format(now));
}

/** now（JST）の前月 'YYYY-MM'（純関数・テスト対象） */
function previousYm(now = new Date()) {
  const today = jstToday(now); // 'YYYY-MM-DD'
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  const d = new Date(Date.UTC(y, m - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** 月初（1〜3 日）の実行時間帯で、その対象月をまだ完了しておらず、今日まだ送っていなければ true（純関数・テスト対象） */
function shouldRunNow({ now = new Date(), lastRunYm: last, lastAttemptDay: attempted = null }) {
  const hour = jstHour(now);
  if (hour < RUN_HOUR_FROM || hour > RUN_HOUR_TO) return false;
  const today = jstToday(now);
  const day = Number(today.slice(8, 10));
  if (!RUN_DAYS.includes(day)) return false;
  if (previousYm(now) === last) return false;   // 完了済み
  return attempted !== today;                    // 未完了でも 1 日 1 通まで
}

async function readSetting(key) {
  const { data } = await supabase.from('system_settings').select('value').eq('key', key).maybeSingle();
  return data?.value ?? null;
}

async function writeSetting(key, value, label) {
  const { error } = await supabase.from('system_settings').upsert(
    { key, value, updated_at: new Date().toISOString() },
    { onConflict: 'key' },
  );
  if (error) console.warn(`[ledger-recon] ${label}の記録に失敗:`, error.message);
}

async function alreadyDone(ym) {
  return (await readSetting(LAST_YM_KEY)) === ym;
}

// 完了（取得不可ゼロ）のときだけ呼ぶ
async function markDone(ym) {
  await writeSetting(LAST_YM_KEY, ym, '突合済み月');
}

// 未完了のまま送った日を残す（同日の再送防止。翌日は再突合する）
async function markAttempt(ym, today) {
  await writeSetting(LAST_ATTEMPT_KEY, `${ym}|${today}`, '突合試行日');
}

async function alreadyAttemptedToday(ym, today) {
  return (await readSetting(LAST_ATTEMPT_KEY)) === `${ym}|${today}`;
}

// 突合してマイチャットへ送る（worker と手動 API の共通本体）。
// @param {object} p { ym, now?, force?（true なら二重送信ガードを無視） }
// 戻り値: { ym, summary, sent, complete }  complete=false は取得不可が混ざった（完了として記録していない）
async function runOnce({ ym, now = new Date(), force = false } = {}) {
  const targetYm = ym || previousYm(now);
  const today = jstToday(now);
  if (!force && await alreadyDone(targetYm)) return { ym: targetYm, skipped: 'already_done' };
  if (!force && await alreadyAttemptedToday(targetYm, today)) return { ym: targetYm, skipped: 'already_attempted_today' };

  const notifications = require('../notifications');
  const { buildAppUrl, sendChatworkRoom, resolveAdminMyChatRoomId, notifyAutoError } = notifications;
  const result = await reconMonth({ supabase, notifications }, { ym: targetYm, now });

  const token = process.env.CHATWORK_API_TOKEN;
  const roomId = token ? await resolveAdminMyChatRoomId(token) : null;
  const text = buildReconDigestText({
    month: targetYm, results: result.results, summary: result.summary,
    pageUrl: buildAppUrl(`api/haruka/admin/delivery-ledger/recon?month=${targetYm}`),
  });
  const r = !token ? { ok: false, reason: 'no_token' }
    : !roomId ? { ok: false, reason: 'no_room' }
    : await sendChatworkRoom(roomId, text, { token });
  if (!r.ok) {
    notifyAutoError({
      source: 'server',
      kind: 'chatwork.delivery_ledger_recon_failed',
      apiPath: `chatwork:room:${roomId || '-'}`,
      message: `納品カウントの自動突合（${targetYm}・${result.summary.total}案件）の結果を Chatwork マイチャットへ送れませんでした（${r.reason}）。CHATWORK_API_TOKEN / ADMIN_MYCHAT_CHATWORK_ROOM_ID を確認してください。`,
    }).catch(() => {});
    throw new Error(`send failed: ${r.reason}`);
  }
  // 取得不可（一時的な通信エラー含む）が 1 件でもあれば「完了」にしない。翌日（1〜3 日の間）に再突合する
  const complete = (result.summary.incomplete || 0) === 0;
  if (!force) {
    if (complete) await markDone(targetYm);
    else await markAttempt(targetYm, today);
  }
  console.log(`[ledger-recon] ${targetYm}: ${result.summary.total}案件を突合（✅${result.summary.match} ❌${result.summary.mismatch} ⚠️${result.summary.no_posts} 🚫${result.summary.fetch_error}${complete ? '' : `・未完了 ${result.summary.incomplete}件`}）→ マイチャットへ送信`);
  return { ym: targetYm, summary: result.summary, sent: true, complete };
}

async function tick(now = new Date()) {
  if (isRunning) return;
  isRunning = true;
  try {
    if (!shouldRunNow({ now, lastRunYm, lastAttemptDay })) return;
    const r = await runOnce({ now });
    if (r.skipped === 'already_done' || r.complete) lastRunYm = previousYm(now);
    else lastAttemptDay = jstToday(now);
  } catch (e) {
    console.error('[ledger-recon] 実行失敗（次の tick で再試行）:', e.message);
  } finally {
    isRunning = false;
  }
}

function startDeliveryLedgerRecon() {
  if (intervalHandle) return;
  if (!isEnabled()) {
    console.log('[ledger-recon] DELIVERY_LEDGER_RECON_ENABLED=false のため停止中');
    return;
  }
  console.log(`[ledger-recon] 起動（${TICK_MS}ms 周期・毎月 1〜3 日の JST ${RUN_HOUR_FROM}時台に前月分を自動突合）`);
  intervalHandle = setInterval(() => { tick().catch(() => {}); }, TICK_MS);
  setTimeout(() => { tick().catch(() => {}); }, 40_000);
}

function stopDeliveryLedgerRecon() {
  if (intervalHandle) { clearInterval(intervalHandle); intervalHandle = null; }
}

module.exports = { startDeliveryLedgerRecon, stopDeliveryLedgerRecon, runOnce, tick, shouldRunNow, previousYm };
