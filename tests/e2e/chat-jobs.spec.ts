import { test, expect, credentials } from './fixtures';

test.beforeEach(async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill(credentials.email);
  await page.getByLabel('Password', { exact: true }).fill(credentials.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('button', { name: 'Start a chat' }).click();
});

test('a reply survives closing the page and the chat stays navigable', async ({
  page,
  context,
}) => {
  const message = page.getByRole('textbox', { name: 'Message', exact: true });
  await message.fill('job-test:complete');
  const accepted = page.waitForResponse(
    (response) => response.url().endsWith('/api/chat') && response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  expect((await accepted).status()).toBe(202);
  const chatURL = page.url();
  await expect(page.getByRole('button', { name: /Choose conversation:/ })).toBeEnabled();
  await page.getByRole('link', { name: 'Back to Home' }).click();
  await page.close();
  const reopened = await context.newPage();
  await reopened.goto(chatURL);
  await expect(reopened.getByText('Background reply complete.', { exact: true })).toBeVisible();
  await expect(reopened.getByRole('button', { name: 'Send message', exact: true })).toBeVisible();
  await reopened.close();
});

test('lost acceptance reconnects without duplication and unsent drafts survive reload', async ({
  page,
}) => {
  const message = page.getByRole('textbox', { name: 'Message', exact: true });
  await message.fill('An unsent thought');
  await page.reload();
  await expect(message).toHaveValue('An unsent thought');
  let dropped = false;
  await page.route('**/api/chat', async (route) => {
    if (route.request().method() === 'POST' && !dropped) {
      dropped = true;
      await route.fetch();
      await route.abort('failed');
    } else await route.continue();
  });
  await message.fill('job-test:complete');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByText('Background reply complete.', { exact: true })).toBeVisible();
  const chatId = new URL(page.url()).pathname.split('/').at(-1)!;
  const snapshot = await page.request.get(
    `/api/chat?spaceId=00000000-0000-4000-8000-000000000001&chatId=${chatId}`,
  );
  const state = await snapshot.json();
  expect(state.messages.filter((item: { role: string }) => item.role === 'user')).toHaveLength(1);
  await expect(message).toHaveValue('');
});
