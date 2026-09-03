// utils/my-stats.js
// 🏅 マイ実績（ホーム画面に「自分の頑張り」を本人だけに見せる）の純関数群。ADR 036。
//
// 役割:
//   - 「自分のクリエイティブ」判定（isCreativeOfUser）
//       /invoices/preview-items が使っている基準をそのまま共通化したもの:
//         creative_assignments に自分の行がある（role 問わず）
//         OR 納品時スナップショット delivered_director_ids[0]（無ければ projects.director_id）が自分（ADR 009）
//         OR 納品時スナップショット delivered_producer_ids[0]（無ければ projects.producer_id）が自分
//       snapshotDirectorId / snapshotProducerId は routes/haruka.js（creator-summary 系）からも
//       ここを require して使う（二重定義禁止）。
//   - 集計（computeMyStats）: 今月/先月/累計納品・今月初稿・直近3ヶ月の納期遵守率・今月の👍
//   - マイルストーン文言（buildMilestones）: 最大2件
//
// ⚠️ 時刻ルール: 月・日付の判定はすべて JST 固定。TIMESTAMPTZ は
//   toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' }) で JST の 'YYYY-MM-DD' に直してから比較する。
//   Railway（UTC）でもローカル（JST）でも同じ結果になること（tests/utils/my-stats.test.js で両TZ検証）。
//   new Date('YYYY-MM-DD') / getMonth() 等のサーバーローカル依存は使わない。
//
// DB 非依存。UMD 形式（Node: require('../utils/my-stats') / ブラウザ: window.MyStatsUtils）。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.MyStatsUtils = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 累計納品のマイルストーン（本数）。昇順。
  const TOTAL_MILESTONES = [10, 30, 50, 100, 300, 500, 1000];
  // 「あと N 本」を出す残り本数の上限
  const NEXT_MILESTONE_WITHIN = 10;
  // 納期遵守100%を称えるための最小分母
  const ON_TIME_MIN_DENOMINATOR = 3;
  // 納期遵守率の集計窓（当月を含む直近 N ヶ月・JST 月）
  const ON_TIME_WINDOW_MONTHS = 3;
  const MAX_MILESTONES = 2;

  // ---------- 「自分のクリエイティブ」判定（ADR 009 スナップショット優先） ----------

  /** 納品時スナップショット優先のディレクター解決。未納品は projects.director_id にフォールバック */
  function snapshotDirectorId(creative) {
    const ids = creative?.delivered_director_ids;
    if (Array.isArray(ids) && ids.length) return ids[0];
    return creative?.projects?.director_id || null;
  }
  /** 納品時スナップショット優先のプロデューサー解決。未納品は projects.producer_id にフォールバック */
  function snapshotProducerId(creative) {
    const ids = creative?.delivered_producer_ids;
    if (Array.isArray(ids) && ids.length) return ids[0];
    return creative?.projects?.producer_id || null;
  }

  /**
   * この creative は uid の「自分のクリエイティブ」か。
   * 担当（creative_assignments.user_id または assignments[].users.id）／ディレクター／プロデューサーのいずれか。
   * /invoices/preview-items の「自分の分」判定と同一基準（請求プレビューに載る本数＝マイ実績の本数）。
   */
  function isCreativeOfUser(creative, uid) {
    if (!creative || !uid) return false;
    const assigned = (creative.creative_assignments || []).some(a =>
      a && (a.user_id === uid || (a.users && a.users.id === uid)));
    if (assigned) return true;
    if (snapshotDirectorId(creative) === uid) return true;
    if (snapshotProducerId(creative) === uid) return true;
    return false;
  }

  // ---------- 日付ヘルパー（JST固定） ----------

  /** Date / ISO文字列 → JST の 'YYYY-MM-DD'。不正値は null */
  function jstDateStr(dateLike) {
    if (dateLike === null || dateLike === undefined || dateLike === '') return null;
    const d = dateLike instanceof Date ? dateLike : new Date(dateLike);
    if (isNaN(d.getTime())) return null;
    return d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
  }

  /** Date / ISO文字列 → JST の 'YYYY-MM'。不正値は null */
  function jstYearMonth(dateLike) {
    const s = jstDateStr(dateLike);
    return s ? s.slice(0, 7) : null;
  }

  /** 'YYYY-MM' に months ヶ月足す（負も可）。文字列演算のみで TZ 非依存 */
  function addMonths(ym, months) {
    if (!/^\d{4}-\d{2}$/.test(ym || '')) return null;
    const [y, m] = ym.split('-').map(Number);
    const idx = y * 12 + (m - 1) + months;
    const ny = Math.floor(idx / 12);
    const nm = (idx % 12) + 1;
    return `${ny}-${String(nm).padStart(2, '0')}`;
  }

  /** DATE 列（'YYYY-MM-DD' または ISO）→ 'YYYY-MM-DD'。TZ 変換しない（DATE 列は素の日付） */
  function dateColStr(v) {
    if (!v) return null;
    const s = String(v).slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
  }

  // ---------- 集計 ----------

  /**
   * マイ実績の集計。
   * @param {object} args
   * @param {Array}  args.creatives   自分のクリエイティブ（isCreativeOfUser で絞り込み済みでも、未絞り込みでも可。uid を渡せばここで絞る）
   * @param {Array}  args.likes       当月候補の like 行 [{ user_id, created_at, creative_id }]（creative_id は creative_files 経由で解決済み）
   * @param {string} args.uid         本人の user id（自分の like を除外・creatives の絞り込みに使う）
   * @param {Date|string} [args.now]  基準時刻（省略時は現在）。JST 月を求めるのに使う
   * @returns {object} { month, delivered_this_month, delivered_last_month, delivered_total,
   *   first_draft_this_month, on_time_rate_3m, on_time_denominator, on_time_numerator, likes_this_month, milestones }
   */
  function computeMyStats({ creatives, likes, uid, now } = {}) {
    const thisYm = jstYearMonth(now || new Date());
    const lastYm = addMonths(thisYm, -1);
    // 直近3ヶ月（当月含む）: [thisYm-2, thisYm]
    const windowStartYm = addMonths(thisYm, -(ON_TIME_WINDOW_MONTHS - 1));

    const mine = (creatives || []).filter(c => c && (!uid || isCreativeOfUser(c, uid)));
    const myIds = new Set(mine.map(c => c.id));

    let deliveredThisMonth = 0;
    let deliveredLastMonth = 0;
    let deliveredTotal = 0;
    let firstDraftThisMonth = 0;
    let onTimeDen = 0;
    let onTimeNum = 0;

    for (const c of mine) {
      // 初稿提出（ADR 034: 「クライアントチェック中」初到達の不可逆イベント）
      if (c.first_draft_submitted_at && jstYearMonth(c.first_draft_submitted_at) === thisYm) {
        firstDraftThisMonth += 1;
      }
      // 納品（ADR 026: delivered_at の JST 月）
      if (!c.delivered_at) continue;
      const dYm = jstYearMonth(c.delivered_at);
      if (!dYm) continue;
      deliveredTotal += 1;
      if (dYm === thisYm) deliveredThisMonth += 1;
      else if (dYm === lastYm) deliveredLastMonth += 1;
      // 納期遵守（直近3ヶ月・final_deadline 設定ありのみ分母。/analytics/delivery-quality と同じ判定式）
      if (dYm >= windowStartYm && dYm <= thisYm) {
        const deadline = dateColStr(c.final_deadline);
        if (deadline) {
          onTimeDen += 1;
          if (jstDateStr(c.delivered_at) <= deadline) onTimeNum += 1;
        }
      }
    }

    // 今月の👍: 自分の creative のファイルに「他人」が付けた当月分
    let likesThisMonth = 0;
    for (const l of (likes || [])) {
      if (!l) continue;
      if (uid && l.user_id === uid) continue;               // 自分の like は除外
      if (!myIds.has(l.creative_id)) continue;               // 自分の creative のみ
      if (jstYearMonth(l.created_at) !== thisYm) continue;   // 当月（JST）
      likesThisMonth += 1;
    }

    const stats = {
      month: thisYm,
      delivered_this_month: deliveredThisMonth,
      delivered_last_month: deliveredLastMonth,
      delivered_total: deliveredTotal,
      first_draft_this_month: firstDraftThisMonth,
      on_time_rate_3m: onTimeDen > 0 ? onTimeNum / onTimeDen : null,
      on_time_denominator: onTimeDen,
      on_time_numerator: onTimeNum,
      likes_this_month: likesThisMonth,
    };
    stats.milestones = buildMilestones(stats);
    return stats;
  }

  // ---------- マイルストーン文言 ----------

  /**
   * 短い称賛・励まし文言を最大2件返す。優先順:
   *   1. 累計マイルストーン到達（今月の納品で M 本を跨いだ）「🎉 累計M本達成！」
   *   2. 次のマイルストーンまで残り NEXT_MILESTONE_WITHIN 本以内「🎯 累計N本まであとK本！」
   *   3. 直近3ヶ月 納期遵守100%（分母 >= 3）「✨ 直近3ヶ月 納期遵守100%」
   *   4. 今月納品が先月超え「📈 今月の納品は先月超え（N本 > M本）」
   */
  function buildMilestones(stats) {
    const out = [];
    const total = Number(stats?.delivered_total) || 0;
    const thisM = Number(stats?.delivered_this_month) || 0;
    const lastM = Number(stats?.delivered_last_month) || 0;
    const before = total - thisM; // 今月初め時点の累計

    // 1. 到達（今月の納品で跨いだマイルストーンのうち最大のもの）
    const reached = TOTAL_MILESTONES.filter(m => before < m && total >= m);
    if (reached.length) out.push(`🎉 累計${reached[reached.length - 1]}本達成！`);

    // 2. 次のマイルストーンが近い（到達文言と重複しないよう到達時は出さない）
    if (!reached.length) {
      const next = TOTAL_MILESTONES.find(m => m > total);
      if (next && next - total <= NEXT_MILESTONE_WITHIN && total > 0) {
        out.push(`🎯 累計${next}本まであと${next - total}本！`);
      }
    }

    // 3. 納期遵守100%
    if (stats && stats.on_time_rate_3m === 1 && (Number(stats.on_time_denominator) || 0) >= ON_TIME_MIN_DENOMINATOR) {
      out.push(`✨ 直近${ON_TIME_WINDOW_MONTHS}ヶ月 納期遵守100%`);
    }

    // 4. 先月超え
    if (thisM > 0 && thisM > lastM) {
      out.push(`📈 今月の納品は先月超え（${thisM}本 > ${lastM}本）`);
    }

    return out.slice(0, MAX_MILESTONES);
  }

  return {
    TOTAL_MILESTONES,
    NEXT_MILESTONE_WITHIN,
    ON_TIME_MIN_DENOMINATOR,
    ON_TIME_WINDOW_MONTHS,
    MAX_MILESTONES,
    snapshotDirectorId,
    snapshotProducerId,
    isCreativeOfUser,
    jstDateStr,
    jstYearMonth,
    addMonths,
    dateColStr,
    computeMyStats,
    buildMilestones,
  };
});
