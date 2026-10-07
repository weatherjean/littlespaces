import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { devClient } from './dev-client.mjs';

const directory = process.argv[2];
if (!directory?.startsWith('.data/dev-instance/evaluations/'))
  throw Error('Provide an evaluation directory.');
const results = JSON.parse(readFileSync(`${directory}/results.json`, 'utf8'));
const client = devClient();
const browser = await chromium.launch();
const filter = process.argv[3];
const reports =
  filter && existsSync(`${directory}/browser-results.json`)
    ? JSON.parse(readFileSync(`${directory}/browser-results.json`, 'utf8')).filter(
        (report) => report.name !== filter,
      )
    : [];
const screenshots = `${directory}/screenshots`;
mkdirSync(screenshots, { recursive: true, mode: 0o700 });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const signed = await context.request.post(`${client.origin}/api/dev/session`, {
    headers: client.headers,
    data: {},
  });
  assert.equal(signed.status(), 200);
  for (const app of results.filter(
    (app) => app.status === 'published' && (!filter || app.name === filter),
  )) {
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const report = { name: app.name, checks: [], errors };
    const frame = page.frameLocator('iframe[title="Your applet"]');
    const action = (name, input) =>
      client.json(`/api/applets/${app.appletId}/actions`, { action: name, input });
    async function check(name, run) {
      await run();
      report.checks.push(name);
    }
    try {
      await page.goto(app.url);
      await frame.locator('main').waitFor();
      if (app.name === 'Reading tracker') {
        const title = 'E2E: The Left Hand of Darkness';
        const second = 'E2E: Invisible Cities';
        const book = frame
          .locator('li')
          .filter({ has: frame.getByRole('heading', { name: title, exact: true }) });
        await check('Create two books through the UI', async () => {
          await frame.getByLabel('Title', { exact: true }).fill(title);
          await frame.getByLabel('Author', { exact: true }).fill('Ursula K. Le Guin');
          await frame.getByRole('button', { name: '+ Add book', exact: true }).click();
          await expect(book).toBeVisible();
          await frame.getByLabel('Title', { exact: true }).fill(second);
          await frame.getByLabel('Author', { exact: true }).fill('Italo Calvino');
          await frame.getByRole('button', { name: '+ Add book', exact: true }).click();
          await expect(frame.getByRole('heading', { name: second, exact: true })).toBeVisible();
        });
        await check('Edit status and rating, then verify refresh persistence', async () => {
          await book.getByRole('button', { name: 'Edit', exact: true }).click();
          await frame.getByLabel('Reading status', { exact: true }).selectOption('finished');
          await frame.locator('#rating').selectOption('4');
          await frame.getByRole('button', { name: 'Save changes', exact: true }).click();
          await expect(book.getByLabel('4 out of 5 stars')).toBeVisible();
          await page.reload();
          await expect(book.getByLabel('4 out of 5 stars')).toBeVisible();
          const saved = (await action('list', {})).result;
          assert.equal(saved.find((item) => item.value.title === title).value.rating, 4);
        });
        await check('Search and status filtering', async () => {
          await frame.getByLabel('Search title or author').fill('Calvino');
          await expect(frame.getByRole('heading', { name: second, exact: true })).toBeVisible();
          await expect(book).toHaveCount(0);
          await frame.getByLabel('Search title or author').fill('');
          await frame.getByLabel('Filter by reading status').selectOption('finished');
          await expect(book).toBeVisible();
          await expect(frame.getByRole('heading', { name: second, exact: true })).toHaveCount(0);
          await frame.getByLabel('Filter by reading status').selectOption('all');
        });
        await check('Invalid input is rejected without changing saved data', async () => {
          const before = (await action('list', {})).result;
          await assert.rejects(
            () => action('add', { title: ' ', author: 'Test', status: 'reading' }),
            /400/,
          );
          await assert.rejects(
            () =>
              action('add', { title: 'Bad rating', author: 'Test', status: 'finished', rating: 6 }),
            /400/,
          );
          assert.deepEqual((await action('list', {})).result, before);
        });
        await page.screenshot({ path: `${screenshots}/reading-desktop.png`, fullPage: true });
        await page.setViewportSize({ width: 390, height: 844 });
        await book.scrollIntoViewIfNeeded();
        await page.screenshot({ path: `${screenshots}/reading-mobile.png`, fullPage: true });
        await check(
          'Delete confirmation can be cancelled and confirmed; deletion survives refresh',
          async () => {
            await book.getByRole('button', { name: 'Delete', exact: true }).click();
            await frame.getByRole('button', { name: 'Keep book', exact: true }).click();
            await expect(book).toBeVisible();
            for (const name of [title, second]) {
              const row = frame
                .locator('li')
                .filter({ has: frame.getByRole('heading', { name, exact: true }) });
              await row.getByRole('button', { name: 'Delete', exact: true }).click();
              await frame.getByRole('button', { name: 'Delete book', exact: true }).click();
              await expect(row).toHaveCount(0);
            }
            await page.reload();
            await expect(
              frame.getByRole('heading', { name: 'Your next chapter starts here' }),
            ).toBeVisible();
          },
        );
      } else if (app.name === 'Expense tracker') {
        async function addExpense(description, amount, category, date) {
          await frame.getByLabel('Description', { exact: true }).fill(description);
          await frame.getByLabel('Amount · EUR', { exact: true }).fill(amount);
          await frame.getByLabel('Category', { exact: true }).fill(category);
          await frame.getByLabel('Date', { exact: true }).fill(date);
          await frame.getByRole('button', { name: '+ Add expense', exact: true }).click();
          await expect(
            frame.getByRole('button', { name: `Delete ${description}`, exact: true }),
          ).toBeVisible();
        }
        await check(
          'Create expenses through the UI and calculate exact decimal totals',
          async () => {
            await addExpense('E2E: Tea', '0.10', 'Food', '2026-10-07');
            await addExpense('E2E: Coffee', '0.20', 'Food', '2026-10-07');
            await expect(frame.locator('.total')).toHaveText('€0.30');
            await expect(frame.locator('.category').filter({ hasText: 'Food' })).toContainText(
              '€0.30',
            );
            await addExpense('E2E: Train', '12.50', 'Transport', '2026-09-30');
            await expect(frame.locator('.total')).toHaveText('€12.50');
          },
        );
        await check('Month filtering and refresh persistence', async () => {
          await frame.getByLabel('Month', { exact: true }).fill('2026-10');
          await expect(frame.locator('.total')).toHaveText('€0.30');
          await expect(
            frame.getByRole('button', { name: 'Delete E2E: Train', exact: true }),
          ).toHaveCount(0);
          await page.reload();
          await frame.getByLabel('Month', { exact: true }).fill('2026-10');
          await expect(frame.locator('.total')).toHaveText('€0.30');
          const records = (await action('list', {})).result;
          assert.equal(records.length, 3);
          assert.equal(
            records.reduce((total, entry) => total + entry.value.cents, 0),
            1280,
          );
        });
        await check('Reject invalid amounts and calendar dates without saving', async () => {
          const before = (await action('list', {})).result;
          for (const amount of ['0', '-1', '1.234', 'NaN'])
            await assert.rejects(
              () =>
                action('add', {
                  description: 'Invalid',
                  amount,
                  category: 'Test',
                  date: '2026-10-07',
                }),
              /400/,
            );
          for (const date of ['2026-02-29', '2026-04-31', '2026-13-01'])
            await assert.rejects(
              () =>
                action('add', { description: 'Invalid', amount: '1.00', category: 'Test', date }),
              /400/,
            );
          assert.deepEqual((await action('list', {})).result, before);
          await frame.getByLabel('Description', { exact: true }).fill('Invalid zero amount');
          await frame.getByLabel('Amount · EUR', { exact: true }).fill('0');
          await frame.getByLabel('Category', { exact: true }).fill('Test');
          await frame.getByRole('button', { name: '+ Add expense', exact: true }).click();
          await expect(frame.getByRole('alert')).toContainText(/amount|positive/i);
          assert.deepEqual((await action('list', {})).result, before);
        });
        await page.screenshot({ path: `${screenshots}/expense-desktop.png`, fullPage: true });
        await page.setViewportSize({ width: 390, height: 844 });
        await frame.locator('.total').scrollIntoViewIfNeeded();
        await page.screenshot({ path: `${screenshots}/expense-mobile.png`, fullPage: true });
        await check(
          'Delete expenses through the UI and verify deletion survives refresh',
          async () => {
            await frame.getByRole('button', { name: 'Delete E2E: Tea', exact: true }).click();
            await expect(frame.locator('.total')).toHaveText('€0.20');
            await frame.getByRole('button', { name: 'Delete E2E: Coffee', exact: true }).click();
            await expect(frame.locator('.total')).toHaveText('€0.00');
            await frame.getByLabel('Month', { exact: true }).fill('2026-09');
            await frame.getByRole('button', { name: 'Delete E2E: Train', exact: true }).click();
            await expect(
              frame.getByRole('button', { name: 'Delete E2E: Train', exact: true }),
            ).toHaveCount(0);
            await page.reload();
            await expect(
              frame.getByRole('heading', { name: 'Your first expense starts here' }),
            ).toBeVisible();
            assert.deepEqual((await action('list', {})).result, []);
          },
        );
      } else if (app.name === 'Habit tracker') {
        await check('Create habits through the form', async () => {
          for (const name of ['E2E: Read daily', 'E2E: Walk outside']) {
            await frame.getByLabel('Habit name', { exact: true }).fill(name);
            await frame.getByRole('button', { name: 'Add habit', exact: true }).click();
            await expect(frame.getByRole('checkbox', { name, exact: true })).toBeVisible();
          }
          await expect(frame.getByRole('progressbar')).toHaveAttribute('aria-valuemax', '2');
        });
        await check(
          'Check and uncheck today, with refresh persistence and correct totals',
          async () => {
            const checkbox = frame.getByRole('checkbox', { name: 'E2E: Read daily', exact: true });
            await checkbox.check();
            await expect(frame.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '1');
            await page.reload();
            await expect(checkbox).toBeChecked();
            await expect(frame.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '1');
            await checkbox.uncheck();
            await expect(frame.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
            await checkbox.check();
            await frame.getByRole('checkbox', { name: 'E2E: Walk outside', exact: true }).check();
            await expect(frame.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '2');
          },
        );
        await check('Seven-day progress and Ljubljana calendar date', async () => {
          const snapshot = (await action('list', {})).result;
          const parts = new Intl.DateTimeFormat('en-CA', {
            timeZone: 'Europe/Ljubljana',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
          }).formatToParts(new Date());
          const part = (type) => parts.find((part) => part.type === type).value;
          assert.equal(snapshot.today, `${part('year')}-${part('month')}-${part('day')}`);
          assert.equal(snapshot.days.length, 7);
          assert.equal(new Set(snapshot.days.map((day) => day.date)).size, 7);
          assert.equal(snapshot.days.at(-1).date, snapshot.today);
          assert.equal(snapshot.days.at(-1).done, 2);
          await expect(frame.locator('.week > div')).toHaveCount(7);
        });
        await check('Reject blank names and invalid/non-today dates without mutation', async () => {
          const before = (await action('list', {})).result;
          await assert.rejects(() => action('add', { name: ' ' }), /400/);
          for (const date of ['2026-02-29', '2026-13-01', '2099-01-01'])
            await assert.rejects(
              () => action('complete', { key: before.habits[0].key, completed: true, date }),
              /400/,
            );
          assert.deepEqual((await action('list', {})).result, before);
          await frame.getByLabel('Habit name', { exact: true }).fill(' ');
          await expect(
            frame.getByRole('button', { name: 'Add habit', exact: true }),
          ).toBeDisabled();
        });
        await page.screenshot({ path: `${screenshots}/habit-desktop.png`, fullPage: true });
        await page.setViewportSize({ width: 390, height: 844 });
        await frame.locator('.week').scrollIntoViewIfNeeded();
        await page.screenshot({ path: `${screenshots}/habit-mobile.png`, fullPage: true });
        await check('Delete confirmation, removal and persistence', async () => {
          const row = frame.locator('li').filter({ hasText: 'E2E: Read daily' });
          await row.getByRole('button', { name: 'Delete E2E: Read daily', exact: true }).click();
          await row.getByRole('button', { name: 'Cancel', exact: true }).click();
          await expect(row).toBeVisible();
          for (const name of ['E2E: Read daily', 'E2E: Walk outside']) {
            const target = frame.locator('li').filter({ hasText: name });
            await target.getByRole('button', { name: `Delete ${name}`, exact: true }).click();
            await target.getByRole('button', { name: 'Delete', exact: true }).click();
            await expect(target).toHaveCount(0);
          }
          await page.reload();
          await expect(
            frame.getByRole('heading', { name: 'No habits yet', exact: true }),
          ).toBeVisible();
          assert.deepEqual((await action('list', {})).result.habits, []);
        });
      } else {
        report.status = 'awaiting workflow checks';
      }
      await check('Mobile layout has no horizontal overflow', async () => {
        await page.setViewportSize({ width: 320, height: 740 });
        const dimensions = await frame
          .locator('body')
          .evaluate((node) => ({ width: node.clientWidth, scroll: node.scrollWidth }));
        assert.ok(dimensions.scroll <= dimensions.width + 1, JSON.stringify(dimensions));
      });
      await check('No browser runtime exceptions', async () => assert.deepEqual(errors, []));
      report.status ||= 'passed';
    } catch (error) {
      report.status = 'failed';
      report.failure = error.message;
      report.screen = await frame
        .locator('body')
        .innerText()
        .catch(() => 'Unavailable');
      report.fields = await frame
        .locator('input')
        .evaluateAll((nodes) =>
          nodes.map((node) => ({
            type: node.type,
            value: node.value,
            valid: node.checkValidity(),
            message: node.validationMessage,
            pattern: node.pattern,
          })),
        )
        .catch(() => []);
      await page.screenshot({
        path: `${screenshots}/${app.name.replaceAll(' ', '-')}-failure.png`,
        fullPage: true,
      });
    }
    reports.push(report);
    console.log(JSON.stringify(report, null, 2));
    await page.close();
  }
  await context.close();
} finally {
  await browser.close();
  writeFileSync(`${directory}/browser-results.json`, JSON.stringify(reports, null, 2), {
    mode: 0o600,
  });
}
if (reports.some((report) => report.status !== 'passed')) process.exitCode = 1;
