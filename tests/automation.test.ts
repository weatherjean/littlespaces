import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDecipheriv } from 'node:crypto';
const directory = mkdtempSync(join(tmpdir(), 'little-automation-'));
process.env.APP_DATA_DIR = directory;
process.env.APP_DIAGNOSTICS = 'off';
const storage = await import('../src/lib/server/storage');
const secrets = await import('../src/lib/server/secrets');
const schedules = await import('../src/lib/server/schedules');
const { appTools } = await import('../src/lib/server/app-tools');
const { runSchedule } = await import('../src/lib/server/scheduler');
const { listNotifications } = await import('../src/lib/server/notifications');
const push = await import('../src/lib/server/push');
const webpush = (await import('web-push')).default;
after(() => rmSync(directory, { recursive: true, force: true }));
const space = storage.createSpace('Plants');
const app = storage.saveApplet(
  { title: 'Plants', description: 'Plants', source: '<p/>', bundle: 'test' },
  undefined,
  space.id,
);
storage.putRecord(app.id, 'monstera', { name: 'Monstera', wateredAt: '2026-01-01' });

test('secrets encrypt values, return only metadata, rotate and delete without exposing values', async () => {
  secrets.saveSecret({
    name: 'API_KEY',
    description: 'Weather credential',
    value: 'super-private-value',
  });
  const rows = secrets.listSecrets();
  assert.equal(rows[0].name, 'API_KEY');
  assert.ok(!JSON.stringify(rows).includes('super-private-value'));
  const row = storage.workspace((db) =>
    db.prepare('SELECT ciphertext FROM secrets WHERE name=?').get('API_KEY'),
  )!;
  assert.ok(!String(row.ciphertext).includes('super-private-value'));
  const encrypted = JSON.parse(String(row.ciphertext));
  const decipher = createDecipheriv(
    'aes-256-gcm',
    readFileSync(join(directory, 'secrets.key')),
    Buffer.from(encrypted.iv, 'base64'),
  );
  decipher.setAAD(Buffer.from('API_KEY'));
  decipher.setAuthTag(Buffer.from(encrypted.tag, 'base64'));
  assert.equal(
    Buffer.concat([
      decipher.update(Buffer.from(encrypted.data, 'base64')),
      decipher.final(),
    ]).toString(),
    'super-private-value',
  );
  assert.equal(statSync(join(directory, 'secrets.key')).mode & 0o777, 0o600);
  secrets.saveSecret({ name: 'API_KEY', description: 'Rotated', value: 'replacement' });
  assert.equal(secrets.listSecrets().length, 1);
  const tools = await appTools(undefined, storage.launcherChatId, undefined, 'knowledge');
  assert.ok(!JSON.stringify(await tools.execute('list_secrets', {})).includes('replacement'));
  await assert.rejects(tools.execute('read_secret', { name: 'API_KEY' }), /unavailable/);
  secrets.deleteSecret('API_KEY');
  assert.equal(secrets.listSecrets().length, 0);
});

test('knowledge tools read cross-app data, paginate, and cannot publish or mutate another app', async () => {
  const launcher = storage.launcherChat();
  const chat = storage.createChat(launcher.id);
  const tools = await appTools(undefined, launcher.id, chat.id, 'knowledge');
  const result = (await tools.execute('read_app', { spaceId: space.id, limit: 1 })) as {
    records: unknown[];
    total: number;
  };
  assert.equal(result.total, 1);
  assert.equal(result.records.length, 1);
  await assert.rejects(tools.execute('publish_draft', { revision: 0 }), /unavailable/);
  await assert.rejects(tools.execute('set_record', { key: 'x', valueJSON: '{}' }), /unavailable/);
  await assert.rejects(tools.execute('read_app', { spaceId: space.id, offset: -1 }), /bounds/);
  const build = await appTools(undefined, launcher.id, chat.id, 'build');
  assert.ok(build.definitions[0].tools.some((tool) => tool.name === 'write_draft'));
});

