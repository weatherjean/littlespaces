import { test, expect, credentials } from './fixtures';
import type { Page, TestInfo } from '@playwright/test';

async function fitsViewport(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
}
async function capture(page: Page, info: TestInfo, name: string) {
  await page.screenshot({ path: info.outputPath(`${name}.png`), fullPage: true, scale: 'css' });
  await info.attach(name, { path: info.outputPath(`${name}.png`), contentType: 'image/png' });
}

test.beforeEach(async ({ page, baseURL }) => {
  // Fail closed: browser tests never call ChatGPT or third-party services.
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    return url.origin === baseURL ? route.continue() : route.abort();
  });
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill(credentials.email);
  await page.getByLabel('Password', { exact: true }).fill(credentials.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Made for your everyday.' })).toBeVisible();
});

test('home and settings have reachable navigation and fit the screen', async ({ page }, info) => {
  await fitsViewport(page);
  const nav = page.getByRole('navigation', { name: 'Main navigation' });
  for (const link of await nav.getByRole('link').all()) {
    const box = await link.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(box!.y + box!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  }
  await capture(page, info, 'home');
  await nav.getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  await fitsViewport(page);
  await expect(nav.getByRole('link', { name: 'Settings' })).toHaveAttribute('aria-current', 'page');
  await capture(page, info, 'settings');
});

test('chat composer and conversation picker work on touch screens', async ({
  page,
  isMobile,
}, info) => {
  await page.getByRole('button', { name: 'Start a chat' }).click();
  const message = page.getByRole('textbox', { name: 'Message', exact: true });
  await expect(message).toBeVisible();
  await message.fill('A thought');
  if (isMobile) {
    await message.press('Enter');
    await expect(message).toHaveValue('A thought\n');
  }
  await fitsViewport(page);
  const send = page.getByRole('button', { name: 'Send message', exact: true });
  const box = await send.boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual(44);
  expect(box!.y + box!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  await capture(page, info, 'chat');
  await page.locator('.conversation-picker-trigger').click();
  const picker = page.getByRole('dialog', { name: 'Conversations', exact: true });
  await expect(picker).toBeVisible();
  await page.getByRole('searchbox', { name: 'Search conversations' }).fill('no-such-conversation');
  await expect(picker.locator('.picker-chat')).toHaveCount(0);
  await fitsViewport(page);
  await capture(page, info, 'conversations');
  await page.getByRole('button', { name: 'Close conversation picker' }).click();
  await expect(picker).not.toBeVisible();
  await expect(message).toHaveValue(isMobile ? 'A thought\n' : 'A thought');
});

test('app grid search, long names, and app chat fit the screen', async ({
  page,
  baseURL,
  isMobile,
}, info) => {
  for (const name of [
    'Plants',
    'Meal planner',
    'Reading list',
    'Daily habits',
    'Travel ideas',
    'Recipes',
    'A very long app name for everything I want to remember',
  ]) {
    const response = await page.request.post('/api/spaces', {
      data: { name, icon: 'leaf' },
      headers: { origin: baseURL! },
    });
    expect(response.ok(), await response.text()).toBe(true);
  }
  await page.reload();
  await fitsViewport(page);
  await capture(page, info, 'apps');
  const search = page.getByRole('searchbox', { name: 'Find an app' });
  await search.fill('Plants');
  await expect(page.locator('.app-grid a')).toHaveCount(1);
  await search.fill('no-such-app');
  await expect(page.getByRole('status')).toContainText('No apps match');
  await search.fill('Plants');
  await page.locator('.app-grid a').click();
  await page.getByRole('link', { name: 'Build it in chat' }).click();
  const dialog = page.locator('.app-chat-modal');
  await expect(dialog).toBeVisible();
  await fitsViewport(page);
  if (isMobile) {
    const bounds = await dialog.boundingBox();
    expect(bounds!.width).toBe(page.viewportSize()!.width);
    expect(bounds!.height).toBe(page.viewportSize()!.height);
  }
  await capture(page, info, 'app-chat');
});

test('notifications and voice remain usable on a phone', async ({ page }, info) => {
  await page.getByRole('button', { name: 'Open inbox' }).click();
  const inbox = page.getByRole('dialog', { name: 'Notifications', exact: true });
  await expect(inbox).toBeVisible();
  await fitsViewport(page);
  await capture(page, info, 'inbox');
  await page.getByRole('button', { name: 'Close notifications' }).click();
  await expect(inbox).not.toBeVisible();
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('link', { name: 'Voice' })
    .click();
  await expect(page.getByRole('heading', { name: 'Voice', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Tap to talk' })).toBeVisible();
  await fitsViewport(page);
  await capture(page, info, 'voice');
});
