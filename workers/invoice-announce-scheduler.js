// workers/invoice-announce-scheduler.js
// =============================================================
// 請求書案内の自動送信ワーカ（毎月20日 10:00 JST 以降）
//
// 役割:
//   10分ごとに JST の現在日時を確認し、毎月20日 10時以降に
//   「請求書送付についてのご案内」を Chatwork 全体チャットと
//   Slack 全体チャンネルへ 1回だけ 自動送信する。
//
// 二重送信ガード:
//   system_settings 'invoice_announce_last_sent'（'YYYY-MM'）で月単位管理。
//   送信済みの月はスキップ。20日に送れなかった場合（デプロイ・障害等）は
//   22日まで翌 tick でリカバリ送信する（旧運用も「20日ごろ」だったため）。
//
// 初回起動ブートストラップ:
//   'invoice_announce_last_sent' キーが無い初回デプロイ時は、過去分を
//   さかのぼって突然全体送信しないよう「消化済み」マークだけ行う
//   （20日以降なら当月、20日前なら前月を消化済みに）。初月に手動で
//   送りたい場合はシステム設定ページの手動送信ボタンを使う。
//
// 送信先（system_settings で上書き可能）:
//   invoice_announce_chatwork_room_id  … 既定 365971239（【HF】全体チャット）
//   invoice_announce_slack_channel_url … 既定 全体チャンネル URL
// =============================================================

const supabase = require('../supabase');
const { sendChatworkRoom, sendSlackChannel, notifyAutoError } = require('../notifications');
const { buildInvoiceAnnounceTexts, parseHfClients, SUBMIT_DAY_END } = require('../utils/invoice-announce');

const TICK_MS = 10 * 60_000; // 10分
const SEND_HOUR_JST = 10;    // 10時以降に送信
const SEND_DAY = 20;         // 毎月20日
const RECOVERY_LAST_DAY = 22; // 20日に送れなかった場合のリカバリ期限

const SETTING_KEYS = {
  lastSent: 'invoice_announce_last_sent',
  chatworkRoomId: 'invoice_announce_chatwork_room_id',
  slackChannelUrl: 'invoice_announce_slack_channel_url',
  hfClients: 'invoice_announce_hf_clients',
};

const DEFAULT_CHATWORK_ROOM_ID = '365971239'; // 【HF】全体チャット
const DEFAULT_SLACK_CHANNEL_URL = 'https://app.slack.com/client/T094ST9L5MH/C094ST9QT5H'; // Slack 全体チャンネル

let intervalHandle = null;
let isRunning = false;

