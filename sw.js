/* CalGencha service worker: keeps the tools working offline.
   Bump VERSION whenever you publish new files so visitors get them. */
const VERSION = 'calgencha-v10-11';
const SHELL = ['./', 'index.html', 'gancha.html', 'SpendTracker.html', 'HabitTracker.html', 'profile.js', 'dashboard.js', 'license.html', 'manifest.webmanifest',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'];
const CROSS = ['fonts.googleapis.com', 'fonts.gstatic.com', 'cdnjs.cloudflare.com'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION)
    .then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => {}))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

/* Network first for this site's own files, so every visit gets the newest version when online (4 second limit,
   then the saved copy is used, so it still works offline). Fonts and the PDF library come from the cache first. */
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const same = url.origin === self.location.origin;
  if (!same && !CROSS.includes(url.hostname)) return;
  e.respondWith(caches.open(VERSION).then(async (cache) => {
    const fresh = fetch(req, same ? { cache: 'no-cache' } : undefined).then((res) => {
      if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
      return res;
    }).catch(() => null);
    if (!same) {
      const hit = await cache.match(req);
      if (hit) { e.waitUntil(fresh); return hit; }
      return (await fresh) || Response.error();
    }
    const quick = await Promise.race([fresh, new Promise((r) => setTimeout(() => r(null), 4000))]);
    if (quick) return quick;
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) { e.waitUntil(fresh); return hit; }
    const late = await fresh;
    if (late) return late;
    if (req.mode === 'navigate') return (await cache.match('index.html')) || Response.error();
    return Response.error();
  }));
});
