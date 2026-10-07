import { test, expect, credentials } from './fixtures';

test('version history shows changes and tests and confirms restoration as a new version', async ({
  page,
  baseURL,
}) => {
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill(credentials.email);
  await page.getByLabel('Password', { exact: true }).fill(credentials.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Made for your everyday.' })).toBeVisible();
  const post = async (path: string, data: object) => {
    const response = await page.request.post(path, { data, headers: { origin: baseURL! } });
    expect(response.ok(), await response.text()).toBe(true);
    return response;
  };
  const { applet } = await (await post('/api/applets', { template: 'plants' })).json();
  const { chat } = await (await post(`/api/spaces/${applet.id}/chats`, {})).json();
  const turn = {
    spaceId: applet.id,
    chatId: chat.id,
    model: 'test-model',
    message: 'Improve this app',
  };
  await post('/api/chat', turn);
  const { plan } = await (
    await page.request.get(`/api/build-plans?spaceId=${applet.id}&chatId=${chat.id}`)
  ).json();
  await post('/api/chat', { ...turn, buildPlanId: plan.id });
  await page.goto(`/spaces/${applet.id}/chat/${chat.id}`);
  await page.getByRole('button', { name: 'App versions and tests' }).click();
  const history = page.locator('.version-panel');
  await expect(history.getByText('v2 · Current', { exact: true })).toBeVisible();
  await expect(
    history.getByText('Updated UI, backend, title, description.', { exact: true }),
  ).toBeVisible();
  const current = history.locator('.version-entry').first();
  await current.getByText('Requested change', { exact: true }).click();
  await expect(current.locator('.requested-change')).toContainText('Approved update');
  await current.locator('summary').filter({ hasText: 'Tests (' }).click();
  await expect(current.getByText('Empty · Passed', { exact: true })).toBeVisible();
  await history.getByRole('button', { name: 'Restore v1', exact: true }).click();
  await expect(
    history.getByText('Restore app code and chat guidance from v1?', { exact: true }),
  ).toBeVisible();
  const before = await (await page.request.get(`/api/applets/${applet.id}`)).json();
  expect(before.versions).toHaveLength(2);
  await history.getByRole('button', { name: 'Restore version', exact: true }).click();
  await expect(history).not.toBeVisible();
  await page.getByRole('button', { name: 'App versions and tests' }).click();
  await expect(history.getByText('v3 · Current', { exact: true })).toBeVisible();
  await expect(
    history.getByText('Restored code and chat guidance from v1. Current data kept.', {
      exact: true,
    }),
  ).toBeVisible();
  const after = await (await page.request.get(`/api/applets/${applet.id}`)).json();
  expect(after.versions).toHaveLength(3);
  expect(after.versions[0].restoredFrom).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});
