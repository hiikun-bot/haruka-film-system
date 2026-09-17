// utils/showcase.js
// =====================================================
// 🎬 新着納品ショーケース（ホームのスライドショー）の純関数。
// 設計: docs/design/decisions/042-portfolio-reactions.md（追補 2026-09-17）
//
//   - 「直近 N 日」の起点（JST の日付境界）を UTC ISO で返す
//   - 納品日時 → JST の日付文字列
//   - 同一案件 × 同一納品日（JST）で 4 本以上ならまとめスライド（bundle）にする
//   - まとめてナイス！の通知文面
//
// DB 非依存・ローカル TZ 非依存（Date.UTC と +9h の加減算だけで扱う。`TZ=UTC` / `Asia/Tokyo` の
// 両方で jest を通す）。routes/haruka.js から使う。tests/utils/showcase.test.js でテスト。
// =====================================================

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

// 既定の対象期間（日）と上限。上限は「ホームで流す新着」の範囲を超えない程度
const SHOWCASE_DEFAULT_DAYS = 7;
const SHOWCASE_MAX_DAYS = 30;
// 同一案件 × 同一納品日でこの本数以上なら 1 スライドにまとめる
const SHOWCASE_MIN_BUNDLE = 4;
// まとめてナイス！で一度に受け付ける作品数の上限
const SHOWCASE_BULK_MAX = 50;

/**
 * timestamptz（ISO 文字列 / Date）→ JST の 'YYYY-MM-DD'。読めなければ null。
 */
function jstDateStr(value) {
  if (!value) return null;
  const t = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(t)) return null;
  return new Date(t + JST_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * 「直近 days 日」の起点。JST で (今日 − days + 1) の 0:00 を UTC の ISO で返す。
 *   days=7・今日が 9/17(JST) → 9/11 00:00 JST = 2026-09-10T15:00:00.000Z
 * 範囲外の days は 1〜SHOWCASE_MAX_DAYS に丸める。
 */
function showcaseSinceIso(days, now = new Date()) {
  const d = clampShowcaseDays(days);
  const todayJst = jstDateStr(now);                       // 'YYYY-MM-DD'
  const startUtc = Date.parse(`${todayJst}T00:00:00Z`);   // JST 0:00 を UTC 表記で仮置き
  return new Date(startUtc - JST_OFFSET_MS - (d - 1) * 86400000).toISOString();
}

function clampShowcaseDays(days) {
  const n = parseInt(days, 10);
  if (!Number.isFinite(n) || n < 1) return SHOWCASE_DEFAULT_DAYS;
  return Math.min(n, SHOWCASE_MAX_DAYS);
}

/**
 * 制作担当の配列を id で重複排除（出現順を保つ）。
 * @param {Array<{id:string}>} lists
 */
function mergeCreators(...lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    for (const c of (list || [])) {
      if (!c || !c.id || seen.has(c.id)) continue;
      seen.add(c.id);
      out.push(c);
    }
  }
  return out;
}

/**
 * 納品作品の配列 → スライドの配列。
 *   同一 project_id × 同一納品日（JST）で minBundle 本以上 → { type:'bundle', project, date, creatives, creators }
 *   それ以外                                              → { type:'single', creative }
 * 並びは新しい納品が先（bundle は中で一番新しい納品日時で並べる）。
 *
 * @param {Array<object>} creatives  { creative_id, project_id, project_name, client_name, delivered_at, creators:[{id,...}] ... }
 * @param {object} [opts]
 * @param {number} [opts.minBundle]
 * @returns {Array<object>}
 */
function bundleDeliveries(creatives, { minBundle = SHOWCASE_MIN_BUNDLE } = {}) {
  const groups = new Map();   // key → creatives[]
  for (const c of (creatives || [])) {
    const date = jstDateStr(c.delivered_at) || 'unknown';
    const key = `${c.project_id || 'none'}|${date}`;
    if (!groups.has(key)) groups.set(key, { project_id: c.project_id || null, date, list: [] });
    groups.get(key).list.push(c);
  }
  const byTime = (a, b) => String(b.delivered_at || '').localeCompare(String(a.delivered_at || ''));

  const items = [];
  for (const g of groups.values()) {
    const list = g.list.slice().sort(byTime);
    if (list.length >= minBundle && g.project_id) {
      const head = list[0];
      items.push({
        type: 'bundle',
        key: `bundle:${g.project_id}:${g.date}`,
        project: { id: g.project_id, name: head.project_name || '', client_name: head.client_name || '' },
        date: g.date,
        latest_delivered_at: head.delivered_at || null,
        count: list.length,
        creatives: list,
        creators: mergeCreators(...list.map(c => c.creators)),
      });
    } else {
      for (const c of list) {
        items.push({ type: 'single', key: `single:${c.creative_id}`, latest_delivered_at: c.delivered_at || null, creative: c });
      }
    }
  }
  items.sort((a, b) => String(b.latest_delivered_at || '').localeCompare(String(a.latest_delivered_at || '')));
  return items;
}

/**
 * まとめてナイス！の通知文面（宛先 1 人につき 1 通）。
 * リンクは先頭作品のディープリンク（作品ページで案件グループごと並ぶ）。
 */
function buildBulkNiceNotification({ actorName, projectName, count, emoji = '👏', firstCreativeId }) {
  const who = actorName || '誰か';
  const proj = String(projectName || '作品').trim();
  const shown = proj.length > 40 ? proj.slice(0, 40) + '…' : proj;
  return {
    type: 'portfolio_reaction',
    title: `${who}さんが「${shown}」${count}本にまとめて${emoji}`,
    body: null,
    linkUrl: firstCreativeId ? `/haruka.html?portfolio=${firstCreativeId}` : '/haruka.html',
  };
}

module.exports = {
  SHOWCASE_DEFAULT_DAYS,
  SHOWCASE_MAX_DAYS,
  SHOWCASE_MIN_BUNDLE,
  SHOWCASE_BULK_MAX,
  jstDateStr,
  showcaseSinceIso,
  clampShowcaseDays,
  mergeCreators,
  bundleDeliveries,
  buildBulkNiceNotification,
};
