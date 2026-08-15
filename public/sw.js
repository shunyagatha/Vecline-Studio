/**
 * Service worker — makes Vecline Studio installable and fully offline.
 *
 * The whole app is static and the engine runs client-side, so once these files
 * are cached the studio works with no network at all. That is not a nicety: it
 * is the strongest possible proof of the privacy claim — a tool that converts
 * your artwork while offline cannot be uploading it.
 *
 * Strategy: network-first with a cache fallback. The cache is the offline safety
 * net, not the source of truth. Cache-first was the wrong call here: the bundle
 * filenames (app.js, worker.js) are stable across builds, so a returning online
 * visitor was served the previous build from cache and only picked up new code on
 * a second reload — a stale-deploy bug that is invisible until someone hits it.
 * Fetching from the network first means an online visitor always runs the code we
 * just shipped; when the network is gone we fall back to the cache, so the offline
 * guarantee — and the privacy proof that rests on it — is untouched.
 */

const CACHE = 'vecline-studio-__BUILD_ID__';
const SHELL = [
  './',
  './index.html',
  './compare.html',
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
    fetch(request)
      .then((res) => {
        // Warm the cache with what we just fetched, so the next offline load has it.
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(request, copy)).catch(() => {});
        return res;
      })
      // Offline (or the server is down): serve the cached copy, and for a
      // navigation with nothing cached, fall back to the app shell.
      .catch(() => caches.match(request).then((hit) => hit ?? caches.match('./index.html'))),
  );
});
