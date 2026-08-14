/**
 * Service worker — makes Vecline Studio installable and fully offline.
 *
 * The whole app is static and the engine runs client-side, so once these files
 * are cached the studio works with no network at all. That is not a nicety: it
 * is the strongest possible proof of the privacy claim — a tool that converts
 * your artwork while offline cannot be uploading it.
 *
 * Strategy: cache-first for the app shell (it is versioned by BUILD_ID, so a
 * new deploy gets a new cache and the old one is dropped).
 */

const CACHE = 'vecline-studio-__BUILD_ID__';
const SHELL = [
  './',
  './index.html',
  './app.js',
  './worker.js',
  './manifest.webmanifest',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  // Only same-origin GETs are ours to answer; the app never calls anything else.
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;

  event.respondWith(
    caches.match(request).then((hit) => hit ?? fetch(request).then((res) => {
      // Keep the cache warm for anything new we legitimately fetched.
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(request, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match('./index.html'))),
  );
});
