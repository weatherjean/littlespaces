import assert from 'node:assert/strict';
export async function testDeviceLogin({ context, origin, snapshots }) {
  // Mock-only auth UX tests must not reach a live authorization endpoint.
  // WebKit service workers can bypass page routing; use a dedicated context here.
  const isolated = await context
    .browser()
    .newContext({ storageState: await context.storageState(), serviceWorkers: 'block' });
  const page = await isolated.newPage();
  page.setDefaultTimeout(15000);
  let starts = 0;
  let status = { connected: false, deviceCode: true };
  await page.route('**/api/chatgpt', (route) => route.fulfill({ json: status }));
  await page.route('**/api/chatgpt/start', async (route) => {
    starts++;
    status = {
      connected: false,
      deviceCode: true,
      login: {
        status: 'pending',
        userCode: 'TEST-1234',
        verificationUrl: 'https://auth.openai.com/codex/device',
      },
    };
    await new Promise((resolve) => setTimeout(resolve, 100));
    await route.fulfill({ json: status });
  });
  await page.route('**/api/chatgpt/cancel', (route) => {
    status = { connected: false, deviceCode: true };
    return route.fulfill({ json: { cancelled: true } });
  });
  await page.goto(`${origin}/settings`);
  const first = page.locator('.settings-content > :first-child');
  await first.getByRole('heading', { name: 'ChatGPT', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Continue with ChatGPT' }).evaluate((button) => {
    button.click();
    button.click();
  });
  await page.getByLabel('ChatGPT sign-in code').waitFor();
  assert.equal(starts, 1);
  assert.equal(new URL(page.url()).pathname, '/settings');
  assert.equal(
    await page.getByRole('link', { name: 'Open ChatGPT', exact: true }).getAttribute('href'),
    'https://auth.openai.com/codex/device',
  );
  for (const width of [320, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await page.screenshot({ path: `${snapshots}/device-signin-${width}.png`, fullPage: true });
  }
  await page.getByRole('button', { name: 'Cancel sign-in' }).click();
  await page.getByRole('button', { name: 'Continue with ChatGPT' }).waitFor();
  await page.getByRole('button', { name: 'Continue with ChatGPT' }).click();
  await page.getByLabel('ChatGPT sign-in code').waitFor();
  status = { connected: false, deviceCode: true, login: { status: 'error' } };
  await page.getByText('Sign-in expired or was declined. Please try again.').waitFor();
  await page.getByRole('button', { name: 'Continue with ChatGPT' }).click();
  await page.getByLabel('ChatGPT sign-in code').waitFor();
  status = { connected: true, planUsage: true, deviceCode: true, email: 'synthetic@example.test' };
  await page.getByRole('button', { name: 'Disconnect', exact: true }).waitFor();
  assert.equal(await page.getByLabel('ChatGPT sign-in code').count(), 0);
  await isolated.close();
}
