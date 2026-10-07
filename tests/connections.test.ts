import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, unlinkSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { credentialWarnings } from '../src/lib/secret-validation';
const directory = mkdtempSync(join(tmpdir(), 'little-connections-'));
process.env.APP_DATA_DIR = directory;
const { saveSecret, listSecrets } = await import('../src/lib/server/secrets');
const { compileBackend, probeBackendConnection } = await import('../src/lib/server/backend');
const { appTools } = await import('../src/lib/server/app-tools');
const storage = await import('../src/lib/server/storage');
const { draftWorkspace } = await import('../src/lib/server/drafts');
after(() => rmSync(directory, { recursive: true, force: true }));
const token = 'synthetic-credential-never-send-to-a-model';
const source = `export const actions={searchBooks:{description:'Read books',readOnly:true,parameters:{type:'object',properties:{},additionalProperties:false},run:async(_,ctx)=>{const r=await ctx.http.request({url:'https://www.googleapis.com/books/v1/volumes',query:{q:'Pride and Prejudice',key:{secret:'GOOGLE_BOOKS_API_KEY'}}});if(!r.ok)throw Error('Google Books request failed. Try again.');return r.data;}}};`;
function credential() {
  saveSecret({
    name: 'GOOGLE_BOOKS_API_KEY',
    value: token,
    description: 'Books',
    origins: ['https://www.googleapis.com'],
  });
}
const provider = {
  resolve: async () => ['142.250.185.74'],
  send: async () => ({
    status: 400,
    text: JSON.stringify({
      error: {
        code: 400,
        status: 'INVALID_ARGUMENT',
        message: 'API key not valid. Please pass a valid API key.',
        details: [{ reason: 'API_KEY_INVALID', domain: 'googleapis.com' }],
      },
    }),
  }),
};

test('format warnings are advisory and never expose entered or stored credentials', () => {
  credential();
  const metadata = listSecrets().find((secret) => secret.name === 'GOOGLE_BOOKS_API_KEY')!;
  assert.match(metadata.warnings[0], /complete API key/);
  assert.equal(metadata.verification, 'not_verified');
  assert.ok(!JSON.stringify(metadata).includes(token));
  assert.deepEqual(credentialWarnings('GOOGLE_BOOKS_API_KEY', 'AIza' + 'a'.repeat(35)), []);
  assert.match(credentialWarnings('OTHER_TOKEN', ' padded ')[0], /whitespace/);
  assert.deepEqual(credentialWarnings('OTHER_TOKEN', 'unusual-valid-provider-format'), []);
});

test('real broker diagnostics expose Google API_KEY_INVALID even when generated code hides it', async () => {
  credential();
  const result = await probeBackendConnection(
    await compileBackend(source),
    'searchBooks',
    {},
    [{ key: 'keep', value: { count: 3 } }],
    provider,
  );
  assert.equal(result.ok, false);
  assert.equal(result.verified, false);
  assert.match(result.error!, /Try again/);
  assert.equal(result.requests[0].status, 400);
  assert.equal(result.requests[0].providerReason, 'API_KEY_INVALID');
  assert.match(result.requests[0].message!, /not valid/);
  assert.equal(result.requests[0].origin, 'https://www.googleapis.com');
  assert.equal(result.requests[0].path, '/books/v1/volumes');
  assert.equal(result.requests[0].secrets[0].name, 'GOOGLE_BOOKS_API_KEY');
  assert.ok(!JSON.stringify(result).includes(token));
  assert.ok(!JSON.stringify(result.requests).includes('Pride and Prejudice'));
});

test('a swallowed HTTP failure or local-only action cannot verify a connection', async () => {
  credential();
  const swallowing = source.replace(
    "throw Error('Google Books request failed. Try again.')",
    'return {connected:true}',
  );
  const result = await probeBackendConnection(
    await compileBackend(swallowing),
    'searchBooks',
    {},
    [],
    provider,
  );
  assert.equal(result.ok, true);
  assert.equal(result.verified, false);
  const local = await compileBackend(
    "export const actions={list:{description:'Read records',readOnly:true,parameters:{type:'object'},run:(_,ctx)=>ctx.db.list()}};",
  );
  const noRequest = await probeBackendConnection(local, 'list', {}, []);
  assert.equal(noRequest.verified, false);
  assert.match(noRequest.note!, /no external requests/);
  const success = await probeBackendConnection(
    await compileBackend(source),
    'searchBooks',
    {},
    [],
    { ...provider, send: async () => ({ status: 200, text: '{"items":[]}' }) },
  );
  assert.equal(success.verified, true);
});

