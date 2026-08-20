// workers/onboarding-stall-reminder.js
// =============================================================
// オンボーディング停滞催促ワーカ
//
// 役割:
//   進行中のオンボーディングで「相手（新メンバー）がやる作業」
//   （phase='mt_before'）が一定日数（既定3日）動いていない場合に自動で催促する。
//
// 送信先:
//   1) 本人が HFS 登録済みで slack_dm_id あり → 本人へ Slack DM（文例そのまま）
//   2) それ以外（未登録・DM先不明）        → admin へ Slack DM で
//      「催促してください」＋コピペ用文例を送る（Chatwork等で人力転送してもらう）
//
// 停滞判定:
//   max(record.created_at, record.last_reminded_at, タスクの最新 done_at)
//   から stall_days 日以上経過していたら催促。送信後は last_reminded_at を
//   更新するので、次の催促はさらに stall_days 日後（毎日は鳴らない）。
//
// 実行タイミング: 30分ごとに tick し、JST 10時〜18時のみ送信（夜間に鳴らさない）。
// 催促日数は system_settings 'onboarding_stall_days' で変更可（既定 3）。
//
// 必要 migration: onboarding_records.last_reminded_at（2026-08-20_onboarding_stall_reminder.sql）
// =============================================================

const supabase = require('../supabase');
const { sendSlackDm } = require('../notifications');

const TICK_MS = 30 * 60_000; // 30分
const SEND_HOUR_FROM = 10;   // JST 10時から
const SEND_HOUR_TO = 18;     // JST 18時台まで
const DEFAULT_STALL_DAYS = 3;
const STALL_DAYS_SETTING_KEY = 'onboarding_stall_days';

let intervalHandle = null;
let isRunning = false;

// ---------- 純関数（テスト対象） ----------

/**
 * 催促すべきか判定する。
 * @param {{ nowMs: number, createdAt?: string, lastRemindedAt?: string, lastDoneAt?: string, stallDays: number }} p
 */
function shouldSendStallReminder({ nowMs, createdAt, lastRemindedAt, lastDoneAt, stallDays }) {
  const toMs = (iso) => (iso ? new Date(iso).getTime() : 0);
  const base = Math.max(toMs(createdAt), toMs(lastRemindedAt), toMs(lastDoneAt));
  if (!base || !Number.isFinite(base)) return false;
  return nowMs - base >= stallDays * 86_400_000;
}

/**
 * 本人向けの催促文例を生成する。
 * @param {{ displayName: string, pendingLabels: string[] }} p
 */
function buildMemberReminderText({ displayName, pendingLabels }) {
  return [
    `${displayName}さん、お疲れ様です！HARUKA FILMです🙌`,
    '',
    'ご加入のお手続きのうち、下記がまだのようです🙇‍♀️',
    ...pendingLabels.map(l => `・${l}`),
    '',
    'お手すきの際にご対応をお願いします✨',
    'ご不明点があればひーくんへDMください！',
  ].join('\n');
}

/**
 * admin 向けの催促代行依頼文を生成する（本人へDMできない場合のフォールバック）。
 * @param {{ memberName: string, occupationLabel: string, stallDays: number, pendingLabels: string[], memberText: string }} p
 */
function buildAdminFallbackText({ memberName, occupationLabel, stallDays, pendingLabels, memberText }) {
  return [
    `🔔 オンボーディング停滞: ${memberName}（${occupationLabel}）`,
    `相手待ちタスクが ${stallDays}日以上 動いていません:`,
    ...pendingLabels.map(l => `・${l}`),
    '',
    '本人へのSlack DMが送れない（HFS未登録 or Slack未連携）ため、',
    'Chatwork等で下記の文例を送ってあげてください👇',
    '─────────────',
    memberText,
    '─────────────',
  ].join('\n');
}

// ---------- ワーカ本体 ----------

async function loadStallDays() {
  const { data } = await supabase.from('system_settings')
    .select('value').eq('key', STALL_DAYS_SETTING_KEY).maybeSingle();
  const n = Number(data?.value);
  return Number.isFinite(n) && n >= 1 ? n : DEFAULT_STALL_DAYS;
}

function jstHour(now = new Date()) {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tokyo', hour: '2-digit', hourCycle: 'h23' }).format(now));
}

