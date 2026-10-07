import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const directory = mkdtempSync(join(tmpdir(), 'little-plans-'));
process.env.APP_DATA_DIR = directory;
const storage = await import('../src/lib/server/storage');
const plans = await import('../src/lib/server/build-plans');
const { appTools } = await import('../src/lib/server/app-tools');
after(() => rmSync(directory, { recursive: true, force: true }));
const content = { title: 'Journal', description: '', source: '<p/>', bundle: '' };
function setup() {
  const space = storage.createSpace('Plan test');
  const chat = storage.createChat(space.id);
  return { space, chat };
}

test('plans are persistent, scoped, replaceable, dismissible and single-use', () => {
  const { space, chat } = setup();
  const first = plans.proposeBuild(space.id, chat.id, {
    title: 'Journal',
    summary: 'Track notes.',
    emoji: '🪴',
    features: ['List saved items'],
    caveats: ['No external integrations'],
  });
  assert.equal(plans.readBuildPlan(space.id, chat.id)?.id, first.id);
  assert.equal(storage.deleteEmptyChats(chat.id), 0);
  const other = setup();
  assert.throws(() => plans.claimBuildPlan(other.space.id, other.chat.id, first.id), /no longer/);
  const second = plans.proposeBuild(space.id, chat.id, {
    title: 'Journal',
    summary: 'Track notes and tags.',
    emoji: '🪴',
    features: ['List saved items'],
    caveats: ['No external integrations'],
  });
  assert.throws(() => plans.claimBuildPlan(space.id, chat.id, first.id), /no longer/);
  plans.cancelBuildPlan(space.id, chat.id, second.id);
  assert.throws(() => plans.claimBuildPlan(space.id, chat.id, second.id), /no longer/);
  const third = plans.proposeBuild(space.id, chat.id, {
    title: 'Journal',
    summary: 'Track notes and tags.',
    emoji: '🪴',
    features: ['List saved items'],
    caveats: ['No external integrations'],
  });
  plans.claimBuildPlan(space.id, chat.id, third.id);
  assert.throws(() => plans.claimBuildPlan(space.id, chat.id, third.id), /no longer/);
  assert.throws(
    () => plans.proposeBuild(space.id, chat.id, { title: 'Different', summary: 'Different' }),
    /running/,
  );
  plans.finishBuild(space.id, chat.id, third.id);
  assert.equal(plans.readBuildPlan(space.id, chat.id)?.status, 'failed');
  plans.claimBuildPlan(space.id, chat.id, third.id);
  plans.finishBuild(space.id, chat.id, third.id, 'published-test');
  assert.equal(plans.readBuildPlan(space.id, chat.id)?.publishedId, 'published-test');
  assert.throws(() => plans.claimBuildPlan(space.id, chat.id, third.id), /no longer/);
});

test('an updated app requires a fresh plan, including changes made after approval', () => {
  const app = storage.saveApplet(content);
  const spaceId = storage.appletSpaceId(app.id),
    chat = storage.createChat(spaceId);
  const first = plans.proposeBuild(spaceId, chat.id, {
    title: 'Update journal',
    summary: 'Add tags.',
    emoji: '🪴',
    features: ['List saved items'],
    caveats: ['No external integrations'],
  });
  storage.saveApplet({ ...content, title: 'Changed' }, app.id);
  assert.throws(() => plans.claimBuildPlan(spaceId, chat.id, first.id), /changed/);
  const next = plans.proposeBuild(spaceId, chat.id, {
    title: 'Update journal',
    summary: 'Add tags.',
    emoji: '🪴',
    features: ['List saved items'],
    caveats: ['No external integrations'],
  });
  plans.claimBuildPlan(spaceId, chat.id, next.id);
  storage.saveApplet({ ...content, title: 'Changed again' }, app.id);
  assert.throws(() => plans.requireBuildApproval(spaceId, chat.id, next.id), /changed/);
  plans.finishBuild(spaceId, chat.id, next.id);
});