test('connection checks reject writes before networking and detect attempts to change records', async () => {
  let sent = false;
  const writes = await compileBackend(source.replace('readOnly:true', 'readOnly:false'));
  await assert.rejects(
    () =>
      probeBackendConnection(writes, 'searchBooks', {}, [], {
        ...provider,
        send: async () => {
          sent = true;
          return { status: 200, text: '{}' };
        },
      }),
    /read-only/,
  );
  assert.equal(sent, false);
  const mutating = await compileBackend(
    "export const actions={check:{description:'Check',readOnly:true,parameters:{type:'object'},run:(_,ctx)=>{actions.check.readOnly=false;ctx.db.set('x',1);return true;}}};",
  );
  const result = await probeBackendConnection(mutating, 'check', {}, []);
  assert.equal(result.ok, false);
  assert.match(result.error!, /No changes were saved/);
});

test('draft connection tests require the tested revision, retain missing-secret evidence and reset on edits', async () => {
  const space = storage.createSpace('Draft integration'),
    chat = storage.createChat(space.id),
    draft = draftWorkspace(chat.id, space.id);
  const backend =
    source.replace('GOOGLE_BOOKS_API_KEY', 'MISSING_TEST_KEY') +
    `export const tests=[{name:'Mock only',run:async({call,mockHttp,assert})=>{mockHttp(()=>({ok:true,status:200,data:{items:[]}}));assert.deepEqual(await call('searchBooks',{}),{items:[]});}}];`;
  await draft.execute('write_draft', {
    revision: 0,
    title: 'Books',
    source: '<p>Books</p>',
    backend,
  });
  await assert.rejects(
    () =>
      draft.execute('test_draft_connection', {
        revision: 1,
        action: 'searchBooks',
        inputJSON: '{}',
      }),
    /test_draft/,
  );
  await draft.execute('test_draft', { revision: 1 });
  const result = (await draft.execute('test_draft_connection', {
    revision: 1,
    action: 'searchBooks',
    inputJSON: '{}',
  })) as any;
  assert.equal(result.verified, false);
  assert.equal(result.requests[0].code, 'secret_unavailable');
  assert.match(result.requests[0].message, /MISSING_TEST_KEY is missing/);
  assert.equal(((await draft.execute('read_draft', {})) as any).connections.length, 1);
  assert.equal(storage.spaceApplets(space.id).length, 0);
  await draft.execute('write_draft', { revision: 1, title: 'Updated' });
  assert.deepEqual(((await draft.execute('read_draft', {})) as any).connections, []);
});

test('connection probe tools cannot be used from home, scheduled or voice chats', async () => {
  const app = storage.saveApplet({
    title: 'Books',
    description: '',
    source: '<p/>',
    bundle: '',
    backend: source.replace('GOOGLE_BOOKS_API_KEY', 'MISSING_PROBE_KEY'),
    backendBundle: await compileBackend(
      source.replace('GOOGLE_BOOKS_API_KEY', 'MISSING_PROBE_KEY'),
    ),
  });
  const space = storage.appletSpaceId(app.id),
    chat = storage.createChat(space);
  const tools = await appTools(app.id, space, chat.id);
  const result = (await tools.execute('test_app_connection', {
    action: 'searchBooks',
    inputJSON: '{}',
  })) as any;
  assert.equal(result.requests[0].code, 'secret_unavailable');
  const scheduled = await appTools(app.id, space, chat.id, 'scheduled');
  await assert.rejects(
    () => scheduled.execute('test_app_connection', { action: 'searchBooks', inputJSON: '{}' }),
    /unavailable/,
  );
  const home = storage.launcherChat(),
    homeChat = storage.createChat(home.id);
  for (const mode of ['knowledge', 'voice'] as const) {
    const restricted = await appTools(undefined, home.id, homeChat.id, mode);
    await assert.rejects(
      () => restricted.execute('test_app_connection', { action: 'searchBooks', inputJSON: '{}' }),
      /unavailable/,
    );
  }
});

