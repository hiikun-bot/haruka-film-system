// =============================================================
// notification-bell.js — Phase 1 段階2 ベル制御
//
// 設計参照: docs/notification/notification_UI_SPEC.md 第2章「ベルアイコン仕様」
//
// このモジュールが提供するもの:
//   ・初期化: GET /api/notifications/unread-count → バッジ表示
//   ・setBadgeCount(n)   バッジを数値で更新（0なら hidden、1〜99 はそのまま、100以上は "99+"）
//   ・incrementBadge(n)  バッジ +n（負の値で減算も可）
//   ・pulseBadge()       新着時アニメーション（scale 1→1.3→1 を 0.4秒）
//   ・refreshUnreadCount() Realtime再接続時の整合性回復用に再取得
//
// イベント受信:
//   ・document.addEventListener('notification:read')      — バッジ -1
//   ・document.addEventListener('notification:readAll')   — バッジ 0
//   ・document.addEventListener('notification:incoming')  — バッジ +1 + pulse
// ============================================================= */

const STATE = {
  unreadCount: 0,
  initialized: false,
};

// 通知認証エラー（401）でひっそりログイン画面に戻すか、コンソールに残すかは init() が判断
async function fetchUnreadCount() {
  try {
    const res = await fetch('/api/notifications/unread-count', {
      credentials: 'same-origin',
    });
    if (!res.ok) return null;
    const json = await res.json();
    return Number(json?.unread_count) || 0;
  } catch (e) {
    console.warn('[notification-bell] unread-count 取得失敗', e);
    return null;
  }
}

// バッジを数値で更新（バッジ表示ルール）
//   0       → 非表示
//   1〜99   → そのまま
//   100以上 → "99+"
export function setBadgeCount(n) {
  const safe = Math.max(0, Number(n) || 0);
  STATE.unreadCount = safe;
  const badge = document.getElementById('notification-badge');
  const bell  = document.getElementById('notification-bell');
  if (!badge) return;
  if (safe <= 0) {
    badge.hidden = true;
    badge.textContent = '0';
  } else {
    badge.hidden = false;
    badge.textContent = safe > 99 ? '99+' : String(safe);
  }
  if (bell) {
    // 未読時は has-unread クラスを付与（CSSでアイコン色変更 + バッジ脈動グロー）
    bell.classList.toggle('has-unread', safe > 0);
    // スクリーンリーダー用の文言も同期
    bell.setAttribute('aria-label', safe > 0 ? `通知 ${safe}件未読` : '通知');
  }
}

// 差分加算
export function incrementBadge(delta = 1) {
  setBadgeCount(STATE.unreadCount + delta);
}

// バッジを 0.4秒アニメーション（CSS .pulse クラス）
export function pulseBadge() {
  const badge = document.getElementById('notification-badge');
  if (!badge) return;
  badge.classList.remove('pulse');
  // クラス再付与のために 1フレーム待つ（reflow をはさんでアニメーションを再生）
  // void プロパティ参照は「リフロー」を強制して、削除→追加を別フレーム扱いにする小技
  void badge.offsetWidth;
  badge.classList.add('pulse');
  // 終わったら外す（次回のために）
  setTimeout(() => badge.classList.remove('pulse'), 500);
}

// Realtime再接続時の整合性回復
export async function refreshUnreadCount() {
  const n = await fetchUnreadCount();
  if (n != null) setBadgeCount(n);
}

// 現在の未読件数を取得
export function getUnreadCount() {
  return STATE.unreadCount;
}

// 初期化: DOMContentLoaded（または即時、要素が既にあるなら）後に1度だけ実行
async function init() {
  if (STATE.initialized) return;
  STATE.initialized = true;
  const n = await fetchUnreadCount();
  if (n == null) return;  // 認証前など。後段で notification:authReady イベントで再試行可
  setBadgeCount(n);
}

// 認証完了イベントを待ち受け（haruka.html 側の init() 内で発火する想定）
document.addEventListener('notification:authReady', () => {
  // 認証が遅れて来た場合の再取得
  refreshUnreadCount();
});

// バッジ操作のグローバル window へも公開（他スクリプトがモジュールでない場合の保険）
window.notificationBell = {
  setBadgeCount,
  incrementBadge,
  pulseBadge,
  refreshUnreadCount,
  getUnreadCount,
};

// イベント駆動で他モジュールから操作される
document.addEventListener('notification:read',    () => incrementBadge(-1));
document.addEventListener('notification:readAll', () => setBadgeCount(0));
document.addEventListener('notification:incoming', () => {
  incrementBadge(1);
  pulseBadge();
});

// 起動
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
