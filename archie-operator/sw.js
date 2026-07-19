// Archie Local Operator: app-shell cache plus stale-while-revalidate model refresh.
const CACHE = 'archie-operator-v3';
const SHELL = ['.', 'index.html', 'operator-core.mjs', 'model.json', 'manifest.webmanifest'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(event.request, { ignoreSearch: true });
    if (cached) {
      event.waitUntil(fetch(event.request).then(response => {
        if (response.ok) return cache.put(event.request, response.clone());
      }).catch(() => {}));
      return cached;
    }
    try {
      const response = await fetch(event.request);
      if (response.ok && new URL(event.request.url).origin === self.location.origin) cache.put(event.request, response.clone());
      return response;
    } catch {
      return cache.match('index.html');
    }
  })());
});
