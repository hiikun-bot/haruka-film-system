// utils/revision-breakdown.js
// 修正回数の内訳（社内 / クライアント）を creative_status_transitions から数える純関数。
// 旧 PR #547（internal_revision_count / client_revision_count 列の新設）の作り直し。
// 遷移ログが全遷移を記録しているため、DB 列を増やさずに集計できる。
//
//   社内 = Wチェック後修正 + Dチェック後修正 + Pチェック後修正 への遷移回数
//   CL   = クライアントチェック後修正 への遷移回数

const INTERNAL_REVISION_STATUSES = ['Wチェック後修正', 'Dチェック後修正', 'Pチェック後修正'];
const CLIENT_REVISION_STATUSES = ['クライアントチェック後修正'];
const REVISION_BREAKDOWN_STATUSES = [...INTERNAL_REVISION_STATUSES, ...CLIENT_REVISION_STATUSES];

function countRevisionBreakdown(transitions) {
  let internal = 0;
  let client = 0;
  for (const tr of transitions || []) {
    const to = tr && tr.to_status;
    if (INTERNAL_REVISION_STATUSES.includes(to)) internal++;
    else if (CLIENT_REVISION_STATUSES.includes(to)) client++;
  }
  return { internal, client };
}

// バッジの文言。両方 0 なら null（バッジを出さない）。0 の側は省略する。
function formatRevisionBadge(breakdown) {
  if (!breakdown) return null;
  const parts = [];
  if (breakdown.internal > 0) parts.push(`社内 ${breakdown.internal}回`);
  if (breakdown.client > 0) parts.push(`CL ${breakdown.client}回`);
  return parts.length ? parts.join(' · ') : null;
}

// 遷移ログが欠けている（ログ導入前の修正・手で直した回数など）と、内訳の合計が従来の
// creatives.revision_count を下回る。そのまま出すと回数が少なく見えたりバッジが消えたりするので、
// 合計が足りないときは内訳を使わない（null を返す → 画面は従来の「修正 N回」を出す・#1312 レビュー対応）。
function reconcileRevisionBreakdown(breakdown, revisionCount) {
  if (!breakdown || typeof breakdown.internal !== 'number' || typeof breakdown.client !== 'number') return null;
  const legacy = Number(revisionCount) || 0;
  if (breakdown.internal + breakdown.client < legacy) return null;
  return breakdown;
}

// 詳細画面のバッジ文言（内訳が使えないときは従来の「修正 N回」）。どちらも 0 なら null（バッジを出さない）
function revisionBadgeText(breakdown, revisionCount) {
  const bd = reconcileRevisionBreakdown(breakdown, revisionCount);
  if (bd) return formatRevisionBadge(bd);
  const legacy = Number(revisionCount) || 0;
  return legacy > 0 ? `修正 ${legacy}回` : null;
}

module.exports = {
  INTERNAL_REVISION_STATUSES,
  CLIENT_REVISION_STATUSES,
  REVISION_BREAKDOWN_STATUSES,
  countRevisionBreakdown,
  formatRevisionBadge,
  reconcileRevisionBreakdown,
  revisionBadgeText,
};
