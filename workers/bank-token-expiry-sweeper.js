// workers/bank-token-expiry-sweeper.js
// =============================================================
// 銀行 API トークンの期限切れ削除ワーカ（ADR 054 追補・1 時間ごと）
//
// 有効期限を過ぎたアクセストークン／リフレッシュトークンの暗号文を bank_api_connections から消す。
// 判定と削除の中身は utils/aozora-token-expiry.js#purgeExpiredTokens（接続取得時の削除と同じ関数）。
//   - アクセストークンだけ切れた → アクセストークンだけ消す（接続は維持・次の利用時に refresh）
//   - 両方切れた → 両方消して revoked_at を立てる（画面は「未接続」に戻り、再接続できる）
//   - 削除ごとに bank_api_audit_logs へ記録
//
// 起動条件: server.js で ENABLE_AOZORA_TRANSFER=true のときだけ start する（bank-transfer-poller と同じ流儀）。
// 深夜帯も止めない（DB だけの処理で銀行 API は呼ばない）。
// =============================================================

const aozora = require('../utils/aozora-api');
const tokenExpiry = require('../utils/aozora-token-expiry');

const TICK_MS = 60 * 60_000; // 1 時間
const FIRST_RUN_DELAY_MS = 60 * 1000;

let intervalHandle = null;
let firstHandle = null;
let isRunning = false;

async function tick({ now = Date.now() } = {}) {
  if (isRunning) return null;
  isRunning = true;
  try {
    if (!aozora.isEnabled()) return null;
    const r = await tokenExpiry.purgeExpiredTokens({ now, source: 'sweeper' });
    if (r.purged) console.log(`[bank-token-expiry-sweeper] ${r.checked} 件確認・${r.purged} 件削除（うち ${r.revoked} 件は未接続に戻した）`);
    return r;
  } catch (e) {
    console.error('[bank-token-expiry-sweeper] tick 失敗:', e.message);
    return null;
  } finally {
    isRunning = false;
  }
}

function startBankTokenExpirySweeper() {
  if (intervalHandle) return;
  if (!aozora.isEnabled()) {
    console.log('[bank-token-expiry-sweeper] ENABLE_AOZORA_TRANSFER が true ではないため起動しません');
    return;
  }
  console.log(`[bank-token-expiry-sweeper] 起動（${TICK_MS / 60000} 分ごと・リフレッシュトークン有効期間 ${tokenExpiry.refreshTokenTtlMs() / 86_400_000} 日）`);
  firstHandle = setTimeout(() => { firstHandle = null; tick(); }, FIRST_RUN_DELAY_MS);
  if (typeof firstHandle.unref === 'function') firstHandle.unref();
  intervalHandle = setInterval(() => { tick(); }, TICK_MS);
  if (typeof intervalHandle.unref === 'function') intervalHandle.unref();
}

function stopBankTokenExpirySweeper() {
  if (firstHandle) { clearTimeout(firstHandle); firstHandle = null; }
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    console.log('[bank-token-expiry-sweeper] 停止しました');
  }
}

module.exports = {
  startBankTokenExpirySweeper,
  stopBankTokenExpirySweeper,
  tick,
  TICK_MS,
};
