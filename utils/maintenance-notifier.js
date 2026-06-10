// Supabase サーキットブレーカーの状態遷移を購読し、
//  - open に入った瞬間に Slack で「障害発生」通知
//  - closed に戻った瞬間に Slack で「復旧」通知（ダウンタイム秒数つき）
// を1回ずつ送る。連続失敗中の再送はしない（スパム防止）。
//
// require するだけで listener が登録されるので、server.js の起動時に
// require('./utils/maintenance-notifier') を1行入れれば常駐する。

const supabaseFetch = require('./supabase-fetch');
const { sendSlackChannel, sendSlackWebhook } = require('../notifications');

const WEBHOOK_URL = process.env.MAINTENANCE_SLACK_WEBHOOK_URL || '';
const CHANNEL_URL =
  process.env.MAINTENANCE_SLACK_CHANNEL_URL ||
  process.env.ERROR_REPORT_SLACK_CHANNEL_URL ||
  '';

let openedAt = null;
let lastNotifiedStatus = 'closed';

function fmtDuration(ms) {
  if (!ms || ms < 0) return '不明';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}秒`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return rs ? `${m}分${rs}秒` : `${m}分`;
}

// Webhook 優先・DB 非依存の Slack 送信。db/migrate.js（schema-sync 失敗通知）からも再利用される。
async function postSafely(text) {
  // DB 非依存ルート（Incoming Webhook）を最優先。
  // CB open＝DB 障害中でも届くのが本来の目的。
  if (WEBHOOK_URL) {
    const r = await sendSlackWebhook(WEBHOOK_URL, text);
    if (r?.ok) return;
    console.warn('[maintenance] Webhook 送信失敗、bot_token ルートにフォールバック:', r?.reason);
  }
  if (!CHANNEL_URL) {
    if (!WEBHOOK_URL) console.warn('[maintenance] Slack 通知先未設定（MAINTENANCE_SLACK_WEBHOOK_URL or MAINTENANCE_SLACK_CHANNEL_URL）');
    return;
  }
  try {
    const r = await sendSlackChannel(CHANNEL_URL, text);
    if (!r?.ok) console.warn('[maintenance] Slack 送信失敗:', r?.reason);
  } catch (e) {
    console.warn('[maintenance] Slack 送信例外:', e && e.message);
  }
}

supabaseFetch.onStateChange(({ prev, next, reason }) => {
  if (next === 'open' && lastNotifiedStatus !== 'open') {
    openedAt = Date.now();
    lastNotifiedStatus = 'open';
    const text = [
      '🚨 *HARUKA: Supabase 接続不安定*',
      `理由: ${reason || 'unknown'}`,
      '工事中モードに切り替えました。利用者にはメンテナンス画面が表示されます。',
      'Supabase ダッシュボード → Project Settings → General → Restart project で復旧してください。',
    ].join('\n');
    postSafely(text);
    return;
  }
  if (next === 'closed' && lastNotifiedStatus === 'open') {
    const downtime = openedAt ? Date.now() - openedAt : 0;
    lastNotifiedStatus = 'closed';
    openedAt = null;
    const text = [
      '✅ *HARUKA: Supabase 接続が復旧*',
      `ダウンタイム: ${fmtDuration(downtime)}`,
      '工事中モードを解除しました。',
    ].join('\n');
    postSafely(text);
  }
});

module.exports = {
  isMaintenance: () => supabaseFetch.getStatus() === 'open',
  // schema-sync 失敗通知などから再利用する管理者向け Slack 送信（Webhook 優先 / DB 非依存）
  postMaintenanceAlert: postSafely,
};