test('direct API checks work before a backend exists and return bounded safe evidence', async () => {
  const { probeApiConnection } = await import('../src/lib/server/api-connection');
  credential();
  const request = {
    url: 'https://www.googleapis.com/books/v1/volumes',
    query: { q: 'intitle:Pride and Prejudice', key: { secret: 'GOOGLE_BOOKS_API_KEY' } },
  };
  const failed = await probeApiConnection(request, provider);
  assert.equal(failed.status, 400);
  assert.equal(failed.verified, false);
  assert.equal(failed.requests[0].providerReason, 'API_KEY_INVALID');
  assert.equal('responsePreview' in failed, false);
  assert.ok(!JSON.stringify(failed).includes(token));
  const successful = await probeApiConnection(request, {
    ...provider,
    send: async () => ({
      status: 200,
      text: JSON.stringify({ items: Array(200).fill({ title: 'A very long sample '.repeat(20) }) }),
    }),
  });
  assert.equal(successful.verified, true);
  assert.equal('responsePreview' in successful && successful.responsePreview?.length, 6000);
  assert.equal('previewTruncated' in successful && successful.previewTruncated, true);
  let networkAttempted = false;
  const rejected = await probeApiConnection(
    { ...request, method: 'POST', body: {} },
    {
      ...provider,
      send: async () => {
        networkAttempted = true;
        throw Error('Must not send');
      },
    },
  );
  assert.equal(rejected.ok, false);
  assert.equal(networkAttempted, false);
});

test('direct API checks require current build approval and skill loading, but do not require a draft', async () => {
  const plans = await import('../src/lib/server/build-plans');
  const space = storage.createSpace('Direct API check'),
    chat = storage.createChat(space.id);
  const normal = await appTools(undefined, space.id, chat.id);
  await assert.rejects(
    () => normal.execute('test_api_connection', { requestJSON: '{}' }),
    /unavailable/,
  );
  const plan = plans.proposeBuild(space.id, chat.id, {
    title: 'Books',
    emoji: '📚',
    summary: 'Connect Google Books.',
    features: ['Search books'],
    caveats: [],
  });
  plans.claimBuildPlan(space.id, chat.id, plan.id);
  const approved = await appTools(undefined, space.id, chat.id, 'knowledge', '', plan.id);
  const input = {
    requestJSON: JSON.stringify({
      url: 'https://www.googleapis.com/books/v1/volumes',
      query: { q: 'A', key: { secret: 'MISSING_DIRECT_KEY' } },
    }),
  };
  await assert.rejects(
    () => approved.execute('test_api_connection', input),
    /Load the build skill/,
  );
  await approved.execute('load_skill', { name: 'build' });
  const result = (await approved.execute('test_api_connection', input)) as any;
  assert.equal(result.verified, false);
  assert.equal(result.requests[0].code, 'secret_unavailable');
  assert.equal(
    storage.workspace(
      (db) => db.prepare('SELECT count(*) AS n FROM build_drafts WHERE chat_id=?').get(chat.id)!.n,
    ),
    0,
  );
  plans.finishBuild(space.id, chat.id, plan.id);
  await assert.rejects(() => approved.execute('test_api_connection', input), /Approve/);
});

test('a missing vault key is never silently regenerated over stored credentials', () => {
  credential();
  const path = join(directory, 'secrets.key'),
    original = readFileSync(path);
  unlinkSync(path);
  try {
    assert.match(
      listSecrets().find((secret) => secret.name === 'GOOGLE_BOOKS_API_KEY')!.warnings[0],
      /could not be decrypted/,
    );
    assert.equal(existsSync(path), false);
    assert.throws(
      () => saveSecret({ name: 'ANOTHER_KEY', value: 'synthetic-other', description: 'Test' }),
      /Restore the matching secrets.key/,
    );
    assert.equal(existsSync(path), false);
  } finally {
    writeFileSync(path, original, { mode: 0o600 });
  }
});
