// workers/r2-eviction-sweep.js
// =============================================================
// R2 再生キャッシュ 排出 sweep ワーカ
//
// 役割:
//   6時間ごとに「納品済み(creatives.status='納品')なのに R2 に複製が残っている
//   (creative_files.r2_status='active')」ファイルを走査し、R2 オブジェクトを
//   削除して r2_status='evicted' にする。Drive 上の原本は残るためバックアップ済み。
//
//   R2 はレビュー中の動画だけを置くホットキャッシュ（10GB 無料枠厳守の
//   「消しながら運用」）。納品時に即時 evict するフック (routes/haruka.js) が
//   あるが、status 変更経路が複数あるため、その取りこぼしをこの sweep が拾う保険。
//   これにより R2 容量が累積せず、予算ガード（lib/r2.js ensureBudgetFor）の
//   前提となる空き容量を維持する。
//
// 起動:
//   server.js の起動時に startR2EvictionSweep() を1回だけ呼ぶ。
//   R2_PLAYBACK_ENABLED=true でない場合は lib/r2.sweepDeliveredR2() 側で
//   skip されるので、フラグ未設定の環境では完全に no-op（無害）。
// =============================================================

const r2 = require('../lib/r2');

const TICK_MS = 6 * 60 * 60 * 1000; // 6時間ごと

let intervalHandle = null;
let isRunning = false;

async function runSweep() {
  if (isRunning) return;
  isRunning = true;
  try {
    if (!r2.isEnabled()) return; // フラグOFF or R2未設定なら何もしない
    const result = await r2.sweepDeliveredR2({ limit: 1000 });
    if (result?.evicted > 0) {
      console.log(`[r2-sweep] 納品済み複製を排出: ${result.evicted}件 (scanned ${result.scanned})`);
    }
  } catch (e) {
    console.error('[r2-sweep] 例外:', e.message);
  } finally {
    isRunning = false;
  }
}

function startR2EvictionSweep() {
  if (intervalHandle) return;
  console.log(`[r2-sweep] 起動（${TICK_MS}ms 周期）`);
  // 起動直後にも1回流す（デプロイ間の取りこぼしを回収）
  runSweep().catch(e => console.error('[r2-sweep] 初回tick失敗:', e.message));
  intervalHandle = setInterval(() => {
    runSweep().catch(e => console.error('[r2-sweep] tick失敗:', e.message));
  }, TICK_MS);
  if (intervalHandle && typeof intervalHandle.unref === 'function') {
    intervalHandle.unref();
  }
}

function stopR2EvictionSweep() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

module.exports = { startR2EvictionSweep, stopR2EvictionSweep, runSweep };
