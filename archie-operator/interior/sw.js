// Archie Interior: shell cache + stale-while-revalidate. Bump on release.
const CACHE = 'archie-interior-v1';
const SHELL = ['.', 'index.html', '../mind-core.mjs', '../operator-core.mjs', '../model.json', 'manifest.webmanifest'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(event.request, { ignoreSearch: true });
    if (cached) {
      event.waitUntil(fetch(event.request).then(r => { if (r.ok) cache.put(event.request, r.clone()); }).catch(() => {}));
      return cached;
    }
    try {
      const r = await fetch(event.request);
      if (r.ok && new URL(event.request.url).origin === self.location.origin) cache.put(event.request, r.clone());
      return r;
    } catch { return cache.match('index.html'); }
  })());
});
