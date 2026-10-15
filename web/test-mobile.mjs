import assert from 'node:assert/strict';
import path from 'node:path';

// Exercise every shell surface with the actual Rust server and synthetic workspace.
export async function testMobileReview({ context, origin, app, api, snapshots }) {
  for (let i = 0; i < 6; i++)
    await api('/api/apps', {
      title:
        i === 0 ? 'A very long app name for checking narrow phone screens' : `Mobile review ${i}`,
    });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.route('**/api/chatgpt', (r) =>
    r.fulfill({ json: { connected: true, planUsage: true } }),
  );
  await page.route('**/api/models', (r) =>
    r.fulfill({ json: [{ slug: 'fixture', display_name: 'Fixture model' }] }),
  );
  async function snapshot(name, width) {
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
      `${name} overflows at ${width}px`,
    );
    const dialogSelectors = {
      'chat-options': '.chat-options-dialog[open]',
      history: '.conversation-picker[open]',
      'secret-form': '.form-dialog[open]',
      'schedule-form': '.form-dialog[open]',
      'app-options': '.app-options[open]',
      versions: '.versions-dialog[open]',
      'app-chat': '.app-chat-modal[open]',
      'secret-error-keyboard': '.form-dialog[open]',
    };
    const dialog = page.locator(dialogSelectors[name] || 'dialog[open]').last();
    if (dialogSelectors[name]) await dialog.waitFor({ state: 'visible' });
    if (await dialog.count()) {
      const box = await dialog.boundingBox();
      assert.ok(box.x >= -1 && box.x + box.width <= width + 1, `${name} dialog outside screen`);
      assert.ok(box.y >= -1 && box.y + box.height <= 845, `${name} dialog too tall`);
    }
    await page.screenshot({
      path: path.join(snapshots, `review-${name}-${width}.png`),
      animations: 'disabled',
    });
  }
  for (const width of [320, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(origin);
    await page.getByRole('button', { name: 'Reload home', exact: true }).waitFor();
    await snapshot('home', width);
    await page
      .getByRole('searchbox', { name: 'Find an app', exact: true })
      .fill('no-match-fixture');
    await page.getByText('No apps match “no-match-fixture”.', { exact: true }).waitFor();
    await snapshot('search-empty', width);
    await page.getByRole('button', { name: 'Clear app search', exact: true }).click();
    await page.getByRole('region', { name: 'Notifications', exact: true }).scrollIntoViewIfNeeded();
    await snapshot('notifications', width);

    await page
      .getByRole('button', { name: 'Start a chat Ask, plan, or create an app', exact: true })
      .click();
    await page.getByRole('textbox', { name: 'Message', exact: true }).waitFor();
    await snapshot('chat', width);
    await page.getByRole('button', { name: 'Chat options', exact: true }).click();
    await snapshot('chat-options', width);
    await page.getByRole('button', { name: 'Close chat options', exact: true }).click();
    await page.getByRole('button', { name: /Choose conversation:/ }).click();
    if (width <= 700)
      assert.notEqual(
        await page.evaluate(() => document.activeElement?.getAttribute('aria-label')),
        'Search conversations',
      );
    await snapshot('history', width);
    await page.getByRole('button', { name: 'Close conversation picker', exact: true }).click();
    await page.goto(`${origin}/voice`);
    await page.getByRole('button', { name: 'Tap to talk', exact: true }).waitFor();
    await snapshot('voice', width);
    await page.goto(`${origin}/settings`);
    await page.getByRole('button', { name: 'Add secret', exact: true }).click();
    await snapshot('secret-form', width);
    await page.getByRole('button', { name: 'Close secret form', exact: true }).click();
    await page.getByRole('button', { name: 'Add schedule', exact: true }).click();
    await page.getByRole('combobox', { name: 'Repeat', exact: true }).waitFor();
    await snapshot('schedule-form', width);
    await page.getByRole('button', { name: 'Close schedule form', exact: true }).click();
    await page.goto(`${origin}/apps/${app}`);
    await page.getByRole('button', { name: 'More app options', exact: true }).click();
    await snapshot('app-options', width);
    await page.getByRole('button', { name: 'Versions & tests', exact: true }).click();
    await snapshot('versions', width);
    await page.getByRole('button', { name: 'Close versions', exact: true }).click();
    await page.getByRole('button', { name: 'Chat with app', exact: true }).click();
    await snapshot('app-chat', width);
    await page.getByRole('button', { name: 'Close chat', exact: true }).click();
  }
  await page.setViewportSize({ width: 390, height: 470 });
  await page.goto(`${origin}/settings`);
  await page.getByRole('button', { name: 'Add secret', exact: true }).click();
  const secretDialog = page.getByRole('dialog', { name: 'Add secret', exact: true });
  await page.getByLabel('Name', { exact: true }).fill('MOBILE_TEST');
  await page.getByLabel('Value', { exact: true }).fill('synthetic-value');
  await page.route('**/api/secrets', (r) =>
    r.fulfill({ status: 503, json: { error: 'Temporarily unavailable. Try again.' } }),
  );
  await page.getByRole('button', { name: 'Save secret', exact: true }).click();
  await secretDialog.getByRole('alert').waitFor();
  assert.equal(await page.getByLabel('Value', { exact: true }).inputValue(), 'synthetic-value');
  await snapshot('secret-error-keyboard', 390);
  await page.unroute('**/api/secrets');
  await page.getByRole('button', { name: 'Close secret form', exact: true }).click();
  await page.getByRole('button', { name: 'Add schedule', exact: true }).click();
  const scheduleDialog = page.getByRole('dialog', { name: 'Add schedule', exact: true });
  await page.getByRole('combobox', { name: 'Scheduled app', exact: true }).selectOption(app);
  await page.getByLabel('Action', { exact: true }).selectOption('list');
  await page.getByLabel('Action input', { exact: false }).fill('bad json');
  await scheduleDialog.getByRole('button', { name: 'Add schedule', exact: true }).click();
  await scheduleDialog.getByRole('alert').filter({ hasText: 'valid JSON' }).waitFor();
  await page.getByLabel('Action input', { exact: false }).fill('{}');
  await page.getByRole('combobox', { name: 'Repeat', exact: true }).selectOption('weekdays');
  await page.getByLabel('Time (UTC)', { exact: true }).fill('10:35');
  await scheduleDialog.getByRole('button', { name: 'Add schedule', exact: true }).click();
  await scheduleDialog.waitFor({ state: 'hidden' });
  const saved = (await api('/api/schedules')).find(
    (s) => s.app === app && s.expression === '35 10 * * 1-5',
  );
  assert.ok(saved, 'Weekday preset saves the chosen UTC time');
  await api(`/api/schedules/${saved.id}/delete`, {});
  const beforeArchive = await api(`/api/apps/${app}`);
  const appTitle = (await api('/api/apps')).find((a) => a.id === app).title;
  await page.goto(`${origin}/apps/${app}`);
  await page.getByRole('button', { name: 'More app options', exact: true }).click();
  await page.getByRole('button', { name: 'Archive app', exact: true }).click();
  await page.waitForURL(origin + '/');
  assert.equal(await page.getByRole('button', { name: appTitle, exact: true }).count(), 0);
  assert.equal((await api('/api/apps')).find((a) => a.id === app).archived, true);
  await page.goto(`${origin}/settings`);
  await page.getByRole('button', { name: `Restore ${appTitle}`, exact: true }).click();
  await page
    .getByRole('button', { name: `Restore ${appTitle}`, exact: true })
    .waitFor({ state: 'hidden' });
  await page.goto(origin);
  await page.getByRole('button', { name: appTitle, exact: true }).waitFor();
  assert.deepEqual((await api(`/api/apps/${app}`)).records, beforeArchive.records);
  assert.deepEqual(errors, []);
  await page.close();
  console.log(
    'All shell pages/sheets reviewed at 320/390/768/1280px; form error recovery, phone focus and schedule presets passed',
  );
}
