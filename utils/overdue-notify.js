// utils/overdue-notify.js — 提出遅れ（最終納品日超過）の日次通知（ADR 049）
// =============================================================
// 純関数のみ（DB・外部 API 非依存。jest で直接テストする）。送信は workers/overdue-notifier.js が担う。
//
//   selectOverdue(creatives, todayYmd)       進行ボードの「提出遅れ」と同じ条件で絞る
//   resolveManagerIds(creative, ctx)         管理している D / P の user_id を解決する
//   groupByRecipient(creatives, ctx)         受信者 → 遅延クリエイティブ一覧
//   buildOverdueDigest(...)                  受信者 1 人分の文面 { title, body, chatwork, slack }
//   buildSosMessage(...)                     SOS が立ったときの文面
//   isJstBusinessDay(now)                    平日（土日・祝日以外）か
//   daysOverdue(finalYmd, todayYmd)          超過日数
//
// 「提出遅れ」の定義は public/haruka.html の renderAlerts と同じ:
//   final_deadline < 今日(JST) かつ status != 納品 かつ ボールがクライアント側でない
//   （= status が「クライアントチェック中」でない）。取引終了クライアントの案件は除く。
// =============================================================

const { isJapanHoliday } = require('../lib/japanese-holidays');

const STATUS_DELIVERED = '納品';
const STATUS_CLIENT_REVIEW = 'クライアントチェック中';
const CLIENT_ENDED = 'クライアント取引終了';
const EDITOR_ROLES = ['editor', 'designer', 'director_as_editor'];
const MAX_ITEMS_IN_MESSAGE = 15;

function jstToday(now = new Date()) {
  return new Date(now).toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
}

/** 'YYYY-MM-DD' → UTC 正午の ms（暦日差の計算用。TZ に依存しない） */
function ymdToMs(ymd) {
  const m = String(ymd || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12);
}

/** 最終納品日から今日までの超過日数（当日は 0、未来は負、不正は null） */
function daysOverdue(finalYmd, todayYmd) {
  const a = ymdToMs(finalYmd);
  const b = ymdToMs(todayYmd);
  if (a == null || b == null) return null;
  return Math.round((b - a) / 86400000);
}

/** JST で土日・祝日でなければ true */
function isJstBusinessDay(now = new Date()) {
  const ymd = jstToday(now);
  const weekday = new Date(`${ymd}T12:00:00Z`).getUTCDay(); // 0=日 6=土（UTC 正午なので日付は不変）
  if (weekday === 0 || weekday === 6) return false;
  return !isJapanHoliday(ymd);
}

/**
 * 進行ボードの「提出遅れ」と同じ条件で絞る。
 * @param {Array<object>} creatives  creatives 行（status / final_deadline / force_delivered / projects.clients.status）
 * @param {string} todayYmd          JST の今日 'YYYY-MM-DD'
 */
function selectOverdue(creatives, todayYmd) {
  return (Array.isArray(creatives) ? creatives : []).filter(c => {
    if (!c || !c.final_deadline) return false;
    if (c.status === STATUS_DELIVERED || c.force_delivered) return false;
    if (c.status === STATUS_CLIENT_REVIEW) return false; // ボールが先方（クライアント確認待ち）
    if (c.projects?.clients?.status === CLIENT_ENDED) return false;
    const d = daysOverdue(c.final_deadline, todayYmd);
    return d != null && d > 0;
  });
}

/**
 * 管理している D / P を解決する。優先順は routes/haruka.js getBallHolder と同じ。
 *   director: assignment(role=director) → projects.director_id → 制作担当のチーム代表ディレクター
 *   producer: assignment(role=producer) → projects.producer_id
 * @param {object} c  creative（creative_assignments[].{role,user_id,users.team_id} / projects.{director_id,producer_id}）
 * @param {{ directorIdByTeamId?: Map, directorIdByUserId?: Map }} ctx
 * @returns {{ directorIds: string[], producerIds: string[], all: string[] }}
 */
function resolveManagerIds(c, ctx = {}) {
  const assigns = Array.isArray(c?.creative_assignments) ? c.creative_assignments : [];
  const uid = a => a?.user_id || a?.users?.id || null;

  let directorIds = assigns.filter(a => a?.role === 'director').map(uid).filter(Boolean);
  if (directorIds.length === 0 && c?.projects?.director_id) directorIds = [c.projects.director_id];
  if (directorIds.length === 0) {
    const editor = assigns.find(a => EDITOR_ROLES.includes(a?.role));
    const teamId = editor?.users?.team_id || null;
    const editorId = uid(editor);
    const viaTeam = (teamId && ctx.directorIdByTeamId?.get(teamId))
      || (editorId && ctx.directorIdByUserId?.get(editorId))
      || null;
    if (viaTeam) directorIds = [viaTeam];
  }

  let producerIds = assigns.filter(a => a?.role === 'producer').map(uid).filter(Boolean);
  if (producerIds.length === 0 && c?.projects?.producer_id) producerIds = [c.projects.producer_id];

  const all = Array.from(new Set([...directorIds, ...producerIds]));
  return { directorIds: Array.from(new Set(directorIds)), producerIds: Array.from(new Set(producerIds)), all };
}

