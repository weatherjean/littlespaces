import assert from 'node:assert/strict';
import sharp from 'sharp';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, webkit, expect } from '@playwright/test';
const data = await mkdtemp(join(tmpdir(), 'little-spaces-full-rust-'));
const binary = process.env.RUST_BINARY || 'rust/target/debug/little-spaces';
let child, browser, activePage;
async function start() {
  child = spawn(binary, {
    env: {
      ...process.env,
      RUST_LISTEN: '127.0.0.1:0',
      RUST_DATA_DIR: data,
      CODEX_BINARY: resolve('tests/fixtures/codex-rust.mjs'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return await new Promise((resolve, reject) => {
    let output = '',
      errors = '';
    const timer = setTimeout(() => reject(Error('Server startup timed out: ' + errors)), 10000);
    child.stderr.on('data', (chunk) => (errors += chunk));
    child.stdout.on('data', (chunk) => {
      output += chunk;
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+(?:\/setup#token=[A-Za-z0-9_-]+)?/);
      if (match) {
        clearTimeout(timer);
        resolve(match[0]);
      }
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(Error(`Server exited ${code}: ${errors}`));
    });
  });
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill();
  await exited;
}
const password = 'correct horse battery fixture';
try {
  let link = await start(),
    origin = new URL(link).origin;
  assert.equal((await fetch(origin + '/api/state')).status, 401);
  assert.equal(
    (
      await fetch(origin + '/api/setup', {
        method: 'POST',
        headers: { origin: 'https://attacker.example', 'content-type': 'application/json' },
        body: '{}',
      })
    ).status,
    403,
  );
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1200, height: 850 } });
  const page = await context.newPage();
  activePage = page;
  const send = async (path, body, method = 'POST') =>
    page.evaluate(
      async ({ path, body, method }) => {
        const response = await fetch(path, {
          method,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        return { status: response.status, value: await response.json() };
      },
      { path, body, method },
    );

  const errors = [];
  page.on('requestfailed', (request) =>
    console.log('Fixture request failed:', new URL(request.url()).pathname, request.failure()),
  );
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(link);
  await page.getByLabel('Email', { exact: true }).fill('test@example.com');
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByLabel('Confirm password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await page.getByRole('heading', { name: 'Made for your everyday.' }).waitFor();
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Continue with ChatGPT' }).click();
  await page.getByText('Connected as test@example.com').waitFor();
  for (const heading of [
    'ChatGPT',
    'Read replies aloud',
    'Expert mode',
    'Apps',
    'Install LittleSpaces',
    'Device notifications',
    'Secrets',
    'Scheduled work',
    'Sessions',
  ])
    await page.getByRole('heading', { name: heading, exact: true }).waitFor();
  await page.getByRole('button', { name: 'Add secret', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('TEST_API_KEY');
  await page.getByLabel('Description', { exact: false }).fill('Fixture credential');
  await page.getByLabel('Secret value', { exact: true }).fill('fixture-secret-do-not-expose');
  await page.getByLabel('Allowed API origins', { exact: true }).fill('https://api.example.com');
  await page.getByRole('button', { name: 'Save secret', exact: true }).click();
  await page.getByText('Secret saved.', { exact: false }).waitFor();
  assert(!(await page.locator('body').innerText()).includes('fixture-secret-do-not-expose'));
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page.getByLabel('Secret value', { exact: true })).toHaveValue('');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Try voice', exact: true }).click();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await mkdir('build-rust/screenshots', { recursive: true });
  await page.screenshot({ path: 'build-rust/screenshots/settings-desktop.png', fullPage: true });
  await page.getByLabel('Expert mode', { exact: true }).check();
  await page.getByRole('link', { name: 'Chat', exact: true }).click();
  await page.getByLabel('Message', { exact: true }).waitFor();
  await page.getByLabel('Message', { exact: true }).fill('Please build a journal app');
  await page.getByRole('button', { name: 'Send message' }).click();
  await page.getByRole('button', { name: 'Build app', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Build app', exact: true }).click();
  await page.getByRole('link', { name: 'Open app', exact: true }).waitFor({ timeout: 30000 });
  await page.getByRole('link', { name: 'Open app', exact: true }).click();
  await page.getByRole('navigation', { name: 'App navigation' }).waitFor();
  await page.getByRole('button', { name: 'Chat with app', exact: true }).waitFor();
  const appPath = new URL(page.url()).pathname;
  const spaceId = appPath.split('/')[2];
  const frame = page.frameLocator('iframe[title="Your applet"]');
  await frame.getByLabel('What’s on your mind?').fill('An idea worth preserving');
  await frame.getByRole('button', { name: 'Save entry', exact: true }).click();
  await frame.getByText('An idea worth preserving', { exact: true }).waitFor();
  const palette = await page.frames()[1].evaluate(() => {
    const body = document.body;
    const original = body.className;
    const snapshot = () => ({
      background: getComputedStyle(body).backgroundColor,
      color: getComputedStyle(body).color,
    });
    body.className = '';
    const neutral = snapshot();
    body.className = 'bg-slate-900 text-slate-100';
    const utilities = snapshot();
    const style = document.createElement('style');
    style.textContent = 'body{background:#edf3ed;color:#253b35}';
    document.head.append(style);
    const authored = snapshot();
    style.remove();
    body.className = original;
    return { neutral, utilities, authored };
  });
  assert.equal(palette.neutral.background, 'rgb(255, 255, 255)');
  assert.equal(palette.utilities.background, 'oklch(0.208 0.042 265.755)');
  assert.equal(palette.authored.background, 'rgb(237, 243, 237)');
  assert.equal(palette.authored.color, 'rgb(37, 59, 53)');
  assert.equal(
    await page.frames()[1].evaluate(() => {
      try {
        void parent.document.body;
        return false;
      } catch {
        return true;
      }
    }),
    true,
  );
  await page.screenshot({ path: 'build-rust/screenshots/journal-desktop.png', fullPage: true });
  await page.getByRole('button', { name: 'Chat with app', exact: true }).click();
  await page.getByLabel('Message', { exact: true }).fill('Please add a journal entry');
  await page.getByRole('button', { name: 'Send message' }).click();
  await page.getByText('Saved your journal entry.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'App versions and tests' }).click();
  await page.getByRole('heading', { name: 'Versions & tests', exact: true }).waitFor();
  const png = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#48a070' } })
    .png()
    .toBuffer();
  await page.getByRole('button', { name: 'Attach photos', exact: true }).click();
  await page
    .locator('.chat-photo-options')
    .getByLabel('Photo file', { exact: true })
    .setInputFiles({ name: 'fixture-photo.png', mimeType: 'image/png', buffer: png });
  await page.getByRole('button', { name: 'Remove fixture-photo.png', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Remove fixture-photo.png', exact: true }).click();
  await page.getByRole('button', { name: 'Close chat', exact: true }).click();
  await frame.getByText('An idea added through chat', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'More app options' }).click();
  await page.getByRole('button', { name: 'Refresh app', exact: true }).click();
  await frame.getByText('An idea worth preserving', { exact: true }).waitFor();
  await page.getByRole('link', { name: 'Home', exact: true }).click();
  await page.getByRole('link', { name: 'Little Journal', exact: true }).waitFor();
  await page.screenshot({ path: 'build-rust/screenshots/launcher-desktop.png', fullPage: true });
  // Voice suggestions are read-only until explicitly confirmed, and confirmation is exactly once.
  await page.getByRole('link', { name: 'Voice', exact: true }).click();
  await page.getByRole('button', { name: 'Tap to talk', exact: true }).waitFor();
  const voiceChat = new URL(page.url()).pathname.split('/')[2];
  let result = await send('/api/chat', {
    requestId: crypto.randomUUID(),
    spaceId: '00000000-0000-4000-8000-000000000001',
    chatId: voiceChat,
    message: 'Add an entry',
    model: 'fixture-model',
    mode: 'voice',
  });
  assert.equal(result.status, 200);
  await page.getByRole('button', { name: 'Confirm', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await page.getByText('Done · Saved to your app', { exact: true }).waitFor();
  await page.screenshot({ path: 'build-rust/screenshots/voice-desktop.png', fullPage: true });
  await page.getByRole('link', { name: 'Back to Home' }).click();
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Archive Little Journal' }).click();
  await page.locator('.archived-apps summary').click();
  await page.getByRole('button', { name: 'Restore Little Journal' }).waitFor();
  await page.getByRole('button', { name: 'Restore Little Journal' }).click();
  await page.getByRole('button', { name: 'Archive Little Journal' }).waitFor();
  const reminder = await send(`/api/spaces/${spaceId}/notifications`, {
    key: 'fixture-reminder',
    title: 'Journal reminder',
    body: 'Check your ideas.',
  });
  assert.equal(reminder.value.result.title, 'Journal reminder');
  const scheduled = await send(`/api/spaces/${spaceId}/schedules`, {
    key: 'fixture-check',
    title: 'Scheduled journal check',
    prompt: 'Read the journal for a reminder.',
    timezone: 'Europe/Ljubljana',
    model: 'fixture-model',
    dueAt: new Date(Date.now() + 2000).toISOString(),
  });
  assert.equal(scheduled.status, 200);
  await expect
    .poll(
      async () => {
        const value = await page.evaluate(
          async () => await (await fetch('/api/notifications')).json(),
        );
        return value.notifications.some((note) => note.title === 'Scheduled reply is ready');
      },
      { timeout: 30000 },
    )
    .toBe(true);
  const template = await send('/api/applets', { template: 'plants' });
  assert.equal(template.status, 200, JSON.stringify(template.value));
  await page.goto(origin + `/spaces/${template.value.spaceId}/applet`);
  const plantFrame = page.frameLocator('iframe');
  await plantFrame.getByRole('button', { name: 'Add plant', exact: true }).click();
  await plantFrame.getByLabel('Plant name', { exact: true }).fill('Monstera');
  await plantFrame.getByRole('button', { name: 'Save plant', exact: true }).click();
  await plantFrame.getByRole('heading', { name: 'Monstera', exact: true }).waitFor();
  await plantFrame.getByRole('button', { name: 'Edit plant', exact: true }).click();
  await plantFrame.getByRole('button', { name: 'Choose or take a photo', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Photo picker', exact: true })
    .getByLabel('Photo file', { exact: true })
    .setInputFiles({ name: 'plant-fixture.png', mimeType: 'image/png', buffer: png });
  await plantFrame.getByRole('button', { name: 'Identify with ChatGPT', exact: true }).click();
  await plantFrame.getByText('Tentative fixture identification.', { exact: true }).waitFor();
  await plantFrame.getByRole('button', { name: 'Confirm & save plant', exact: true }).click();
  await plantFrame.getByRole('button', { name: 'Watered today', exact: true }).click();
  await plantFrame.getByText('Last watered', { exact: false }).waitFor();
  await page.screenshot({ path: 'build-rust/screenshots/plants-desktop.png', fullPage: true });
  await page.getByRole('link', { name: 'Home', exact: true }).click();
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Log out', exact: true }).click();
  await page.getByLabel('Email', { exact: true }).fill('test@example.com');
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByLabel('Remember me for 30 days').check();
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('heading', { name: 'Made for your everyday.' }).waitFor();
  await stop();
  link = await start();
  origin = new URL(link).origin;
  const cookies = await context.cookies();
  await context.addCookies(cookies.map((cookie) => ({ ...cookie, domain: '127.0.0.1' })));
  await page.goto(origin + appPath);
  await page
    .frameLocator('iframe')
    .getByText('An idea worth preserving', { exact: true })
    .waitFor();
  await page.frameLocator('iframe').getByText('A confirmed voice idea', { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  await context.close();
  await browser.close();
  browser = null;
  for (const engine of [chromium, webkit]) {
    browser = await engine.launch();
    const mobile = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    const phone = await mobile.newPage();
    await phone.goto(origin + '/login');
    await phone.getByLabel('Email', { exact: true }).fill('test@example.com');
    await phone.getByLabel('Password', { exact: true }).fill(password);
    await phone.getByRole('button', { name: 'Sign in', exact: true }).click();
    await phone.getByRole('link', { name: 'Little Journal', exact: true }).waitFor();
    assert(
      await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      'Launcher overflow',
    );
    await phone.screenshot({
      path: `build-rust/screenshots/launcher-${engine.name()}-mobile.png`,
      fullPage: true,
    });
    await phone.getByRole('link', { name: 'Little Journal', exact: true }).click();
    await phone.getByRole('navigation', { name: 'App navigation' }).waitFor();
    const dock = await phone.getByRole('navigation', { name: 'App navigation' }).boundingBox();
    assert(dock.y + dock.height <= 844 && dock.height >= 44, 'App dock is on screen');
    await phone
      .frameLocator('iframe')
      .getByText('An idea worth preserving', { exact: true })
      .waitFor();
    await phone.screenshot({
      path: `build-rust/screenshots/journal-${engine.name()}-mobile.png`,
      fullPage: true,
    });
    await phone.getByRole('button', { name: 'Chat with app', exact: true }).click();
    await phone.getByLabel('Message', { exact: true }).waitFor();
    await phone.screenshot({
      path: `build-rust/screenshots/app-chat-${engine.name()}-mobile.png`,
      fullPage: true,
    });
    await phone.getByRole('button', { name: 'Close chat', exact: true }).click();
    await phone.getByRole('link', { name: 'Home', exact: true }).click();
    await phone.getByRole('link', { name: 'Settings', exact: true }).click();
    await phone.getByRole('heading', { name: 'Secrets', exact: true }).waitFor();
    assert(
      await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      'Settings overflow',
    );
    await phone.screenshot({
      path: `build-rust/screenshots/settings-${engine.name()}-mobile.png`,
      fullPage: true,
    });
    await mobile.close();
    await browser.close();
    browser = null;
  }
  console.log(
    'Full Rust flow passed: setup/login, ChatGPT device sign-in, complete settings, encrypted secrets, build approval → tested QuickJS publication, app dock and scoped chat, photo upload and identification, scheduled read-only work, voice confirmation, archive/restore, remembered-session and SQLite restart persistence, desktop/mobile Chromium and WebKit.',
  );
} catch (error) {
  if (activePage && !activePage.isClosed()) {
    console.log(
      'Fixture UI at failure:',
      (await activePage.locator('body').innerText()).slice(-5000),
    );
    await activePage.screenshot({ path: 'build-rust/screenshots/failure.png', fullPage: true });
  }
  throw error;
} finally {
  await browser?.close();
  await stop();
  await rm(data, { recursive: true, force: true });
}
