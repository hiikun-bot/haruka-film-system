// workers/bank-transfer-poller.js
// =============================================================
// 総合振込の状態ポーリングワーカ（ADR 054 Stage B・10 分ごと）
//
// 役割:
//   awaiting_approval / approved / processing / requested の payout_transfer_batches を
//   銀行に照会（総合振込依頼結果照会 → 1:完了なら総合振込状況照会）して反映する。
//   反映の中身は utils/bank-transfer.js#pollBatch（画面の「最新の状態を取得」と同じ処理）:
//     - 明細ごとに completed / returned / failed
//     - 全件完了で batch を completed にし、各 payout_records を paid（paid_via='aozora_api'）にして
//       既存の buildPayoutMessage の文面で本人へ通知
//     - 8:期限切 → expired にして管理者マイチャットへ
//
// 起動条件: server.js で ENABLE_AOZORA_TRANSFER=true のときだけ start する。
// 接続が無い（切断中）ときは何もしない。銀行 API の失敗は batch の last_error に残して次の tick で再試行。
// JST: 深夜帯（JST 0〜6 時）は銀行側のメンテナンスが多く、状態も動かないため照会しない。
// =============================================================

const supabase = require('../supabase');
const aozora = require('../utils/aozora-api');
const bt = require('../utils/bank-transfer');

const TICK_MS = 10 * 60_000; // 10 分
const ACTIVE_STATUSES = ['requesting', 'requested', 'awaiting_approval', 'approved', 'processing'];
const QUIET_HOURS_JST = { from: 0, to: 6 }; // この時間帯は照会しない

let intervalHandle = null;
let isRunning = false;

function jstHour(now = new Date()) {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tokyo', hour: '2-digit', hourCycle: 'h23' }).format(now));
}

/** この tick で照会してよいか（純関数・テスト用） */
function shouldPoll({ hour }) {
  return !(hour >= QUIET_HOURS_JST.from && hour < QUIET_HOURS_JST.to);
}

/**
 * requesting（応答待ち）の batch を自動で再送してよいか（純関数・テスト用）。
 * 最後の送信（request_summary.last_attempt_at・無ければ requested_at）から 15 分以上たっていること。
 */
function shouldRetryRequesting(batch, now = Date.now()) {
  if (!batch || batch.status !== 'requesting') return false;
  const last = batch.request_summary?.last_attempt_at || batch.requested_at || batch.created_at;
  const t = last ? new Date(last).getTime() : 0;
  if (!t) return true;
  return now - t >= bt.REQUESTING_RETRY_AFTER_MS;
}

async function loadActiveBatches() {
  const { data, error } = await supabase
    .from('payout_transfer_batches')
    .select(bt.BATCH_COLUMNS)
    .in('status', ACTIVE_STATUSES)
    .order('requested_at', { ascending: true })
    .limit(50);
  if (error) throw new Error(`payout_transfer_batches 取得失敗: ${error.message}`);
  return data || [];
}

// ---------- 未接続で照会できないとき（トークン期限切れの自動解除など） ----------
const DISCONNECTED_LAST_ERROR = '銀行 API が未接続のため状態を照会できません（トークン期限切れ等）。振込管理から再接続してください';
const DISCONNECTED_NOTICE_KEY = 'bank_disconnected_notice_last_date'; // 'YYYY-MM-DD'（JST）＝最後に知らせた日

/** 今日（JST）まだ知らせていなければ true（純関数・テスト用。1 日 1 回の再送ガード） */
function shouldNotifyDisconnected(lastDate, today) {
  return !lastDate || String(lastDate) < String(today);
}

function buildDisconnectedNotice(batches) {
  const lines = batches.slice(0, 10).map(b => `・${b.year}年${b.month}月分 ${b.total_count ?? '-'}件（${b.status}）`);
  if (batches.length > 10) lines.push(`ほか ${batches.length - 10} 件`);
  return `[info][title]🏦 銀行API未接続のため振込依頼の状態を確認できません[/title]進行中の振込依頼が ${batches.length} 件ありますが、銀行 API の接続が切れています（トークン期限切れ等）。\n振込管理から再接続してください。\n${lines.join('\n')}[/info]`;
}

// プロセス内の控え（system_settings への記録に失敗しても同じ日に再送しない）
let _lastDisconnectedNoticeDate = null;

