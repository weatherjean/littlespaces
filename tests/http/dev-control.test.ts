import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { OwnerStore } from '../../scripts/owner-store.mjs';

test('live dev API uses the capability, preserves origin checks and supplies browser sessions', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'little-dev-control-'));
  const owner = new OwnerStore(directory);
  owner.configure('dev@example.test', 'temporary development password');
  owner.close();
  const reservation = createServer();
  await new Promise<void>((done) => reservation.listen(0, '127.0.0.1', done));
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((done) => reservation.close(() => done()));
  const origin = `http://127.0.0.1:${port}`;
  const token = 'a'.repeat(43);
  const child = spawn(process.execPath, ['scripts/dev.mjs'], {
    env: {
      ...process.env,
      APP_DATA_DIR: directory,
      APP_ORIGIN: origin,
      APP_DEV_CONTROL_TOKEN: token,
      APP_DIAGNOSTICS: 'off',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw Error(output);
      try {
        ready = (await fetch(origin + '/login')).status === 200;
      } catch {}
      if (ready) break;
      await new Promise((done) => setTimeout(done, 100));
    }
    assert.ok(ready, output);
    assert.equal((await fetch(origin + '/api/spaces')).status, 401);
    assert.equal(
      (
        await fetch(origin + '/api/spaces', {
          headers: { authorization: `Bearer ${'b'.repeat(43)}` },
        })
      ).status,
      401,
    );
    const headers = {
      origin,
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    };
    assert.equal((await fetch(origin + '/api/spaces', { headers })).status, 200);
    assert.equal(
      (
        await fetch(origin + '/api/spaces', {
          method: 'POST',
          headers: { ...headers, origin: 'https://evil.example' },
          body: '{}',
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(origin + '/api/spaces', {
          headers: { ...headers, 'sec-fetch-site': 'cross-site' },
        })
      ).status,
      401,
    );
    assert.equal((await fetch(origin + '/settings', { headers, redirect: 'manual' })).status, 303);
    const signed = await fetch(origin + '/api/dev/session', {
      method: 'POST',
      headers,
      body: '{}',
    });
    assert.equal(signed.status, 200);
    const cookie = signed.headers
      .getSetCookie()
      .find((value) => value.startsWith('little_spaces_session='))!
      .split(';')[0];
    assert.equal(
      (await fetch(origin + '/settings', { headers: { cookie }, redirect: 'manual' })).status,
      200,
    );
    assert.equal(
      (
        await fetch(origin + '/api/dev/session', {
          method: 'POST',
          headers: { origin, cookie },
          body: '{}',
        })
      ).status,
      404,
    );
  } finally {
    if (child.exitCode === null) {
      const stopped = once(child, 'exit');
      child.kill('SIGTERM');
      await stopped;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