async function tick() {
  if (isRunning) return;
  isRunning = true;
  try {
    const hour = jstHour();
    if (hour < SEND_HOUR_FROM || hour > SEND_HOUR_TO) return;

    const stallDays = await loadStallDays();
    const { data: records, error } = await supabase
      .from('onboarding_records')
      .select(`id, member_name, occupation, created_at, last_reminded_at,
               user:users!onboarding_records_user_id_fkey(id, full_name, nickname, slack_dm_id),
               onboarding_tasks(label, phase, done, done_at)`)
      .eq('status', 'in_progress');
    if (error) {
      // last_reminded_at 未適用（migration 前）でも他機能を巻き込まない
      console.warn('[onboarding-stall] レコード取得失敗:', error.message);
      return;
    }

    const nowMs = Date.now();
    const { ONBOARDING_OCCUPATIONS } = require('../utils/onboarding');

    for (const rec of records || []) {
      const tasks = rec.onboarding_tasks || [];
      const pending = tasks.filter(t => t.phase === 'mt_before' && !t.done);
      if (pending.length === 0) continue;

      const doneAts = tasks.filter(t => t.done_at).map(t => t.done_at);
      const lastDoneAt = doneAts.length ? doneAts.sort().at(-1) : null;
      if (!shouldSendStallReminder({
        nowMs,
        createdAt: rec.created_at,
        lastRemindedAt: rec.last_reminded_at,
        lastDoneAt,
        stallDays,
      })) continue;

      const pendingLabels = pending.map(t => t.label);
      const displayName = rec.user?.nickname || rec.user?.full_name || rec.member_name;
      const memberText = buildMemberReminderText({ displayName, pendingLabels });

      let sent = { ok: false, reason: 'no_target' };
      let route = 'admin_fallback';
      if (rec.user?.slack_dm_id) {
        sent = await sendSlackDm(rec.user.slack_dm_id, memberText);
        route = 'member_dm';
      }
      if (!rec.user?.slack_dm_id || !sent.ok) {
        // 本人へ送れない → admin（slack_dm_id 登録済みの active admin）へ代行依頼
        const adminText = buildAdminFallbackText({
          memberName: rec.member_name,
          occupationLabel: ONBOARDING_OCCUPATIONS[rec.occupation] || rec.occupation,
          stallDays,
          pendingLabels,
          memberText,
        });
        const { data: admins } = await supabase.from('users')
          .select('slack_dm_id').eq('role', 'admin').eq('is_active', true).not('slack_dm_id', 'is', null);
        for (const a of admins || []) {
          const r = await sendSlackDm(a.slack_dm_id, adminText);
          if (r.ok) { sent = r; route = 'admin_fallback'; }
        }
      }

      if (sent.ok) {
        await supabase.from('onboarding_records')
          .update({ last_reminded_at: new Date().toISOString() }).eq('id', rec.id);
        console.log(`[onboarding-stall] 催促送信 (${route}): ${rec.member_name} / 未完了 ${pendingLabels.length}件`);
      } else {
        console.warn(`[onboarding-stall] 催促送信失敗: ${rec.member_name} (${sent.reason})`);
      }
    }
  } catch (e) {
    console.error('[onboarding-stall] tick 失敗:', e.message);
  } finally {
    isRunning = false;
  }
}

function startOnboardingStallReminder() {
  if (intervalHandle) return;
  console.log(`[onboarding-stall] 起動（${TICK_MS}ms 周期・停滞${DEFAULT_STALL_DAYS}日で催促・JST ${SEND_HOUR_FROM}-${SEND_HOUR_TO}時）`);
  tick().catch(e => console.error('[onboarding-stall] 初回tick失敗:', e.message));
  intervalHandle = setInterval(() => {
    tick().catch(e => console.error('[onboarding-stall] tick失敗:', e.message));
  }, TICK_MS);
  if (intervalHandle && typeof intervalHandle.unref === 'function') intervalHandle.unref();
}

function stopOnboardingStallReminder() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    console.log('[onboarding-stall] 停止しました');
  }
}

module.exports = {
  startOnboardingStallReminder,
  stopOnboardingStallReminder,
  // テスト用
  shouldSendStallReminder,
  buildMemberReminderText,
  buildAdminFallbackText,
  DEFAULT_STALL_DAYS,
};
