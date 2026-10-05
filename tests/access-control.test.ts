import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isHttpError, isRedirect, type RequestEvent } from '@sveltejs/kit';
const directory = mkdtempSync(join(tmpdir(), 'little-guard-'));
process.env.APP_DATA_DIR = directory;
process.env.APP_ORIGIN = 'https://private.example.org';
const { guard, privateHeaders } = await import('../src/lib/server/access-control');
const { ownerStore } = await import('../src/lib/server/owner');
const { sessions } = await import('../src/lib/server/sessions');
const { sessionCookie, cookieOptions } = await import('../src/lib/server/security');
after(() => {
  ownerStore().close();
  rmSync(directory, { recursive: true, force: true });
});
function event(path: string, method = 'GET', token?: string, origin?: string) {
  return {
    url: new URL(path, 'https://private.example.org'),
    request: new Request(new URL(path, 'https://private.example.org'), {
      method,
      headers: origin ? { origin } : {},
    }),
    locals: {},
    cookies: { get: (name: string) => (name === sessionCookie ? token : undefined) },
  } as unknown as RequestEvent;
}
test('unconfigured app exposes only setup and generic assets, never private data', () => {
  guard(event('/setup'));
  guard(event('/setup', 'POST', undefined, 'https://private.example.org'));
  for (const path of ['/login', '/', '/settings'])
    assert.throws(
      () => guard(event(path)),
      (e) => isRedirect(e) && e.location === '/setup',
    );
  assert.throws(
    () => guard(event('/api/spaces')),
    (e) => isHttpError(e, 401),
  );
  assert.throws(
    () => guard(event('/setup', 'POST', undefined, 'https://evil.example')),
    (e) => isHttpError(e, 403),
  );
  ownerStore().configure('owner@example.com', 'test-only-long-password');
});
test('private pages, APIs, OAuth, unknown routes and page-data requests require a session', () => {
  for (const path of [
    '/',
    '/settings',
    '/chat',
    '/spaces/id/applet',
    '/settings/__data.json',
    '/unknown',
  ])
    assert.throws(
      () => guard(event(path)),
      (e) => isRedirect(e) && e.location === '/login',
    );
  for (const path of [
    '/api/applets',
    '/api/spaces/id/photos/photo',
    '/api/notifications',
    '/auth/callback?code=secret',
    '/auth/start',
  ])
    assert.throws(
      () => guard(event(path)),
      (e) => isHttpError(e, 401),
    );
  assert.throws(
    () => guard(event('/setup')),
    (e) => isRedirect(e) && e.location === '/login',
  );
  assert.throws(
    () => guard(event('/setup', 'POST', undefined, 'https://private.example.org')),
    (e) => isHttpError(e, 404),
  );
  guard(event('/login'));
  guard(event('/icon.svg'));
  guard(event('/appearance.js'));
  guard(event('/_app/immutable/app.js'));
  assert.equal(sessionCookie.startsWith('__Host-'), true);
  assert.equal(cookieOptions.secure, true);
  assert.equal(cookieOptions.httpOnly, true);
});
test('valid owner sessions allow routes but never cross-origin writes; cookie forgery does not work', () => {
  const owner = ownerStore().requireOwner(),
    token = sessions.create(owner.email, owner.version);
  const request = event('/settings', 'GET', token);
  guard(request);
  assert.equal(request.locals.owner?.email, owner.email);
  guard(event('/api/spaces', 'POST', token, 'https://private.example.org'));
  for (const origin of [undefined, 'null', 'https://evil.example'])
    assert.throws(
      () => guard(event('/api/spaces', 'POST', token, origin)),
      (e) => isHttpError(e, 403),
    );
  assert.throws(
    () => guard(event('/login', 'POST', undefined, 'https://evil.example')),
    (e) => isHttpError(e, 403),
  );
  assert.throws(
    () => guard(event('/api/spaces', 'GET', 'fabricated-cookie')),
    (e) => isHttpError(e, 401),
  );
  const response = privateHeaders(new Response('private'));
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.ok(response.headers.has('strict-transport-security'));
  assert.equal(
    privateHeaders(new Response(null, { status: 413 })).headers.get('connection'),
    'close',
  );
});
