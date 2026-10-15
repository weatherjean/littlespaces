const CACHE = 'little-spaces-public-v1';
const PUBLIC = [
  '/offline.html',
  '/icon.svg',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-512.png',
  '/apple-touch-icon.png',
  '/manifest.webmanifest',
];
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PUBLIC))
      .then(() => self.skipWaiting()),
  );
});
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith('little-spaces') && key !== CACHE)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});
self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  // Never persist account data, app content, API responses, or authenticated pages.
  if (PUBLIC.includes(url.pathname)) {
    event.respondWith(fetch(request).catch(() => caches.match(url.pathname)));
  } else if (
    request.mode === 'navigate' &&
    !url.pathname.startsWith('/api/') &&
    !url.pathname.startsWith('/auth/')
  ) {
    event.respondWith(fetch(request).catch(() => caches.match('/offline.html')));
  }
});
function destination(value) {
  try {
    const url = new URL(value || '/', self.location.origin);
    if (
      url.origin === self.location.origin &&
      /^\/(?:$|chat(?:\/|$)|apps(?:\/|$))/.test(url.pathname)
    )
      return url.href;
  } catch {}
  return self.location.origin + '/';
}
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data?.json() || {};
  } catch {}
  event.waitUntil(
    self.registration.showNotification(data.title || 'LittleSpaces', {
      body: data.body || 'Something is ready in your workspace.',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: data.id,
      data: { href: destination(data.href) },
    }),
  );
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const href = destination(event.notification.data?.href);
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (clients) => {
      for (const client of clients) {
        if (new URL(client.url).origin === self.location.origin) {
          await client.navigate(href);
          return client.focus();
        }
      }
      return self.clients.openWindow(href);
    }),
  );
});
