// utils/my-focus.js
// 🎯 ホーム「いま、あなたにボールがあるもの」（ADR 040）の集計純関数群。
// DB 非依存。routes/haruka.js（GET /dashboard/my-focus）と tests/utils/my-focus.test.js から共用する。
//
// 用語（ADR 040 の定義表と一致させること）:
//   関与CR … 未納品クリエイティブのうち、member_user_ids（creative_assignments の担当者を role 問わず
//            ＋ 案件の director_id / producer_id）に自分が含まれる、またはボール保持者が自分のもの。
//            ADR 033（チーム状況）の「担当」は editor/designer/director_as_editor に限定しているが、
//            ホームは D/P 自身の手番・納期責任も出す必要があるため role を問わない。定義差は ADR 040 に明記。
//   ボール … getBallHolder().user_ids に自分が含まれる＝「いま自分が動かす番」のもの。
//            クライアント確認待ちは user_ids が空なので構造上ここには入らない。
//
// 日付は全て 'YYYY-MM-DD'（JST 基準で呼び出し側が生成）で受け取り、文字列比較と UTC 固定パースだけで
// 扱う。サーバーローカル TZ（Railway は UTC）に依存する new Date('Y-M-D') / getDay() は使わない。

// ボールがクライアントにある getBallHolder().type（status「クライアントチェック中」）。
// 制作の手は止まっているのでボール一覧には出さず、「クラ確認待ち N件」として別に数える（ADR 033 と同じ扱い）。
const CLIENT_BALL_TYPE = 'client';

function _isDateStr(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}/.test(s);
}

