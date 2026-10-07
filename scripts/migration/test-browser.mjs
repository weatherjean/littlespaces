import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, webkit } from '@playwright/test';
const data = await mkdtemp(join(tmpdir(), 'little-spaces-rust-test-'));
let child, browser;
const binary = process.env.RUST_BINARY || 'rust/target/debug/little-spaces';
async function start() {
  child = spawn(binary, {
    env: { ...process.env, RUST_LISTEN: '127.0.0.1:0', RUST_DATA_DIR: data },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return await new Promise((resolve, reject) => {
    let output = '',
      errors = '';
    const timer = setTimeout(() => reject(Error('Server startup timed out: ' + errors)), 10000);
    child.stderr.on('data', (chunk) => {
      errors += chunk;
    });
    child.stdout.on('data', (chunk) => {
      output += chunk;
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+\/auth\?token=[a-f0-9]+/);
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
try {
  let link = await start();
  let origin = new URL(link).origin;
  assert.equal((await fetch(origin + '/api/spaces')).status, 401);
  assert.equal((await fetch(origin + '/auth?token=invalid', { redirect: 'manual' })).status, 401);
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1200, height: 850 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(link);
  await page.getByRole('heading', { name: 'Made for your everyday.' }).waitFor();
  await page.getByRole('link', { name: 'Little Journal' }).waitFor();
  const cookies = await context.cookies();
  const cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  const action = (body) =>
    fetch(origin + '/api/applets/journal/actions', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', origin },
      body: JSON.stringify(body),
    });
  assert.equal(
    (
      await fetch(origin + '/api/applets/journal/actions', {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json', origin: 'https://attacker.example' },
        body: '{"action":"list"}',
      })
    ).status,
    403,
  );
  assert.equal((await action({ action: 'add', input: { text: ' ' } })).status, 400);
  const before = await (await action({ action: 'list' })).json();
  assert.deepEqual(before.result, [], JSON.stringify(before));
  await mkdir('build-rust/screenshots', { recursive: true });
  await page.screenshot({ path: 'build-rust/screenshots/launcher-desktop.png', fullPage: true });
  await page.getByRole('link', { name: 'Little Journal' }).click();
  const frame = page.frameLocator('iframe[title="Your applet"]');
  await frame.getByLabel('What’s on your mind?').fill('An idea worth preserving');
  await frame.getByRole('button', { name: 'Save entry', exact: true }).click();
  await frame.getByText('An idea worth preserving', { exact: true }).waitFor();
  const isolated = await page.frames()[1].evaluate(() => {
    let parentBlocked = false;
    try {
      void parent.document.body;
    } catch {
      parentBlocked = true;
    }
    return { parentBlocked, frameOrigin: location.origin };
  });
  assert.equal(isolated.parentBlocked, true);
  assert.equal(await page.locator('iframe').getAttribute('sandbox'), 'allow-scripts allow-forms');
  await page.screenshot({ path: 'build-rust/screenshots/journal-desktop.png', fullPage: true });
  await page.getByRole('link', { name: 'Back to apps' }).click();
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByRole('heading', { name: 'Voice on this device' }).waitFor();
  await page.getByRole('button', { name: 'Try voice' }).click();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  assert.deepEqual(errors, []);
  await stop();
  link = await start();
  origin = new URL(link).origin;
  await page.goto(link);
  await page.getByRole('link', { name: 'Little Journal' }).click();
  await page
    .frameLocator('iframe')
    .getByText('An idea worth preserving', { exact: true })
    .waitFor();
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
    await phone.goto(link);
    await phone.getByRole('link', { name: 'Little Journal' }).waitFor();
    assert(
      await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      'Launcher overflow',
    );
    await phone.screenshot({
      path: `build-rust/screenshots/launcher-${engine.name()}-mobile.png`,
      fullPage: true,
    });
    await phone.getByRole('link', { name: 'Little Journal' }).click();
    await phone
      .frameLocator('iframe')
      .getByText('An idea worth preserving', { exact: true })
      .waitFor();
    assert(
      await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      'Applet page overflow',
    );
    await mobile.close();
    await browser.close();
    browser = null;
  }
  console.log(
    'Rust browser checks passed: auth, origin checks, isolated QuickJS action, SQLite restart persistence, device speech controls, desktop and mobile Chromium/WebKit.',
  );
} finally {
  await browser?.close();
  await stop();
  await rm(data, { recursive: true, force: true });
}
