import { test, expect, credentials } from './fixtures';

test('compact dock opens fresh app chats with live context, guidance and preserved UI drafts', async ({
  page,
  baseURL,
}, info) => {
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill(credentials.email);
  await page.getByLabel('Password', { exact: true }).fill(credentials.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Made for your everyday.' })).toBeVisible();
  const post = async (path: string, data: object) => {
    const response = await page.request.post(path, { data, headers: { origin: baseURL! } });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const { applet } = await post('/api/applets', { template: 'plants' });
  const { result: plant } = await post(`/api/applets/${applet.id}/actions`, {
    action: 'addPlant',
    input: { name: 'Context fern', interval: 7 },
  });
  await page.goto(`/spaces/${applet.id}/applet`);
  const frame = page.frameLocator('iframe[title="Your applet"]');
  await expect(frame.getByRole('heading', { name: 'Context fern' })).toBeVisible();
  await expect(frame.getByRole('button', { name: /Add with chat/ })).toHaveCount(0);
  await frame.getByRole('button', { name: 'Select plant', exact: true }).click();
  const dock = page.getByRole('navigation', { name: 'App navigation' });
  await expect(dock.getByRole('link', { name: 'Home', exact: true })).toBeVisible();
  await expect(dock.locator('.dock-app-icon')).not.toContainText('Plant care');
  for (const control of await dock.locator('a,button').all()) {
    const box = await control.boundingBox();
    expect(box!.width).toBeGreaterThanOrEqual(44);
    expect(box!.height).toBeGreaterThanOrEqual(44);
  }
  await page.screenshot({ path: info.outputPath('compact-dock.png'), fullPage: true });
  await dock.getByRole('button', { name: 'More app options' }).click();
  await expect(page.locator('.app-options')).toBeVisible();
  await expect(
    page.locator('.app-options').getByRole('button', { name: 'Refresh app' }),
  ).toBeVisible();
  await expect(
    page.locator('.app-options').getByRole('button', { name: /Notifications,/ }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Close app options' }).click();
  await dock.getByRole('button', { name: 'Chat with app', exact: true }).click();
  const first = page.url();
  const chat = page.locator('.app-chat-modal');
  await expect(chat).toBeVisible();
  await expect(chat.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue('');
  await expect(chat.locator('.message')).toHaveCount(0);
  await expect(chat.locator('.chat-context')).toContainText('selected record');
  await page.getByRole('button', { name: 'Close chat' }).click();
  await frame.getByRole('button', { name: 'Edit plant', exact: true }).click();
  await frame.getByLabel('Plant name', { exact: true }).fill('Unsaved monstera');
  await post(`/api/applets/${applet.id}/actions`, {
    action: 'updatePlant',
    input: { key: plant.key, name: 'Context fern', interval: 12, location: 'Window' },
  });
  await dock.getByRole('button', { name: 'Chat with app', exact: true }).click();
  await expect(page).not.toHaveURL(first);
  await expect(chat.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue('');
  let submitted: any;
  page.on('request', (request) => {
    if (request.url().endsWith('/api/chat') && request.method() === 'POST')
      submitted = request.postDataJSON();
  });
  await chat.getByRole('textbox', { name: 'Message', exact: true }).fill('inspect-current-context');
  await chat.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(chat.locator('.message').last()).toContainText('"guidance":true');
  await expect(chat.locator('.message').last()).toContainText('"location":"Window"');
  await expect(chat.locator('.message').last()).toContainText('Unsaved monstera');
  expect(submitted.appContext.appletId).toBe(applet.id);
  expect(submitted.appContext.view.recordKeys).toEqual([plant.key]);
  await expect(chat.getByRole('button', { name: 'New chat', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Close chat' }).click();
  await expect(frame.getByLabel('Plant name', { exact: true })).toHaveValue('Unsaved monstera');
  await expect(frame.getByText('Window', { exact: true })).toBeVisible();
  await dock.getByRole('button', { name: 'Chat with app', exact: true }).click();
  await expect(chat.locator('.message')).toHaveCount(0);
  await chat.locator('.conversation-picker-trigger').click();
  const previous = page
    .getByRole('dialog', { name: 'Conversations', exact: true })
    .locator('.picker-chat')
    .filter({ hasText: 'inspect-current-context' });
  await expect(previous).toBeVisible();
  await previous.click();
  await expect(chat.locator('.message')).toHaveCount(2);
  await expect(chat.locator('.message').last()).toContainText('"guidance":true');
  await page.getByRole('button', { name: 'Close chat' }).click();
  await dock.getByRole('button', { name: 'More app options' }).click();
  await page.locator('.app-options').getByRole('button', { name: 'Refresh app' }).click();
  await expect(frame.getByRole('heading', { name: 'Context fern' })).toBeVisible();
  await expect(frame.getByLabel('Plant name', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test('a saved completed reply does not blank the applet on first navigation from Home', async ({
  page,
  baseURL,
}) => {
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill(credentials.email);
  await page.getByLabel('Password', { exact: true }).fill(credentials.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const post = async (path: string, data: object) => {
    const response = await page.request.post(path, { data, headers: { origin: baseURL! } });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const { applet } = await post('/api/applets', { template: 'plants' });
  await post(`/api/applets/${applet.id}/actions`, {
    action: 'addPlant',
    input: { name: 'First-open fern', interval: 7 },
  });
  const { chat } = await post(`/api/spaces/${applet.id}/chats`, {});
  const completed = await page.request.post('/api/chat', {
    headers: { origin: baseURL! },
    data: {
      spaceId: applet.id,
      chatId: chat.id,
      model: 'test-model',
      message: 'inspect-current-context',
    },
  });
  expect(await completed.text()).toContain('event: done');
  await page.reload();
  await page.locator(`a[href="/spaces/${applet.id}/applet"]`).click();
  const frame = page.frameLocator('iframe[title="Your applet"]');
  await expect(frame.getByRole('heading', { name: 'First-open fern', exact: true })).toBeVisible();
  // Recovering that same historical reply when opening its modal must preserve app UI drafts.
  await frame.getByRole('button', { name: 'Select plant', exact: true }).click();
  await frame.getByRole('button', { name: 'Edit plant', exact: true }).click();
  await frame.getByLabel('Plant name', { exact: true }).fill('Keep my unsent edit');
  await page.getByRole('button', { name: 'More app options', exact: true }).click();
  await page.getByRole('button', { name: 'Versions & tests', exact: true }).click();
  await expect(page.locator('.app-chat-modal .message')).toHaveCount(2);
  await page.getByRole('button', { name: 'Close chat', exact: true }).click();
  await expect(frame.getByLabel('Plant name', { exact: true })).toHaveValue('Keep my unsent edit');
});
