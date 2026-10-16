import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import path from 'node:path';
export async function testImages({ context, origin, api, snapshots, app }) {
  const page = await context.newPage();
  await page.route('**/api/chatgpt', (r) =>
    r.fulfill({ json: { connected: true, planUsage: true } }),
  );
  await page.route('**/api/models', (r) =>
    r.fulfill({ json: [{ slug: 'fixture', display_name: 'Fixture model' }] }),
  );
  const conversation = (await api('/api/conversations', { app })).conversation;
  await page.goto(`${origin}/chat/${conversation}`);
  await page.getByLabel('Message', { exact: true }).waitFor();
  const input = page.getByLabel('Attach images', { exact: true });
  // Reconnecting the same conversation must not discard an in-flight upload.
  await page.route('**/api/images', async (route) => {
    const response = await route.fetch();
    const refreshed = page.waitForResponse(
      (value) => new URL(value.url()).pathname === `/api/conversations/${conversation}/info`,
    );
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await refreshed;
    await route.fulfill({ response });
  });
  await input.setInputFiles(fileURLToPath(new URL('../static/icon-192.png', import.meta.url)));
  await page.getByRole('button', { name: 'Remove icon-192.png', exact: true }).waitFor();
  await page.unroute('**/api/images');
  await page.getByRole('button', { name: 'Remove icon-192.png', exact: true }).click();
  assert.equal(await page.locator('.attachment').count(), 0);
  await input.setInputFiles(fileURLToPath(new URL('../static/icon-192.png', import.meta.url)));
  await page.getByRole('button', { name: 'Remove icon-192.png', exact: true }).waitFor();
  await page.route('**/send', (r) => r.fulfill({ status: 503, json: { error: 'model' } }));
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'unexpected response' }).waitFor();
  assert.equal(await page.locator('.attachment').count(), 1);
  await page.unroute('**/send');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.getByText('Reply: Received 1 image with actual pixel data', { exact: true }).waitFor();
  assert.equal(await page.locator('.attachment').count(), 0);
  const messages = await api(`/api/conversations/${conversation}`);
  const id = messages.find((m) => m.images?.length).images[0];
  assert.ok((await api(`/api/apps/${app}/images`)).some((image) => image.id === id));
  await page.reload();
  await page.getByAltText('Attached image', { exact: true }).waitFor();
  assert.ok(
    await page
      .getByAltText('Attached image', { exact: true })
      .evaluate((image) => image.complete && image.naturalWidth > 0),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(snapshots, 'review-image-chat-390.png') });
  await page.goto(`${origin}/apps/${app}`);
  const frame = page.frameLocator('iframe[title="Applet"]');
  const image = await frame.locator('body').evaluate(async (_, id) => window.applet.image(id), id);
  assert.ok(image.dataUrl.startsWith('data:image/jpeg;base64,'));
  const listed = await frame.locator('body').evaluate(() => window.applet.images());
  assert.ok(listed.some((image) => image.id === id));
  const uploaded = await frame
    .locator('body')
    .evaluate(
      async (_, dataUrl) => window.applet.uploadImage(dataUrl, 'App upload'),
      image.dataUrl,
    );
  assert.ok((await api(`/api/apps/${app}/images`)).some((image) => image.id === uploaded.id));
  await page.close();
  console.log(
    'Image upload/remove, failed-send recovery, persisted thumbnails, model image payload and scoped app bridge passed',
  );
}
