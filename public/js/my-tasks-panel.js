/* =============================================================
 * my-tasks-panel.js — 案件スケジュール Phase 2 L4
 *
 * 設計参照: docs/design/decisions/010-project-schedule-tasks.md
 *
 * 責務:
 *   - ヘッダー ✅ アイコン (#my-tasks-icon) のバッジを 5分ごとに更新
 *   - クリックで右側からスライドパネル (#my-tasks-panel) を開閉
 *   - タブで today / thisWeek / later を切替
 *   - 行クリックで案件編集モーダル(openEditProjectById)を開く
 *   - チェックボックスで PATCH /api/my-tasks/:id/done
 *   - ダッシュボード「✅ あなたのタスク」ウィジェット (#dash-my-tasks-body) も同データから描画
 *   - ダッシュボード「🎯 今週の山場」(#dash-upcoming-milestones) を /api/dashboard/upcoming-milestones から描画
 *
 * 通知ベルとの違い:
 *   - Realtime 購読は無し（ポーリングのみ）
 *   - badge は赤色（緊急性が高いため）
 * ============================================================= */
(function () {
  'use strict';

  const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5分

  const STATE = {
    isOpen: false,
    isLoading: false,
    activeTab: 'today',
    data: { today: [], thisWeek: [], later: [] },
    pollTimer: null,
    milestonesPollTimer: null,
  };

  // ---------- ユーティリティ ----------
  function escHtml(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function todayJST() {
    return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
  }

  function fmtMD(yyyymmdd) {
    if (!yyyymmdd) return '期日未設定';
    const m = String(yyyymmdd).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return yyyymmdd;
    const d = new Date(`${yyyymmdd}T00:00:00+09:00`);
    const dow = ['日', '月', '火', '水', '木', '金', '土'][d.getDay()];
    return `${dow} ${parseInt(m[2], 10)}/${parseInt(m[3], 10)}`;
  }

  function dueClass(yyyymmdd) {
    if (!yyyymmdd) return 'later';
    const t = todayJST();
    if (yyyymmdd < t) return 'overdue';
    if (yyyymmdd === t) return 'today';
    // this-week は呼び出し側で判定
    return 'later';
  }

  function setBadge(n) {
    const badge = document.getElementById('my-tasks-badge');
    const icon = document.getElementById('my-tasks-icon');
    if (!badge || !icon) return;
    const safe = Math.max(0, Number(n) || 0);
    if (safe <= 0) {
      badge.hidden = true;
      badge.textContent = '0';
      icon.classList.remove('has-unread');
    } else {
      badge.hidden = false;
      badge.textContent = safe > 99 ? '99+' : String(safe);
      icon.classList.add('has-unread');
    }
    icon.setAttribute('aria-label', safe > 0 ? `マイタスク ${safe}件` : 'マイタスク');
  }

  // ---------- API ----------
  async function fetchCount() {
    try {
      const res = await fetch('/api/my-tasks/count', { credentials: 'same-origin' });
      if (!res.ok) return null;
      return res.json();
    } catch (e) {
      console.warn('[my-tasks-panel] count 取得失敗', e);
      return null;
    }
  }

  async function fetchTasks() {
    const res = await fetch('/api/my-tasks', { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`my-tasks ${res.status}`);
    return res.json();
  }

  async function fetchUpcomingMilestones() {
    const res = await fetch('/api/dashboard/upcoming-milestones?days=14', { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`upcoming-milestones ${res.status}`);
    return res.json();
  }

  async function patchTaskDone(taskId, isDone) {
    const res = await fetch(`/api/my-tasks/${encodeURIComponent(taskId)}/done`, {
      method: 'PATCH',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_done: !!isDone }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`done ${res.status} ${text}`);
    }
    return res.json();
  }

  // ---------- パネル開閉 ----------
  async function openPanel() {
    if (STATE.isOpen) return;
    STATE.isOpen = true;
    const overlay = document.getElementById('my-tasks-overlay');
    const panel = document.getElementById('my-tasks-panel');
    const icon = document.getElementById('my-tasks-icon');
    if (!overlay || !panel || !icon) return;
    overlay.classList.add('open');
    overlay.setAttribute('aria-hidden', 'false');
    panel.classList.add('open');
    panel.setAttribute('aria-hidden', 'false');
    icon.classList.add('active');
    icon.setAttribute('aria-expanded', 'true');

    const body = document.getElementById('my-tasks-body');
    if (body) body.innerHTML = '<div class="notification-loading">読み込み中…</div>';

    STATE.isLoading = true;
    try {
      const data = await fetchTasks();
      STATE.data = data || { today: [], thisWeek: [], later: [] };
      renderPanel();
      renderDashboardWidget();
      // count も更新
      refreshBadge();
    } catch (e) {
      console.warn('[my-tasks-panel] fetch 失敗', e);
      if (body) {
        body.innerHTML = '<div class="my-task-empty">取得に失敗しました。少し待って再度お試しください。</div>';
      }
    } finally {
      STATE.isLoading = false;
    }
  }

  function closePanel() {
    if (!STATE.isOpen) return;
    STATE.isOpen = false;
    const overlay = document.getElementById('my-tasks-overlay');
    const panel = document.getElementById('my-tasks-panel');
    const icon = document.getElementById('my-tasks-icon');
    if (overlay) {
      overlay.classList.remove('open');
      overlay.setAttribute('aria-hidden', 'true');
    }
    if (panel) {
      panel.classList.remove('open');
      panel.setAttribute('aria-hidden', 'true');
    }
    if (icon) {
      icon.classList.remove('active');
      icon.setAttribute('aria-expanded', 'false');
    }
  }

  // ---------- レンダリング: パネル ----------
  function renderPanel() {
    const counts = {
      today: (STATE.data.today || []).length,
      thisWeek: (STATE.data.thisWeek || []).length,
      later: (STATE.data.later || []).length,
    };
    const cTd = document.getElementById('my-tasks-count-today');
    const cWk = document.getElementById('my-tasks-count-thisWeek');
    const cLt = document.getElementById('my-tasks-count-later');
    if (cTd) cTd.textContent = String(counts.today);
    if (cWk) cWk.textContent = String(counts.thisWeek);
    if (cLt) cLt.textContent = String(counts.later);

    const list = STATE.data[STATE.activeTab] || [];
    const body = document.getElementById('my-tasks-body');
    if (!body) return;
    if (list.length === 0) {
      const msg = STATE.activeTab === 'today' ? '今日対応するタスクはありません ✓'
        : STATE.activeTab === 'thisWeek' ? '今週のタスクはありません'
        : 'これ以降のタスクはありません';
      body.innerHTML = `<div class="my-task-empty">${msg}</div>`;
      return;
    }

    const todayStr = todayJST();
    const html = list.map(t => {
      let cls;
      if (STATE.activeTab === 'today' || (t.current_end_date && t.current_end_date <= todayStr)) {
        cls = (t.current_end_date && t.current_end_date < todayStr) ? 'overdue' : 'today';
      } else if (STATE.activeTab === 'thisWeek') {
        cls = 'this-week';
      } else {
        cls = 'later';
      }
      const milestoneCls = t.is_milestone ? ' is-milestone' : '';
      return `
        <div class="my-task-row" data-task-id="${escHtml(t.task_id)}" data-project-id="${escHtml(t.project_id)}">
          <input type="checkbox" class="my-task-check" data-task-id="${escHtml(t.task_id)}" aria-label="完了にする">
          <div class="my-task-main">
            <div class="my-task-title${milestoneCls}">${escHtml(t.title)}</div>
            <div class="my-task-meta">
              <span class="my-task-project">${escHtml(t.project_name || '')}</span>
              <span class="my-task-due ${cls}">${escHtml(fmtMD(t.current_end_date))}</span>
            </div>
          </div>
        </div>
      `;
    }).join('');
    body.innerHTML = html;

    // クリックハンドラ
    body.querySelectorAll('.my-task-row').forEach(row => {
      row.addEventListener('click', (e) => {
        if (e.target.closest('.my-task-check')) return; // チェックボックスは別動線
        const pid = row.getAttribute('data-project-id');
        if (!pid) return;
        if (typeof window.openEditProjectById === 'function') {
          closePanel();
          // モーダル展開はパネルクローズ後に
          setTimeout(() => window.openEditProjectById(pid), 150);
        }
      });
    });
    body.querySelectorAll('.my-task-check').forEach(cb => {
      cb.addEventListener('click', (e) => e.stopPropagation());
      cb.addEventListener('change', async (e) => {
        const tid = cb.getAttribute('data-task-id');
        if (!tid) return;
        cb.disabled = true;
        try {
          await patchTaskDone(tid, true);
          // ローカル状態から削除
          ['today', 'thisWeek', 'later'].forEach(k => {
            STATE.data[k] = (STATE.data[k] || []).filter(x => x.task_id !== tid);
          });
          renderPanel();
          renderDashboardWidget();
          refreshBadge();
        } catch (err) {
          console.warn('[my-tasks-panel] 完了切替失敗', err);
          alert('タスクの更新に失敗しました');
          cb.checked = false;
          cb.disabled = false;
        }
      });
    });
  }

  function setActiveTab(tab) {
    if (!['today', 'thisWeek', 'later'].includes(tab)) return;
    STATE.activeTab = tab;
    document.querySelectorAll('.my-tasks-tab').forEach(t => {
      const isActive = t.getAttribute('data-tab') === tab;
      t.classList.toggle('active', isActive);
      t.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });
    renderPanel();
  }

  // ---------- レンダリング: ダッシュボードウィジェット ----------
  function renderDashboardWidget() {
    const body = document.getElementById('dash-my-tasks-body');
    if (!body) return;
    const todayCount = (STATE.data.today || []).length;
    const weekCount = (STATE.data.thisWeek || []).length;
    const total = todayCount + weekCount + (STATE.data.later || []).length;

    if (total === 0) {
      body.innerHTML = '<div class="dash-card-empty">担当タスクはありません ✓</div>';
      return;
    }

    // 今日 + 今週から先頭 5 件を抽出（今日優先）
    const todayList = (STATE.data.today || []).slice();
    const weekList = (STATE.data.thisWeek || []).slice();
    const items = todayList.concat(weekList).slice(0, 5);

    const todayStr = todayJST();
    const rows = items.map(t => {
      const isPast = t.current_end_date && t.current_end_date < todayStr;
      const cls = isPast ? 'overdue' : (t.current_end_date === todayStr ? 'today' : 'this-week');
      const milestoneCls = t.is_milestone ? ' is-milestone' : '';
      return `
        <div class="milestones-day-row">
          <span class="my-task-due ${cls}" style="font-size:10px">${escHtml(fmtMD(t.current_end_date))}</span>
          <a href="javascript:void(0)" data-project-id="${escHtml(t.project_id)}" class="dash-my-task-link">
            <span class="my-task-title${milestoneCls}" style="display:inline">${escHtml(t.title)}</span>
            <span class="row-project" style="margin-left:6px">${escHtml(t.project_name || '')}</span>
          </a>
        </div>
      `;
    }).join('');

    const summary = `<div style="font-size:11px;color:var(--text-muted);margin-bottom:6px">今日 ${todayCount} 件 / 今週 ${weekCount} 件 / 全 ${total} 件</div>`;
    body.innerHTML = summary + rows;

    body.querySelectorAll('.dash-my-task-link').forEach(a => {
      a.addEventListener('click', () => {
        const pid = a.getAttribute('data-project-id');
        if (pid && typeof window.openEditProjectById === 'function') {
          window.openEditProjectById(pid);
        }
      });
    });
  }

  // ---------- ダッシュボード「今週の山場」(L3) ----------
  async function renderUpcomingMilestones() {
    const section = document.getElementById('dash-upcoming-milestones');
    if (!section) return;
    let data;
    try {
      data = await fetchUpcomingMilestones();
    } catch (e) {
      console.warn('[upcoming-milestones] 取得失敗', e);
      const body = document.getElementById('dash-milestones-by-day');
      if (body) body.innerHTML = '<div class="dash-card-empty">取得に失敗しました</div>';
      return;
    }

    const upcoming = Array.isArray(data?.upcoming) ? data.upcoming : [];
    const overdue = Array.isArray(data?.overdue) ? data.overdue : [];

    // 遅延中アラート
    const alertEl = document.getElementById('dash-overdue-alert');
    const alertCount = document.getElementById('dash-overdue-count');
    const alertList = document.getElementById('dash-overdue-list');
    if (overdue.length > 0 && alertEl) {
      alertEl.style.display = '';
      if (alertCount) alertCount.textContent = `${overdue.length}件`;
      if (alertList) {
        alertList.innerHTML = overdue.slice(0, 5).map(t => `
          <li>
            <a href="javascript:void(0)" data-project-id="${escHtml(t.project_id)}" class="dash-overdue-link">
              ${escHtml(fmtMD(t.current_end_date))} — ${escHtml(t.project_name || '')} / ${escHtml(t.title)}
            </a>
          </li>
        `).join('');
      }
    } else if (alertEl) {
      alertEl.style.display = 'none';
    }

    // 曜日別グルーピング
    const byDay = new Map();
    upcoming.forEach(t => {
      const d = t.current_end_date;
      if (!d) return;
      if (!byDay.has(d)) byDay.set(d, []);
      byDay.get(d).push(t);
    });

    const todayStr = todayJST();
    const tomorrow = new Date(`${todayStr}T00:00:00+09:00`);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });

    const sortedDays = Array.from(byDay.keys()).sort();

    const dayBody = document.getElementById('dash-milestones-by-day');
    if (!dayBody) return;
    if (sortedDays.length === 0 && overdue.length === 0) {
      dayBody.innerHTML = '<div class="dash-card-empty">直近2週間にマイルストーンはありません</div>';
      return;
    }
    if (sortedDays.length === 0) {
      dayBody.innerHTML = '';
      return;
    }

    const html = sortedDays.map(d => {
      const items = byDay.get(d) || [];
      let headCls = '';
      if (d === todayStr) headCls = ' is-today';
      else if (d === tomorrowStr) headCls = ' is-tomorrow';
      const head = `<div class="milestones-day-head${headCls}">${escHtml(fmtMD(d))}${d === todayStr ? '（今日）' : d === tomorrowStr ? '（明日）' : ''}</div>`;
      const rows = items.map(t => `
        <div class="milestones-day-row">
          <a href="javascript:void(0)" data-project-id="${escHtml(t.project_id)}" class="dash-milestone-link">
            <span class="row-project">${escHtml(t.project_name || '')}</span>
            <span style="color:var(--text)">／ ${escHtml(t.title)}</span>
          </a>
        </div>
      `).join('');
      return `<div class="milestones-day-group">${head}${rows}</div>`;
    }).join('');
    dayBody.innerHTML = html;

    // クリック動線
    section.querySelectorAll('.dash-milestone-link, .dash-overdue-link').forEach(a => {
      a.addEventListener('click', () => {
        const pid = a.getAttribute('data-project-id');
        if (pid && typeof window.openEditProjectById === 'function') {
          window.openEditProjectById(pid);
        }
      });
    });
  }

  // ---------- バッジ更新 ----------
  async function refreshBadge() {
    const c = await fetchCount();
    if (c == null) return;
    const total = (Number(c.today) || 0) + (Number(c.overdue) || 0);
    setBadge(total);
  }

  // ---------- 初期化 ----------
  function init() {
    const icon = document.getElementById('my-tasks-icon');
    const overlay = document.getElementById('my-tasks-overlay');
    const closeBtn = document.getElementById('my-tasks-panel-close');

    if (icon) {
      icon.addEventListener('click', () => {
        if (STATE.isOpen) closePanel();
        else openPanel();
      });
    }
    if (overlay) overlay.addEventListener('click', closePanel);
    if (closeBtn) closeBtn.addEventListener('click', closePanel);

    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && STATE.isOpen) closePanel();
    });

    document.querySelectorAll('.my-tasks-tab').forEach(t => {
      t.addEventListener('click', () => setActiveTab(t.getAttribute('data-tab')));
    });

    // 初回バッジ取得 + 5分ごとにポーリング
    refreshBadge();
    if (STATE.pollTimer) clearInterval(STATE.pollTimer);
    STATE.pollTimer = setInterval(refreshBadge, POLL_INTERVAL_MS);

    // ダッシュボード初期描画 + 5分ごと
    refreshDashboard();
    if (STATE.milestonesPollTimer) clearInterval(STATE.milestonesPollTimer);
    STATE.milestonesPollTimer = setInterval(refreshDashboard, POLL_INTERVAL_MS);
  }

  async function refreshDashboard() {
    // ダッシュボードが表示中の時のみ
    const dashEl = document.getElementById('page-dashboard');
    if (!dashEl || !dashEl.classList.contains('active')) return;
    // L3
    renderUpcomingMilestones();
    // L4 ダッシュ部分は my-tasks データを使う（パネルを開かなくても出す）
    try {
      const data = await fetchTasks();
      STATE.data = data || { today: [], thisWeek: [], later: [] };
      renderDashboardWidget();
    } catch (e) {
      const body = document.getElementById('dash-my-tasks-body');
      if (body) body.innerHTML = '<div class="dash-card-empty">取得に失敗しました</div>';
    }
  }

  // 公開
  window.myTasksPanel = {
    openPanel,
    closePanel,
    refreshBadge,
    refreshDashboard,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
