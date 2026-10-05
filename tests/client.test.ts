import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from '../src/lib/client';

test('host requests reject framework error responses instead of reporting a successful write', async (t) => {
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ message: 'Sign in to continue.' }, { status: 401 }),
  );
  await assert.rejects(
    () => request('/api/applets/example/records', { method: 'set', key: 'x', value: 1 }),
    /Sign in to continue/,
  );
});

test('host requests preserve successful bridge results and app-specific errors', async (t) => {
  const mock = t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ result: { saved: true } }),
  );
  assert.deepEqual(await request('/api/applets/example/actions', { action: 'save' }), {
    result: { saved: true },
  });
  mock.mock.mockImplementation(async () =>
    Response.json({ error: 'Invalid action input.' }, { status: 400 }),
  );
  await assert.rejects(
    () => request('/api/applets/example/actions', { action: 'save' }),
    /Invalid action input/,
  );
});

test('HTML proxy failures and malformed success responses produce useful errors', async (t) => {
  const mock = t.mock.method(
    globalThis,
    'fetch',
    async () => new Response('<h1>Bad gateway</h1>', { status: 502 }),
  );
  await assert.rejects(() => request('/api/models'), /Request failed \(502\)/);
  mock.mock.mockImplementation(async () => new Response('<html>Not JSON</html>'));
  await assert.rejects(() => request('/api/models'), /unreadable response/);
  mock.mock.mockImplementation(async () => Response.json(null));
  await assert.rejects(() => request('/api/models'), /unreadable response/);
});
