import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { OwnerStore } from '../../scripts/owner-store.mjs';
import sharp from 'sharp';

async function freePort() {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}
test('production HTTP login protects data, locks after three failures, and invalidates sessions on restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'little-http-')),
    owner = new OwnerStore(directory);
  const password = 'temporary http test password';
  owner.configure('owner@example.com', password);
  const port = await freePort(),
    origin = `http://127.0.0.1:${port}`;
  let child: ChildProcess | undefined,
    output = '';
  async function start() {
    output = '';
    child = spawn(process.execPath, ['scripts/start.mjs'], {
      cwd: resolve('.'),
      env: {
        ...process.env,
        APP_DATA_DIR: directory,
        APP_ORIGIN: origin,
        HOST: '127.0.0.1',
        PORT: String(port),
        APP_DIAGNOSTICS: 'off',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout!.on('data', (chunk) => (output += chunk));
    child.stderr!.on('data', (chunk) => (output += chunk));
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error(output);
      try {
        const response = await fetch(`${origin}/login`);
        if (response.status === 200) return;
      } catch {}
      await new Promise((done) => setTimeout(done, 100));
    }
    throw new Error(`Server did not start: ${output}`);
  }
  async function stop() {
    if (child && child.exitCode === null) {
      const closed = once(child, 'exit');
      child.kill('SIGTERM');
      await closed;
    }
    child = undefined;
  }
  const request = (path: string, options: RequestInit = {}) =>
    fetch(origin + path, { redirect: 'manual', ...options });
  const login = (email = 'owner@example.com', pass = password) =>
    request('/login', {
      method: 'POST',
      headers: { origin, accept: 'text/html', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email, password: pass }),
    });
  const cookie = (response: Response) =>
    response.headers
      .getSetCookie()
      .find((value) => value.startsWith('little_spaces_session='))
      ?.split(';')[0] || '';
  try {
    await start();
    for (const path of ['/', '/settings', '/chat', '/voice', '/spaces/private/applet']) {
      const response = await request(path);
      assert.equal(response.status, 303, path);
      assert.equal(response.headers.get('location'), '/login');
      assert.equal(response.headers.get('cache-control'), 'no-store');
    }
    for (const path of [
      '/api/applets',
      '/api/spaces',
      '/api/notifications',
      '/api/settings/secrets',
      '/api/settings/schedules',
      '/api/settings/push',
      '/api/spaces/private/schedules',
      '/api/spaces/private/photos/private',
      '/api/voice/actions?chatId=private',
      '/api/voice/speech',
      '/auth/callback?state=forged',
    ])
      assert.equal((await request(path)).status, 401, path);
    for (const path of [
      '/icon-192.png',
      '/icon-512.png',
      '/icon-180.png',
      '/manifest.webmanifest',
      '/appearance.js',
      '/icon.svg',
      '/favicon.ico',
      '/favicon-16.png',
      '/favicon-32.png',
      '/apple-touch-icon.png',
      '/icon-maskable-512.png',
    ])
      assert.equal((await request(path)).status, 200);
    const aliasLogin = await fetch(`http://localhost:${port}/login?from=settings`, {
      redirect: 'manual',
    });
    assert.equal(aliasLogin.status, 307);
    assert.equal(aliasLogin.headers.get('location'), `${origin}/login?from=settings`);
    const aliasPost = await fetch(`http://localhost:${port}/login`, {
      redirect: 'manual',
      method: 'POST',
      headers: {
        host: `localhost:${port}`,
        origin: `http://localhost:${port}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'email=unused&password=unused',
    });
    assert.equal(aliasPost.status, 403, 'cross-origin writes remain blocked, never redirected');
    const loginPage = await request('/login');
    const html = await loginPage.text();
    assert.ok(html.includes('id="login-title"'));
    assert.equal(html.includes('owner@example.com'), false);
    assert.equal(loginPage.headers.has('set-cookie'), false);
    const data = await request('/settings/__data.json');
    assert.deepEqual(
      await data.json(),
      { type: 'redirect', location: '/login' },
      'page-data requests must contain only a login redirect',
    );
    assert.equal(
      (
        await request('/login', {
          method: 'POST',
          headers: {
            origin: 'https://evil.example',
            'content-type': 'application/x-www-form-urlencoded',
          },
          body: 'email=a&password=b',
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await request('/login', {
          method: 'POST',
          headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
          body: 'x'.repeat(5000),
        })
      ).status,
      413,
    );
    const accepted = await login();
    assert.equal(accepted.status, 303);
    const first = cookie(accepted);
    assert.ok(first);
    assert.match(accepted.headers.getSetCookie().join(';'), /HttpOnly/i);
    assert.equal((await request('/settings', { headers: { cookie: first } })).status, 200);
    const homeHtml = await (await request('/', { headers: { cookie: first } })).text();
    assert.match(homeHtml, /ChatGPT connection required/);
    assert.ok(homeHtml.indexOf('>Voice</span>') < homeHtml.indexOf('>Chat</span>'));
    const chatRedirect = await request('/chat', { headers: { cookie: first } });
    const disconnectedChat = await (
      await request(chatRedirect.headers.get('location')!, { headers: { cookie: first } })
    ).text();
    assert.match(disconnectedChat, /Connect ChatGPT/);
    assert.ok(!disconnectedChat.includes('aria-label="Message"'));
    assert.ok(!disconnectedChat.includes('What’s on your mind?'));
    assert.ok(!disconnectedChat.includes('Choose conversation:'));
    assert.equal((await request('/api/spaces', { headers: { cookie: first } })).status, 200);
    const headers = { origin, cookie: first, 'content-type': 'application/json' };
    const voiceRedirect = await request('/voice', { headers });
    assert.match(voiceRedirect.headers.get('location')!, /^\/voice\//);
    const speechStatus = await request('/api/voice/speech', { headers });
    assert.equal((await speechStatus.json()).engine, 'piper');
    for (const path of ['/api/voice/actions', '/api/voice/speech']) {
      assert.equal(
        (
          await request(path, {
            method: 'POST',
            headers: { ...headers, origin: 'https://evil.example' },
            body: '{}',
          })
        ).status,
        403,
      );
      assert.equal((await request(path, { method: 'POST', headers, body: '{}' })).status, 400);
    }
    const missingSchedule = await request('/api/settings/schedules', {
      method: 'POST',
      headers,
      body: JSON.stringify({ spaceId: 'missing', key: 'check' }),
    });
    assert.equal(missingSchedule.status, 400);
    assert.match((await missingSchedule.json()).error, /not found/);
    const savedSecret = await request('/api/settings/secrets', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: 'HTTP_KEY',
        description: 'A test credential',
        value: 'never-return-this-value',
      }),
    });
    assert.equal(savedSecret.status, 200);
    assert.ok(!(await savedSecret.text()).includes('never-return-this-value'));
    const secretList = await request('/api/settings/secrets', { headers });
    const secretText = await secretList.text();
    assert.ok(secretText.includes('HTTP_KEY'));
    assert.ok(!secretText.includes('never-return-this-value'));
    const csrfSecret = await request('/api/settings/secrets', {
      method: 'POST',
      headers: { ...headers, origin: 'https://evil.example' },
      body: JSON.stringify({ name: 'HTTP_KEY', value: 'bad', description: '' }),
    });
    assert.equal(csrfSecret.status, 403);
    const unsafePush = await request('/api/settings/push', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        subscription: {
          endpoint: 'https://127.0.0.1/internal',
          keys: { p256dh: 'A'.repeat(87), auth: 'A'.repeat(22) },
        },
      }),
    });
    assert.equal(unsafePush.status, 400);
    const created = await request('/api/applets', {
      method: 'POST',
      headers,
      body: JSON.stringify({ template: 'plants' }),
    });
    assert.equal(created.status, 200, await created.clone().text());
    const { applet } = await created.json();
    const emptyChat = await request(`/api/spaces/${applet.id}/chats`, {
      method: 'POST',
      headers,
      body: '{}',
    });
    const { chat: empty } = await emptyChat.json();
    const cleanupBody = JSON.stringify({ chatId: empty.id });
    assert.equal(
      (
        await request('/api/chat', {
          method: 'DELETE',
          headers: { ...headers, origin: 'https://evil.example' },
          body: cleanupBody,
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await request('/api/chat', {
          method: 'DELETE',
          headers: { origin, 'content-type': 'application/json' },
          body: cleanupBody,
        })
      ).status,
      401,
    );
    assert.deepEqual(
      await (await request('/api/chat', { method: 'DELETE', headers, body: cleanupBody })).json(),
      { deleted: true },
    );
    assert.deepEqual(
      await (await request('/api/chat', { method: 'DELETE', headers, body: cleanupBody })).json(),
      { deleted: false },
    );
    assert.equal((await request(`/spaces/${applet.id}/chat/${empty.id}`, { headers })).status, 307);
    const scheduled = await request(`/api/spaces/${applet.id}/schedules`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        key: 'check',
        title: 'Check plants',
        prompt: 'Inspect current plants',
        model: 'test-model',
        timezone: 'UTC',
        dueAt: '2099-01-01T00:00:00Z',
      }),
    });
    assert.equal(scheduled.status, 200, await scheduled.clone().text());
    const settingsHtml = await (await request('/settings', { headers })).text();
    assert.ok(!settingsHtml.includes('Add plant tracker'));
    const archive = await request('/api/settings/apps', {
      method: 'POST',
      headers,
      body: JSON.stringify({ id: applet.id, archived: true }),
    });
    assert.equal(archive.status, 200);
    assert.equal((await archive.json()).space.archived, true);
    const activeSpaces = await (await request('/api/spaces', { headers })).json();
    assert.ok(!activeSpaces.spaces.some((space: { id: string }) => space.id === applet.id));
    const archivedPage = await request(`/spaces/${applet.id}/applet`, { headers });
    assert.equal(archivedPage.headers.get('location'), '/settings#apps');
    const restore = await request('/api/settings/apps', {
      method: 'POST',
      headers,
      body: JSON.stringify({ id: applet.id, archived: false }),
    });
    assert.equal(restore.status, 200);
    const action = await request(`/api/applets/${applet.id}/actions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ action: 'addPlant', input: { name: 'Fern', interval: 7 } }),
    });
    assert.equal(action.status, 200, await action.clone().text());
    const bypass = await request(`/api/applets/${applet.id}/records`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ method: 'set', key: 'bypass', value: {} }),
    });
    assert.equal(bypass.status, 400);
    assert.match((await bypass.json()).error, /backend actions/);
    const pixels = await sharp({
      create: { width: 2, height: 2, channels: 3, background: '#00ff00' },
    })
      .png()
      .toBuffer();
    const form = new FormData();
    form.append('photo', new Blob([new Uint8Array(pixels)], { type: 'image/png' }), 'fern.png');
    const uploaded = await request(`/api/spaces/${applet.id}/photos`, {
      method: 'POST',
      headers: { origin, cookie: first },
      body: form,
    });
    assert.equal(uploaded.status, 200, await uploaded.clone().text());
    assert.equal((await uploaded.json()).photo.mime, 'image/jpeg');
    const oversized = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 9; i++) controller.enqueue(new Uint8Array(1024 * 1024));
        controller.close();
      },
    });
    const rejected = await request(`/api/spaces/${applet.id}/photos`, {
      method: 'POST',
      headers: { origin, cookie: first, 'content-type': 'multipart/form-data; boundary=test' },
      body: oversized,
      duplex: 'half',
    } as RequestInit);
    assert.equal(rejected.status, 413, 'chunked uploads must enforce the photo request limit');
    assert.equal(
      (
        await request('/api/spaces', {
          method: 'POST',
          headers: { cookie: first, 'content-type': 'application/json' },
          body: '{}',
        })
      ).status,
      403,
    );
    const logout = await request('/logout', { method: 'POST', headers: { origin, cookie: first } });
    assert.equal(logout.status, 303);
    assert.equal((await request('/api/spaces', { headers: { cookie: first } })).status, 401);
    const second = cookie(await login());
    assert.ok(second);
    assert.notEqual(first, second);
    await stop();
    await start();
    assert.equal(
      (await request('/api/spaces', { headers: { cookie: second } })).status,
      401,
      'restart must revoke sessions',
    );
    assert.equal((await login('owner@example.com', 'wrong')).status, 400);
    assert.equal((await login('unknown@example.com', password)).status, 400);
    const locked = await login('owner@example.com', 'wrong');
    assert.equal(locked.status, 429);
    assert.equal(locked.headers.get('retry-after'), '300');
    await stop();
    await start();
    assert.equal((await login()).status, 429, 'restart must preserve lockout');
    owner.configure('owner@example.com', password, true);
    const third = cookie(await login());
    assert.ok(third);
    const persisted = await request('/api/settings/schedules', { headers: { cookie: third } });
    assert.equal((await persisted.json()).schedules[0].key, 'check');
    const persistedSecret = await request('/api/settings/secrets', { headers: { cookie: third } });
    assert.equal((await persistedSecret.json()).secrets[0].name, 'HTTP_KEY');
    owner.configure('owner@example.com', 'new temporary http password', true);
    assert.equal(
      (await request('/api/spaces', { headers: { cookie: third } })).status,
      401,
      'CLI reset must revoke sessions',
    );
  } finally {
    await stop();
    owner.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('fresh production install permits token-protected registration once and rotates setup links on restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'little-http-setup-')),
    owner = new OwnerStore(directory);
  const port = await freePort(),
    origin = `http://127.0.0.1:${port}`;
  let child: ChildProcess | undefined,
    output = '';
  async function start() {
    output = '';
    child = spawn(process.execPath, ['scripts/start.mjs'], {
      cwd: resolve('.'),
      env: {
        ...process.env,
        APP_DATA_DIR: directory,
        APP_ORIGIN: origin,
        HOST: '127.0.0.1',
        PORT: String(port),
        APP_DIAGNOSTICS: 'off',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout!.on('data', (chunk) => (output += chunk));
    child.stderr!.on('data', (chunk) => (output += chunk));
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error('Setup server exited unexpectedly.');
      try {
        if ((await fetch(`${origin}/setup`)).status === 200) return;
      } catch {}
      await new Promise((done) => setTimeout(done, 100));
    }
    throw new Error('Setup server did not start.');
  }
  async function stop() {
    if (child && child.exitCode === null) {
      const closed = once(child, 'exit');
      child.kill('SIGTERM');
      await closed;
    }
    child = undefined;
  }
  const request = (path: string, options: RequestInit = {}) =>
    fetch(origin + path, { redirect: 'manual', ...options });
  const post = (action: string, fields: Record<string, string>, cookie = '') =>
    request(`/setup?/${action}`, {
      method: 'POST',
      headers: {
        origin,
        accept: 'text/html',
        'content-type': 'application/x-www-form-urlencoded',
        cookie,
      },
      body: new URLSearchParams(fields),
    });
  const token = () => {
    const value = output.match(/\/setup#token=([A-Za-z0-9_-]{43})/)?.[1];
    assert.ok(value, 'startup must print a private setup link');
    return value;
  };
  const setupCookie = (response: Response) =>
    response.headers
      .getSetCookie()
      .find((value) => value.startsWith('little_spaces_setup='))
      ?.split(';')[0] || '';
  const password = 'temporary registration password';
  try {
    await start();
    const old = token();
    const home = await request('/');
    assert.equal(home.status, 303);
    assert.equal(home.headers.get('location'), '/setup');
    assert.equal((await request('/api/spaces')).status, 401);
    const generic = await (await request('/setup')).text();
    assert.ok(generic.includes('Set up LittleSpaces'));
    assert.equal(generic.includes('name="email"'), false);
    assert.equal(generic.includes(old), false);
    assert.equal(
      (await post('register', { email: 'attacker@example.com', password, confirmation: password }))
        .status,
      403,
    );
    assert.equal((await post('unlock', { token: 'x'.repeat(43) })).status, 403);
    const unlocked = await post('unlock', { token: old });
    assert.equal(unlocked.status, 303);
    const oldCookie = setupCookie(unlocked);
    assert.ok(oldCookie);
    assert.match(unlocked.headers.getSetCookie().join(';'), /HttpOnly/);
    const form = await request('/setup', { headers: { cookie: oldCookie } });
    assert.ok((await form.text()).includes('Create account'));
    assert.equal(
      (
        await post(
          'register',
          { email: 'owner@example.com', password, confirmation: 'mismatch' },
          oldCookie,
        )
      ).status,
      400,
    );
    assert.equal(owner.get(), undefined);
    await stop();
    await start();
    const fresh = token();
    assert.notEqual(fresh, old);
    assert.equal((await post('unlock', { token: old })).status, 403);
    assert.equal(
      (
        await post(
          'register',
          { email: 'owner@example.com', password, confirmation: password },
          oldCookie,
        )
      ).status,
      403,
    );
    const cookie = setupCookie(await post('unlock', { token: fresh }));
    assert.ok(cookie);
    const responses = await Promise.all([
      post('register', { email: 'owner@example.com', password, confirmation: password }, cookie),
      post('register', { email: 'owner@example.com', password, confirmation: password }, cookie),
    ]);
    assert.equal(responses.filter((response) => response.status === 303).length, 1);
    assert.ok(responses.some((response) => [403, 404, 409].includes(response.status)));
    const accepted = responses.find((response) => response.status === 303)!;
    assert.ok(
      accepted.headers.getSetCookie().some((value) => value.startsWith('little_spaces_session=')),
    );
    assert.equal(owner.requireOwner().email, 'owner@example.com');
    assert.equal((await post('unlock', { token: fresh })).status, 404);
    assert.equal(
      (
        await post(
          'register',
          { email: 'attacker@example.com', password, confirmation: password },
          cookie,
        )
      ).status,
      404,
    );
    assert.equal((await request('/setup')).headers.get('location'), '/login');
    await stop();
    await start();
    assert.equal(
      output.includes('/setup#token='),
      false,
      'configured startup must not issue another setup link',
    );
  } finally {
    await stop();
    owner.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
