// woflo.dev Service Worker — zero dependencies, pure Web Standards
// Bump this to bust all caches on deploy
var CACHE = 'woflo-v2';

var SHELL = [
  '/offline',
  '/favicon.svg',
  '/images/logo.webp',
  '/fonts/InterVariable.woff2',
];

/** @type {ServiceWorkerGlobalScope} */
var sw = /** @type {any} */ (self);

// Install: pre-cache shell assets + offline page
sw.addEventListener('install', function (e) {
  e.waitUntil((async function () {
    var cache = await caches.open(CACHE);
    await cache.addAll(SHELL);
  })());
  sw.skipWaiting();
});

// Activate: purge old caches
sw.addEventListener('activate', function (e) {
  e.waitUntil((async function () {
    var keys = await caches.keys();
    await Promise.all(
      keys
        .filter(function (k) { return k !== CACHE; })
        .map(function (k) { return caches.delete(k); })
    );
  })());
  sw.clients.claim();
});

// Fetch: network-first for pages, cache-first for assets
sw.addEventListener('fetch', function (e) {
  var req = e.request;

  // Only handle GET
  if (req.method !== 'GET') return;

  // Skip cross-origin requests
  if (!req.url.startsWith(sw.location.origin)) return;

  // Navigation (HTML pages) — network-first, fallback to cache, then offline page
  if (req.mode === 'navigate') {
    e.respondWith((async function () {
      try {
        var res = await fetch(req);
        try {
          var cache = await caches.open(CACHE);
          await cache.put(req, res.clone());
        } catch (cacheErr) {}
        return res;
      } catch (networkErr) {
        var cached = await caches.match(req);
        return cached || caches.match('/offline');
      }
    })());
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