// 'YYYY-MM' の前月を返す
function prevMonth(monthStr) {
  const [y, m] = monthStr.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1)); // m-1 が当月 index なので -2 で前月
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

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
function decideInvoiceAnnounceAction({ jstDate, jstHour, lastSentMonth }) {
  const month = jstDate.slice(0, 7);
  const day = Number(jstDate.slice(8, 10));
  if (!lastSentMonth) {
    // 初回起動: 過去分を勝手に送らない（当月/前月を消化済みマークして次の20日から開始）
    return { action: 'bootstrap', markMonth: day >= SEND_DAY ? month : prevMonth(month) };
  }
  if (day >= SEND_DAY && day <= RECOVERY_LAST_DAY && jstHour >= SEND_HOUR_JST && lastSentMonth < month) {
    return { action: 'send', month };
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
 * 案内を Chatwork + Slack に送信する（手動送信 API からも呼ばれる）。
 * どちらか一方でも成功したら last_sent を更新（もう一方の失敗はエラーチャンネルへ通知）。
 * @param {{ month: string, trigger: 'auto'|'manual' }} p
 */
async function sendInvoiceAnnounce({ month, trigger = 'auto' }) {
  const settings = await loadSettings();
  const hfClients = parseHfClients(settings[SETTING_KEYS.hfClients]);
  const texts = buildInvoiceAnnounceTexts(month, { hfClients: hfClients || undefined });
  const roomId = settings[SETTING_KEYS.chatworkRoomId] || DEFAULT_CHATWORK_ROOM_ID;
  const slackUrl = settings[SETTING_KEYS.slackChannelUrl] || DEFAULT_SLACK_CHANNEL_URL;

  const chatwork = await sendChatworkRoom(roomId, texts.chatwork);
  const slack = await sendSlackChannel(slackUrl, texts.slack);

  // ダッシュボードの全体連絡（お知らせ）カードにも同内容を掲載。
  // 掲載期限 = 提出期間最終日（28日）の 23:59:59 JST。
  // ※POST /announcements 経由だと broadcast Slack へ二重投稿されるため直接 INSERT する。
  let announcement = { ok: false, reason: 'skipped' };
  try {
    const [y, m] = month.split('-').map(Number);
    const deadlineIso = new Date(Date.UTC(y, m - 1, SUBMIT_DAY_END, 23, 59, 59) - 9 * 3600 * 1000).toISOString();
    const { data: admin } = await supabase.from('users')
      .select('id').eq('role', 'admin').eq('is_active', true).limit(1).maybeSingle();
    const { error: annErr } = await supabase.from('announcements').insert({
      title: `🧾 請求書送付についてのご案内（${m}月・提出 ${texts.submitPeriodLabel}）`,
      body: texts.plain,
      posted_by: admin?.id || null,
      deadline_at: deadlineIso,
      is_active: true,
    });
    announcement = annErr ? { ok: false, reason: annErr.message } : { ok: true };
    if (annErr) console.warn('[invoice-announce] お知らせ掲載失敗:', annErr.message);
  } catch (e) {
    announcement = { ok: false, reason: e.message };
    console.warn('[invoice-announce] お知らせ掲載失敗:', e.message);
  }

  if (chatwork.ok || slack.ok || announcement.ok) {
    await upsertSetting(SETTING_KEYS.lastSent, month);
  }
  if (!chatwork.ok || !slack.ok) {
    const detail = `chatwork(room=${roomId})=${chatwork.ok ? 'OK' : chatwork.reason} / slack=${slack.ok ? 'OK' : slack.reason}`;
    console.warn(`[invoice-announce] 送信一部失敗 (${trigger}): ${detail}`);
    await notifyAutoError({
      source: 'server',
      kind: 'invoice-announce-send-failed',
      message: `請求書案内（${month}）の送信に失敗があります: ${detail}`,
      apiPath: trigger === 'manual' ? 'POST /api/haruka/admin/invoice-announce/send' : 'worker:invoice-announce-scheduler',
    });
  }
  console.log(`[invoice-announce] 送信結果 (${trigger}, ${month}): chatwork=${chatwork.ok ? 'OK' : chatwork.reason}, slack=${slack.ok ? 'OK' : slack.reason}, announcement=${announcement.ok ? 'OK' : announcement.reason}`);
  return { month, chatwork, slack, announcement, roomId, slackUrl };
}

async function tick() {
  if (isRunning) return;
  isRunning = true;
  try {
    const { date, hour } = jstNowParts();
    const settings = await loadSettings();
    const decision = decideInvoiceAnnounceAction({
      jstDate: date,
      jstHour: hour,
      lastSentMonth: settings[SETTING_KEYS.lastSent] || null,
    });
    if (decision.action === 'bootstrap') {
      await upsertSetting(SETTING_KEYS.lastSent, decision.markMonth);
      console.log(`[invoice-announce] 初回ブートストラップ: ${decision.markMonth} まで消化済みとしてマーク（自動送信は次の20日から）`);
    } else if (decision.action === 'send') {
      await sendInvoiceAnnounce({ month: decision.month, trigger: 'auto' });
    }
  } catch (e) {
    console.error('[invoice-announce] tick 失敗:', e.message);
  } finally {
    isRunning = false;
  }
}

function startInvoiceAnnounceScheduler() {
  if (intervalHandle) return;
  console.log(`[invoice-announce] 起動（${TICK_MS}ms 周期・毎月${SEND_DAY}日 ${SEND_HOUR_JST}時 JST 送信）`);
  tick().catch(e => console.error('[invoice-announce] 初回tick失敗:', e.message));
  intervalHandle = setInterval(() => {
    tick().catch(e => console.error('[invoice-announce] tick失敗:', e.message));
  }, TICK_MS);
  if (intervalHandle && typeof intervalHandle.unref === 'function') intervalHandle.unref();
}

function stopInvoiceAnnounceScheduler() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    console.log('[invoice-announce] 停止しました');
  }
}

module.exports = {
  startInvoiceAnnounceScheduler,
  stopInvoiceAnnounceScheduler,
  sendInvoiceAnnounce,
  // テスト・routes 用
  decideInvoiceAnnounceAction,
  jstNowParts,
  prevMonth,
  SETTING_KEYS,
  DEFAULT_CHATWORK_ROOM_ID,
  DEFAULT_SLACK_CHANNEL_URL,
};
