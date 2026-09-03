// utils/portfolio-reactions.js
// =====================================================
// 作品ギャラリー（ポートフォリオ）の 👏 拍手 / 💬 ひとこと まわりの純関数。
// 設計: docs/design/decisions/037-portfolio-reactions.md
//
//   - 一覧に載せる集計（reactions / my_reactions / comment_count）の組み立て
//   - 通知の宛先（制作担当）の決定 — アクター本人は除外
//   - 連打対策の抑制判定（同じ人 × 同じ作品 × 同じ通知種別は 1 日 1 回）
//   - 通知の文面
//
// DB 非依存。routes/haruka.js から使う。tests/utils/portfolio-reactions.test.js でテスト。
// =====================================================

const { REACTION_TYPES, REACTION_EMOJI } = require('./reactions');

// 通知種別（notification_logs.notification_type）
const PORTFOLIO_NOTIFY_TYPES = {
  reaction: 'portfolio_reaction',
  comment:  'portfolio_comment',
};

// 同一 (actor, creative, 通知種別) の通知をこの時間内は 1 回に抑える
const PORTFOLIO_NOTIFY_WINDOW_MS = 24 * 60 * 60 * 1000;

// ひとことの上限文字数（DB の CHECK と揃える）
const PORTFOLIO_COMMENT_MAX = 500;

// 通知を受け取る「制作担当」の creative_assignments.role。
// producer / wcheck はチェック側なので含めない（作った本人に届ける通知のため）。
const MAKER_ASSIGNMENT_ROLES = ['editor', 'designer', 'director_as_editor', 'director'];

/**
 * 空のリアクション集計 { good: 0, heart: 0, ... }
 */
function emptyReactionCounts() {
  return Object.fromEntries(REACTION_TYPES.map(t => [t, 0]));
}

/**
 * portfolio_reactions の行（同一 creative のもの）を集計する。
 * @param {Array<{user_id:string, reaction_type:string}>} rows
 * @param {string|null} currentUserId
 * @returns {{ counts: object, my_reactions: string[], total: number }}
 */
function summarizeReactions(rows, currentUserId) {
  const counts = emptyReactionCounts();
  const mine = new Set();
  let total = 0;
  for (const r of (rows || [])) {
    if (!REACTION_TYPES.includes(r.reaction_type)) continue;
    counts[r.reaction_type] += 1;
    total += 1;
    if (currentUserId && r.user_id === currentUserId) mine.add(r.reaction_type);
  }
  return { counts, my_reactions: REACTION_TYPES.filter(t => mine.has(t)), total };
}

/**
 * 一覧 API 用: creative_id → { reactions, my_reactions, reaction_total, comment_count } の Map。
 * @param {Array<{creative_id:string, user_id:string, reaction_type:string}>} reactionRows
 * @param {Array<{creative_id:string}>} commentRows  deleted_at IS NULL のものだけ渡す
 * @param {string|null} currentUserId
 */
function buildPortfolioSocialMap(reactionRows, commentRows, currentUserId) {
  const byCreative = new Map();
  for (const r of (reactionRows || [])) {
    if (!byCreative.has(r.creative_id)) byCreative.set(r.creative_id, []);
    byCreative.get(r.creative_id).push(r);
  }
  const commentCount = new Map();
  for (const c of (commentRows || [])) {
    commentCount.set(c.creative_id, (commentCount.get(c.creative_id) || 0) + 1);
  }
  const out = new Map();
  const ids = new Set([...byCreative.keys(), ...commentCount.keys()]);
  for (const id of ids) {
    const s = summarizeReactions(byCreative.get(id) || [], currentUserId);
    out.set(id, {
      reactions: s.counts,
      my_reactions: s.my_reactions,
      reaction_total: s.total,
      comment_count: commentCount.get(id) || 0,
    });
  }
  return out;
}

/** 一覧の 1 カードに載せる既定値（リアクションもひとことも無い作品） */
function emptyPortfolioSocial() {
  return { reactions: emptyReactionCounts(), my_reactions: [], reaction_total: 0, comment_count: 0 };
}

