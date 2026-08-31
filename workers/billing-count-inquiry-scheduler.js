// workers/billing-count-inquiry-scheduler.js
// =============================================================
// 月次制作本数ヒアリングの自動送信ワーカ（毎月末日 10:00 JST 以降）
//
// 役割:
//   10分ごとに JST の現在日時を確認し、毎月「月末最終日」10時以降に
//   制作本数ヒアリング（よたさん案件の請求用。文面は utils/billing-count-inquiry.js）
//   を対象 Chatwork ルームへ 1回だけ 自動送信する。
//
// 二重送信ガード:
//   system_settings 'billing_inquiry_last_sent'（'YYYY-MM'）で月単位管理。
//   送信済みの月はスキップ。月末日に送れなかった場合（デプロイ・障害等）は
//   翌月2日まで翌 tick でリカバリ送信する（対象月は前月のまま）。
//
// 初回起動ブートストラップ:
//   'billing_inquiry_last_sent' キーが無い初回デプロイ時は、過去分を
//   さかのぼって突然送信しないよう「消化済み」マークだけ行う
//   （月末日なら当月＝当日分は手動送信済み想定、それ以外は前月を消化済みに）。
//   初月に手動で送りたい場合は POST /api/haruka/admin/billing-inquiry/send を使う。
//
// 送信先（system_settings 'billing_inquiry_targets' の JSON 配列で上書き可能）:
//   既定 = 【HF】よたさん｜YouTube動画（room 405007443）みっつー宛て
// =============================================================

const supabase = require('../supabase');
const { sendChatworkRoom, notifyAutoError } = require('../notifications');
const { DEFAULT_TARGETS, lastDayOfMonth, prevMonth, parseTargets, buildBillingInquiryMessage } = require('../utils/billing-count-inquiry');

const TICK_MS = 10 * 60_000;   // 10分
const SEND_HOUR_JST = 10;      // 10時以降に送信
const RECOVERY_LAST_DAY = 2;   // 月末に送れなかった場合、翌月2日までリカバリ

const SETTING_KEYS = {
  lastSent: 'billing_inquiry_last_sent',
  targets: 'billing_inquiry_targets',
};

let intervalHandle = null;
let isRunning = false;

// JST の現在日付・時刻（サーバーTZ 非依存。Railway は UTC 動作のため必ずこれを使う）
function jstNowParts(now = new Date()) {
  const date = now.toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' }); // 'YYYY-MM-DD'
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tokyo', hour: '2-digit', hourCycle: 'h23' }).format(now));
  return { date, hour };
}

/**
 * この tick で何をすべきかの純関数判定（テスト対象）。
 * @param {{ jstDate: string, jstHour: number, lastSentMonth: string|null }} p
 * @returns {{ action: 'bootstrap', markMonth: string } | { action: 'send', month: string } | { action: 'skip' }}
 */
function decideBillingInquiryAction({ jstDate, jstHour, lastSentMonth }) {
  const month = jstDate.slice(0, 7);
  const day = Number(jstDate.slice(8, 10));
  const [y, m] = month.split('-').map(Number);
  const isMonthEnd = day === lastDayOfMonth(y, m);
  if (!lastSentMonth) {
    // 初回起動: 過去分を勝手に送らない（月末日なら当月を消化済み＝当日分は手動済み想定）
    return { action: 'bootstrap', markMonth: isMonthEnd ? month : prevMonth(month) };
  }
  if (isMonthEnd && jstHour >= SEND_HOUR_JST && lastSentMonth < month) {
    return { action: 'send', month };
  }
  // リカバリ: 月初1〜2日で前月分が未送信なら前月分として送る
  if (day <= RECOVERY_LAST_DAY && jstHour >= SEND_HOUR_JST && lastSentMonth < prevMonth(month)) {
    return { action: 'send', month: prevMonth(month) };
  }
  return { action: 'skip' };
}

