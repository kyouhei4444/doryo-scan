/* ============================================================
   sw.js  オフライン動作
   このアプリは外部の地図やAPIを使わないので、本体を入れておけば
   圏外の現場でもそのまま動く。
   更新を早く反映したいときは APP_CACHE の版数を上げる。
   ============================================================ */
var APP_CACHE = 'doryo-app-v2';

var SHELL = [
  './',
  './index.html',
  './css/style.css',
  './js/geom.js',
  './js/grid.js',
  './js/volume.js',
  './js/mesh.js',
  './js/scan.js',
  './js/render.js',
  './js/view3d.js',
  './js/store.js',
  './js/exporter.js',
  './js/app.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(APP_CACHE).then(function (c) {
      // 1件でも失敗すると全体が失敗するので個別に入れる
      return Promise.all(SHELL.map(function (u) {
        return c.add(new Request(u, { cache: 'reload' })).catch(function (err) {
          console.warn('[SW] キャッシュ失敗:', u, err);
        });
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) { if (k !== APP_CACHE) return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) return;

  // キャッシュ優先 + 背後で更新（現場では通信が細いので表示を止めない）
  e.respondWith(
    caches.match(req).then(function (hit) {
      var net = fetch(req).then(function (res) {
        if (res && res.ok) {
          var copy = res.clone();
          caches.open(APP_CACHE).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () { return hit; });
      return hit || net;
    })
  );
});
