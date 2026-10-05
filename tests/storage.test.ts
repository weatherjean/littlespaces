import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const directory = mkdtempSync(join(tmpdir(), 'little-spaces-storage-'));
process.env.APP_DATA_DIR = directory;
const storage = await import('../src/lib/server/storage');
after(() => rmSync(directory, { recursive: true, force: true }));
const content = {
  title: 'Test',
  description: 'A test applet',
  source: '<p>test</p>',
  bundle: 'test',
};

test('scoped reads and writes do not open unrelated app databases', () => {
  const app = storage.saveApplet(content);
  const unrelated = join(directory, 'applets', '10000000-0000-4000-8000-000000000000.sqlite');
  writeFileSync(unrelated, 'Not a SQLite database');
  try {
    assert.equal(storage.getSpace(app.id).appletCount, 1);
    assert.equal(storage.spaceApplets(app.id)[0].id, app.id);
    assert.equal(storage.listChats(app.id)[0].id, app.id);
    storage.saveApplet({ ...content, title: 'Updated' }, app.id, app.id);
    assert.equal(storage.revision(app.id).title, 'Updated');
  } finally {
    rmSync(unrelated);
  }
});

test('creating a chat preserves an unmigrated legacy conversation', () => {
  const space = storage.createSpace('Legacy conversation');
  storage.saveExchange(space.id, 'Keep this question', 'Keep this answer');
  storage.workspace((db) => db.prepare('DELETE FROM chats WHERE space_id=?').run(space.id));
  const added = storage.createChat(space.id);
  assert.notEqual(added.id, space.id);
  assert.equal(storage.listChats(space.id).length, 2);
  assert.equal(storage.getChat(space.id, space.id).id, space.id);
  assert.equal(storage.messages(space.id)[0].content, 'Keep this question');
});

test('each applet uses a real, separate SQLite file and the same record key stays isolated', () => {
  const a = storage.saveApplet(content);
  const b = storage.saveApplet(content);
  storage.putRecord(a.id, 'plant', { name: 'Monstera' });
  storage.putRecord(b.id, 'plant', { name: 'Fern' });
  assert.deepEqual(storage.records(a.id), [{ key: 'plant', value: { name: 'Monstera' } }]);
  assert.deepEqual(storage.records(b.id), [{ key: 'plant', value: { name: 'Fern' } }]);
  const path = join(directory, 'applets', `${a.id}.sqlite`);
  assert.equal(readFileSync(path).subarray(0, 16).toString(), 'SQLite format 3\0');
  const reopened = new DatabaseSync(path);
  assert.equal(
    JSON.parse(
      String(reopened.prepare('SELECT value FROM records WHERE key=?').get('plant')!.value),
    ).name,
    'Monstera',
  );
  reopened.close();
});

test('editing and restoring code preserve records and retain revision history', () => {
  const a = storage.saveApplet(content);
  storage.putRecord(a.id, 'saved', { wateredAt: '2026-10-04' });
  storage.saveApplet({ ...content, source: '<p>new UI</p>' }, a.id);
  storage.saveApplet(storage.revision(a.id, 1), a.id);
  assert.equal(storage.revision(a.id).version, 3);
  assert.equal(storage.revision(a.id).source, content.source);
  assert.equal(storage.versions(a.id).length, 3);
  assert.deepEqual(storage.records(a.id), [{ key: 'saved', value: { wateredAt: '2026-10-04' } }]);
});

test('path traversal and missing IDs cannot create or read databases', () => {
  const before = readdirSync(join(directory, 'applets'));
  assert.throws(() => storage.records('../../credentials'), /Invalid applet ID/);
  assert.throws(() => storage.records('00000000-0000-0000-0000-000000000000'), /not found/);
  assert.deepEqual(readdirSync(join(directory, 'applets')), before);
});

test('SQL-looking record keys are data; deletes stay in their applet', () => {
  const a = storage.saveApplet(content);
  const b = storage.saveApplet(content);
  const key = "'); DROP TABLE records; --";
  storage.putRecord(a.id, key, { safe: true });
  storage.putRecord(b.id, key, { safe: true });
  storage.removeRecord(a.id, key);
  assert.equal(storage.records(a.id).length, 0);
  assert.equal(storage.records(b.id).length, 1);
});

test('host ID and thread history persist across database reopens', () => {
  assert.equal(storage.hostId(), storage.hostId());
  storage.saveExchange('one', 'hello', 'hi');
  assert.deepEqual(storage.messages('one'), [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi' },
  ]);
  assert.deepEqual(storage.messages('two'), []);
});

