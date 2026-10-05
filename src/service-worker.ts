/// <reference lib="webworker" />
import { build, files, version } from '$service-worker';

const worker = self as unknown as ServiceWorkerGlobalScope;
const cacheName = `little-spaces-${version}`;
const assets = [...build, ...files];
worker.addEventListener('install', (event) => {
  event.waitUntil(caches.open(cacheName).then((cache) => cache.addAll(assets)));
});
worker.addEventListener('activate', (event) => {
  event.waitUntil(worker.clients.claim());
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
worker.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (
    event.request.method !== 'GET' ||
    url.origin !== worker.location.origin ||
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/auth/')
  )
    return;
  if (assets.includes(url.pathname)) {
    event.respondWith(
      caches
        .open(cacheName)
        .then(async (cache) => (await cache.match(url.pathname)) || fetch(event.request)),
    );
  } else if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(
        async () => (await caches.match('/offline.html')) || Response.error(),
      ),
    );
  }
});

worker.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') void worker.skipWaiting();
});
worker.addEventListener('push', (event) => {
  let value: { title?: string; body?: string; href?: string; id?: string } = {};
  try {
    value = event.data?.json() || {};
  } catch {
    /* Show a generic notification. */
  }
  const href =
    typeof value.href === 'string' && /^\/(chat|spaces\/)/.test(value.href) ? value.href : '/';
  event.waitUntil(
    worker.registration.showNotification(value.title || 'LittleSpaces', {
      body: value.body || 'You have a new notification.',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: value.id,
      data: { href },
    }),
  );
});
worker.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.href || '/', worker.location.origin);
  if (url.origin !== worker.location.origin) return;
  event.waitUntil(
    (async () => {
      const clients = await worker.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of clients) {
        if (new URL(client.url).origin === url.origin) {
          await client.navigate(url.href);
          await client.focus();
          return;
        }
      }
      await worker.clients.openWindow(url.href);
    })(),
  );
});
