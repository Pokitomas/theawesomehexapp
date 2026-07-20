// Archie 95 Operator: shell cache + stale-while-revalidate.
const CACHE = 'archie95-operator-v1';
const SHELL = ['.', 'index.html', '../transformer-core.mjs', '../operator-core.mjs', '../transformer-model.json', '../model.json', 'manifest.webmanifest'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => Promise.allSettled(SHELL.map(u => c.add(u)))).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith((async () => {
    const c = await caches.open(CACHE);
    const hit = await c.match(e.request, { ignoreSearch: true });
    if (hit) { e.waitUntil(fetch(e.request).then(r => { if (r.ok) c.put(e.request, r.clone()); }).catch(() => {})); return hit; }
    try { const r = await fetch(e.request); if (r.ok && new URL(e.request.url).origin === self.location.origin) c.put(e.request, r.clone()); return r; }
    catch { return c.match('index.html'); }
  })());
});
