// =============================================================
// notification-panel.js — Phase 1 段階2 通知パネル開閉
//
// 設計参照: docs/notification/notification_UI_SPEC.md 第3章「通知一覧パネル」
//
// 責務:
//   ・ベルクリックで GET /api/notifications を呼んでパネルを右からスライドイン
//   ・閉じる方法 3つ: オーバーレイクリック / Xボタン / Esc キー
//   ・「すべて既読にする」ボタン → PATCH /api/notifications/read-all
//   ・パネル開放中はベルアイコンに .active クラス
//   ・パネル本体への描画は notification-card.js に委譲
//
// 用語メモ:
//   ・ARIA（エイリア）— Accessible Rich Internet Applications。スクリーンリーダーに
//     「いま開いた」「いま閉じた」を伝えるための属性群。aria-expanded / aria-hidden 等。
// ============================================================= */

import {
  renderNotificationList,
  prependNewCard,
  markAllCardsAsRead,
} from './notification-card.js';
import { getUnreadCount, setBadgeCount } from './notification-bell.js';

const STATE = {
  isOpen: false,
  isLoading: false,
  notifications: [],
};

// ============================================================
// 通知一覧の取得
// ============================================================
async function fetchNotifications({ limit = 30, offset = 0 } = {}) {
  const url = `/api/notifications?limit=${limit}&offset=${offset}`;
  const res = await fetch(url, { credentials: 'same-origin' });
  if (!res.ok) {
    throw new Error(`通知一覧の取得に失敗しました（${res.status}）`);
  }
  return res.json();
}

// ============================================================
// パネル開閉
// ============================================================
export async function openPanel() {
  if (STATE.isOpen) return;
  STATE.isOpen = true;

  const overlay = document.getElementById('notification-overlay');
  const panel   = document.getElementById('notification-panel');
  const bell    = document.getElementById('notification-bell');
  if (!overlay || !panel || !bell) return;

  overlay.classList.add('open');
  overlay.setAttribute('aria-hidden', 'false');
  panel.classList.add('open');
  panel.setAttribute('aria-hidden', 'false');
  bell.classList.add('active');
  bell.setAttribute('aria-expanded', 'true');

  // ロード中表示
  const body = document.getElementById('notification-panel-body');
  if (body && !body.querySelector('.notification-card')) {
    body.innerHTML = '<div class="notification-loading">読み込み中…</div>';
  }

  // 一覧取得
  STATE.isLoading = true;
  try {
    const json = await fetchNotifications({ limit: 30 });
    STATE.notifications = Array.isArray(json?.notifications) ? json.notifications : [];
    renderNotificationList(STATE.notifications);
    updateMarkAllReadButton();
  } catch (e) {
    console.warn('[notification-panel] 取得失敗', e);
    if (body) {
      body.innerHTML = `
        <div class="notification-empty">
          <div class="notification-empty-icon" aria-hidden="true">⚠️</div>
          <div>通知の取得に失敗しました。少し待って再度お試しください。</div>
        </div>
      `;
    }
  } finally {
    STATE.isLoading = false;
  }
}

export function closePanel() {
  if (!STATE.isOpen) return;
  STATE.isOpen = false;

  const overlay = document.getElementById('notification-overlay');
  const panel   = document.getElementById('notification-panel');
  const bell    = document.getElementById('notification-bell');
  if (overlay) {
    overlay.classList.remove('open');
    overlay.setAttribute('aria-hidden', 'true');
  }
  if (panel) {
    panel.classList.remove('open');
    panel.setAttribute('aria-hidden', 'true');
  }
  if (bell) {
    bell.classList.remove('active');
    bell.setAttribute('aria-expanded', 'false');
  }
}

export function isPanelOpen() {
  return STATE.isOpen;
}

// ============================================================
// 「すべて既読にする」ボタン
// ============================================================
function updateMarkAllReadButton() {
  const btn = document.getElementById('notification-mark-all-read');
  if (!btn) return;
  // 未読が一件でも無ければグレーアウト
  const hasUnread = (STATE.notifications || []).some(n => !n.is_read) || getUnreadCount() > 0;
  btn.disabled = !hasUnread;
}

async function handleMarkAllRead() {
  const btn = document.getElementById('notification-mark-all-read');
  if (btn?.disabled) return;
  if (btn) btn.disabled = true;
  try {
    const res = await fetch('/api/notifications/read-all', {
      method: 'PATCH',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (!res.ok) throw new Error(`既読化API失敗 ${res.status}`);
    // バッジ 0 化
    setBadgeCount(0);
    document.dispatchEvent(new CustomEvent('notification:readAll'));
    // パネル内のカードも見た目を既読化
    markAllCardsAsRead();
    // STATE 側も更新（次回開いた時のためにキャッシュ）
    STATE.notifications = STATE.notifications.map(n => ({ ...n, is_read: true }));
  } catch (e) {
    console.warn('[notification-panel] read-all 失敗', e);
    if (btn) btn.disabled = false;
  }
}

// ============================================================
// 新着 Realtime 受信ハンドラ
// ============================================================
function handleIncoming(payload) {
  const notification = payload?.detail;
  if (!notification) return;
  // 自分宛じゃないものは Realtime filter で弾かれている前提だが、念のため id 重複だけ排除
  const dup = STATE.notifications.find(n => n.id === notification.id);
  if (dup) return;
  STATE.notifications.unshift(notification);
  // パネルが開いていれば先頭に差し込んでスポットライト
  if (STATE.isOpen) {
    prependNewCard(notification);
  }
  updateMarkAllReadButton();
}

// ============================================================
// 初期化
// ============================================================
function init() {
  const bell    = document.getElementById('notification-bell');
  const overlay = document.getElementById('notification-overlay');
  const closeBtn = document.getElementById('notification-panel-close');
  const markAll = document.getElementById('notification-mark-all-read');

  if (bell) {
    bell.addEventListener('click', () => {
      if (STATE.isOpen) closePanel();
      else openPanel();
    });
  }
  if (overlay)  overlay.addEventListener('click', closePanel);
  if (closeBtn) closeBtn.addEventListener('click', closePanel);
  if (markAll)  markAll.addEventListener('click', handleMarkAllRead);

  // Esc キーで閉じる
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && STATE.isOpen) closePanel();
  });

  // カードからのパネル閉じ要求（社内URL遷移前に閉じてからモーダル展開する）
  document.addEventListener('notification:requestPanelClose', closePanel);

  // バッジ -1 のたびにボタン状態を更新
  document.addEventListener('notification:read',    updateMarkAllReadButton);
  document.addEventListener('notification:readAll', updateMarkAllReadButton);

  // Realtime 新着の受け口
  document.addEventListener('notification:incoming', handleIncoming);
}

// グローバル公開（他スクリプトから openPanel() を呼びたい時用）
window.notificationPanel = { openPanel, closePanel, isPanelOpen };

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
