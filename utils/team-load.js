// utils/team-load.js
// 📊 チーム状況（チーム負荷ダッシュボード）の集計純関数群。
// DB 非依存。routes/haruka.js（GET /team-load）とテスト tests/utils/team-load.test.js から共用する。
//
// 背景（ADR 033）:
//   メンバー個人のタスク量把握は、自己申告ではなく実務データ（creatives / creative_assignments /
//   ボール保持者）の自動集計で行う。閲覧は admin + プロデューサー層のみ
//   （メンバー同士の比較・詮索を防ぐチームビルディング上の判断）。
//
// 集計定義（レスポンス definitions / PR 本文と一致させること）:
//   - 進行中CR数     : 担当（creative_assignments.role IN ('editor','designer','director_as_editor')）
//                      かつ status が「保留」以外の未納品クリエイティブ数
//   - 持ちボール数   : getBallHolder() の user_ids[]（複数ホルダー対応）に自分が含まれる
//                      未納品クリエイティブ数（ball_holder_id キャッシュ列は通知用の単数値のため使わない）
//   - 今週期限数     : 担当クリエイティブのうち final_deadline が今日〜今週日曜（JST・週=月〜日）のもの
//   - 期限超過数     : 担当クリエイティブのうち final_deadline < 今日（JST）のもの（未納品）
//   ※ 期限系（今週期限・期限超過）は「保留」も含む担当分全体で数える
//     （保留でも納期は生きており、超過リスクの可視化が目的のため）。

// 担当とみなす assignment ロール（getBallHolder の editor 判定と同一集合）
const ASSIGNEE_ROLES = ['editor', 'designer', 'director_as_editor'];

// 進行中カウントから除外するステータス（納品系はデータ取得時点で除外済みの前提だが二重ガード）
const INACTIVE_STATUSES = ['保留', '納品', '完納', '納品済'];

// 高負荷判定の閾値（isHighLoad）。根拠:
//   - balls >= 4      : ボール4件は「即日対応すべき差し戻し・チェック待ち」が同時に4本ある状態。
//                       1日で捌ける量（2〜3件/日の実務感覚）を超えるため 'high'
//   - dueThisWeek >= 5: 週5件納期は稼働日数（5日）と同数＝毎日1本納品ペースで、遅延余地ゼロ
//   - overdue >= 1    : 期限超過は件数によらず即フォローが必要（クライアント影響が出ている可能性）
//   'mid' はそれぞりの約半分（balls 2〜3 / dueThisWeek 3〜4）を注意ゾーンとする。
const HIGH_LOAD = { balls: 4, dueThisWeek: 5, overdue: 1 };
const MID_LOAD  = { balls: 2, dueThisWeek: 3 };

/**
 * 負荷レベル判定。'high' | 'mid' | 'low' を返す。
 */
function isHighLoad({ balls = 0, dueThisWeek = 0, overdue = 0 } = {}) {
  if (balls >= HIGH_LOAD.balls || dueThisWeek >= HIGH_LOAD.dueThisWeek || overdue >= HIGH_LOAD.overdue) return 'high';
  if (balls >= MID_LOAD.balls || dueThisWeek >= MID_LOAD.dueThisWeek) return 'mid';
  return 'low';
}

// YYYY-MM-DD 文字列の妥当性（緩め）。final_deadline が null/空のCRは期限系カウント対象外
function _isDateStr(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}/.test(s);
}

/**
 * チーム負荷を集計する（純関数・DB非依存）。
 *
 * @param {Object} args
 * @param {Array}  args.members   [{ id, full_name, nickname, roles }]（is_active かつ社内メンバーのみ）
 * @param {Array}  args.creatives 未納品クリエイティブの配列。各要素:
 *                 { id, status, final_deadline,
 *                   assignee_user_ids: string[],  // role IN ASSIGNEE_ROLES の user_id 集合（呼び出し側で抽出）
 *                   ball_user_ids: string[] }     // getBallHolder().user_ids（複数ホルダー対応・呼び出し側で解決）
 * @param {string} args.todayStr  今日（JST）の 'YYYY-MM-DD'
 * @param {string} args.sundayStr 今週日曜（JST・週=月〜日）の 'YYYY-MM-DD'
 * @returns {{ totals: {active:number, due_this_week:number, overdue:number},
 *             members: Array }}  members は持ちボール数降順 → 進行中CR数降順
 */
function computeTeamLoad({ members = [], creatives = [], todayStr, sundayStr } = {}) {
  const stats = new Map(); // userId -> { active, balls, dueThisWeek, overdue }
  for (const m of members) {
    stats.set(m.id, { active: 0, balls: 0, dueThisWeek: 0, overdue: 0 });
  }

  // 全体KPI（クリエイティブ単位・メンバー横断の重複なし）
  const totals = { active: 0, due_this_week: 0, overdue: 0 };

  for (const c of creatives || []) {
    if (!c) continue;
    const isActive = !INACTIVE_STATUSES.includes(c.status);
    const dl = _isDateStr(c.final_deadline) ? c.final_deadline.slice(0, 10) : null;
    const isDueThisWeek = !!(dl && dl >= todayStr && dl <= sundayStr);
    const isOverdue = !!(dl && dl < todayStr);

    if (isActive) totals.active++;
    if (isDueThisWeek) totals.due_this_week++;
    if (isOverdue) totals.overdue++;

    // 担当分カウント（同一CRに同メンバーが複数 assignment を持っても1回だけ数える）
    const assignees = Array.from(new Set(c.assignee_user_ids || []));
    for (const uid of assignees) {
      const s = stats.get(uid);
      if (!s) continue; // 非アクティブ・外部メンバーは対象外
      if (isActive) s.active++;
      if (isDueThisWeek) s.dueThisWeek++;
      if (isOverdue) s.overdue++;
    }

    // 持ちボール（複数ホルダー全員にカウント）
    const holders = Array.from(new Set(c.ball_user_ids || []));
    for (const uid of holders) {
      const s = stats.get(uid);
      if (!s) continue;
      s.balls++;
    }
  }

  const rows = members.map(m => {
    const s = stats.get(m.id);
    return {
      id: m.id,
      full_name: m.full_name || '',
      nickname: m.nickname || '',
      roles: m.roles || [],
      active: s.active,
      balls: s.balls,
      due_this_week: s.dueThisWeek,
      overdue: s.overdue,
      load: isHighLoad({ balls: s.balls, dueThisWeek: s.dueThisWeek, overdue: s.overdue }),
    };
  });

  // デフォルト: 持ちボール数降順 → 進行中CR数降順 → 名前昇順（表示側でソート切替可能）
  rows.sort((a, b) =>
    (b.balls - a.balls) || (b.active - a.active) || String(a.full_name).localeCompare(String(b.full_name), 'ja'));

  return { totals, members: rows };
}

/**
 * creative_assignments から担当（ASSIGNEE_ROLES）の user_id 集合を抽出するヘルパー。
 * routes 側で embed 結果（[{ role, users: { id } }] or [{ role, user_id }]）を渡す。
 */
function extractAssigneeUserIds(assignments) {
  return Array.from(new Set((assignments || [])
    .filter(a => a && ASSIGNEE_ROLES.includes(a.role))
    .map(a => (a.users && a.users.id) || a.user_id)
    .filter(Boolean)));
}

module.exports = {
  ASSIGNEE_ROLES,
  INACTIVE_STATUSES,
  HIGH_LOAD,
  MID_LOAD,
  isHighLoad,
  computeTeamLoad,
  extractAssigneeUserIds,
};
