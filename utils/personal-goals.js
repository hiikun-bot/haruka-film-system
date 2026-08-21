// utils/personal-goals.js
// 🎯 マイゴール（完全個人の目標・タスク管理）の純関数群。
// - 進捗率（done/total/pct）・分類ツリー（大分類→中分類→タスク）の構築
// - 今週の完了数・連続日数（ストリーク）・目標日カウントダウン
// - 「今週やること」「期限順」ビューの絞り込み・整列
//
// ⚠️ 時刻ルール: 日付判定はすべて JST 固定。completed_at（TIMESTAMPTZ）は
//   toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' }) で JST の YYYY-MM-DD に
//   直してから比較し、日付文字列同士の演算は Date.UTC ベースで行う。
//   サーバー（Railway=UTC）・ブラウザどちらのローカルTZにも依存しない。
// DB 非依存。UMD 形式:
//   - Node (jest / routes): require('../utils/personal-goals')
//   - ブラウザ: server.js が /js/personal-goals.js で配信 → window.PersonalGoalsUtils
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.PersonalGoalsUtils = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const TASK_DONE = '完了';
  const TASK_STATUSES = ['未着手', '進行中', '完了'];
  const GOAL_STATUSES = ['active', 'achieved', 'archived'];
  const UNCATEGORIZED = '（未分類）';

  // ---------- 日付ヘルパー（JST固定） ----------

  /** Date / ISO文字列 → JST の 'YYYY-MM-DD'。不正値は null */
  function jstDateStr(dateLike) {
    const d = dateLike instanceof Date ? dateLike : new Date(dateLike);
    if (isNaN(d.getTime())) return null;
    return d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
  }

  /** 'YYYY-MM-DD' → UTC ミリ秒（日付演算専用。TZ非依存） */
  function dateStrToUtcMs(s) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s || '')) return null;
    const [y, m, d] = s.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  }

  /** 'YYYY-MM-DD' に n 日足した 'YYYY-MM-DD' */
  function addDays(dateStr, n) {
    const ms = dateStrToUtcMs(dateStr);
    if (ms === null) return null;
    return new Date(ms + n * 86400000).toISOString().slice(0, 10);
  }

  /** 目標日まであと何日か（targetDate - today。過去なら負） */
  function daysUntil(targetDateStr, todayStr) {
    const t = dateStrToUtcMs(targetDateStr);
    const n = dateStrToUtcMs(todayStr);
    if (t === null || n === null) return null;
    return Math.round((t - n) / 86400000);
  }

  /** todayStr を含む今週（月曜はじまり）の { start, end }（両端含む） */
  function jstWeekRange(todayStr) {
    const ms = dateStrToUtcMs(todayStr);
    if (ms === null) return null;
    const dow = new Date(ms).getUTCDay();          // 0=日, 1=月, ...
    const sinceMonday = (dow + 6) % 7;             // 月曜からの経過日数
    const start = addDays(todayStr, -sinceMonday);
    return { start, end: addDays(start, 6) };
  }

  // ---------- 進捗計算 ----------

  function isDone(task) {
    return !!task && task.status === TASK_DONE;
  }

  /** タスク配列 → { done, total, pct }（pct は 0-100 の整数。total=0 なら 0） */
  function computeProgress(tasks) {
    const list = tasks || [];
    const done = list.filter(isDone).length;
    const total = list.length;
    return { done, total, pct: total > 0 ? Math.round((done / total) * 100) : 0 };
  }

  /**
   * 大分類 → 中分類 → タスクの3階層ツリーを構築する。
   * 分類はテキスト自由入力のため、出現順（呼び出し側が sort_order / created_at で
   * 整列済みの前提）を保ったままグルーピングする。分類なしは '（未分類）' に集約。
   * @returns [{ name, done, total, pct, mids: [{ name, done, total, pct, tasks: [...] }] }]
   */
  function buildCategoryTree(tasks) {
    const majors = [];
    const majorMap = new Map();
    for (const t of tasks || []) {
      const majorName = (t.major_category || '').trim() || UNCATEGORIZED;
      const midName = (t.mid_category || '').trim() || UNCATEGORIZED;
      let major = majorMap.get(majorName);
      if (!major) {
        major = { name: majorName, mids: [], midMap: new Map() };
        majorMap.set(majorName, major);
        majors.push(major);
      }
      let mid = major.midMap.get(midName);
      if (!mid) {
        mid = { name: midName, tasks: [] };
        major.midMap.set(midName, mid);
        major.mids.push(mid);
      }
      mid.tasks.push(t);
    }
    return majors.map((major) => {
      const mids = major.mids.map((mid) => ({ name: mid.name, tasks: mid.tasks, ...computeProgress(mid.tasks) }));
      const all = major.mids.flatMap((mid) => mid.tasks);
      return { name: major.name, mids, ...computeProgress(all) };
    });
  }

  // ---------- 今週の完了数・ストリーク ----------

  /** 完了日時が今週（JST・月〜日）に入っている完了タスク数 */
  function countWeekCompleted(tasks, todayStr) {
    const range = jstWeekRange(todayStr);
    if (!range) return 0;
    let count = 0;
    for (const t of tasks || []) {
      if (!isDone(t) || !t.completed_at) continue;
      const d = jstDateStr(t.completed_at);
      if (d && d >= range.start && d <= range.end) count++;
    }
    return count;
  }

  /**
   * 連続日数（ストリーク）: 「1件以上タスクを完了した日」が今日から途切れず何日続いているか。
   * 今日まだ完了が無い場合は昨日を起点に数える（当日中に途切れた扱いにしない）。
   */
  function computeStreak(tasks, todayStr) {
    const days = new Set();
    for (const t of tasks || []) {
      if (!isDone(t) || !t.completed_at) continue;
      const d = jstDateStr(t.completed_at);
      if (d) days.add(d);
    }
    if (days.size === 0) return 0;
    let cursor = days.has(todayStr) ? todayStr : addDays(todayStr, -1);
    let streak = 0;
    while (cursor && days.has(cursor)) {
      streak++;
      cursor = addDays(cursor, -1);
    }
    return streak;
  }

  // ---------- ビュー用の絞り込み・整列 ----------

  function isOverdue(task, todayStr) {
    return !!task && !isDone(task) && !!task.due_date && task.due_date < todayStr;
  }

  /** 期限昇順（期限なしは末尾・元の相対順維持）で未完了タスクを整列した新配列 */
  function sortByDueDate(tasks) {
    return (tasks || [])
      .filter((t) => !isDone(t))
      .map((t, i) => ({ t, i }))
      .sort((a, b) => {
        const da = a.t.due_date || '9999-99-99';
        const db = b.t.due_date || '9999-99-99';
        if (da !== db) return da < db ? -1 : 1;
        return a.i - b.i; // 安定ソート保証（同一期限は元の順）
      })
      .map((x) => x.t);
  }

  /** 「今週やること」= 期限が今週（JST・月〜日）内 or 期限超過の未完了タスク（期限昇順） */
  function filterThisWeek(tasks, todayStr) {
    const range = jstWeekRange(todayStr);
    if (!range) return [];
    return sortByDueDate(
      (tasks || []).filter((t) => !isDone(t) && !!t.due_date && t.due_date <= range.end)
    );
  }

  return {
    TASK_DONE,
    TASK_STATUSES,
    GOAL_STATUSES,
    UNCATEGORIZED,
    jstDateStr,
    addDays,
    daysUntil,
    jstWeekRange,
    isDone,
    computeProgress,
    buildCategoryTree,
    countWeekCompleted,
    computeStreak,
    isOverdue,
    sortByDueDate,
    filterThisWeek,
  };
});
