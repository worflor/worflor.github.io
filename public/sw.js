// woflo.dev Service Worker — zero dependencies, pure Web Standards
// Bump this to bust all caches on deploy
var CACHE = 'woflo-v1';

var SHELL = [
  '/offline',
  '/favicon.svg',
  '/images/logo.webp',
  '/fonts/InterVariable.woff2',
];

// Install: pre-cache shell assets + offline page
self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (cache) {
      return cache.addAll(SHELL);
    })
  );
  self.skipWaiting();
});

// Activate: purge old caches
self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys
          .filter(function (k) { return k !== CACHE; })
          .map(function (k) { return caches.delete(k); })
      );
    })
  );
  self.clients.claim();
});

// Fetch: network-first for pages, cache-first for assets
self.addEventListener('fetch', function (e) {
  var req = e.request;

  // Only handle GET
  if (req.method !== 'GET') return;

  // Skip cross-origin requests
  if (!req.url.startsWith(self.location.origin)) return;

  // Navigation (HTML pages) — network-first, fallback to cache, then offline page
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then(function (res) {
          var clone = res.clone();
          caches.open(CACHE).then(function (cache) { cache.put(req, clone); });
          return res;
        })
        .catch(function () {
          return caches.match(req).then(function (cached) {
            return cached || caches.match('/offline');
          });
        })
    );
    return;
  }

  // Static assets — cache-first, fallback to network (and cache the response)
  e.respondWith(
    caches.match(req).then(function (cached) {
      if (cached) return cached;
      return fetch(req).then(function (res) {
        // Only cache successful same-origin responses
        if (res.ok) {
          var clone = res.clone();
          caches.open(CACHE).then(function (cache) { cache.put(req, clone); });
        }
        return res;
      });
    })
  );
});
