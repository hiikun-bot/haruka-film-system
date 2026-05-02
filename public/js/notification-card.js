// =============================================================
// notification-card.js — Phase 1 段階2 通知カード描画
//
// 設計参照: docs/notification/notification_UI_SPEC.md 第4章「通知カードのバリエーション」
//
// このモジュールが提供するもの:
//   ・renderNotificationCard(n)       通知1件をHTML文字列にして返す
//   ・renderNotificationList(list)    通知配列をパネル本体に流し込む
//   ・formatRelativeTime(iso)         相対時刻表記（2分前 / 1時間前 / 05/02 12:03）
//   ・attachCardClickHandlers(root)   カードクリック→既読化→遷移 を仕掛ける
//   ・markCardAsRead(cardEl)          DOM上のカードを既読見た目に変える
//   ・prependNewCard(notification)    Realtime新着をパネル先頭に差し込む（スポットライト付き）
//
// 依存: 同じディレクトリの notification-bell.js（バッジ更新用イベントを発火）
// ============================================================= */

// 種別ごとのアイコン絵文字（UI_SPEC 第4章の表）
const ICON_BY_TYPE = {
  ball_returned: '⚪',    // 白丸（ボール）
  global:        '📢', // 📢 拡声器
  mention:       '@',
  post_reaction: '❤️', // ❤️
  post_comment:  '💬', // 💬
  sos:           '🆘', // 🆘
  deadline:      '⏰',       // ⏰
  assignment:    '📋', // 📋
  invoice:       '📄', // 📄
};

