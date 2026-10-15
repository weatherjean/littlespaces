import assert from 'node:assert/strict';
export async function testPwa({ context, origin, api }) {
  const page = await context.newPage();
  await page.goto(origin);
  assert.equal(
    await page.locator('link[rel="manifest"]').getAttribute('href'),
    '/manifest.webmanifest',
  );
  assert.equal(
    await page.locator('link[rel="apple-touch-icon"]').getAttribute('href'),
    '/apple-touch-icon.png',
  );
  const manifest = await (await context.request.get(`${origin}/manifest.webmanifest`)).json();
  assert.equal(manifest.display, 'standalone');
  for (const path of [
    ...manifest.icons.map((i) => i.src),
    '/apple-touch-icon.png',
    '/favicon.ico',
  ]) {
    const response = await context.request.get(origin + path);
    assert.equal(response.status(), 200);
    assert.ok((await response.body()).length > 100);
  }
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  assert.ok(await page.evaluate(() => Boolean(navigator.serviceWorker.controller)));
  const cached = await page.evaluate(async () => {
    const names = await caches.keys();
    return (
      await Promise.all(
        names.map(async (name) =>
          (await (await caches.open(name)).keys()).map((r) => new URL(r.url).pathname),
        ),
      )
    ).flat();
  });
  assert.ok(cached.includes('/offline.html'));
  assert.ok(cached.every((p) => !p.startsWith('/api/') && !p.startsWith('/chat') && p !== '/'));
  await context.setOffline(true);
  await page.goto(`${origin}/chat`);
  await page.getByRole('heading', { name: 'Server unavailable' }).waitFor();
  await context.setOffline(false);
  await page.goto(origin);
  await api('/api/settings/push/test', {});
  await page.reload();
  await page
    .getByRole('region', { name: 'Notifications', exact: true })
    .getByText('Notifications are working', { exact: true })
    .waitFor();
  await page.getByRole('button', { name: 'Mark all read', exact: true }).click();
  await page.waitForFunction(
    () => !document.querySelector('.home-notifications [aria-label$=" unread"]'),
  );
  assert.ok((await api('/api/notifications')).every((n) => n.read));
  await page.keyboard.press('Escape');
  await page.goto(`${origin}/settings`);
  await page.getByRole('heading', { name: 'Notifications', exact: true }).waitFor();
  for (const width of [320, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    const aligned = await page.locator('.setting-icon').evaluateAll((icons) =>
      icons.every((icon) => {
        const box = icon.getBoundingClientRect(),
          glyph = icon.querySelector('svg').getBoundingClientRect();
        return (
          Math.abs(box.x + box.width / 2 - glyph.x - glyph.width / 2) < 1 &&
          Math.abs(box.y + box.height / 2 - glyph.y - glyph.height / 2) < 1
        );
      }),
    );
    assert.ok(aligned, `Settings icons centered at ${width}px`);
    await page.screenshot({
      path: new URL(`../build-rust/screenshots/settings-${width}.png`, import.meta.url).pathname,
      fullPage: true,
    });
  }

  const worker = context.serviceWorkers().find((w) => w.url() === `${origin}/service-worker.js`);
  assert.ok(worker);
  // Real installed worker; native notification presentation is a device boundary fixture.
  const notice = await worker.evaluate(async () => {
    const original = self.registration.showNotification;
    let displayed, pending;
    self.registration.showNotification = async (title, options) => {
      displayed = { title, ...options };
    };
    const event = new Event('push');
    event.data = {
      json: () => ({
        id: 'test-worker',
        title: 'Browser push verified',
        body: 'Test payload',
        href: 'https://evil.example/',
      }),
    };
    event.waitUntil = (promise) => {
      pending = promise;
    };
    try {
      self.dispatchEvent(event);
      await pending;
      return displayed;
    } finally {
      self.registration.showNotification = original;
    }
  });
  assert.equal(notice.title, 'Browser push verified');
  assert.equal(notice.body, 'Test payload');
  assert.equal(notice.icon, '/icon-192.png');
  assert.equal(notice.data.href, `${origin}/`);
  // Device subscription transport is simulated; exercise stale-key recovery and opt-out UI.
  const settings = await context.newPage();
  const updates = [];
  await settings.route('**/api/settings/push', async (route) => {
    if (route.request().method() === 'POST') {
      updates.push(route.request().postDataJSON());
      await route.fulfill({ json: { ok: true } });
    } else await route.fulfill({ json: { publicKey: 'AQID' } });
  });
  await settings.addInitScript(() => {
    window.testPush = { removed: 0, created: 0 };
    const makeSub = (key, endpoint) => ({
      endpoint,
      options: { applicationServerKey: new Uint8Array(key).buffer },
      toJSON() {
        return { endpoint, keys: { p256dh: 'fixture', auth: 'fixture' } };
      },
      async unsubscribe() {
        window.testPush.removed++;
        current = null;
        return true;
      },
    });
    let current = makeSub([9], 'https://fcm.googleapis.com/old-fixture');
    PushManager.prototype.getSubscription = async () => current;
    PushManager.prototype.subscribe = async ({ applicationServerKey }) => {
      window.testPush.created++;
      current = makeSub(Array.from(applicationServerKey), 'https://fcm.googleapis.com/new-fixture');
      return current;
    };
    Notification.requestPermission = async () => 'granted';
  });
  await settings.goto(`${origin}/settings`);
  await settings
    .getByText('Enable notifications to reconnect this device to this workspace.', { exact: true })
    .waitFor();
  await settings.getByRole('button', { name: 'Enable notifications', exact: true }).click();
  await settings.getByRole('button', { name: 'Disable notifications', exact: true }).waitFor();
  assert.deepEqual(await settings.evaluate(() => window.testPush), { removed: 1, created: 1 });
  assert.equal(updates[0].enabled, false);
  assert.equal(updates[1].subscription.endpoint, 'https://fcm.googleapis.com/new-fixture');
  await settings.reload();
  // The fixture deliberately supplies an obsolete subscription on each page load.
  await settings
    .getByText('Enable notifications to reconnect this device to this workspace.', { exact: true })
    .waitFor();
  await settings.getByRole('button', { name: 'Enable notifications', exact: true }).click();
  await settings.getByRole('button', { name: 'Disable notifications', exact: true }).click();
  await settings.getByRole('button', { name: 'Enable notifications', exact: true }).waitFor();
  assert.equal(updates.at(-1).enabled, false);
  await settings.close();
  await page.close();
  console.log(
    'PWA manifest/icons, service worker, offline fallback, private-cache exclusion, inbox and browser push handling passed',
  );
}
