// utils/pricing-pending-reminder.js
// 単価の承認待ち（ADR 037）が残っている間、管理者の Chatwork マイチャットへ平日朝にまとめて 1 通送る
// リマインド本文の純関数（jest テスト対象）。送信は workers/pricing-pending-reminder.js。

const MAX_ITEMS_IN_MESSAGE = 10;

/** ISO 日時 → JST 'YYYY-MM-DD'（不正は null） */
function isoToJstYmd(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
}

/** 申請日（JST）から今日までの日数。当日は 0、不明は null */
function daysWaiting(requestedAt, todayYmd) {
  const ymd = isoToJstYmd(requestedAt);
  if (!ymd || !todayYmd) return null;
  const toMs = s => Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)), 12);
  return Math.max(0, Math.round((toMs(todayYmd) - toMs(ymd)) / 86400000));
}

/**
 * 承認待ち line を案件ごとにまとめる（申請が古い案件ほど上）。
 * @param {Array<{project_id, client_name, project_name, requester_label, requested_at}>} items
 */
function groupByProject(items) {
  const map = new Map();
  for (const it of Array.isArray(items) ? items : []) {
    if (!it) continue;
    const key = it.project_id || '(none)';
    let g = map.get(key);
    if (!g) {
      g = { project_id: it.project_id || null, client_name: it.client_name || '', project_name: it.project_name || '', count: 0, oldest_at: null, requesters: new Set() };
      map.set(key, g);
    }
    g.count++;
    if (it.requester_label) g.requesters.add(it.requester_label);
    if (it.requested_at && (!g.oldest_at || it.requested_at < g.oldest_at)) g.oldest_at = it.requested_at;
  }
  return [...map.values()].sort((a, b) => String(a.oldest_at || '9').localeCompare(String(b.oldest_at || '9')));
}

/**
 * Chatwork 本文。
 * @param {{ items: Array, todayYmd: string, pageUrl: string|null }} p
 */
function buildPricingPendingReminderText({ items, todayYmd, pageUrl }) {
  const groups = groupByProject(items);
  const total = groups.reduce((s, g) => s + g.count, 0);
  const lines = [];
  lines.push(`承認待ちの単価が ${total}件（${groups.length}案件）残っています。承認されるまで、その案件の請求書は発行できません。`);
  lines.push('');
  for (const g of groups.slice(0, MAX_ITEMS_IN_MESSAGE)) {
    const days = daysWaiting(g.oldest_at, todayYmd);
    const wait = days == null ? '' : (days === 0 ? '（今日）' : `（${days}日待ち）`);
    const who = g.requesters.size ? ` ／ ${[...g.requesters].join('・')}さん` : '';
    lines.push(`・${[g.client_name, g.project_name].filter(Boolean).join(' / ') || '(案件不明)'}：${g.count}グループ${wait}${who}`);
  }
  if (groups.length > MAX_ITEMS_IN_MESSAGE) lines.push(`…ほか ${groups.length - MAX_ITEMS_IN_MESSAGE}案件`);
  if (pageUrl) { lines.push(''); lines.push(`まとめて承認する: ${pageUrl}`); }
  return `[info][title]💴 単価の承認待ちが残っています（${total}件）[/title]${lines.join('\n')}[/info]`;
}

module.exports = { isoToJstYmd, daysWaiting, groupByProject, buildPricingPendingReminderText, MAX_ITEMS_IN_MESSAGE };