test('same agent can fetch the skill, but code tools require approval and loading the skill', async () => {
  const { space, chat } = setup();
  const normal = await appTools(undefined, space.id, chat.id, 'knowledge');
  const skill = (await normal.execute('load_skill', { name: 'build' })) as any;
  assert.match(skill.instructions, /single primary conversation entry/);
  assert.match(skill.instructions, /chat.setContext/);
  assert.match(skill.instructions, /ctx.http.request/);
  assert.match(skill.instructions, /Settings → Secrets/);
  assert.match(skill.instructions, /minimum scopes/);
  assert.match(skill.instructions, /Test connection/);
  assert.match(skill.instructions, /mockHttp/);
  assert.match(skill.instructions, /Do not claim it is connected until a real request succeeds/);
  await assert.rejects(() => normal.execute('write_draft', { revision: 0 }), /unavailable/);
  const proposal = (await normal.execute('propose_build', {
    title: 'Journal',
    summary: 'Track notes.',
    emoji: '🪴',
    features: ['List saved items'],
    caveats: ['No external integrations'],
  })) as any;
  await assert.rejects(
    () => appTools(undefined, space.id, chat.id, 'knowledge', '', proposal.id),
    /Approve/,
  );
  plans.claimBuildPlan(space.id, chat.id, proposal.id);
  const approved = await appTools(undefined, space.id, chat.id, 'knowledge', '', proposal.id);
  await assert.rejects(
    () => approved.execute('write_draft', { revision: 0 }),
    /Load the build skill/,
  );
  await approved.execute('load_skill', { name: 'build' });
  await approved.execute('write_draft', { revision: 0, ...content });
  plans.finishBuild(space.id, chat.id, proposal.id);
  await assert.rejects(
    () => approved.execute('write_draft', { revision: 1, title: 'Unapproved' }),
    /Approve/,
  );
  for (const mode of ['scheduled', 'voice'] as const) {
    const home = storage.launcherChat();
    const homeChat = storage.createChat(home.id);
    const restricted = await appTools(undefined, home.id, homeChat.id, mode);
    await assert.rejects(
      () => restricted.execute('propose_build', { title: 'No', summary: 'No' }),
      /unavailable/,
    );
    await assert.rejects(() => restricted.execute('load_skill', { name: 'build' }), /unavailable/);
  }
});

test('interrupted builds recover status without repeating an already published draft', () => {
  for (const published of [undefined, { id: 'finished-app' }]) {
    const { space, chat } = setup();
    const plan = plans.proposeBuild(space.id, chat.id, {
      title: 'Journal',
      summary: 'Track notes.',
      emoji: '🪴',
      features: ['List saved items'],
      caveats: ['No external integrations'],
    });
    storage.workspace((db) => {
      db.prepare('UPDATE build_plans SET data=? WHERE chat_id=?').run(
        JSON.stringify({ ...plan, status: 'running' }),
        chat.id,
      );
      if (published)
        db.prepare('INSERT INTO build_drafts VALUES(?,?)').run(
          chat.id,
          JSON.stringify({ published }),
        );
    });
    assert.equal(plans.readBuildPlan(space.id, chat.id)?.status, published ? 'complete' : 'failed');
  }
});

test('plans require reviewable features and bound caveats before replacing an existing proposal', () => {
  const { space, chat } = setup();
  const input = {
    title: 'Plants',
    summary: 'A houseplant journal.',
    emoji: '🪴',
    features: ['Identify photos with confirmation', 'Record moves and watering'],
    caveats: ['Identification can be uncertain.'],
  };
  const plan = plans.proposeBuild(space.id, chat.id, input);
  assert.deepEqual(plans.readBuildPlan(space.id, chat.id)?.features, input.features);
  for (const patch of [
    { features: [] },
    { features: [''] },
    { emoji: '🪴📓' },
    { emoji: 'plant' },
    { caveats: Array(6).fill('Too many') },
    { summary: 'x'.repeat(601) },
  ]) {
    assert.throws(() => plans.proposeBuild(space.id, chat.id, { ...input, ...patch }));
    assert.equal(plans.readBuildPlan(space.id, chat.id)?.id, plan.id);
  }
});