test('a named space has separate conversations and one shared applet', () => {
  const space = storage.createSpace('My garden', 'leaf');
  const first = storage.listChats(space.id)[0];
  const second = storage.createChat(space.id);
  storage.saveExchange(first.id, 'Build a watering tracker', 'Built it');
  storage.saveExchange(second.id, 'Make the buttons bigger', 'Updated it');
  assert.equal(storage.messages(first.id)[0].content, 'Build a watering tracker');
  assert.equal(storage.messages(second.id)[0].content, 'Make the buttons bigger');
  assert.equal(storage.getChat(space.id, second.id).title, 'Make the buttons bigger');
  const applet = storage.saveApplet(content, undefined, space.id);
  storage.putRecord(applet.id, 'plant', { name: 'Fern' });
  storage.saveApplet({ ...content, title: 'Changed applet title' }, applet.id, space.id);
  assert.equal(storage.getSpace(space.id).name, 'My garden');
  assert.equal(storage.getSpace(space.id).appletCount, 1);
  assert.equal(storage.spaceApplets(space.id)[0].id, applet.id);
  assert.deepEqual(storage.records(applet.id), [{ key: 'plant', value: { name: 'Fern' } }]);
  assert.throws(() => storage.saveApplet(content, undefined, space.id), /one applet/);
  const other = storage.createSpace('Other');
  assert.throws(() => storage.getChat(other.id, first.id), /not found/);
  assert.throws(() => storage.saveApplet(content, applet.id, other.id), /another space/);
});

test('legacy applets migrate without losing records or conversation history', () => {
  const applet = storage.saveApplet(content);
  storage.putRecord(applet.id, 'keep', 42);
  storage.saveExchange(applet.id, 'Original conversation', 'Original reply');
  const db = new DatabaseSync(join(directory, 'workspace.sqlite'));
  db.prepare('DELETE FROM chats WHERE space_id = ?').run(applet.id);
  db.prepare('DELETE FROM space_applets WHERE applet_id = ?').run(applet.id);
  db.prepare('DELETE FROM spaces WHERE id = ?').run(applet.id);
  db.close();
  assert.equal(storage.getSpace(applet.id).name, content.title);
  assert.equal(storage.listChats(applet.id)[0].id, applet.id);
  assert.equal(storage.messages(applet.id)[0].content, 'Original conversation');
  assert.deepEqual(storage.records(applet.id), [{ key: 'keep', value: 42 }]);
  assert.equal(storage.listChats(applet.id).length, 1);
});

test('app chat guidance is versioned and survives omitted-field edits and restores', async () => {
  const { prepareApp } = await import('../src/lib/server/publish');
  const a = storage.saveApplet({ ...content, chatInstructions: 'Ask before saving.' });
  const first = storage.revision(a.id);
  const next = await prepareApp(
    { title: 'Updated', description: '', source: '<p>New view</p>' },
    a.id,
  );
  assert.equal(next.chatInstructions, 'Ask before saving.');
  storage.saveApplet({ ...next, chatInstructions: 'Ask one question at a time.' }, a.id);
  storage.saveApplet(first, a.id);
  assert.equal(storage.revision(a.id).chatInstructions, 'Ask before saving.');
  await assert.rejects(
    () => prepareApp({ ...content, chatInstructions: 'x'.repeat(12001) }),
    /12,000/,
  );
});

test('task chats persist scoped references, refresh records, and handle deleted selections', async () => {
  const { validateChatLaunch, liveChatContext } = await import('../src/lib/server/chat-context');
  const a = storage.saveApplet(content),
    b = storage.saveApplet(content);
  storage.putRecord(a.id, 'fern', { name: 'Fern', interval: 7 });
  storage.putRecord(b.id, 'other', { name: 'Private' });
  const launch = validateChatLaunch(a.id, {
    task: 'Help this plant',
    title: 'Fern help',
    welcome: 'Tell me what you have noticed.',
    recordKeys: ['fern'],
    context: { screen: 'journal' },
  });
  const chat = storage.createChat(a.id, launch);
  assert.deepEqual(storage.getChat(a.id, chat.id).launch, launch);
  assert.deepEqual(storage.messages(chat.id), []);
  assert.throws(
    () => validateChatLaunch(a.id, { task: 'Help', welcome: 'x'.repeat(2001) }),
    /welcome/,
  );
  storage.putRecord(a.id, 'fern', { name: 'Fern', interval: 12 });
  assert.deepEqual(liveChatContext(a.id, launch)?.selectedRecords, [
    { key: 'fern', value: { name: 'Fern', interval: 12 } },
  ]);
  storage.removeRecord(a.id, 'fern');
  assert.deepEqual(liveChatContext(a.id, launch)?.selectedRecords, [
    { key: 'fern', missing: true },
  ]);
  assert.throws(
    () => validateChatLaunch(a.id, { task: 'Help', recordKeys: ['other'] }),
    /not available/,
  );
  assert.throws(() => validateChatLaunch(a.id, { task: 'Help', photoIds: ['invalid'] }));
  assert.throws(
    () => validateChatLaunch(a.id, { task: 'Help', context: 'x'.repeat(8001) }),
    /too large/,
  );
  assert.throws(() => storage.getChat(b.id, chat.id), /not found/);
});
