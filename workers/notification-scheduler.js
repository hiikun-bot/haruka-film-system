// workers/notification-scheduler.js
// =============================================================
// 通知 Phase 1: 予約配信ワーカ
//
// 役割:
//   1分ごとに notification_logs を走査し、
//     delivered_at IS NULL AND cancelled_at IS NULL AND scheduled_send_at <= NOW()
//   の行を「配信済み」として delivered_at = NOW() にマークする。
//
// 受信者へのリアルタイム反映は Supabase Realtime（notification_logs テーブル）を
// 既にフロント側 (public/js/notification-realtime.js) が購読しているため、
// UPDATE が走った瞬間にフロントは検知して新着通知扱いで描画してくれる想定。
//
// 多重起動防止:
//   Railway 単一プロセス前提なので setInterval で十分。server.js の起動時に
//   startNotificationScheduler() を1回だけ呼ぶ。
//
// 制約:
//   ・配信ワーカが落ちていた間に予定時刻が過ぎた行も、復帰後の次の tick で拾われる
//   ・実際の Slack/Chatwork 即時送信トリガはここでは未実装（既存の即時送信は
//     createNotification 内で行うが、現状 Slack push は別パス）。必要に応じてここに追加する。
// =============================================================

const supabase = require('../supabase');

const TICK_MS = 60_000; // 1分

let intervalHandle = null;
let isRunning = false; // tick 多重実行防止（処理が重なってもズラせるよう）

async function deliverDueNotifications() {
  if (isRunning) return;
  isRunning = true;
  try {
    const nowIso = new Date().toISOString();

    // 部分インデックス idx_notification_logs_pending_delivery により高速に拾える
    const { data, error } = await supabase
      .from('notification_logs')
      .update({ delivered_at: nowIso })
      .is('delivered_at', null)
      .is('cancelled_at', null)
      .lte('scheduled_send_at', nowIso)
      .select('id, user_id, notification_type, sender_id');

    if (error) {
      console.error('[notification-scheduler] 配信UPDATE失敗:', error.message);
      return;
    }

    const delivered = data || [];
    if (delivered.length > 0) {
      console.log(`[notification-scheduler] 配信完了: ${delivered.length} 件`);
      // ここで Slack/Chatwork など外部チャネルへの push が必要であれば追加する。
      // 既存の即時送信パスでは外部 push は別系統で動いており、現状フロントの
      // Realtime 購読 (notification_logs UPDATE) が新着検知を担っている。
    }
  } catch (e) {
    console.error('[notification-scheduler] 例外:', e.message);
  } finally {
    isRunning = false;
  }
}

/**
 * ワーカを起動する。server.js から1回だけ呼ぶ想定。
 * 既に起動済みなら何もしない。
 */
function startNotificationScheduler() {
  if (intervalHandle) return;
  console.log(`[notification-scheduler] 起動（${TICK_MS}ms 周期）`);
  // 起動直後にも1回流す（積み残しの即時消化）
  deliverDueNotifications().catch(e => console.error('[notification-scheduler] 初回tick失敗:', e.message));
  intervalHandle = setInterval(() => {
    deliverDueNotifications().catch(e => console.error('[notification-scheduler] tick失敗:', e.message));
  }, TICK_MS);
  // Node.js プロセス終了時のクリーンアップ
  if (intervalHandle && typeof intervalHandle.unref === 'function') {
    // unref しない: ワーカが原因で待たせたい/プロセスを止めたくない訳ではないが、
    // 通常の終了時に setInterval が残ってブロックしないよう unref する。
    intervalHandle.unref();
  }
}

function stopNotificationScheduler() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

module.exports = { startNotificationScheduler, stopNotificationScheduler, deliverDueNotifications };
