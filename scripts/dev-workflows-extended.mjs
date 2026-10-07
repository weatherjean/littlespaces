import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { devClient } from './dev-client.mjs';

const directory = process.argv[2];
const filter = process.argv[3];
if (!directory?.startsWith('.data/dev-instance/evaluations/'))
  throw Error('Provide an evaluation directory.');
const results = JSON.parse(readFileSync(`${directory}/results.json`, 'utf8'));
const reports =
  filter && existsSync(`${directory}/browser-results.json`)
    ? JSON.parse(readFileSync(`${directory}/browser-results.json`, 'utf8')).filter(
        (report) => report.name !== filter,
      )
    : [];
const screenshots = `${directory}/screenshots`;
mkdirSync(screenshots, { recursive: true, mode: 0o700 });
const client = devClient();
const browser = await chromium.launch();
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
    async function capture(label) {
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.screenshot({ path: `${screenshots}/${label}-desktop.png`, fullPage: true });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: `${screenshots}/${label}-mobile.png`, fullPage: true });
    }
    try {
      await page.goto(app.url);
      await frame.locator('main').waitFor();
      if (app.name === 'Recipe scaler') {
        const recipe = 'E2E: Pancakes';
        const soup = 'E2E: Soup';
        const choose = (name) => frame.getByRole('button', { name: new RegExp(name) }).click();
        await expect(frame.getByRole('heading', { name: 'A fresh page awaits' })).toBeVisible();
        await check(
          'Create a recipe with multiple decimal ingredients through the form',
          async () => {
            await frame.getByLabel('Recipe name', { exact: true }).fill(recipe);
            await frame.getByLabel('Base servings', { exact: true }).fill('2');
            await frame.getByPlaceholder('Ingredient', { exact: true }).fill('Flour');
            await frame.getByPlaceholder('1.5', { exact: true }).fill('1.5');
            await frame.getByPlaceholder('cups, g…', { exact: true }).fill('cups');
            await frame.getByRole('button', { name: '+ Add ingredient', exact: true }).click();
            await frame.getByPlaceholder('Ingredient', { exact: true }).nth(1).fill('Milk');
            await frame.getByPlaceholder('1.5', { exact: true }).nth(1).fill('0.25');
            await frame.getByPlaceholder('cups, g…', { exact: true }).nth(1).fill('L');
            await frame.getByLabel('Instructions', { exact: true }).fill('Mix, then cook.');
            await frame.getByRole('button', { name: 'Save recipe', exact: true }).click();
            await expect(frame.getByRole('heading', { name: recipe, exact: true })).toBeVisible();
          },
        );
        await check(
          'Scale to fractional and larger serving counts without mutating originals',
          async () => {
            const before = (await action('list', {})).result;
            await frame.getByLabel('Target servings', { exact: true }).fill('3');
            await frame.getByRole('button', { name: 'Scale ingredients', exact: true }).click();
            await expect(frame.locator('.amounts li').filter({ hasText: 'Flour' })).toContainText(
              '2.25 cups',
            );
            await expect(frame.locator('.amounts li').filter({ hasText: 'Milk' })).toContainText(
              '0.375 L',
            );
            await frame.getByLabel('Target servings', { exact: true }).fill('0.5');
            await frame.getByRole('button', { name: 'Scale ingredients', exact: true }).click();
            await expect(frame.locator('.amounts li').filter({ hasText: 'Flour' })).toContainText(
              '0.375 cups',
            );
            assert.deepEqual((await action('list', {})).result, before);
            await page.reload();
            await choose(recipe);
            await expect(frame.getByLabel('Target servings', { exact: true })).toHaveValue('2');
            await expect(frame.locator('.amounts li').filter({ hasText: 'Flour' })).toContainText(
              '1.5 cups',
            );
            await expect(frame.getByText('Mix, then cook.', { exact: true })).toBeVisible();
          },
        );
        await check('Search and switch between persisted recipes', async () => {
          await frame.getByLabel('Recipe name', { exact: true }).fill(soup);
          await frame.getByLabel('Base servings', { exact: true }).fill('4');
          await frame.getByPlaceholder('Ingredient', { exact: true }).fill('Beans');
          await frame.getByPlaceholder('1.5', { exact: true }).fill('0.5');
          await frame.getByPlaceholder('cups, g…', { exact: true }).fill('cups');
          await frame.getByRole('button', { name: 'Save recipe', exact: true }).click();
          await expect(frame.getByRole('heading', { name: soup, exact: true })).toBeVisible();
          await frame.getByLabel('Search by name', { exact: true }).fill('Soup');
          await expect(frame.getByRole('button', { name: new RegExp(recipe) })).toHaveCount(0);
          await frame.getByLabel('Search by name', { exact: true }).fill('does not exist');
          await expect(
            frame.getByText('No matching recipes. Try another name.', { exact: true }),
          ).toBeVisible();
          await frame.getByLabel('Search by name', { exact: true }).fill('');
          await choose(recipe);
        });
        await capture('recipe');
        await check(
          'Invalid recipes and scaling targets do not change records; UI retains input',
          async () => {
            const before = (await action('list', {})).result;
            const valid = {
              name: 'Invalid',
              baseServings: 2,
              instructions: '',
              ingredients: [{ name: 'Flour', quantity: 1, unit: 'cups' }],
            };
            for (const input of [
              { ...valid, name: ' ' },
              { ...valid, baseServings: 0 },
              { ...valid, ingredients: [{ name: ' ', quantity: 1, unit: 'cups' }] },
              { ...valid, ingredients: [{ name: 'Flour', quantity: -1, unit: 'cups' }] },
            ])
              await assert.rejects(() => action('create', input), /400/);
            await assert.rejects(
              () => action('scale', { key: before[0].key, targetServings: 0 }),
              /400/,
            );
            await assert.rejects(
              () => action('delete', { key: before[0].key, confirmed: false }),
              /400/,
            );
            await frame.getByLabel('Recipe name', { exact: true }).fill('Invalid recipe retained');
            await frame.getByLabel('Base servings', { exact: true }).fill('0');
            await frame.getByPlaceholder('Ingredient', { exact: true }).fill('Salt');
            await frame.getByPlaceholder('1.5', { exact: true }).fill('1');
            await frame.getByRole('button', { name: 'Save recipe', exact: true }).click();
            await expect(frame.getByRole('alert')).toContainText(/positive/i);
            await expect(frame.getByLabel('Recipe name', { exact: true })).toHaveValue(
              'Invalid recipe retained',
            );
            assert.deepEqual((await action('list', {})).result, before);
          },
        );
        await check('Cancel and confirm deletion; deletion persists through refresh', async () => {
          await choose(recipe);
          await frame.getByRole('button', { name: 'Delete recipe', exact: true }).click();
          await frame.getByRole('button', { name: 'Keep recipe', exact: true }).click();
          await expect(frame.getByRole('heading', { name: recipe, exact: true })).toBeVisible();
          for (const name of [recipe, soup]) {
            await choose(name);
            await frame.getByRole('button', { name: 'Delete recipe', exact: true }).click();
            await frame.getByRole('button', { name: 'Yes, delete recipe', exact: true }).click();
            await expect(frame.getByRole('button', { name: new RegExp(name) })).toHaveCount(0);
          }
          await page.reload();
          await expect(frame.getByRole('heading', { name: 'A fresh page awaits' })).toBeVisible();
          assert.deepEqual((await action('list', {})).result, []);
        });
      } else if (app.name === 'Project board') {
        const first = 'E2E: Ship release';
        const second = 'E2E: Draft announcement';
        const updated = 'E2E: Ship reviewed release';
        const row = (title) =>
          frame
            .locator('article')
            .filter({ has: frame.getByRole('heading', { name: title, exact: true }) });
        const count = (status) =>
          frame.locator('.counts > div').filter({ hasText: status }).locator('strong');
        await expect(
          frame.getByRole('heading', { name: 'Your next project starts here' }),
        ).toBeVisible();
        await check('Create tasks with and without optional notes and dates', async () => {
          await frame.locator('#task-title').fill(first);
          await frame.getByLabel('Notes', { exact: true }).fill('Perform crossbrowser checks');
          await frame.getByLabel('Priority', { exact: true }).selectOption('high');
          await frame.locator('#due').fill('2026-10-31');
          await frame.getByRole('button', { name: 'Add task', exact: true }).click();
          await expect(row(first)).toBeVisible();
          await frame.locator('#task-title').fill(second);
          await frame.getByLabel('Priority', { exact: true }).selectOption('low');
          await frame.getByLabel('Status', { exact: true }).selectOption('doing');
          await frame.getByRole('button', { name: 'Add task', exact: true }).click();
          await expect(row(second)).toBeVisible();
          await expect(count('To do')).toHaveText('1');
          await expect(count('Doing')).toHaveText('1');
          await expect(count('Done')).toHaveText('0');
        });
        await check('Move across all statuses and persist status through refresh', async () => {
          await row(first).getByLabel('Move to').selectOption('doing');
          await expect(count('Doing')).toHaveText('2');
          await expect(count('To do')).toHaveText('0');
          await row(first).getByLabel('Move to').selectOption('done');
          await expect(count('Done')).toHaveText('1');
          await page.reload();
          await expect(row(first).getByLabel('Move to')).toHaveValue('done');
          await expect(count('Doing')).toHaveText('1');
        });
        await check('Edit task details without duplication and persist the changes', async () => {
          const before = (await action('list', {})).result;
          const original = before.find((task) => task.value.title === first);
          await row(first).getByRole('button', { name: 'Edit', exact: true }).click();
          await frame.locator('#task-title').fill(updated);
          await frame.getByLabel('Notes', { exact: true }).fill('Review crossbrowser checks');
          await frame.getByLabel('Priority', { exact: true }).selectOption('medium');
          await frame.locator('#due').fill('2026-11-01');
          await frame.getByRole('button', { name: 'Save changes', exact: true }).click();
          await expect(row(updated)).toBeVisible();
          await page.reload();
          await expect(row(updated)).toContainText('2026-11-01');
          const saved = (await action('list', {})).result;
          assert.equal(saved.length, 2);
          assert.equal(saved.find((task) => task.value.title === updated).key, original.key);
          assert.equal(saved.find((task) => task.key === original.key).value.priority, 'medium');
        });
        await check('Search notes and filter priority with accurate status counts', async () => {
          await frame.getByLabel('Search tasks', { exact: true }).fill('crossbrowser');
          await expect(row(updated)).toBeVisible();
          await expect(row(second)).toHaveCount(0);
          await frame.getByLabel('Search tasks', { exact: true }).fill('');
          await frame.getByLabel('Priority filter', { exact: true }).selectOption('low');
          await expect(row(second)).toBeVisible();
          await expect(row(updated)).toHaveCount(0);
          await expect(count('Done')).toHaveText('1');
          await frame.getByLabel('Priority filter', { exact: true }).selectOption('');
        });
        await capture('project');
        await check(
          'Invalid titles, dates and statuses cannot mutate records; failed form retains input',
          async () => {
            const before = (await action('list', {})).result;
            const valid = { title: 'Invalid', priority: 'low', status: 'todo' };
            for (const input of [
              { ...valid, title: ' ' },
              { ...valid, dueDate: '2026-02-29' },
              { ...valid, dueDate: '2026-04-31' },
              { ...valid, status: 'unknown' },
              { ...valid, priority: 'unknown' },
            ])
              await assert.rejects(() => action('save', input), /400/);
            await assert.rejects(
              () => action('delete', { key: before[0].key, confirmed: false }),
              /400/,
            );
            await frame.locator('#task-title').fill(' ');
            await frame.getByRole('button', { name: 'Add task', exact: true }).click();
            await expect(frame.getByRole('alert')).toContainText(/title/i);
            await expect(frame.locator('#task-title')).toHaveValue(' ');
            assert.deepEqual((await action('list', {})).result, before);
          },
        );
        await check(
          'Cancel and confirm task deletion; removal persists through refresh',
          async () => {
            await row(updated).getByRole('button', { name: 'Delete', exact: true }).click();
            await row(updated).getByRole('button', { name: 'Keep task', exact: true }).click();
            await expect(row(updated)).toBeVisible();
            for (const title of [updated, second]) {
              await row(title).getByRole('button', { name: 'Delete', exact: true }).click();
              await row(title).getByRole('button', { name: 'Confirm delete', exact: true }).click();
              await expect(row(title)).toHaveCount(0);
            }
            await page.reload();
            await expect(
              frame.getByRole('heading', { name: 'Your next project starts here' }),
            ).toBeVisible();
            assert.deepEqual((await action('list', {})).result, []);
          },
        );
      } else if (app.name === 'Trip packing checklist') {
        const trip = 'E2E: Ljubljana getaway';
        const boots = 'E2E: Hiking boots';
        const renamed = 'E2E: Trail boots';
        const charger = 'E2E: Charger';
        const socks = 'E2E: Socks';
        const row = (name) => frame.locator('article').filter({ hasText: name });
        const checkbox = (name) => frame.getByRole('checkbox', { name: new RegExp(name) });
        const progress = frame.getByRole('progressbar', { name: 'Packed checklist items' });
        await expect(
          frame.getByRole('heading', { name: 'Your adventure, unpacked.' }),
        ).toBeVisible();
        await check('Trip setup gates item entry and persists name/date', async () => {
          await expect(frame.locator('#item-name')).toBeDisabled();
          await frame.getByLabel('Trip name', { exact: true }).fill(trip);
          await frame.locator('input[type="date"]').fill('2026-12-07');
          await frame.getByRole('button', { name: 'Save trip', exact: true }).click();
          await expect(frame.getByRole('heading', { name: trip, exact: true })).toBeVisible();
          await expect(frame.locator('#item-name')).toBeEnabled();
          await page.reload();
          await expect(frame.getByLabel('Trip name', { exact: true })).toHaveValue(trip);
          await expect(frame.locator('input[type="date"]')).toHaveValue('2026-12-07');
        });
        await check(
          'Create packing items with integer quantities and group by category',
          async () => {
            for (const [name, category, quantity] of [
              [boots, 'Clothing', '2'],
              [charger, 'Electronics', '1'],
              [socks, 'Clothing', '3'],
            ]) {
              await frame.getByLabel('Item name', { exact: true }).fill(name);
              await frame.getByLabel('Category', { exact: true }).fill(category);
              await frame.getByLabel('Quantity', { exact: true }).fill(quantity);
              await frame.getByRole('button', { name: 'Add item', exact: true }).click();
              await expect(row(name)).toBeVisible();
            }
            await expect(
              frame
                .locator('.group')
                .filter({ has: frame.getByRole('heading', { name: /Clothing/ }) })
                .locator('article'),
            ).toHaveCount(2);
            await expect(
              frame
                .locator('.group')
                .filter({ has: frame.getByRole('heading', { name: /Electronics/ }) })
                .locator('article'),
            ).toHaveCount(1);
            await expect(progress).toHaveAttribute('max', '3');
            await expect(progress).toHaveAttribute('value', '0');
          },
        );
        await check(
          'Packed toggles and filters preserve item-based progress through refresh',
          async () => {
            await checkbox(boots).check();
            await expect(progress).toHaveAttribute('value', '1');
            await frame.getByRole('button', { name: 'Packed', exact: true }).click();
            await expect(row(boots)).toBeVisible();
            await expect(frame.locator('article')).toHaveCount(1);
            await frame.getByRole('button', { name: 'Unpacked', exact: true }).click();
            await expect(frame.locator('article')).toHaveCount(2);
            await expect(row(boots)).toHaveCount(0);
            await expect(progress).toHaveAttribute('value', '1');
            await frame.getByRole('button', { name: 'All', exact: true }).click();
            await page.reload();
            await expect(checkbox(boots)).toBeChecked();
            await checkbox(boots).uncheck();
            await expect(progress).toHaveAttribute('value', '0');
            await checkbox(boots).check();
            await expect(progress).toHaveAttribute('value', '1');
          },
        );
        await check(
          'Edit item details without losing packed state or creating duplicates',
          async () => {
            const before = (await action('load', {})).result;
            const original = before.items.find((item) => item.value.name === boots);
            await row(boots).getByRole('button', { name: 'Edit', exact: true }).click();
            await frame.getByLabel('Item name', { exact: true }).fill(renamed);
            await frame.getByLabel('Category', { exact: true }).fill('Footwear');
            await frame.getByLabel('Quantity', { exact: true }).fill('4');
            await frame.getByRole('button', { name: 'Save changes', exact: true }).click();
            await expect(row(renamed)).toContainText('Quantity: 4');
            await page.reload();
            await expect(checkbox(renamed)).toBeChecked();
            const saved = (await action('load', {})).result;
            assert.equal(saved.items.length, 3);
            const edited = saved.items.find((item) => item.key === original.key);
            assert.equal(edited.value.name, renamed);
            assert.equal(edited.value.category, 'Footwear');
            assert.equal(edited.value.packed, true);
          },
        );
        await capture('packing');
        await check(
          'Invalid trip/date/item/quantity inputs do not mutate records; UI retains values',
          async () => {
            const before = (await action('load', {})).result;
            await assert.rejects(() => action('saveTrip', { name: ' ' }), /400/);
            for (const departure of ['2026-02-29', '2026-04-31', '2026-13-01'])
              await assert.rejects(() => action('saveTrip', { name: 'Invalid', departure }), /400/);
            const valid = { name: 'Invalid', category: 'Test', quantity: 1 };
            for (const input of [
              { ...valid, name: ' ' },
              { ...valid, category: ' ' },
              { ...valid, quantity: 0 },
              { ...valid, quantity: -1 },
              { ...valid, quantity: 1.5 },
            ])
              await assert.rejects(() => action('add', input), /400/);
            await assert.rejects(
              () => action('delete', { key: before.items[0].key, confirmed: false }),
              /400/,
            );
            await frame.getByLabel('Item name', { exact: true }).fill('Invalid zero quantity');
            await frame.getByLabel('Category', { exact: true }).fill('Test');
            await frame.getByLabel('Quantity', { exact: true }).fill('0');
            await frame.getByRole('button', { name: 'Add item', exact: true }).click();
            await expect(frame.getByRole('alert')).toContainText(/positive whole number/i);
            await expect(frame.getByLabel('Item name', { exact: true })).toHaveValue(
              'Invalid zero quantity',
            );
            assert.deepEqual((await action('load', {})).result, before);
          },
        );
        await check('Cancel and confirm item deletion, with refresh persistence', async () => {
          await row(renamed).getByRole('button', { name: 'Delete', exact: true }).click();
          await frame.getByRole('button', { name: 'Keep item', exact: true }).click();
          await expect(row(renamed)).toBeVisible();
          for (const name of [renamed, charger, socks]) {
            await row(name).getByRole('button', { name: 'Delete', exact: true }).click();
            await frame.getByRole('button', { name: 'Delete item', exact: true }).click();
            await expect(row(name)).toHaveCount(0);
          }
          await page.reload();
          await expect(
            frame.getByRole('heading', { name: 'Your adventure, unpacked.' }),
          ).toBeVisible();
          assert.deepEqual((await action('load', {})).result.items, []);
          await frame.getByLabel('Trip name', { exact: true }).fill('Evaluation trip');
          await frame.locator('input[type="date"]').fill('');
          await frame.getByRole('button', { name: 'Save trip', exact: true }).click();
          await expect(
            frame.getByRole('heading', { name: 'Evaluation trip', exact: true }),
          ).toBeVisible();
        });
      } else {
        report.status = 'awaiting workflow checks';
      }
      await check('No horizontal overflow at 390px and 320px', async () => {
        for (const width of [390, 320]) {
          await page.setViewportSize({ width, height: 844 });
          const dimensions = await frame
            .locator('body')
            .evaluate((node) => ({ width: node.clientWidth, scroll: node.scrollWidth }));
          assert.ok(dimensions.scroll <= dimensions.width + 1, JSON.stringify(dimensions));
        }
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
          })),
        )
        .catch(() => []);
      await page.screenshot({
        path: `${screenshots}/${app.name.replaceAll(' ', '-')}-failure.png`,
        fullPage: true,
      });
    }
    reports.push(report);
    writeFileSync(`${directory}/browser-results.json`, JSON.stringify(reports, null, 2), {
      mode: 0o600,
    });
    console.log(JSON.stringify(report, null, 2));
    await page.close();
  }
  await context.close();
} finally {
  await browser.close();
}
if (reports.some((report) => report.status !== 'passed')) process.exitCode = 1;