test('cron timezone calculation and one-time validation are persisted and scoped', () => {
  assert.equal(
    schedules.nextCron('0 9 * * *', 'Europe/Ljubljana', new Date('2026-01-01T00:00:00Z')),
    '2026-01-01T08:00:00.000Z',
  );
  assert.equal(
    schedules.nextCron('0 9 * * *', 'Europe/Ljubljana', new Date('2026-07-01T00:00:00Z')),
    '2026-07-01T07:00:00.000Z',
  );
  assert.throws(() => schedules.nextCron('* * * * * *', 'UTC'), /five-field/);
  assert.throws(() => schedules.nextCron('0 9 * * *', 'Imaginary/Zone'));
  const job = schedules.saveSchedule(space.id, {
    key: 'morning',
    title: 'Plant check',
    prompt: 'Check plants',
    model: 'test-model',
    timezone: 'Europe/Ljubljana',
    cron: '0 9 * * *',
  });
  assert.equal(schedules.listSchedules(space.id)[0].id, job.id);
  assert.equal(
    schedules.saveSchedule(space.id, {
      key: 'morning',
      title: 'Updated',
      prompt: 'Check soil',
      model: 'test-model',
      timezone: 'UTC',
      cron: '0 10 * * *',
    }).id,
    job.id,
  );
  assert.throws(
    () =>
      schedules.saveSchedule(space.id, {
        key: 'bad',
        title: 'Bad',
        prompt: 'Check',
        model: 'test',
        timezone: 'UTC',
        dueAt: '2000-01-01',
      }),
    /future/,
  );
  const other = storage.createSpace('Other');
  schedules.cancelSchedule(other.id, 'morning');
  assert.equal(schedules.listSchedules(space.id).length, 1);
  schedules.cancelSchedule(space.id, 'morning');
});

test('scheduled LLM runs are claimed once, notify on success and failure, and expose no write tools', async () => {
  const tools = await appTools(app.id, space.id, undefined, 'scheduled');
  await assert.rejects(tools.execute('set_record', { key: 'x', valueJSON: '{}' }), /unavailable/);
  await assert.rejects(tools.execute('notify', { key: 'x', title: 'x', body: 'x' }), /unavailable/);
  const job = schedules.saveSchedule(space.id, {
    key: 'once',
    title: 'Water check',
    prompt: 'Check the monstera',
    model: 'test-model',
    timezone: 'UTC',
    dueAt: '2099-01-01T00:00:00Z',
  });
  let calls = 0;
  await runSchedule(
    job,
    new Date('2099-01-01T00:00:01Z'),
    async (_model, history, _source, _delta, _signal, options) => {
      calls++;
      assert.equal(options?.mode, 'scheduled');
      assert.equal(options?.appletId, app.id);
      assert.match(history[0].content, /monstera/);
      return { message: 'Time to check your monstera’s soil.', published: undefined };
    },
  );
  await runSchedule(job, new Date('2099-01-01T00:00:01Z'), async () => {
    calls++;
    throw Error('Must not replay');
  });
  assert.equal(calls, 1);
  assert.equal(schedules.listSchedules(space.id).find((j) => j.id === job.id)?.enabled, 0);
  assert.match(
    listNotifications(space.id).find((n) => n.key === `schedule:${job.id}`)!.body,
    /monstera/,
  );
  const failed = schedules.saveSchedule(space.id, {
    key: 'fail',
    title: 'Failed check',
    prompt: 'Check',
    model: 'test-model',
    timezone: 'UTC',
    dueAt: '2099-01-01T00:00:00Z',
  });
  await runSchedule(failed, new Date('2099-01-01T00:00:01Z'), async () => {
    throw Error('sensitive provider error');
  });
  assert.match(
    listNotifications(space.id).find((n) => n.key === `schedule:${failed.id}`)!.body,
    /failed/,
  );
  assert.ok(!JSON.stringify(schedules.listSchedules()).includes('sensitive provider error'));
});

test('push persists stable VAPID keys, rejects arbitrary endpoints, deduplicates delivery and removes expired devices', async () => {
  const publicKey = push.pushPublicKey();
  assert.equal(push.pushPublicKey(), publicKey);
  const subscription = {
    endpoint: 'https://fcm.googleapis.com/fcm/send/test-device',
    keys: { p256dh: 'A'.repeat(87), auth: 'A'.repeat(22) },
  };
  assert.throws(
    () => push.subscribePush({ ...subscription, endpoint: 'https://127.0.0.1/private' }),
    /provider/,
  );
  assert.throws(
    () =>
      push.subscribePush({ ...subscription, endpoint: 'https://fcm.googleapis.com.evil.example/' }),
    /provider/,
  );
  push.subscribePush(subscription);
  assert.equal(push.hasPush(subscription.endpoint), true);
  const { notify } = await import('../src/lib/server/notifications');
  notify(space.id, { key: 'push-test', title: 'Water Monstera', body: 'Check the soil.' });
  const original = webpush.sendNotification;
  let sends = 0;
  webpush.sendNotification = async () => {
    sends++;
    return { statusCode: 201, body: '', headers: {} };
  };
  try {
    await push.deliverPush();
    const first = sends;
    assert.ok(first > 0);
    await push.deliverPush();
    assert.equal(sends, first);
    notify(space.id, { key: 'push-test', title: 'Water Monstera', body: 'Updated reminder.' });
    webpush.sendNotification = async () => {
      throw Object.assign(Error('Gone'), { statusCode: 410 });
    };
    await push.deliverPush();
    assert.equal(push.hasPush(subscription.endpoint), false);
  } finally {
    webpush.sendNotification = original;
  }
});

