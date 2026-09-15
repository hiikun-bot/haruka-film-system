// v3: chart.js を cdn.jsdelivr.net から自オリジン /js/vendor/chart.umd.js に切り替え（旧 CDN エントリを捨てる）。
// /js/vendor/chart.umd.js は URL にバージョンを含まずキャッシュ優先で返すため、chart.js を更新するときは
// package.json と一緒にこの CACHE_NAME も上げること（上げないと旧ビルドが SW キャッシュから返り続ける）。
const CACHE_NAME = 'haruka-film-v3';

// キャッシュするスタティックリソース（アプリシェル）
// 注意: /haruka.html は認証必須ページのため SW キャッシュ対象から除外する
// （未ログイン時に addAll が失敗し SW install ごと壊れる事故を防ぐ）
const STATIC_ASSETS = [
  '/HARUKA%20FILM%20%E3%83%AD%E3%82%B4.png',
  '/manifest.json',
  'https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@300;400;500;700&family=Montserrat:wght@700;800;900&display=swap',
  '/js/vendor/chart.umd.js',
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
    // Google Fonts はキャッシュから返す（chart.js は自オリジン配信になったので下の「その他」キャッシュ優先経路を通る）
    if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
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

  // HTMLファイル: ネットワークのみ（認証必須のためキャッシュにフォールバックしない）
  // 古い SW v1 が /haruka.html をキャッシュしていたため、シークレットモードでないと
  // 動作しない不具合があった。v2 では navigate を一切キャッシュ介在させない。
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request));
    return;
  }

  // その他（アイコン等）: キャッシュ優先
  event.respondWith(
    caches.match(event.request).then(cached => cached || fetch(event.request))
  );
});
