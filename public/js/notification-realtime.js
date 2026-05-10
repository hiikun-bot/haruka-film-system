// =============================================================
// notification-realtime.js — Phase 1 段階2 Supabase Realtime 購読
//
// 設計参照: docs/notification/notification_API_SPEC.md 第6章
//
// 責務:
//   ・Supabase JS（CDN: https://esm.sh/@supabase/supabase-js@2）を読み込んで anon key で接続
//   ・notification_logs テーブルの INSERT を user_id=eq.<自分のID> でフィルタ購読
//   ・受信時に CustomEvent('notification:incoming', { detail: payload.new }) を発火
//   ・接続が切れたら 5秒後に再接続 + 未読件数を再取得して整合性回復
//
// 用語メモ:
//   ・「Realtime（リアルタイム）」— Supabase が PostgreSQL のレプリケーション機能を使って
//     INSERT/UPDATE/DELETE をブラウザに即座に流してくれる仕組み。
//   ・「anon key（アノン キー）」— Supabase の公開鍵。RLS（行レベルセキュリティ）で守られる
//     前提でブラウザに置いてOK。service_role キー（管理者鍵）は絶対にフロントへ渡さない。
//   ・「filter（フィルター）」— サーバー側で条件マッチした行だけ送ってもらうための条件式。
//     `user_id=eq.<自分のID>` で「自分宛だけ」に絞る。
// ============================================================= */

const RECONNECT_DELAY_MS = 5000;

let supabaseClient = null;
let realtimeChannel = null;
let currentUserId   = null;
let reconnectTimer  = null;

// /api/config から URL と anon key を貰う
async function fetchSupabaseConfig() {
  const res = await fetch('/api/config', { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`/api/config 取得失敗 ${res.status}`);
  const json = await res.json();
  if (!json?.supabase_url || !json?.supabase_anon_key) {
    throw new Error('Supabase 設定が空です（SUPABASE_URL / SUPABASE_ANON_KEY を確認）');
  }
  return { url: json.supabase_url, anonKey: json.supabase_anon_key };
}

// ログイン中ユーザーIDを取得（既存 /auth/me を再利用）
async function fetchCurrentUserId() {
  // 既に window.currentUser が乗っていればそれを使う（haruka.html の init() が必ずセットする）
  const fromGlobal = window.currentUser?.id || window.currentUser?.supabase_id;
  if (fromGlobal) return fromGlobal;
  const res = await fetch('/auth/me', { credentials: 'same-origin' });
  if (!res.ok) return null;
  const me = await res.json();
  return me?.id || null;
}

// Supabase JS を CDN から動的 import（ESM）
async function loadSupabaseLib() {
  // 既に読み込み済みならそれを返す
  if (window.__supabaseJsLib) return window.__supabaseJsLib;
  const mod = await import('https://esm.sh/@supabase/supabase-js@2');
  window.__supabaseJsLib = mod;
  return mod;
}

async function initClient() {
  const [{ url, anonKey }, lib] = await Promise.all([
    fetchSupabaseConfig(),
    loadSupabaseLib(),
  ]);
  if (!supabaseClient) {
    supabaseClient = lib.createClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      realtime: { params: { eventsPerSecond: 10 } },
    });
  }
  return supabaseClient;
}

// 受信時の CustomEvent 発火
function emitIncoming(notification) {
  if (!notification) return;
  document.dispatchEvent(new CustomEvent('notification:incoming', {
    detail: notification,
  }));
}

// 購読を張る
async function subscribe() {
  try {
    const client = await initClient();
    if (!currentUserId) currentUserId = await fetchCurrentUserId();
    if (!currentUserId) {
      console.warn('[notification-realtime] user_id 未取得。あとで再試行します。');
      // 認証完了イベントを待って再試行
      document.addEventListener('notification:authReady', subscribe, { once: true });
      return;
    }

    // 既存チャネルがあればクリーンアップ
    if (realtimeChannel) {
      try { client.removeChannel(realtimeChannel); } catch (_) {}
      realtimeChannel = null;
    }

    realtimeChannel = client
      .channel(`notifications:${currentUserId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'notification_logs',
          filter: `user_id=eq.${currentUserId}`,
        },
        payload => emitIncoming(payload?.new)
      )
      .subscribe(status => {
        // status は SUBSCRIBED / CLOSED / CHANNEL_ERROR / TIMED_OUT
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          scheduleReconnect();
        } else if (status === 'SUBSCRIBED') {
          console.log('[notification-realtime] 接続成立 user_id=', currentUserId);
          // 接続できたタイミングで未読件数も同期（Realtime 切れ前後の取りこぼし救済）
          if (window.notificationBell?.refreshUnreadCount) {
            window.notificationBell.refreshUnreadCount();
          }
        }
      });
  } catch (e) {
    console.warn('[notification-realtime] 接続失敗', e);
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    console.log('[notification-realtime] 再接続を試みます');
    // 念のため未読件数も整合性回復
    if (window.notificationBell?.refreshUnreadCount) {
      try { await window.notificationBell.refreshUnreadCount(); } catch (_) {}
    }
    subscribe();
  }, RECONNECT_DELAY_MS);
}

// 認証完了イベントを待ってから接続（DOMContentLoaded だと currentUser がまだ無い可能性）
function bootstrap() {
  // 既にユーザーが居ればすぐに購読開始
  if (window.currentUser?.id || window.currentUser?.supabase_id) {
    subscribe();
    return;
  }
  // なければ authReady を待つ
  document.addEventListener('notification:authReady', () => subscribe(), { once: true });
  // 念のため一定時間後に強制試行（authReady イベント未発火時のフォールバック）
  setTimeout(() => {
    if (!realtimeChannel) subscribe();
  }, 4000);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap);
} else {
  bootstrap();
}

// グローバル公開（デバッグ用）
window.notificationRealtime = {
  reconnect: subscribe,
  getClient: () => supabaseClient,
};
