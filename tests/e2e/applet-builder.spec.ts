import { test, expect } from '@playwright/test';
import { compileApplet } from '../../src/lib/server/compiler';
import { buildExamples } from '../../src/lib/server/build-examples';
import { appletDocument } from '../../src/lib/sandbox';

async function mount(page: import('@playwright/test').Page, bundle: string) {
  await page.setContent(
    '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0"></body></html>',
  );
  await page.evaluate(
    (document) => {
      const host = window as any;
      host.launches = [];
      host.failList = false;
      host.failChat = false;
      addEventListener('message', (event) => {
        if (event.data?.channel !== 'little-spaces') return;
        const { id, method, params } = event.data;
        if (method === 'chat.open') host.launches.push(params);
        event.source?.postMessage(
          {
            channel: 'little-spaces-result',
            id,
            ...(method === 'action' && host.failList
              ? {
                  error:
                    'Service returned 401. Check the configured credential in Settings → Secrets.',
                }
              : method === 'chat.open' && host.failChat
                ? { error: 'Chat unavailable' }
                : {
                    result:
                      method === 'action'
                        ? []
                        : method === 'chat.open'
                          ? { id: 'error-chat' }
                          : { logged: true },
                  }),
          },
          { targetOrigin: '*' },
        );
      });
      const frame = window.document.createElement('iframe');
      frame.title = 'Test app';
      frame.setAttribute('sandbox', 'allow-scripts');
      frame.style.cssText = 'width:100%;height:800px;border:0';
      frame.srcdoc = document;
      window.document.body.append(frame);
    },
    appletDocument(bundle, 'test-nonce'),
  );
  return page.frameLocator('iframe');
}

test('starter renders compiled Tailwind and attaches an actionable error to chat', async ({
  page,
}) => {
  const frame = await mount(page, await compileApplet(buildExamples.starter.source));
  await expect(frame.getByText('No entries yet', { exact: true })).toBeVisible();
  expect(
    await frame.locator('main').evaluate((element) => getComputedStyle(element).paddingLeft),
  ).toBe(page.viewportSize()!.width >= 640 ? '32px' : '16px');
  expect(
    await frame.locator('main').evaluate((element) => element.scrollWidth <= window.innerWidth),
  ).toBe(true);
  await page.evaluate(() => {
    (window as any).failList = true;
  });
  await frame.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(frame.getByRole('alert')).toContainText('Service returned 401');
  await expect(frame.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
  await frame.getByRole('button', { name: 'Ask about this error' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).launches.length)).toBe(1);
  const launch = await page.evaluate(() => (window as any).launches[0]);
  expect(launch.context.error.operation).toBe('Load entries');
  expect(launch.context.error.message).toContain('401');
  expect(launch.welcome).toContain('error details');
  expect(launch.context.error).not.toHaveProperty('records');
  await page.evaluate(() => {
    (window as any).failChat = true;
  });
  await frame.getByRole('button', { name: 'Ask about this error' }).click();
  await expect(frame.getByRole('alert').last()).toContainText(
    'Could not open troubleshooting chat',
  );
  await expect(frame.getByRole('alert').first()).toContainText('Service returned 401');
});

test('unhandled app errors have a host-provided troubleshooting button with redacted context', async ({
  page,
}) => {
  const frame = await mount(
    page,
    'throw new Error("Could not start: Bearer fake-secret token=another-secret")',
  );
  await expect(frame.getByRole('alert').first()).toContainText('Could not start');
  await expect(frame.getByRole('alert').first()).not.toContainText('fake-secret');
  await frame.getByRole('button', { name: 'Ask about this error' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).launches.length)).toBe(1);
  const launch = await page.evaluate(() => (window as any).launches[0]);
  expect(launch.context.error.message).toContain('[redacted]');
  expect(launch.context.error.message).not.toContain('another-secret');
  expect(launch.context.error).not.toHaveProperty('stack');
});