async function loadSettings() {
  const keys = Object.values(SETTING_KEYS);
  const { data, error } = await supabase.from('system_settings').select('key, value').in('key', keys);
  if (error) throw new Error(`system_settings 読み取り失敗: ${error.message}`);
  const map = {};
  (data || []).forEach(r => { map[r.key] = r.value; });
  return map;
}

async function upsertSetting(key, value) {
  const { error } = await supabase.from('system_settings')
    .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  if (error) throw new Error(`system_settings 書き込み失敗 (${key}): ${error.message}`);
}

/**
 * ヒアリングを全ターゲットへ送信する（手動送信 API からも呼ばれる）。
 * 1件でも成功したら last_sent を更新（失敗分はエラーチャンネルへ通知）。
 * @param {{ month: string, trigger: 'auto'|'manual' }} p
 */
async function sendBillingInquiry({ month, trigger = 'auto' }) {
  const settings = await loadSettings();
  const targets = parseTargets(settings[SETTING_KEYS.targets]) || DEFAULT_TARGETS;

  const results = [];
  for (const target of targets) {
    const message = buildBillingInquiryMessage(target);
    const result = await sendChatworkRoom(target.roomId, message);
    results.push({ label: target.label, roomId: target.roomId, ok: result.ok, reason: result.ok ? null : result.reason });
  }

  const okCount = results.filter(r => r.ok).length;
  if (okCount > 0) {
    await upsertSetting(SETTING_KEYS.lastSent, month);
  }
  const failed = results.filter(r => !r.ok);
  if (failed.length > 0) {
    const detail = failed.map(r => `${r.label}(room=${r.roomId})=${r.reason || 'unknown'}`).join(' / ');
    console.warn(`[billing-inquiry] 送信一部失敗 (${trigger}): ${detail}`);
    await notifyAutoError({
      source: 'server',
      kind: 'billing-inquiry-send-failed',
      message: `制作本数ヒアリング（${month}）の送信に失敗があります: ${detail}`,
      apiPath: trigger === 'manual' ? 'POST /api/haruka/admin/billing-inquiry/send' : 'worker:billing-count-inquiry-scheduler',
    });
  }
  console.log(`[billing-inquiry] 送信結果 (${trigger}, ${month}): ${results.map(r => `${r.label}=${r.ok ? 'OK' : r.reason}`).join(', ')}`);
  return { month, results };
}

async function tick() {
  if (isRunning) return;
  isRunning = true;
  try {
    const { date, hour } = jstNowParts();
    const settings = await loadSettings();
    const decision = decideBillingInquiryAction({
      jstDate: date,
      jstHour: hour,
      lastSentMonth: settings[SETTING_KEYS.lastSent] || null,
    });
    if (decision.action === 'bootstrap') {
      await upsertSetting(SETTING_KEYS.lastSent, decision.markMonth);
      console.log(`[billing-inquiry] 初回ブートストラップ: ${decision.markMonth} まで消化済みとしてマーク（自動送信は次の月末から）`);
    } else if (decision.action === 'send') {
      await sendBillingInquiry({ month: decision.month, trigger: 'auto' });
    }
  } catch (e) {
    console.error('[billing-inquiry] tick 失敗:', e.message);
  } finally {
    isRunning = false;
  }
}

function startBillingInquiryScheduler() {
  if (intervalHandle) return;
  console.log(`[billing-inquiry] 起動（${TICK_MS}ms 周期・毎月末日 ${SEND_HOUR_JST}時 JST 送信）`);
  tick().catch(e => console.error('[billing-inquiry] 初回tick失敗:', e.message));
  intervalHandle = setInterval(() => {
    tick().catch(e => console.error('[billing-inquiry] tick失敗:', e.message));
  }, TICK_MS);
  if (intervalHandle && typeof intervalHandle.unref === 'function') intervalHandle.unref();
}

function stopBillingInquiryScheduler() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    console.log('[billing-inquiry] 停止しました');
  }
}

module.exports = {
  startBillingInquiryScheduler,
  stopBillingInquiryScheduler,
  sendBillingInquiry,
  // テスト・routes 用
  decideBillingInquiryAction,
  jstNowParts,
  SETTING_KEYS,
};
