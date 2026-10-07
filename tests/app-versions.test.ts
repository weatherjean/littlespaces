import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const directory = mkdtempSync(join(tmpdir(), 'little-versions-'));
process.env.APP_DATA_DIR = directory;
const storage = await import('../src/lib/server/storage');
const { appTools } = await import('../src/lib/server/app-tools');
after(() => rmSync(directory, { recursive: true, force: true }));
const content = {
  title: 'Journal',
  description: 'Entries',
  source: '<h1>Old</h1>',
  bundle: 'old',
  chatInstructions: 'Old guidance',
  testReport: JSON.stringify([{ name: 'List', passed: true }]),
};

test('publication history records requests, changes and tests; restoring keeps data and later code', async () => {
  const app = storage.saveApplet(content, undefined, undefined, undefined, {
    requestedChange: 'Create a journal.',
  });
  storage.putRecord(app.id, 'keep', { title: 'Saved after publication' });
  storage.saveApplet(
    { ...content, source: '<h1>New</h1>', bundle: 'new', chatInstructions: 'New guidance' },
    app.id,
    undefined,
    undefined,
    { requestedChange: 'Change the heading and guidance.' },
  );
  const history = storage.versions(app.id);
  assert.equal(history[0].requestedChange, 'Change the heading and guidance.');
  assert.match(history[0].changeSummary, /UI, chat guidance/);
  assert.equal(JSON.parse(history[0].testReport)[0].passed, true);
  const restored = storage.restoreApplet(app.id, 1, 2);
  assert.equal(restored.version, 3);
  assert.equal(storage.revision(app.id).source, content.source);
  assert.equal(storage.revision(app.id).chatInstructions, content.chatInstructions);
  assert.equal(storage.versions(app.id)[0].restoredFrom, 1);
  assert.equal(storage.revision(app.id, 2).bundle, 'new');
  assert.deepEqual(storage.records(app.id), [
    { key: 'keep', value: { title: 'Saved after publication' } },
  ]);
  assert.throws(() => storage.restoreApplet(app.id, 2, 2), /changed/);
  assert.throws(() => storage.restoreApplet(app.id, 100, 3), /not found/);
  assert.equal(storage.revision(app.id).version, 3);
});

test('restore tools are scoped to app chat and unavailable in scheduled and home turns', async () => {
  const app = storage.saveApplet(content);
  storage.saveApplet({ ...content, source: '<h1>New</h1>' }, app.id);
  const space = storage.appletSpaceId(app.id),
    chat = storage.createChat(space);
  const tools = await appTools(app.id, space, chat.id);
  const versions = (await tools.execute('list_app_versions', {})) as any;
  assert.equal(versions.currentVersion, 2);
  const read = (await tools.execute('read_app_version', { version: 1 })) as any;
  assert.equal(read.source, content.source);
  assert.equal(read.bundle, undefined);
  const result = (await tools.execute('restore_app_version', {
    version: 1,
    expectedVersion: 2,
  })) as any;
  assert.equal(result.applet.version, 3);
  const scheduled = await appTools(app.id, space, chat.id, 'scheduled');
  await assert.rejects(
    () => scheduled.execute('restore_app_version', { version: 1, expectedVersion: 3 }),
    /unavailable/,
  );
  const home = storage.launcherChat(),
    homeChat = storage.createChat(home.id);
  const homeTools = await appTools(undefined, home.id, homeChat.id);
  await assert.rejects(
    () => homeTools.execute('restore_app_version', { version: 1, expectedVersion: 3 }),
    /unavailable/,
  );
  await assert.rejects(() => tools.execute('read_app_version', { version: '1' }), /valid/);
});
