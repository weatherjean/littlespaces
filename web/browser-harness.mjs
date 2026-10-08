// Development-only browser service. Never bundled into the Rust executable.
import http from 'node:http';
import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { timingSafeEqual, randomUUID } from 'node:crypto';
export async function startHarness({
  token,
  port = 0,
  artifacts = new URL('../build-rust/screenshots/', import.meta.url).pathname,
}) {
  if (!token || token.length < 32) throw Error('A private harness token is required');
  await mkdir(artifacts, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  let active = false;
  const server = http.createServer(async (req, res) => {
    const auth = Buffer.from(req.headers.authorization || ''),
      expected = Buffer.from(`Bearer ${token}`);
    if (
      req.method !== 'POST' ||
      auth.length !== expected.length ||
      !timingSafeEqual(auth, expected)
    ) {
      res.writeHead(401).end();
      return;
    }
    if (active) {
      res.writeHead(503).end();
      return;
    }
    active = true;
    let context, page;
    const errors = [];
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 256 * 1024) throw Error('Request too large');
        chunks.push(chunk);
      }
      const { url, steps } = JSON.parse(Buffer.concat(chunks));
      const target = new URL(url);
      if (
        target.protocol !== 'http:' ||
        target.hostname !== '127.0.0.1' ||
        !target.pathname.startsWith('/preview-test/')
      )
        throw Error('Invalid preview URL');
      if (!Array.isArray(steps) || steps.length > 32) throw Error('Invalid browser suite');
      context = await browser.newContext();
      page = await context.newPage();
      page.setDefaultTimeout(5000);
      page.on('pageerror', (e) => errors.push(String(e).slice(0, 2000)));
      await context.route('**/*', (route) => {
        const url = new URL(route.request().url());
        if (url.origin === target.origin || url.protocol === 'data:') return route.continue();
        return route.abort();
      });
      await page.goto(url);
      const frame = page.frameLocator('#frame');
      let assertions = 0;
      for (const step of steps) {
        if (typeof step.selector !== 'string' || step.selector.length > 256)
          throw Error('Invalid selector');
        const locator = frame.locator(step.selector);
        if (step.action === 'fill') await locator.fill(String(step.value));
        else if (step.action === 'click') await locator.click();
        else if (step.action === 'text') {
          await locator
            .filter({ hasText: String(step.contains) })
            .first()
            .waitFor();
          assertions++;
        } else throw Error('Unknown browser step');
      }
      errors.push(...(await page.evaluate(() => window.errors || [])));
      const screenshot = `browser-${randomUUID()}.png`;
      await page.screenshot({ path: `${artifacts}/${screenshot}`, fullPage: true });
      const snapshot = (await frame.locator('body').innerText()).slice(0, 8192);
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          passed: errors.length === 0 && assertions > 0,
          assertions,
          errors,
          snapshot,
          screenshot,
        }),
      );
    } catch (error) {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          passed: false,
          assertions: 0,
          errors: [
            ...errors,
            String(error).slice(0, 4096),
            ...((await page?.evaluate(() => window.errors || []).catch(() => [])) || []),
          ],
          snapshot: await page
            ?.frameLocator('#frame')
            .locator('body')
            .innerText()
            .catch(() => '<unavailable>'),
        }),
      );
    } finally {
      await context?.close().catch(() => {});
      active = false;
    }
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await browser.close();
    },
  };
}
if (process.argv[1] === new URL(import.meta.url).pathname) {
  const service = await startHarness({
    token: process.env.LITTLESPACES_BROWSER_TOKEN,
    port: Number(process.env.LITTLESPACES_BROWSER_PORT || 5176),
  });
  console.log(`Development browser harness: ${service.url}`);
  process.on('SIGINT', async () => {
    await service.close();
    process.exit();
  });
}
