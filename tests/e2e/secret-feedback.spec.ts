import { test, expect, credentials } from './fixtures';

test('Secrets gives advisory format feedback and only reveals newly entered values', async ({
  page,
}) => {
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill(credentials.email);
  await page.getByLabel('Password', { exact: true }).fill(credentials.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Made for your everyday.' })).toBeVisible();
  await page.goto('/settings');
  const secrets = page
    .locator('.automation-card')
    .filter({ has: page.getByRole('heading', { name: 'Secrets', exact: true }) });
  const add = secrets.getByRole('button', { name: 'Add secret', exact: true });
  await expect(secrets.getByLabel('Name', { exact: true })).toHaveCount(0);
  await expect(add).toBeEnabled();
  await add.click();
  await expect(secrets.getByLabel('Name', { exact: true })).toBeFocused();
  await secrets.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(secrets.getByLabel('Name', { exact: true })).toHaveCount(0);
  await expect(add).toBeFocused();
  await add.click();
  await secrets.getByLabel('Name', { exact: true }).fill('GOOGLE_BOOKS_API_KEY');
  const value = secrets.getByLabel('Secret value', { exact: true });
  await value.fill('synthetic-invalid-google-value');
  await secrets
    .getByLabel('Allowed API origins', { exact: true })
    .fill('https://www.googleapis.com');
  await expect(
    secrets.getByText(/This does not match the usual Google Cloud API-key format/),
  ).toBeVisible();
  await expect(value).toHaveAttribute('type', 'password');
  await secrets.getByRole('button', { name: 'Show entered value', exact: true }).click();
  await expect(value).toHaveAttribute('type', 'text');
  await secrets.getByRole('button', { name: 'Save secret', exact: true }).click();
  await expect(secrets.getByRole('status')).toContainText('Saving does not verify the connection');
  await expect(value).toHaveCount(0);
  await expect(add).toBeEnabled();
  const response = await page.request.get('/api/settings/secrets');
  const metadata = await response.json();
  expect(JSON.stringify(metadata)).not.toContain('synthetic-invalid-google-value');
  expect(metadata.secrets[0].warnings.length).toBeGreaterThan(0);
  await secrets.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(value).toHaveValue('');
  await expect(value).toHaveAttribute('type', 'password');
  await expect(secrets.getByLabel('Name', { exact: true })).toHaveAttribute('readonly', '');
  await value.fill('AIza' + 'a'.repeat(35));
  await expect(secrets.getByRole('status').filter({ hasText: 'usual Google Cloud' })).toHaveCount(
    0,
  );
  await secrets.getByRole('button', { name: 'Save secret', exact: true }).click();
  await expect(
    secrets.getByText(/This does not match the usual Google Cloud API-key format/),
  ).toHaveCount(0);
  await expect(secrets.getByRole('status')).toContainText('Saving does not verify the connection');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});