/**
 * 通知の宛先＝その作品の制作担当。
 *   - creative_assignments のうち editor / designer / director_as_editor / director
 *   - 納品時スナップショット delivered_director_ids（あれば）
 *   - アクター本人は除外（自分の作品に自分で押しても通知しない）
 * 重複は除き、出現順を保つ。
 *
 * @param {object} args
 * @param {Array<{role:string, user_id?:string, users?:{id:string}}>} args.assignments
 * @param {string[]|null} args.deliveredDirectorIds
 * @param {string} args.actorId
 * @returns {string[]}
 */
function resolvePortfolioNotifyRecipients({ assignments, deliveredDirectorIds, actorId }) {
  const out = [];
  const seen = new Set();
  const push = (id) => {
    if (!id || id === actorId || seen.has(id)) return;
    seen.add(id);
    out.push(id);
  };
  for (const a of (assignments || [])) {
    if (!MAKER_ASSIGNMENT_ROLES.includes(a.role)) continue;
    push(a.user_id || a.users?.id);
  }
  for (const id of (deliveredDirectorIds || [])) push(id);
  return out;
}

/**
 * 連打対策: 直近に同じ (actor, creative, 通知種別) の通知があれば抑制する。
 * @param {object} args
 * @param {string|Date|null} args.lastSentAt  直近の notification_logs.created_at（無ければ null）
 * @param {Date} [args.now]
 * @param {number} [args.windowMs]
 * @returns {boolean} true = 通知しない
 */
function isPortfolioNotifySuppressed({ lastSentAt, now = new Date(), windowMs = PORTFOLIO_NOTIFY_WINDOW_MS }) {
  if (!lastSentAt) return false;
  const t = lastSentAt instanceof Date ? lastSentAt.getTime() : new Date(lastSentAt).getTime();
  if (!Number.isFinite(t)) return false;
  return (now.getTime() - t) < windowMs;
}

/** 抑制判定に使う「この時刻以降」の ISO 文字列 */
function portfolioNotifyWindowStart(now = new Date(), windowMs = PORTFOLIO_NOTIFY_WINDOW_MS) {
  return new Date(now.getTime() - windowMs).toISOString();
}

/** 通知の本文に載せる作品名。長すぎる場合は省略 */
function portfolioTitleExcerpt(fileName, max = 40) {
  const s = String(fileName || '').trim() || '作品';
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/**
 * 通知の文面。linkUrl は作品ページの該当作品へのディープリンク（?portfolio=<creative_id>）。
 * @param {object} args
 * @param {'reaction'|'comment'} args.kind
 * @param {string} args.actorName
 * @param {string} args.creativeId
 * @param {string} args.fileName
 * @param {string=} args.reactionType  kind='reaction' のとき
 * @param {string=} args.commentBody   kind='comment' のとき
 */
function buildPortfolioNotification({ kind, actorName, creativeId, fileName, reactionType, commentBody }) {
  const who = actorName || '誰か';
  const work = portfolioTitleExcerpt(fileName);
  const linkUrl = `/haruka.html?portfolio=${creativeId}`;
  if (kind === 'reaction') {
    const emoji = REACTION_EMOJI[reactionType] || '✨';
    return {
      type: PORTFOLIO_NOTIFY_TYPES.reaction,
      title: `${who}さんが「${work}」に${emoji}`,
      body: null,
      linkUrl,
    };
  }
  const body = String(commentBody || '').trim();
  return {
    type: PORTFOLIO_NOTIFY_TYPES.comment,
    title: `${who}さんが「${work}」にひとこと`,
    body: body.length > 80 ? body.slice(0, 80) + '…' : body,
    linkUrl,
  };
}

module.exports = {
  PORTFOLIO_NOTIFY_TYPES,
  PORTFOLIO_NOTIFY_WINDOW_MS,
  PORTFOLIO_COMMENT_MAX,
  MAKER_ASSIGNMENT_ROLES,
  emptyReactionCounts,
  summarizeReactions,
  buildPortfolioSocialMap,
  emptyPortfolioSocial,
  resolvePortfolioNotifyRecipients,
  isPortfolioNotifySuppressed,
  portfolioNotifyWindowStart,
  portfolioTitleExcerpt,
  buildPortfolioNotification,
};