// 'YYYY-MM-DD' 同士の日数差（to - from）。両端を UTC 0:00 として解釈するため実行環境の TZ に依存しない。
// 読めない値は null（呼び出し側で「納期なし」として扱う）。
function diffDays(fromStr, toStr) {
  if (!_isDateStr(fromStr) || !_isDateStr(toStr)) return null;
  const a = Date.parse(`${String(fromStr).slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${String(toStr).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86400000);
}

/**
 * ホームの「自分の手番」を集計する（純関数・DB非依存）。
 *
 * @param {Object} args
 * @param {Array}  args.creatives 未納品クリエイティブ。各要素:
 *                 { id, file_name, status, final_deadline, draft_deadline, help_flag,
 *                   project_id, project_name, client_name,
 *                   ball_type: string,           // getBallHolder().type
 *                   ball_user_ids: string[],     // getBallHolder().user_ids（複数ホルダー対応）
 *                   member_user_ids: string[] }  // assignments（role 問わず）＋案件 D/P の user_id 集合
 *                 同一 id が複数経路で混ざっていても内部で重複排除する。
 * @param {string} args.userId     本人の user_id
 * @param {string} args.todayStr   今日（JST）の 'YYYY-MM-DD'
 * @param {string} args.weekEndStr 今週日曜（JST）の 'YYYY-MM-DD'
 * @param {number} args.limit      items に載せる最大件数（0 以下なら全件）
 * @returns {{counts: Object, items: Array, has_more: boolean}}
 */
function computeMyFocus({ creatives = [], userId, todayStr, weekEndStr, limit = 5 } = {}) {
  const counts = { balls: 0, overdue: 0, due_this_week: 0, client_wait: 0 };
  const items = [];
  if (!userId) return { counts, items, has_more: false };

  const seen = new Set(); // 3経路 union で同じ CR が重複して来るため id で一意化する
  for (const c of creatives || []) {
    if (!c || !c.id || seen.has(c.id)) continue;
    seen.add(c.id);

    const hasBall = Array.isArray(c.ball_user_ids) && c.ball_user_ids.includes(userId);
    const isMember = Array.isArray(c.member_user_ids) && c.member_user_ids.includes(userId);
    if (!hasBall && !isMember) continue; // 関与していない CR（取得経路の巻き込み分）は無視

    const dl = _isDateStr(c.final_deadline) ? c.final_deadline.slice(0, 10) : null;
    // 納期系は「手元に無くても納期は生きている」ため関与CR全体で数える（ADR 033 の期限系と同じ考え方）
    if (dl && dl < todayStr) counts.overdue++;
    if (dl && dl >= todayStr && dl <= weekEndStr) counts.due_this_week++;
    if (c.ball_type === CLIENT_BALL_TYPE) counts.client_wait++;

    if (!hasBall) continue;
    counts.balls++;
    items.push({
      id: c.id,
      file_name: c.file_name || '',
      status: c.status || '',
      final_deadline: dl,
      draft_deadline: _isDateStr(c.draft_deadline) ? c.draft_deadline.slice(0, 10) : null,
      help_flag: !!c.help_flag,
      project_id: c.project_id || null,
      project_name: c.project_name || '',
      client_name: c.client_name || '',
      sheet_url: c.sheet_url || '',
      regulation_url: c.regulation_url || '',
      ball_type: c.ball_type || 'unknown',
      // 負なら超過日数、0 は今日、正なら残り日数。納期未設定は null
      days_left: dl ? diffDays(todayStr, dl) : null,
    });
  }

  // 納期が近い順（超過が最上段）。納期未設定は末尾にまとめ、同着はファイル名で安定させる。
  items.sort((a, b) => {
    if (a.final_deadline && b.final_deadline) {
      if (a.final_deadline !== b.final_deadline) return a.final_deadline < b.final_deadline ? -1 : 1;
    } else if (a.final_deadline || b.final_deadline) {
      return a.final_deadline ? -1 : 1;
    }
    return String(a.file_name).localeCompare(String(b.file_name), 'ja');
  });

  const capped = limit > 0 ? items.slice(0, limit) : items;
  return { counts, items: capped, has_more: items.length > capped.length };
}

/**
 * 自チーム（自分が案件の D/P、または自分が代表ディレクターのチーム）で「気になる」CR を集計する。
 *
 * ADR 033（チーム状況）はメンバー同士の比較・詮索を避けるため人単位の負荷集計を
 * admin＋プロデューサー層に限定しており、director 単独には見せない。
 * ここはその線を越えないよう **人単位の集計・順位・負荷スコアを一切返さず、CR 単位のリストだけ**を返す
 * （「誰が何件抱えているか」ではなく「どの制作物が止まっているか」を見る画面・ADR 042）。
 *
 * 「気になる」= SOS が立っている / 納期を過ぎている / 今週が納期、のいずれか。
 * 自分にボールがあるものは 🎯 マイフォーカスに出ているのでここからは除外する（ホーム内の重複防止）。
 *
 * @param {Object} args computeMyFocus と同じ creatives 配列（各要素に in_team_scope / ball_holder_user 等が付く）
 * @returns {{counts: Object, items: Array, has_more: boolean}}
 */
function computeTeamFocus({ creatives = [], userId, todayStr, weekEndStr, limit = 5 } = {}) {
  const counts = { sos: 0, overdue: 0, due_this_week: 0 };
  const items = [];
  if (!userId) return { counts, items, has_more: false };

  const seen = new Set();
  for (const c of creatives || []) {
    if (!c || !c.id || seen.has(c.id)) continue;
    seen.add(c.id);
    if (!c.in_team_scope) continue;
    // 自分の手番のものはマイフォーカス側に出ている
    if (Array.isArray(c.ball_user_ids) && c.ball_user_ids.includes(userId)) continue;

    const dl = _isDateStr(c.final_deadline) ? c.final_deadline.slice(0, 10) : null;
    const isSos = !!c.help_flag;
    const isOverdue = !!(dl && dl < todayStr);
    const isDueThisWeek = !!(dl && dl >= todayStr && dl <= weekEndStr);
    if (isSos) counts.sos++;
    if (isOverdue) counts.overdue++;
    if (isDueThisWeek) counts.due_this_week++;
    // 落ち着いているCRは出さない（件数も出さない）。画面は「手を打つ必要があるもの」だけに絞る
    if (!isSos && !isOverdue && !isDueThisWeek) continue;

    items.push({
      id: c.id,
      file_name: c.file_name || '',
      status: c.status || '',
      final_deadline: dl,
      days_left: dl ? diffDays(todayStr, dl) : null,
      help_flag: isSos,
      project_id: c.project_id || null,
      project_name: c.project_name || '',
      client_name: c.client_name || '',
      ball_type: c.ball_type || 'unknown',
      // 「いま誰で止まっているか」。user が解決できないボール（クライアント等）は label だけ返す
      ball_holder_user: c.ball_holder_user || null,
      ball_holder_label: c.ball_holder_label || '',
      reason: isSos ? 'sos' : (isOverdue ? 'overdue' : 'due'),
    });
  }

  // SOS → 期限超過（古い順）→ 今週締切（近い順）。同着はファイル名で安定させる。
  const rank = { sos: 0, overdue: 1, due: 2 };
  items.sort((a, b) => {
    const r = (rank[a.reason] ?? 9) - (rank[b.reason] ?? 9);
    if (r) return r;
    if (a.final_deadline && b.final_deadline) {
      if (a.final_deadline !== b.final_deadline) return a.final_deadline < b.final_deadline ? -1 : 1;
    } else if (a.final_deadline || b.final_deadline) {
      return a.final_deadline ? -1 : 1;
    }
    return String(a.file_name).localeCompare(String(b.file_name), 'ja');
  });

  const capped = limit > 0 ? items.slice(0, limit) : items;
  return { counts, items: capped, has_more: items.length > capped.length };
}

module.exports = { CLIENT_BALL_TYPE, diffDays, computeMyFocus, computeTeamFocus };
