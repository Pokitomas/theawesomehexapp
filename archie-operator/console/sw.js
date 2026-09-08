// Archie Console: app-shell cache with stale-while-revalidate. Bump on release.
const CACHE = 'archie-console-v1';
const SHELL = ['.', 'index.html', 'manifest.webmanifest',
  '../operator-core.mjs', '../register-router.mjs', '../transformer-core.mjs',
  '../model.json', '../transformer-model.json'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE)
    // Model files are large and optional; never fail the install on them.
    .then(cache => Promise.allSettled(SHELL.map(url => cache.add(url))))
    .then(() => self.skipWaiting()));
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
      event.waitUntil(fetch(event.request)
        .then(r => { if (r.ok) cache.put(event.request, r.clone()); })
        .catch(() => {}));
      return cached;
    }
    try {
      const response = await fetch(event.request);
      if (response.ok && new URL(event.request.url).origin === self.location.origin) {
        cache.put(event.request, response.clone());
      }
      return response;
    } catch {
      return (await cache.match('index.html')) || Response.error();
    }
  })());
});
