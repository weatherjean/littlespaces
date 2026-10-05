import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const directory = mkdtempSync(join(tmpdir(), 'little-inbox-'));
process.env.APP_DATA_DIR = directory;
const storage = await import('../src/lib/server/storage');
const { notify, listNotifications, markNotificationsRead, cancelNotification } =
  await import('../src/lib/server/notifications');
const { appTools } = await import('../src/lib/server/app-tools');
after(() => rmSync(directory, { recursive: true, force: true }));
const a = storage.createSpace('Plants'),
  b = storage.createSpace('Food');
test('scheduled notifications become visible when due and preserve read state on unchanged updates', () => {
  const past = {
    key: 'plant:fern',
    title: 'Check fern soil',
    body: 'Check before watering.',
    dueAt: '2026-01-01T00:00:00Z',
  };
  const created = notify(a.id, past);
  assert.equal(listNotifications().length, 1);
  assert.equal(created.href, `/spaces/${a.id}/applet`);
  markNotificationsRead(created.id);
  assert.equal(listNotifications()[0].read, true);
  assert.equal(notify(a.id, past).id, created.id);
  assert.equal(listNotifications()[0].read, true);
  const future = { ...past, dueAt: '2099-01-01T00:00:00Z' };
  notify(a.id, future);
  assert.equal(listNotifications().length, 0);
  assert.equal(listNotifications(a.id, true)[0].read, false);
  markNotificationsRead();
  assert.equal(listNotifications(a.id, true)[0].read, false);
  notify(a.id, { ...past, title: 'Fern needs a check' });
  assert.equal(listNotifications()[0].read, false);
});
test('notification keys and tools are scoped to each space', async () => {
  notify(b.id, {
    key: 'plant:fern',
    title: 'Food reminder',
    body: 'Your meal journal',
    dueAt: '2026-01-01T00:00:00Z',
  });
  const tools = await appTools(undefined, b.id);
  await tools.execute('cancel_notification', { key: 'plant:fern' });
  assert.equal(listNotifications(b.id, true).length, 0);
  assert.equal(listNotifications(a.id, true).length, 1);
  assert.throws(
    () => notify(a.id, { key: 'bad', title: 'Hello', body: 'World', dueAt: 'nonsense' }),
    /date/,
  );
  assert.throws(
    () => notify('../escape', { key: 'bad', title: 'Hello', body: 'World' }),
    /not found/,
  );
  cancelNotification(a.id, 'plant:fern');
  assert.equal(listNotifications().length, 0);
});
test('successful tool calls attach to replies while failed-turn calls survive separately and cannot cross chats', () => {
  const chat = storage.createChat(a.id),
    other = storage.createChat(b.id);
  const call = {
    id: 'tool-1',
    name: 'invoke',
    status: 'running' as const,
    input: { action: 'list' },
    startedAt: new Date().toISOString(),
  };
  storage.saveToolCall(chat.id, call);
  assert.equal(storage.pendingTools(chat.id).length, 1);
  const completed = { ...call, status: 'complete' as const, output: { rows: [] }, durationMs: 10 };
  storage.saveToolCall(chat.id, completed);
  storage.saveExchange(chat.id, 'Show plants', 'No plants yet', [], [completed]);
  assert.equal(storage.pendingTools(chat.id).length, 0);
  assert.deepEqual(storage.messages(chat.id)[1].toolCalls, [completed]);
  storage.saveToolCall(chat.id, {
    ...call,
    id: 'failed',
    status: 'error',
    output: { error: 'Bad input' },
  });
  assert.equal(storage.pendingTools(chat.id)[0].status, 'error');
  assert.deepEqual(storage.pendingTools(other.id), []);
  assert.deepEqual(storage.messages(other.id), []);
});