test('push drains backlogs beyond a single batch without resending delivered items', async () => {
  const subscription = {
    endpoint: 'https://fcm.googleapis.com/fcm/send/backlog-device',
    keys: { p256dh: 'A'.repeat(87), auth: 'A'.repeat(22) },
  };
  push.subscribePush(subscription);
  const { notify } = await import('../src/lib/server/notifications');
  for (let i = 0; i < 51; i++)
    notify(space.id, { key: `backlog-${i}`, title: 'Reminder', body: 'Check this item.' });
  const original = webpush.sendNotification;
  const ids = new Set<string>();
  let attempts = 0;
  webpush.sendNotification = async (_subscription, payload) => {
    attempts++;
    const id = JSON.parse(String(payload)).id;
    assert.ok(!ids.has(id));
    ids.add(id);
    return { statusCode: 201, body: '', headers: {} };
  };
  try {
    await push.deliverPush();
    assert.equal(attempts, 50);
    await push.deliverPush();
    assert.ok(attempts >= 51);
    const drained = attempts;
    await push.deliverPush();
    assert.equal(attempts, drained);
  } finally {
    webpush.sendNotification = original;
    push.unsubscribePush(subscription.endpoint);
  }
});

test('archiving hides an app, preserves data and conversations, and pauses reminders and scheduled turns until restored', async () => {
  const archivedSpace = storage.createSpace('Archive me');
  const archivedApp = storage.saveApplet(
    { title: 'Archive me', description: 'Keep data', source: '<p/>', bundle: 'test' },
    undefined,
    archivedSpace.id,
  );
  storage.putRecord(archivedApp.id, 'important', { value: 'keep me' });
  const chat = storage.createChat(archivedSpace.id);
  storage.saveExchange(chat.id, 'Remember this', 'Saved conversation');
  const job = schedules.saveSchedule(archivedSpace.id, {
    key: 'check',
    title: 'Check',
    prompt: 'Check records',
    model: 'test-model',
    timezone: 'UTC',
    dueAt: '2099-01-01T00:00:00Z',
  });
  const { notify } = await import('../src/lib/server/notifications');
  notify(archivedSpace.id, { key: 'reminder', title: 'Saved reminder', body: 'Do not delete' });
  storage.setSpaceArchived(archivedSpace.id, true);
  assert.equal(
    storage.listSpaces().some((s) => s.id === archivedSpace.id),
    false,
  );
  assert.equal(storage.listSpaces(true).find((s) => s.id === archivedSpace.id)?.archived, true);
  assert.deepEqual(storage.records(archivedApp.id), [
    { key: 'important', value: { value: 'keep me' } },
  ]);
  assert.equal(storage.messages(chat.id)[1].content, 'Saved conversation');
  assert.equal(listNotifications(archivedSpace.id).length, 0);
  const tools = await appTools(undefined, storage.launcherChatId, undefined, 'knowledge');
  await assert.rejects(tools.execute('read_app', { spaceId: archivedSpace.id }), /archived/);
  let calls = 0;
  const turn = async () => {
    calls++;
    return { message: 'Checked preserved data', published: undefined };
  };
  await runSchedule(job, new Date('2099-01-01T00:00:01Z'), turn);
  assert.equal(calls, 0);
  assert.equal(schedules.listSchedules(archivedSpace.id)[0].enabled, 1);
  storage.setSpaceArchived(archivedSpace.id, false);
  assert.equal(
    storage.listSpaces().some((s) => s.id === archivedSpace.id),
    true,
  );
  assert.equal(listNotifications(archivedSpace.id)[0].body, 'Do not delete');
  await runSchedule(job, new Date('2099-01-01T00:00:01Z'), turn);
  assert.equal(calls, 1);
  assert.throws(() => storage.setSpaceArchived(storage.launcherChatId, true), /cannot be archived/);
  assert.throws(() => storage.setSpaceArchived('not-an-app', true), /not found/);
});
