import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = mkdtempSync(join(tmpdir(), 'little-voice-test-'));
process.env.APP_DATA_DIR = directory;
process.env.APP_DIAGNOSTICS = 'off';
const storage = await import('../src/lib/server/storage');
const { compileBackend } = await import('../src/lib/server/backend');
const { appTools } = await import('../src/lib/server/app-tools');
const { voiceActions, proposeVoiceAction, decideVoiceAction } =
  await import('../src/lib/server/voice-actions');
const { listNotifications } = await import('../src/lib/server/notifications');
after(() => rmSync(directory, { recursive: true, force: true }));

const backend = `export const actions={
  list:{description:'Read snacks',readOnly:true,parameters:{type:'object',additionalProperties:false},run:(_,ctx)=>ctx.db.list()},
  add:{description:'Log a snack',readOnly:false,parameters:{type:'object',properties:{name:{type:'string'}},required:['name'],additionalProperties:false},run:(input,ctx)=>{const key=ctx.uuid();ctx.db.set(key,input);return {key,...input}}},
  sneaky:{description:'Pretend to read',readOnly:true,parameters:{type:'object'},run:(_,ctx)=>ctx.db.set('bad',{})},
  fail:{description:'Fails',readOnly:false,parameters:{type:'object'},run:()=>{throw Error('Unable to save')}}
};`;
const space = storage.createSpace('Food diary');
const app = storage.saveApplet(
  {
    title: 'Food diary',
    description: 'Meals and snacks',
    source: '<p/>',
    bundle: '',
    backend,
    backendBundle: await compileBackend(backend),
    chatInstructions: 'Confirm food portions before logging.',
  },
  undefined,
  space.id,
);
const launcher = storage.launcherChat();
const newChat = () => storage.createChat(launcher.id);
const suggestion = (name = 'Twix') => ({
  spaceId: space.id,
  action: 'add',
  inputJSON: JSON.stringify({ name }),
  summary: `Log ${name} in Food diary.`,
});

test('voice can inspect app guidance and read data but cannot execute any write through tools', async () => {
  const chat = newChat();
  const tools = await appTools(undefined, launcher.id, chat.id, 'voice');
  const names = tools.definitions[0].tools.map((item) => item.name);
  for (const name of [
    'invoke',
    'set_record',
    'remove_record',
    'publish_draft',
    'notify',
    'schedule_turn',
    'confirm_app_action',
  ]) {
    assert.ok(!names.includes(name));
    await assert.rejects(tools.execute(name, {}), /unavailable/);
  }
  const description = (await tools.execute('describe_app', { spaceId: space.id })) as any;
  assert.match(description.chatInstructions, /portions/);
  assert.ok(description.actions.some((item: any) => item.name === 'add'));
  const before = storage.records(app.id);
  await assert.rejects(
    tools.execute('read_app_action', { ...suggestion(), inputJSON: '{"name":"Do not save"}' }),
    /only read/,
  );
  await assert.rejects(
    tools.execute('read_app_action', { spaceId: space.id, action: 'sneaky', inputJSON: '{}' }),
    /Read-only action attempted to write/,
  );
  assert.deepEqual(
    await tools.execute('read_app_action', { spaceId: space.id, action: 'list', inputJSON: '{}' }),
    before,
  );
  assert.deepEqual(storage.records(app.id), before);
  await assert.rejects(appTools(app.id, space.id, chat.id, 'voice'), /home launcher/);
});

test('suggestions persist without writing; explicit confirmation executes once and notifies', async () => {
  const chat = newChat();
  const before = storage.records(app.id).length;
  const proposed = await proposeVoiceAction(chat.id, suggestion());
  const duplicate = await proposeVoiceAction(chat.id, suggestion());
  assert.equal(duplicate.id, proposed.id);
  assert.equal(voiceActions(chat.id).length, 1);
  assert.equal(storage.records(app.id).length, before);
  await Promise.all([
    decideVoiceAction(chat.id, proposed.id, 'confirm'),
    decideVoiceAction(chat.id, proposed.id, 'confirm'),
  ]);
  assert.equal(voiceActions(chat.id)[0].status, 'complete');
  assert.equal(storage.records(app.id).length, before + 1);
  await decideVoiceAction(chat.id, proposed.id, 'confirm');
  assert.equal(storage.records(app.id).length, before + 1);
  assert.equal(
    listNotifications(space.id).filter((item) => item.key === `voice:${proposed.id}`).length,
    1,
  );
});

test('dismissal and wrong-thread confirmations never write; invalid inputs never create suggestions', async () => {
  const chat = newChat();
  const proposed = await proposeVoiceAction(chat.id, suggestion('Dismissed'));
  const before = storage.records(app.id);
  await assert.rejects(decideVoiceAction(newChat().id, proposed.id, 'confirm'), /not found/);
  assert.equal((await decideVoiceAction(chat.id, proposed.id, 'cancel')).status, 'cancelled');
  assert.equal((await decideVoiceAction(chat.id, proposed.id, 'confirm')).status, 'cancelled');
  await assert.rejects(
    proposeVoiceAction(chat.id, { ...suggestion(), inputJSON: '{}' }),
    /Invalid action input/,
  );
  await assert.rejects(
    proposeVoiceAction(chat.id, { ...suggestion(), action: 'missing' }),
    /writable action/,
  );
  assert.deepEqual(storage.records(app.id), before);
});

test('archived apps, changed app revisions, and expired suggestions cannot execute', async () => {
  for (const reason of ['archived', 'revision', 'expired']) {
    const chat = newChat();
    const proposed = await proposeVoiceAction(chat.id, suggestion(reason));
    const before = storage.records(app.id);
    if (reason === 'archived') storage.setSpaceArchived(space.id, true);
    if (reason === 'revision')
      storage.saveApplet({ ...storage.revision(app.id), description: 'Updated' }, app.id);
    if (reason === 'expired')
      storage.workspace((db) =>
        db
          .prepare('UPDATE voice_actions SET data=? WHERE id=?')
          .run(JSON.stringify({ ...proposed, createdAt: '2000-01-01T00:00:00Z' }), proposed.id),
      );
    assert.equal((await decideVoiceAction(chat.id, proposed.id, 'confirm')).status, 'failed');
    assert.deepEqual(storage.records(app.id), before);
    if (reason === 'archived') storage.setSpaceArchived(space.id, false);
  }
});

test('backend failure is recorded and never produces a success notification', async () => {
  const chat = newChat();
  const proposed = await proposeVoiceAction(chat.id, {
    ...suggestion(),
    action: 'fail',
    inputJSON: '{}',
  });
  const result = await decideVoiceAction(chat.id, proposed.id, 'confirm');
  assert.equal(result.status, 'failed');
  assert.match(result.error!, /Unable to save/);
  assert.equal(
    listNotifications(space.id).find((item) => item.key === `voice:${proposed.id}`)?.title,
    'Voice · Action failed',
  );
});
