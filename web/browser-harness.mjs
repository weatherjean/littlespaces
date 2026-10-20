import { fileURLToPath } from 'node:url';
// Optional browser verifier service. Never bundled into the Rust executable.
import http from 'node:http';
import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { timingSafeEqual, randomUUID } from 'node:crypto';
export async function startHarness({
  token,
  port = 0,
  publicOrigin = process.env.LITTLESPACES_PUBLIC_URL,
  connectOrigin = process.env.LITTLESPACES_BROWSER_CONNECT_ORIGIN,
  artifacts = fileURLToPath(new URL('../build-rust/screenshots/', import.meta.url)),
}) {
  if (!token || token.length < 32) throw Error('A private harness token is required');
  if (connectOrigin) {
    const internal = new URL(connectOrigin);
    if (
      internal.protocol !== 'http:' ||
      internal.hostname !== '127.0.0.1' ||
      internal.username ||
      internal.password ||
      internal.pathname !== '/' ||
      internal.search ||
      internal.hash
    )
      throw Error('Verifier connection origin must be HTTP loopback');
    connectOrigin = internal.origin;
  }
  await mkdir(artifacts, { recursive: true, mode: 0o700 });
  const browser = await chromium.launch({
    headless: true,
    chromiumSandbox: process.env.LITTLESPACES_BROWSER_SANDBOX === '1',
  });
  let active = false;
  const server = http.createServer(async (req, res) => {
    const auth = Buffer.from(req.headers.authorization || ''),
      expected = Buffer.from(`Bearer ${token}`);
    if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) {
      res.writeHead(401).end();
      return;
    }
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(browser.isConnected() ? 200 : 503, { 'cache-control': 'no-store' }).end();
      return;
    }
    if (req.method !== 'POST' || req.url !== '/') {
      res.writeHead(404).end();
      return;
    }
    if (active) {
      res.writeHead(503).end();
      return;
    }
    active = true;
    let context, page, responseBody;
    const errors = [];
    let assertions = 0,
      completedSteps = 0,
      failedStep = null;
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
        !(
          (target.protocol === 'http:' && target.hostname === '127.0.0.1') ||
          (target.protocol === 'https:' && target.origin === publicOrigin)
        ) ||
        target.username ||
        target.password ||
        !target.pathname.startsWith('/preview-test/')
      )
        throw Error('Invalid preview URL');
      if (!Array.isArray(steps) || steps.length > 32) throw Error('Invalid browser suite');
      context = await browser.newContext();
      // Verification needs HTTP only; WebSockets bypass HTTP request routing.
      await context.routeWebSocket('**/*', (socket) => socket.close());
      page = await context.newPage();
      page.setDefaultTimeout(5000);
      page.on('pageerror', (e) => errors.push(String(e).slice(0, 2000)));
      await context.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== target.origin || !['http:', 'https:'].includes(url.protocol))
          return route.abort();
        // route.continue() follows redirects without calling this handler again.
        // Preview endpoints need no redirects: reject them before any next hop.
        let response;
        try {
          // In Compose the browser retains the public origin/CSP while transport
          // goes directly to the app's private loopback listener. This also works
          // when Tailscale Serve uses userspace networking and has no kernel route.
          const internal =
            connectOrigin && url.origin === publicOrigin
              ? new URL(url.pathname + url.search, connectOrigin)
              : null;
          response = await route.fetch({
            maxRedirects: 0,
            timeout: 10000,
            ...(internal
              ? { url: internal.href, headers: { ...route.request().headers(), host: url.host } }
              : {}),
          });
          if (response.status() >= 300 && response.status() < 400) await route.abort();
          else await route.fulfill({ response });
        } catch {
          await route.abort().catch(() => {});
        } finally {
          // Context shutdown can dispose the response before this callback does.
          await response?.dispose().catch(() => {});
        }
      });
      await page.goto(url);
      const frame = page.frameLocator('#frame');
      for (const [index, step] of steps.entries()) {
        failedStep = { index: index + 1, action: step.action, selector: step.selector };
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
        } else if (step.action === 'value') {
          await expect(locator).toHaveValue(String(step.value));
          assertions++;
        } else if (step.action === 'enabled') {
          await expect(locator).toBeEnabled();
          assertions++;
        } else throw Error('Unknown browser step');
        completedSteps++;
      }
      failedStep = null;
      errors.push(...(await page.evaluate(() => window.errors || [])));
      const screenshot = `browser-${randomUUID()}.png`;
      // App content can be private even when the developer's umask is permissive.
      await writeFile(`${artifacts}/${screenshot}`, await page.screenshot({ fullPage: true }), {
        mode: 0o600,
        flag: 'wx',
      });
      const snapshot = (await frame.locator('body').innerText()).slice(0, 8192);
      res.setHeader('content-type', 'application/json');
      responseBody = JSON.stringify({
        passed: errors.length === 0 && assertions > 0,
        assertions,
        completedSteps,
        errors,
        snapshot,
        screenshot,
      });
    } catch (error) {
      res.setHeader('content-type', 'application/json');
      responseBody = JSON.stringify({
        passed: false,
        assertions,
        completedSteps,
        failedStep,
        errors: [
          ...errors,
          String(error).slice(0, 4096),
          ...((await page?.evaluate(() => window.errors || []).catch(() => [])) || []),
        ],
        snapshot: await page
          ?.frameLocator('#frame')
          .locator('body')
          .innerText()
          .then((text) => text.slice(0, 8192))
          .catch(() => '<unavailable>'),
      });
    } finally {
      await context?.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
      await context?.close().catch(() => {});
      active = false;
    }
    // Admit the next request before exposing completion to the caller.
    res.end(responseBody);
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
if (process.argv[1] === fileURLToPath(new URL(import.meta.url))) {
  const service = await startHarness({
    token: process.env.LITTLESPACES_BROWSER_TOKEN,
    port: Number(process.env.LITTLESPACES_BROWSER_PORT || 5176),
    artifacts: process.env.LITTLESPACES_BROWSER_ARTIFACTS,
  });
  console.log(`Browser verifier: ${service.url}`);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await service.close();
    process.exit();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
