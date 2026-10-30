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
const ACTIVE_STATUSES = ['requested', 'awaiting_approval', 'approved', 'processing'];
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
      return;
    }
    let changed = 0;
    for (const batch of batches) {
      try {
        const r = await bt.pollBatch(batch, conn);
        if (r.changed) changed++;
      } catch (e) {
        // pollBatch 内で last_error と監査ログは残している。次の tick で再試行
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
  ACTIVE_STATUSES,
  TICK_MS,
};
