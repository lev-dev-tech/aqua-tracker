/* Aqua service worker — offline app shell + notifications (PWA). */
const CACHE = 'aqua-v10';
const CORE = [
  './', './index.html', './styles.css', './app.js', './manifest.json',
  './assets/icon-192.png', './assets/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  // Never touch POST (the /proxy calls) or cross-origin (API/images/fonts).
  if (e.request.method !== 'GET') return;
  const u = new URL(e.request.url);
  if (u.origin !== location.origin) return;
  // Network-first for the app's own code + data so a new release is picked up on the next
  // online load (no more serving stale app.js forever); falls back to cache when offline.
  // Static images stay cache-first (fast, rarely change).
  const isImage = /\.(png|jpg|jpeg|svg|webp|ico|gif)$/i.test(u.pathname);
  if (isImage) {
    e.respondWith(
      caches.match(e.request).then((hit) => hit || fetch(e.request).then((resp) => {
        const cp = resp.clone(); caches.open(CACHE).then((c) => c.put(e.request, cp)); return resp;
      }))
    );
    return;
  }
  e.respondWith(
    fetch(e.request).then((resp) => {
      const cp = resp.clone();
      caches.open(CACHE).then((c) => c.put(e.request, cp)); // refresh cache with the latest
      return resp;
    }).catch(() => caches.match(e.request).then((hit) => hit || caches.match('./index.html')))
  );
});

// Page can ask the SW to activate immediately (after a new version is detected).
self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'skipWaiting') self.skipWaiting();
});

// Page asks SW to show a notification (works when the window is backgrounded).
self.addEventListener('message', (e) => {
  const d = e.data || {};
  if (d.type === 'notify') {
    self.registration.showNotification(d.title || 'Aqua', {
      body: d.body || '', icon: './assets/icon-192.png', badge: './assets/icon-192.png',
      tag: 'aqua-water', renotify: true,
    });
  }
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((ws) => {
      for (const w of ws) { if ('focus' in w) return w.focus(); }
      if (self.clients.openWindow) return self.clients.openWindow('./index.html');
    })
  );
});
