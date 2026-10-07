const cacheName = 'little-spaces-rust-__VERSION__';
const assets = __ASSETS__;
self.addEventListener('install', (event) =>
  event.waitUntil(caches.open(cacheName).then((cache) => cache.addAll(assets))),
);
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith('little-spaces-') && key !== cacheName)
            .map((key) => caches.delete(key)),
        ),
      ),
  );
});
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (
    event.request.method !== 'GET' ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/auth/')
  )
    return;
  if (assets.includes(url.pathname))
    event.respondWith(
      caches
        .open(cacheName)
        .then(async (cache) => (await cache.match(url.pathname)) || fetch(event.request)),
    );
  else if (event.request.mode === 'navigate')
    event.respondWith(
      fetch(event.request).catch(
        async () => (await caches.match('/offline.html')) || Response.error(),
      ),
    );
});
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});
self.addEventListener('push', (event) => {
  let value = {};
  try {
    value = event.data?.json() || {};
  } catch {}
  const href =
    typeof value.href === 'string' && /^\/(chat|spaces\/)/.test(value.href) ? value.href : '/';
  event.waitUntil(
    self.registration.showNotification(value.title || 'LittleSpaces', {
      body: value.body || 'You have a new notification.',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: value.id,
      data: { href },
    }),
  );
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.href || '/', self.location.origin);
  if (url.origin !== self.location.origin) return;
  event.waitUntil(
    (async () => {
      for (const client of await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      })) {
        if (new URL(client.url).origin === url.origin) {
          await client.navigate(url.href);
          await client.focus();
          return;
        }
      }
      await self.clients.openWindow(url.href);
    })(),
  );
});