// HTMLエスケープ — ユーザー入力を安全に埋め込むための関数
// （innerHTML に値を入れる時、スクリプトタグ等を文字列として表示させる）
function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// 相対時刻表記（UI_SPEC 第4章「時刻表記ルール」）
//   1分未満       「たった今」
//   1分〜59分    「N分前」
//   1時間〜23時間「N時間前」
//   1日〜6日     「N日前」
//   7日以上      「MM/DD HH:mm」
export function formatRelativeTime(iso) {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const diffMs = Date.now() - t;
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60)      return 'たった今';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60)      return `${diffMin}分前`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24)        return `${diffH}時間前`;
  const diffD = Math.floor(diffH / 24);
  if (diffD < 7)         return `${diffD}日前`;
  // 7日以上は MM/DD HH:mm
  const d = new Date(t);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${mm}/${dd} ${hh}:${mi}`;
}

// 1件をHTML文字列で返す
export function renderNotificationCard(n) {
  const isUnread = !n.is_read;
  const iconChar = ICON_BY_TYPE[n.notification_type] || '🔔'; // 🔔 fallback
  const typeClass = ICON_BY_TYPE[n.notification_type]
    ? `type-${n.notification_type}`
    : 'type-default';
  const senderLabel = n.sender_name && String(n.sender_name).trim()
    ? n.sender_name
    : 'システム通知';
  const timeLabel = formatRelativeTime(n.created_at);

  return `
    <article
      class="notification-card ${isUnread ? 'unread' : 'read'}"
      data-notification-id="${escapeHtml(n.id)}"
      data-link-url="${escapeHtml(n.link_url || '')}"
      data-notification-type="${escapeHtml(n.notification_type || '')}"
      tabindex="0"
      role="button"
      aria-label="${escapeHtml(n.title || '通知')}（${isUnread ? '未読' : '既読'}）">
      <div class="notification-card-icon ${typeClass}" aria-hidden="true">${iconChar}</div>
      <div class="notification-card-main">
        <div class="notification-card-row">
          <div class="notification-card-title">${escapeHtml(n.title || '')}</div>
          <div class="notification-card-time">${escapeHtml(timeLabel)}</div>
        </div>
        ${n.body ? `<div class="notification-card-body">${escapeHtml(n.body)}</div>` : ''}
        <div class="notification-card-sender">${escapeHtml(senderLabel)}</div>
      </div>
    </article>
  `;
}

// 配列まるごとをパネル本体に注入
export function renderNotificationList(notifications, options = {}) {
  const root = document.getElementById('notification-panel-body');
  if (!root) return;
  if (!Array.isArray(notifications) || notifications.length === 0) {
    root.innerHTML = `
      <div class="notification-empty">
        <div class="notification-empty-icon" aria-hidden="true">🔔</div>
        <div>新しい通知はありません</div>
      </div>
    `;
    return;
  }
  root.innerHTML = notifications.map(renderNotificationCard).join('');
  attachCardClickHandlers(root, options);
}

// クリック→既読化→遷移ロジックを仕掛ける
//   options.onCardActivated(notification) を渡せば独自処理に差し替え可
export function attachCardClickHandlers(root, options = {}) {
  if (!root) return;
  root.querySelectorAll('.notification-card').forEach(card => {
    if (card.dataset.handlersAttached === '1') return;
    card.dataset.handlersAttached = '1';
    const activate = () => activateCard(card, options);
    card.addEventListener('click', activate);
    card.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        activate();
      }
    });
  });
}

async function activateCard(cardEl, options = {}) {
  const id = cardEl.dataset.notificationId;
  const linkUrl = cardEl.dataset.linkUrl || '';
  const wasUnread = cardEl.classList.contains('unread');

  // 既読化（未読時のみ）
  if (wasUnread && id) {
    try {
      const res = await fetch(`/api/notifications/${encodeURIComponent(id)}/read`, {
        method: 'PATCH',
        credentials: 'same-origin',
      });
      if (res.ok) {
        markCardAsRead(cardEl);
        // バッジ -1 を伝える（notification-bell.js が拾う）
        document.dispatchEvent(new CustomEvent('notification:read', { detail: { id } }));
      }
    } catch (e) {
      console.warn('[notification-card] 既読化失敗', e);
    }
  }

  if (typeof options.onCardActivated === 'function') {
    options.onCardActivated({ id, linkUrl, cardEl });
    return;
  }

  // デフォルト遷移ロジック:
  //   ・/creatives/<id> 形式は既存の openCreativeDetail() を呼んでモーダル展開
  //   ・それ以外の社内パスは普通に location.href で遷移
  //   ・グローバル通知は通知詳細モーダル（未実装）。とりあえずアラート相当の処理を後で差し替え
  if (!linkUrl) return;

  const creativeMatch = /^\/creatives\/([^/?#]+)/.exec(linkUrl);
  if (creativeMatch && typeof window.openCreativeDetail === 'function') {
    // パネルを閉じてからモーダルを開くと自然
    document.dispatchEvent(new CustomEvent('notification:requestPanelClose'));
    try {
      window.openCreativeDetail(creativeMatch[1]);
    } catch (e) {
      console.warn('[notification-card] openCreativeDetail 失敗', e);
    }
    return;
  }

  // /announcements/* 等の社内URLはそのまま遷移（クエリ ?creative= でディープリンクを保つ既存仕組みあり）
  if (linkUrl.startsWith('/')) {
    window.location.href = linkUrl;
  } else {
    window.open(linkUrl, '_blank', 'noopener');
  }
}

// 既読の見た目に変える（DOM操作のみ。サーバー通信は activateCard 側で済ませる前提）
export function markCardAsRead(cardEl) {
  if (!cardEl) return;
  cardEl.classList.remove('unread');
  cardEl.classList.add('read');
  const aria = cardEl.getAttribute('aria-label') || '';
  cardEl.setAttribute('aria-label', aria.replace('未読', '既読'));
}

// パネル先頭に新着カードを差し込み、スポットライトを1秒で消す
export function prependNewCard(notification, options = {}) {
  const root = document.getElementById('notification-panel-body');
  if (!root) return;
  // 「新しい通知はありません」表示が出ていたら掃除
  const empty = root.querySelector('.notification-empty');
  if (empty) empty.remove();

  const wrap = document.createElement('div');
  wrap.innerHTML = renderNotificationCard(notification).trim();
  const cardEl = wrap.firstElementChild;
  if (!cardEl) return;
  cardEl.classList.add('new');
  root.prepend(cardEl);
  attachCardClickHandlers(root, options);

  // スポットライト 1秒で消す（CSSアニメーションが終わったタイミングで .new を外す）
  setTimeout(() => {
    cardEl.classList.remove('new');
  }, 1100);
}

// 全カードを既読の見た目に変える（read-all 押下時の即時UI反映用）
export function markAllCardsAsRead() {
  document.querySelectorAll('.notification-card.unread').forEach(markCardAsRead);
}
