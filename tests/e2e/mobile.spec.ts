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

test('Chat and Voice entries start fresh while saved history and reloads retain their chat', async ({
  page,
}, info) => {
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('link', { name: 'Chat', exact: true })
    .click();
  await expect(page).toHaveURL(/\/chat\/[0-9a-f-]+$/);
  const savedURL = page.url();
  const note = `Remember this note from ${info.project.name}`;
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill(note);
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.locator('.message:not(.from-user)')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'New chat', exact: true })).toBeEnabled();
  await page.reload();
  expect(page.url()).toBe(savedURL);
  await expect(page.locator('.message.from-user')).toContainText(note);
  await page.getByRole('link', { name: 'Back to Home', exact: true }).click();
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('link', { name: 'Chat', exact: true })
    .click();
  await expect(page).toHaveURL(/\/chat\/[0-9a-f-]+$/);
  const freshURL = page.url();
  expect(freshURL).not.toBe(savedURL);
  await expect(page.locator('.message')).toHaveCount(0);
  await page.locator('.conversation-picker-trigger').click();
  await page
    .getByRole('dialog', { name: 'Conversations', exact: true })
    .getByRole('button', { name: new RegExp(note) })
    .click();
  await expect(page).toHaveURL(savedURL);
  await expect(page.locator('.message.from-user')).toContainText(note);
  await page.getByRole('link', { name: 'Back to Home', exact: true }).click();
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('link', { name: 'Voice', exact: true })
    .click();
  await expect(page).toHaveURL(/\/voice\/[0-9a-f-]+$/);
  const firstVoiceURL = page.url();
  expect(firstVoiceURL.split('/').pop()).not.toBe(savedURL.split('/').pop());
  await expect(page.locator('.message')).toHaveCount(0);
  await page.getByRole('link', { name: 'Back to Home', exact: true }).click();
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('link', { name: 'Voice', exact: true })
    .click();
  await expect(page).toHaveURL(/\/voice\/[0-9a-f-]+$/);
  expect(page.url()).not.toBe(firstVoiceURL);
  await expect(page.locator('.message')).toHaveCount(0);
});

test('compact composer grows, retains drafts through options, and fits a shorter viewport', async ({
  page,
  isMobile,
}, info) => {
  await page.getByRole('button', { name: 'Start a chat' }).click();
  const message = page.getByRole('textbox', { name: 'Message', exact: true });
  await expect(message).toBeVisible();
  const small = await message.boundingBox();
  const draft = 'First line\nSecond line\nThird line\nFourth line';
  await message.fill(draft);
  await expect
    .poll(async () => (await message.boundingBox())!.height)
    .toBeGreaterThan(small!.height);
  await page.getByRole('button', { name: 'Chat options', exact: true }).click();
  const options = page.getByRole('dialog', { name: 'Chat options', exact: true });
  await expect(options).toBeVisible();
  await expect(options.getByRole('combobox', { name: 'Model', exact: true })).toHaveValue(
    'test-model',
  );
  await page.getByRole('button', { name: 'Close chat options' }).click();
  await expect(message).toHaveValue(draft);
  await expect(page.getByRole('button', { name: 'Chat options', exact: true })).toBeFocused();
  if (isMobile) {
    await page.setViewportSize({ width: page.viewportSize()!.width, height: 360 });
    await fitsViewport(page);
    const send = page.getByRole('button', { name: 'Send message', exact: true });
    await expect
      .poll(async () => {
        const bounds = await send.boundingBox();
        return bounds!.y + bounds!.height;
      })
      .toBeLessThanOrEqual(360);
    const header = await page.locator('.chat-header').boundingBox();
    expect(header!.y).toBeGreaterThanOrEqual(0);
    await capture(page, info, 'short-chat');
  }
});

test('visible viewport fallback keeps the composer above a simulated keyboard without disabling zoom', async ({
  page,
  isMobile,
}) => {
  test.skip(!isMobile, 'Keyboard fallback is mobile-specific');
  await page.addInitScript(() => {
    const viewport = Object.assign(new EventTarget(), {
      height: window.innerHeight,
      offsetTop: 0,
      scale: 1,
    });
    Object.defineProperty(window, 'visualViewport', { value: viewport, configurable: true });
  });
  await page.goto('/chat');
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
  await expect
    .poll(() =>
      page
        .locator('.mobile-chat')
        .evaluate((node) => (node as HTMLElement).style.getPropertyValue('--chat-viewport-height')),
    )
    .not.toBe('');
  await page.evaluate(() => {
    Object.assign(window.visualViewport!, { height: 320, offsetTop: 40 });
    window.visualViewport!.dispatchEvent(new Event('resize'));
  });
  const shell = page.locator('.mobile-chat');
  await expect.poll(async () => (await shell.boundingBox())!.height).toBe(320);
  expect((await shell.boundingBox())!.y).toBe(40);
  const send = await page.getByRole('button', { name: 'Send message', exact: true }).boundingBox();
  expect(send!.y + send!.height).toBeLessThanOrEqual(360);
  await page.locator('.conversation-picker-trigger').click();
  const picker = page.getByRole('dialog', { name: 'Conversations', exact: true });
  await expect(picker).toBeVisible();
  const pickerBounds = await picker.boundingBox();
  expect(pickerBounds!.y).toBeGreaterThanOrEqual(40);
  expect(pickerBounds!.y + pickerBounds!.height).toBeLessThanOrEqual(360);
  const searchBounds = await page
    .getByRole('searchbox', { name: 'Search conversations' })
    .boundingBox();
  expect(searchBounds!.y + searchBounds!.height).toBeLessThanOrEqual(360);
  await page.getByRole('button', { name: 'Close conversation picker' }).click();

  await page.evaluate(() => {
    Object.assign(window.visualViewport!, { scale: 2 });
    window.visualViewport!.dispatchEvent(new Event('resize'));
  });
  await expect
    .poll(() =>
      shell.evaluate((node) =>
        (node as HTMLElement).style.getPropertyValue('--chat-viewport-height'),
      ),
    )
    .toBe('');
});

test('reading earlier messages survives viewport changes and Latest returns to the bottom', async ({
  page,
}, info) => {
  await page.getByRole('button', { name: 'Start a chat' }).click();
  const message = page.getByRole('textbox', { name: 'Message', exact: true });
  await message.fill('An earlier line of conversation to read.\n'.repeat(80));
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.locator('.message:not(.from-user)')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'New chat', exact: true })).toBeEnabled();
  const transcript = page.locator('.transcript');
  await transcript.evaluate((node) => node.scrollTo({ top: 0, behavior: 'instant' }));
  const latest = page.getByRole('button', { name: 'Latest messages', exact: true });
  await expect(latest).toBeVisible();
  await page.setViewportSize({ width: page.viewportSize()!.width, height: 480 });
  await expect.poll(() => transcript.evaluate((node) => node.scrollTop)).toBe(0);
  await capture(page, info, 'reading-history');
  await latest.click();
  await expect(latest).not.toBeVisible();
  await expect
    .poll(() =>
      transcript.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight),
    )
    .toBeLessThan(2);
});