async function handleDisconnected(batches, { now = new Date() } = {}) {
  // 1) 進行中の依頼に理由を残す（画面の依頼履歴に出る）。既存の last_error（再送失敗など）は上書きしない
  const ids = batches.filter(b => !b.last_error).map(b => b.id);
  if (ids.length) {
    const { error } = await supabase.from('payout_transfer_batches')
      .update({ last_error: DISCONNECTED_LAST_ERROR, updated_at: now.toISOString() })
      .in('id', ids)
      .is('last_error', null);
    if (error) console.warn('[bank-transfer-poller] last_error の記録に失敗:', error.message);
  }
  // 2) 管理者マイチャットへ 1 日 1 回まで（判定できないときは送らない）
  try {
    const today = bt.todayJst(now);
    if (_lastDisconnectedNoticeDate && !shouldNotifyDisconnected(_lastDisconnectedNoticeDate, today)) return;
    const { data, error: selErr } = await supabase.from('system_settings').select('value').eq('key', DISCONNECTED_NOTICE_KEY).maybeSingle();
    if (selErr) { console.warn('[bank-transfer-poller] 未接続通知日の読み出しに失敗（今回は送らない）:', selErr.message); return; }
    if (!shouldNotifyDisconnected(data?.value, today)) { _lastDisconnectedNoticeDate = data.value; return; }
    const r = await bt.sendAdminMyChat(buildDisconnectedNotice(batches));
    if (r && r.ok === false) return; // 送れなかったら記録せず次の tick でもう一度
    _lastDisconnectedNoticeDate = today;
    const { error } = await supabase.from('system_settings').upsert(
      { key: DISCONNECTED_NOTICE_KEY, value: today, updated_at: now.toISOString() },
      { onConflict: 'key' },
    );
    if (error) console.warn('[bank-transfer-poller] 未接続通知日の記録に失敗（このプロセスでは今日はもう送らない）:', error.message);
  } catch (e) {
    console.warn('[bank-transfer-poller] 未接続の通知に失敗:', e.message);
  }
}

async function tick() {
  if (isRunning) return;
  isRunning = true;
  try {
    if (!aozora.isEnabled()) return;
    if (!shouldPoll({ hour: jstHour() })) return;
    const batches = await loadActiveBatches();
    if (!batches.length) return;
    const conn = await aozora.loadActiveConnection();
    if (!conn) {
      console.warn(`[bank-transfer-poller] 照会対象 ${batches.length} 件ありますが銀行 API が未接続のためスキップ`);
      await handleDisconnected(batches);
      return;
    }
    let changed = 0;
    for (const batch of batches) {
      try {
        if (batch.status === 'requesting') {
          // 応答待ち（§3-2-3）: 15 分以上続いていれば「照会 → 無ければ同じ idempotency_key で 1 回だけ再送」。
          // それでも確認できなければ retryRequestingBatch が failed にして管理者マイチャットへ知らせる
          if (!shouldRetryRequesting(batch, Date.now())) continue;
          const r = await bt.retryRequestingBatch(batch, conn, { auto: true });
          if (r.outcome !== 'pending') changed++;
          continue;
        }
        const r = await bt.pollBatch(batch, conn);
        if (r.changed) changed++;
      } catch (e) {
        // pollBatch / retryRequestingBatch 内で last_error と監査ログは残している。次の tick で再試行
        console.warn(`[bank-transfer-poller] batch=${batch.id} 照会失敗: ${e.message}`);
      }
    }
    if (changed) console.log(`[bank-transfer-poller] ${batches.length} 件照会・${changed} 件更新`);
  } catch (e) {
    console.error('[bank-transfer-poller] tick 失敗:', e.message);
  } finally {
    isRunning = false;
  }
}

function startBankTransferPoller() {
  if (intervalHandle) return;
  if (!aozora.isEnabled()) {
    console.log('[bank-transfer-poller] ENABLE_AOZORA_TRANSFER が true ではないため起動しません');
    return;
  }
  console.log(`[bank-transfer-poller] 起動（${TICK_MS / 60000} 分ごと・env=${aozora.getConfig().environment}）`);
  // 起動直後に 1 回（デプロイ中に動いた状態を拾う）。30 秒遅らせて他の起動処理と重ねない
  const first = setTimeout(() => { tick().catch(e => console.error('[bank-transfer-poller] 初回 tick 失敗:', e.message)); }, 30 * 1000);
  if (typeof first.unref === 'function') first.unref();
  intervalHandle = setInterval(() => {
    tick().catch(e => console.error('[bank-transfer-poller] tick 失敗:', e.message));
  }, TICK_MS);
  if (typeof intervalHandle.unref === 'function') intervalHandle.unref();
}

function stopBankTransferPoller() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    console.log('[bank-transfer-poller] 停止しました');
  }
}

module.exports = {
  startBankTransferPoller,
  stopBankTransferPoller,
  tick,
  shouldPoll,
  shouldRetryRequesting,
  shouldNotifyDisconnected,
  buildDisconnectedNotice,
  handleDisconnected,
  _resetDisconnectedNoticeForTest: () => { _lastDisconnectedNoticeDate = null; },
  DISCONNECTED_LAST_ERROR,
  ACTIVE_STATUSES,
  TICK_MS,
};
