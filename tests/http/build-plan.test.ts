import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { OwnerStore } from '../../scripts/owner-store.mjs';

test('HTTP chat proposes, persists, approves, loads the skill, tests and publishes without a mode switch', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'little-build-http-'));
  const owner = new OwnerStore(directory);
  const password = 'temporary build test password';
  owner.configure('owner@example.com', password);
  writeFileSync(
    join(directory, 'credentials.json'),
    JSON.stringify({
      name: 'Test owner',
      email: 'owner@example.com',
      emailVerified: true,
      accessToken: 'synthetic-test-token',
      scopes: ['chatgpt.tokens.use.direct'],
      expiresAt: Date.now() + 3600000,
    }),
    { mode: 0o600 },
  );
  const reservation = createServer();
  await new Promise<void>((done) => reservation.listen(0, '127.0.0.1', done));
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((done) => reservation.close(() => done()));
  const origin = `http://127.0.0.1:${port}`;
  let child: ChildProcess | undefined,
    output = '',
    cookie = '';
  async function start() {
    output = '';
    child = spawn(
      process.execPath,
      ['--import', resolve('tests/fixtures/build-provider.mjs'), 'scripts/start.mjs'],
      {
        env: {
          ...process.env,
          APP_DATA_DIR: directory,
          APP_ORIGIN: origin,
          HOST: '127.0.0.1',
          PORT: String(port),
          APP_DIAGNOSTICS: 'off',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    child.stdout!.on('data', (chunk) => (output += chunk));
    child.stderr!.on('data', (chunk) => (output += chunk));
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw Error(output);
      try {
        if ((await fetch(origin + '/login')).status === 200) return;
      } catch {}
      await new Promise((done) => setTimeout(done, 100));
    }
    throw Error('Test server did not start: ' + output);
  }
  async function stop() {
    if (child && child.exitCode === null) {
      const closed = once(child, 'exit');
      child.kill('SIGTERM');
      await closed;
    }
    child = undefined;
  }
  const request = (path: string, data?: object) =>
    fetch(origin + path, {
      redirect: 'manual',
      headers: { cookie, origin, 'content-type': 'application/json' },
      ...(data ? { method: 'POST', body: JSON.stringify(data) } : {}),
    });
  const spaceId = '00000000-0000-4000-8000-000000000001';
  try {
    await start();
    assert.equal((await request('/api/build-plans?spaceId=x&chatId=y')).status, 401);
    const signed = await fetch(origin + '/login', {
      method: 'POST',
      redirect: 'manual',
      headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: 'owner@example.com', password, remember: 'on' }),
    });
    cookie = signed.headers
      .getSetCookie()
      .find((value) => value.startsWith('little_spaces_session='))!
      .split(';')[0];
    await request('/');
    const { chat } = await (await request(`/api/spaces/${spaceId}/chats`, {})).json();
    const send = (extra: object = {}) =>
      request('/api/chat', {
        spaceId,
        chatId: chat.id,
        model: 'test-model',
        message: 'Make a notes app',
        ...extra,
      });
    const read = async () =>
      (await (await request(`/api/build-plans?spaceId=${spaceId}&chatId=${chat.id}`)).json()).plan;
    const proposal = await send({ mode: 'build' });
    assert.match(await proposal.text(), /event: done/);
    const first = await read();
    assert.equal(first.status, 'pending');
    assert.equal(first.features.length, 3);
    assert.equal(first.caveats.length, 2);
    assert.equal(
      (await (await request('/api/applets')).json()).applets.length,
      0,
      'client mode must not authorize publishing',
    );
    await (await send({ message: 'Add tags too' })).text();
    const revised = await read();
    assert.notEqual(revised.id, first.id);
    assert.equal((await send({ buildPlanId: first.id })).status, 409);
    await stop();
    await start();
    assert.equal((await read()).id, revised.id, 'plan survives restart');
    const other = (await (await request(`/api/spaces/${spaceId}/chats`, {})).json()).chat;
    assert.equal((await send({ chatId: other.id, buildPlanId: revised.id })).status, 409);
    const built = await send({ buildPlanId: revised.id });
    const stream = await built.text();
    assert.match(stream, /load_skill/);
    assert.match(stream, /publish_draft/);
    assert.match(stream, /event: done/);
    const conversation = await (
      await request(`/api/chat?spaceId=${spaceId}&chatId=${chat.id}`)
    ).json();
    assert.ok(
      conversation.messages.some(
        (message: { content: string }) =>
          message.content.includes('Features:') && message.content.includes('No external account'),
      ),
    );
    assert.doesNotMatch(stream, /event: error/);
    const completed = await read();
    assert.equal(completed.status, 'complete');
    assert.ok(completed.publishedId);
    assert.equal(completed.emoji, '🪴');
    const spaces = (await (await request('/api/spaces')).json()).spaces;
    assert.equal(
      spaces.find((space: { id: string }) => space.id === completed.publishedId).icon,
      completed.emoji,
    );
    assert.equal((await (await request('/api/applets')).json()).applets.length, 1);
    assert.equal(
      (await send({ buildPlanId: revised.id })).status,
      409,
      'approval cannot publish twice',
    );
    const updateChat = (
      await (await request(`/api/spaces/${completed.publishedId}/chats`, {})).json()
    ).chat;
    const updateInput = {
      spaceId: completed.publishedId,
      chatId: updateChat.id,
      model: 'test-model',
      message: 'Improve my notes app',
    };
    await (await request('/api/chat', updateInput)).text();
    const update = (
      await (
        await request(`/api/build-plans?spaceId=${completed.publishedId}&chatId=${updateChat.id}`)
      ).json()
    ).plan;
    assert.equal(update.appletId, completed.publishedId);
    assert.equal(update.version, 1);
    const updateStream = await (
      await request('/api/chat', { ...updateInput, buildPlanId: update.id })
    ).text();
    assert.match(updateStream, /event: done/);
    assert.doesNotMatch(updateStream, /event: error/);
    const apps = (await (await request('/api/applets')).json()).applets;
    assert.equal(apps.length, 1);
    assert.equal(apps[0].version, 2);
    const versionHistory = await (await request(`/api/applets/${completed.publishedId}`)).json();
    assert.match(versionHistory.versions[0].requestedChange, /Approved update/);
    assert.match(versionHistory.versions[0].requestedChange, /Organize notes with tags/);
    assert.equal(versionHistory.versions[0].changeSummary, 'Republished without code changes.');
    assert.equal(JSON.parse(versionHistory.versions[0].testReport)[0].passed, true);
    assert.equal(
      (
        await request(`/api/applets/${completed.publishedId}`, {
          action: 'restore',
          version: 1,
          expectedVersion: 1,
        })
      ).status,
      400,
    );
    const restored = await (
      await request(`/api/applets/${completed.publishedId}`, {
        action: 'restore',
        version: 1,
        expectedVersion: 2,
      })
    ).json();
    assert.equal(restored.applet.version, 3);
    const restoredHistory = await (await request(`/api/applets/${completed.publishedId}`)).json();
    assert.equal(restoredHistory.versions[0].restoredFrom, 1);
    assert.equal(restoredHistory.versions.length, 3);
    const page = await (await request(`/chat/${chat.id}`)).text();
    assert.ok(!page.includes('aria-label="Chat mode"'));
  } finally {
    await stop();
    owner.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
