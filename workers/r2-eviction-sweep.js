// workers/r2-eviction-sweep.js
// =============================================================
// R2 再生キャッシュ 排出 sweep ワーカ
//
// 役割:
//   一定間隔で「納品済み(creatives.status='納品')なのに R2 に複製が残っている
//   (creative_files.r2_status='active')」ファイルを走査し、R2 オブジェクトを
//   削除して r2_status='evicted' にする。Drive 上の原本は残るためバックアップ済み。
//
//   R2 はレビュー中の動画だけを置くホットキャッシュ。納品時に即時 evict する
//   フック (routes/haruka.js) があるが、status 変更経路が複数あるため、その
//   取りこぼしをこの sweep が拾う保険。これにより R2 容量が累積しない。
//
// 起動:
//   server.js の起動時に startR2EvictionSweep() を1回だけ呼ぶ。
//   R2 未設定なら lib/r2.sweepDeliveredR2() 側で skip されるので無害。
// =============================================================

const r2 = require('../lib/r2');

const TICK_MS = 6 * 60 * 60 * 1000; // 6時間ごと

let intervalHandle = null;
let isRunning = false;

async function runSweep() {
  if (isRunning) return;
  isRunning = true;
  try {
    if (!r2.isEnabled()) return; // R2 未設定なら何もしない
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
  // 起動直後にも1回流す
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
