// =============================================================
// utils/tweets-unread.js — つぶやき未読件数の「いつから数えるか」を決める純関数
//
// 設計参照: docs/design/decisions/041-tweets-awareness-without-interruption.md
//
// 未読の基準時刻（最終閲覧時刻）はブラウザ側（localStorage）が持ち、
// GET /api/haruka/tweets/unread-count?since=<ISO> で渡してくる。
// サーバー側はこの関数で since を正規化してから COUNT する。
//   ・欠落 / 不正値 → 「24時間前」（初回・別端末でも直近の空気だけは伝わる）
//   ・古すぎる値   → 「30日前」に丸める（何ヶ月も開いていない人に 200 件の赤バッジを出さない）
//   ・未来の値     → now に丸める（端末時計ズレで永遠に 0 件にならないための保険）
// =============================================================

const DEFAULT_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const MAX_LOOKBACK_MS     = 30 * 24 * 60 * 60 * 1000;

/**
 * @param {unknown} raw   クエリの since（ISO 文字列を想定）
 * @param {Date}    [now] テスト用に注入可
 * @returns {Date}
 */
function resolveUnreadSince(raw, now = new Date()) {
  const nowMs = now.getTime();
  let ms = NaN;
  if (typeof raw === 'string' && raw.trim()) ms = Date.parse(raw.trim());
  if (!Number.isFinite(ms)) return new Date(nowMs - DEFAULT_LOOKBACK_MS);
  if (ms > nowMs) return new Date(nowMs);
  if (ms < nowMs - MAX_LOOKBACK_MS) return new Date(nowMs - MAX_LOOKBACK_MS);
  return new Date(ms);
}

module.exports = { resolveUnreadSince, DEFAULT_LOOKBACK_MS, MAX_LOOKBACK_MS };
