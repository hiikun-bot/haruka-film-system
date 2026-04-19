const CACHE_NAME = 'haruka-film-v1';

// キャッシュするスタティックリソース（アプリシェル）
const STATIC_ASSETS = [
  '/haruka.html',
  '/icon-192.png',
  '/icon-512.png',
  '/manifest.json',
  'https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@300;400;500;700&family=Montserrat:wght@700;800;900&display=swap',
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js',
];

// インストール: スタティックアセットをキャッシュ
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(STATIC_ASSETS).catch(() => {});
    }).then(() => self.skipWaiting())
  );
});

// アクティベート: 古いキャッシュを削除
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// フェッチ: APIリクエストはネットワーク優先、それ以外はキャッシュ優先
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // API・外部リクエストはネットワークのみ（キャッシュしない）
  if (url.pathname.startsWith('/api/') || url.hostname !== self.location.hostname) {
    // Chart.js と Google Fonts はキャッシュから返す
    if (url.hostname === 'cdn.jsdelivr.net' || url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
      event.respondWith(
        caches.match(event.request).then(cached => cached || fetch(event.request).then(res => {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
          return res;
        }))
      );
      return;
    }
    return; // APIはそのまま通す
  }

  // HTMLファイル: ネットワーク優先（最新を取得、失敗時はキャッシュ）
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(() => caches.match('/haruka.html'))
    );
    return;
  }

  // その他（アイコン等）: キャッシュ優先
  event.respondWith(
    caches.match(event.request).then(cached => cached || fetch(event.request))
  );
});
