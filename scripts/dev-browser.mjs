import { chromium } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { devClient } from './dev-client.mjs';

const client = devClient();
const directory = '.data/dev-instance/browser';
mkdirSync(directory, { recursive: true, mode: 0o700 });
const browser = await chromium.launch();
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const signed = await context.request.post(`${client.origin}/api/dev/session`, {
    headers: client.headers,
    data: {},
  });
  if (!signed.ok()) throw Error(`Browser sign-in failed (${signed.status()}).`);
  const { applets } = await client.json('/api/applets');
  const evaluation = process.argv[2];
  const targets = evaluation
    ? JSON.parse(readFileSync(`${evaluation}/results.json`, 'utf8')).map((app) => app.appletId)
    : undefined;
  for (const app of applets.filter((app) => !targets || targets.includes(app.id))) {
    const { spaceId } = await client.json(`/api/applets/${app.id}`);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${client.origin}/spaces/${spaceId}/applet`);
    const frame = page.frameLocator('iframe[title="Your applet"]');
    await frame.locator('main').waitFor();
    await frame
      .getByText(/Loading/)
      .first()
      .waitFor({ state: 'hidden', timeout: 10000 })
      .catch(() => {});
    const inspection = {
      appletId: app.id,
      title: app.title,
      text: await frame.locator('body').innerText(),
      controls: await frame.locator('input,select,button').evaluateAll((nodes) =>
        nodes.map((node) => ({
          tag: node.tagName,
          type: node.getAttribute('type'),
          label: node.getAttribute('aria-label'),
          placeholder: node.getAttribute('placeholder'),
          text: node.textContent,
          id: node.id,
        })),
      ),
      errors,
      styles: await frame.locator('body,main,h1,h2,button,input').evaluateAll((nodes) =>
        nodes.slice(0, 20).map((node) => {
          const style = getComputedStyle(node);
          return {
            tag: node.tagName,
            text: node.textContent?.slice(0, 80),
            font: style.fontFamily,
            fontSize: style.fontSize,
            color: style.color,
            background: style.backgroundColor,
          };
        }),
      ),
    };
    console.log(JSON.stringify(inspection, null, 2));
    await page.screenshot({ path: `${directory}/${app.id}-desktop.png`, fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: `${directory}/${app.id}-mobile.png`, fullPage: true });
    const overflow = await frame
      .locator('body')
      .evaluate((node) => ({ width: node.clientWidth, scrollWidth: node.scrollWidth }));
    writeFileSync(
      `${directory}/${app.id}-inspection.json`,
      JSON.stringify({ ...inspection, mobile: overflow }, null, 2),
      { mode: 0o600 },
    );
    await page.close();
  }
  await context.close();
} finally {
  await browser.close();
}