/**
 * 受信者ごとにまとめる。
 * @returns {Map<string, Array<object>>} user_id → creatives（超過日数の大きい順）
 */
function groupByRecipient(creatives, ctx = {}, todayYmd = jstToday()) {
  const map = new Map();
  for (const c of creatives || []) {
    const { all } = resolveManagerIds(c, ctx);
    for (const id of all) {
      if (!map.has(id)) map.set(id, []);
      map.get(id).push(c);
    }
  }
  for (const [, list] of map) {
    list.sort((a, b) => (daysOverdue(b.final_deadline, todayYmd) || 0) - (daysOverdue(a.final_deadline, todayYmd) || 0));
  }
  return map;
}

function formatMd(ymd) {
  const m = String(ymd || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${Number(m[2])}/${Number(m[3])}` : String(ymd || '未設定');
}

function displayName(u) {
  return (u?.nickname || u?.full_name || '').trim();
}

function editorNameOf(c) {
  const e = (c?.creative_assignments || []).find(a => EDITOR_ROLES.includes(a?.role));
  return displayName(e?.users) || '担当未定';
}

/**
 * 受信者 1 人分の日次まとめ文面。
 * @param {{ recipient: object, items: object[], todayYmd: string, creativeUrl: (id:string)=>string|null, boardUrl: string|null }} p
 * @returns {{ title: string, body: string, chatwork: string, slack: string, count: number }}
 */
function buildOverdueDigest({ recipient, items, todayYmd, creativeUrl, boardUrl }) {
  const name = displayName(recipient);
  const list = Array.isArray(items) ? items : [];
  const count = list.length;
  const title = `⏰ 提出遅れのクリエイティブ ${count}件（${formatMd(todayYmd)}時点）`;
  const shown = list.slice(0, MAX_ITEMS_IN_MESSAGE);
  const rest = count - shown.length;

  const lines = [];
  lines.push(`${name ? `${name}さん、` : ''}お疲れさまです。`);
  lines.push('ディレクター／プロデューサーとして管理しているクリエイティブのうち、最終納品日を過ぎてまだ「納品」になっていないものです。');
  lines.push('');
  for (const c of shown) {
    const client = c.projects?.clients?.name || '-';
    const days = daysOverdue(c.final_deadline, todayYmd);
    lines.push(`■ ${client} / ${c.file_name || '(ファイル名なし)'}`);
    lines.push(`　最終納品日 ${formatMd(c.final_deadline)}（${days}日超過）・ステータス: ${c.status || '-'}・担当: ${editorNameOf(c)}`);
    const url = typeof creativeUrl === 'function' ? creativeUrl(c.id) : null;
    if (url) lines.push(`　${url}`);
  }
  if (rest > 0) lines.push(`…ほか ${rest}件`);
  lines.push('');
  lines.push('それぞれ、次のどれかの対応をお願いします。');
  lines.push('① 日程が変わっただけ → 最終納品日を実際の日付に直す（進行ボード上部の「📅 予定日をまとめて変更」でまとめて直せます）');
  lines.push('② 実際は進んでいる・納品済み → ステータスを今の状態に合わせて進める');
  lines.push('③ 問題があって進められない → クリエイティブの 🆘SOS を立てて、コメントに状況を書く（管理者と担当 D/P に届きます）');
  if (boardUrl) {
    lines.push('');
    lines.push(`進行ボード（遅延のみ表示）: ${boardUrl}`);
  }
  lines.push('※ この連絡は平日の朝、提出遅れが残っている間だけ届きます。');

  const body = lines.join('\n');
  return {
    title,
    body,
    count,
    chatwork: `[info][title]${title}[/title]${body}[/info]`,
    slack: `*${title}*\n${body}`,
  };
}

/**
 * SOS が立ったときの文面（管理者・担当 D/P 向け）。
 * @param {{ actorName: string, clientName: string, projectName: string, fileName: string, status: string, comment?: string, url?: string|null }} p
 */
function buildSosMessage({ actorName, clientName, projectName, fileName, status, comment, url }) {
  const title = `🆘 SOS: ${fileName || '(ファイル名なし)'}`;
  const lines = [
    `${actorName || '担当者'}さんがクリエイティブに SOS を立てました。状況を確認してください。`,
    `クライアント: ${clientName || '-'} / 案件: ${projectName || '-'}`,
    `ステータス: ${status || '-'}`,
  ];
  const c = String(comment || '').trim();
  if (c) lines.push(`コメント: ${c.length > 200 ? `${c.slice(0, 200)}…` : c}`);
  if (url) lines.push(url);
  const body = lines.join('\n');
  return {
    title,
    body,
    chatwork: `[info][title]${title}[/title]${body}[/info]`,
    slack: `*${title}*\n${body}`,
  };
}

module.exports = {
  STATUS_DELIVERED,
  STATUS_CLIENT_REVIEW,
  CLIENT_ENDED,
  MAX_ITEMS_IN_MESSAGE,
  jstToday,
  daysOverdue,
  isJstBusinessDay,
  selectOverdue,
  resolveManagerIds,
  groupByRecipient,
  buildOverdueDigest,
  buildSosMessage,
  formatMd,
};
