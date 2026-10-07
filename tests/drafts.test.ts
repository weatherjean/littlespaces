import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const directory = mkdtempSync(join(tmpdir(), 'little-drafts-'));
process.env.APP_DATA_DIR = directory;
const storage = await import('../src/lib/server/storage');
const { draftWorkspace } = await import('../src/lib/server/drafts');
after(() => rmSync(directory, { recursive: true, force: true }));
const backend = `export const actions={list:{description:'List',readOnly:true,parameters:{type:'object',properties:{},additionalProperties:false},run:(_,ctx)=>ctx.db.list()}};export const tests=[{name:'Empty list',run:async({call,assert})=>assert.deepEqual(await call('list',{}),[])}];`;
const content = {
  title: 'Journal',
  description: 'A journal',
  source: '<h1>Journal</h1>',
  backend,
  chatInstructions: 'Help add entries with chat.',
};
function setup() {
  const space = storage.createSpace('Draft test');
  const chat = storage.createChat(space.id);
  return { space, chat, tools: draftWorkspace(chat.id, space.id) };
}

test('drafts survive reopening, publish only tested revisions, and repeat publication is idempotent', async () => {
  const { space, chat, tools } = setup();
  await tools.execute('write_draft', { revision: 0, ...content });
  assert.equal(storage.spaceApplets(space.id).length, 0);
  const reopened = draftWorkspace(chat.id, space.id);
  assert.equal(((await reopened.execute('read_draft', {})) as any).source, content.source);
  await assert.rejects(() => reopened.execute('publish_draft', { revision: 1 }), /test_draft/);
  await reopened.execute('test_draft', { revision: 1 });
  const first = (await reopened.execute('publish_draft', { revision: 1 })) as any;
  const again = (await reopened.execute('publish_draft', { revision: 1 })) as any;
  assert.equal(first.applet.id, again.applet.id);
  assert.equal(again.alreadyPublished, true);
  assert.equal(storage.revision(first.applet.id).version, 1);
  storage.commitRecords(
    first.applet.id,
    [],
    [{ key: 'keep', value: { count: 7 } }],
    first.applet.version,
  );
  await reopened.execute('edit_draft', {
    revision: 1,
    field: 'source',
    search: 'Journal',
    replace: 'Updated',
  });
  await assert.rejects(() => reopened.execute('publish_draft', { revision: 2 }), /test_draft/);
  await assert.rejects(() => reopened.execute('test_draft', { revision: 1 }), /Draft changed/);
  await reopened.execute('test_draft', { revision: 2 });
  await reopened.execute('publish_draft', { revision: 2 });
  assert.equal(storage.revision(first.applet.id).version, 2);
  assert.deepEqual(storage.records(first.applet.id), [{ key: 'keep', value: { count: 7 } }]);
});

test('failing tests leave live code untouched and permit focused correction', async () => {
  const { tools, space } = setup();
  await tools.execute('write_draft', {
    revision: 0,
    ...content,
    backend: backend.replace("'list',{}),[]", "'list',{}),[1]"),
  });
  await assert.rejects(() => tools.execute('test_draft', { revision: 1 }), /Backend tests failed/);
  await assert.rejects(() => tools.execute('publish_draft', { revision: 1 }), /test_draft/);
  assert.equal(storage.spaceApplets(space.id).length, 0);
  await assert.rejects(
    () =>
      tools.execute('edit_draft', {
        revision: 1,
        field: 'source',
        search: 'missing',
        replace: 'x',
      }),
    /exactly once/,
  );
  await tools.execute('edit_draft', {
    revision: 1,
    field: 'backend',
    search: '[1]',
    replace: '[]',
  });
  await tools.execute('test_draft', { revision: 2 });
  await tools.execute('publish_draft', { revision: 2 });
  assert.equal(storage.spaceApplets(space.id).length, 1);
});

test('drafts cannot cross chats and stale builds cannot overwrite a newer live revision', async () => {
  const { tools, space, chat } = setup();
  await tools.execute('write_draft', { revision: 0, ...content });
  await tools.execute('test_draft', { revision: 1 });
  const { applet } = (await tools.execute('publish_draft', { revision: 1 })) as any;
  const other = storage.createSpace('Other');
  assert.throws(() => draftWorkspace(chat.id, other.id), /Chat/);
  const newChat = storage.createChat(space.id),
    fresh = draftWorkspace(newChat.id, space.id, applet.id);
  await fresh.execute('write_draft', { revision: 0, title: 'Updated' });
  await fresh.execute('test_draft', { revision: 1 });
  storage.saveApplet({ ...storage.revision(applet.id), title: 'A newer change' }, applet.id);
  await assert.rejects(() => fresh.execute('publish_draft', { revision: 1 }), /live app changed/);
  assert.equal(storage.revision(applet.id).title, 'A newer change');
});

test('the evaluated form bug blocks publication; corrected drafts report actual test coverage', async () => {
  const { tools, space } = setup();
  await tools.execute('write_draft', {
    revision: 0,
    ...content,
    source: '<input pattern="[0-9]+([.][0-9]{1,2})?" />',
  });
  await assert.rejects(() => tools.execute('test_draft', { revision: 1 }), /Svelte interpolation/);
  await assert.rejects(() => tools.execute('publish_draft', { revision: 1 }), /test_draft/);
  assert.equal(storage.spaceApplets(space.id).length, 0);
  await tools.execute('edit_draft', {
    revision: 1,
    field: 'source',
    search: 'pattern="[0-9]+([.][0-9]{1,2})?"',
    replace: 'pattern={"[0-9]+([.][0-9]{1,2})?"}',
  });
  const result = (await tools.execute('test_draft', { revision: 2 })) as any;
  assert.equal(result.tests.length, 1);
  assert.deepEqual(result.coverage, {
    uiCompiled: true,
    inputPatternsValidated: true,
    backendTestsRun: true,
    browserWorkflowsTested: false,
  });
  await tools.execute('publish_draft', { revision: 2 });
  assert.equal(storage.spaceApplets(space.id).length, 1);
});
