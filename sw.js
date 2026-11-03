// sw.js — caches the app shell so the trainer works fully offline.
const CACHE = 'drum-trainer-v1';
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/styles.css',
  './js/app.js',
  './js/analyzer.js',
  './js/player.js',
  './js/roll.js',
  './js/pads.js',
  './js/settings.js',
  './js/storage.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== CACHE).map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  e.respondWith(
    caches.match(req).then(cached => {
      if (cached) return cached;
      return fetch(req).then(res => {
        // Cache same-origin runtime requests
        try {
          const url = new URL(req.url);
          if (url.origin === self.location.origin) {
            const copy = res.clone();
            caches.open(CACHE).then(c => c.put(req, copy));
          }
        } catch (_) {}
        return res;
      }).catch(() => cached);
    })
  );
});
