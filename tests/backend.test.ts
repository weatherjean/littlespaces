import { runBackend } from '../src/lib/server/backend-process';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { backendSandbox } from '../src/lib/server/backend-sandbox';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const directory = mkdtempSync(join(tmpdir(), 'little-backend-test-'));
process.env.APP_DATA_DIR = directory;
const { compileBackend, validateBackend, callApp, appActions } =
  await import('../src/lib/server/backend');
const storage = await import('../src/lib/server/storage');
const { publishApp } = await import('../src/lib/server/publish');
const { appTools } = await import('../src/lib/server/app-tools');
after(() => rmSync(directory, { recursive: true, force: true }));
const source = readFileSync(
  new URL('../src/lib/templates/plants-backend.ts.txt', import.meta.url),
  'utf8',
);
const validated = await validateBackend(source);
const content = {
  title: 'Plants',
  description: 'Test',
  source: '<p>Plants</p>',
  bundle: 'test',
  backend: source,
  backendBundle: validated.bundle,
  testReport: JSON.stringify(validated.report),
};

test('real backend suite runs in isolation and uses no production records', () => {
  assert.equal(validated.report.length, 5);
  assert.ok(validated.report.every((test) => test.passed));
});

test('UI and agent call the same actions and persist only to the scoped app', async () => {
  const a = storage.saveApplet(content),
    b = storage.saveApplet(content);
  const tools = await appTools(a.id);
  const plant = (await tools.execute('invoke', {
    action: 'addPlant',
    inputJSON: JSON.stringify({ name: 'Fern', interval: 7 }),
  })) as { key: string };
  await callApp(a.id, 'waterPlant', { key: plant.key });
  const rows = (await callApp(a.id, 'listPlants', {})) as {
    key: string;
    value: { name: string; wateredAt: string };
  }[];
  assert.equal(rows[0].value.name, 'Fern');
  assert.ok(rows[0].value.wateredAt);
  assert.deepEqual(await callApp(b.id, 'listPlants', {}), []);
  await assert.rejects(
    () => callApp(a.id, 'addPlant', { name: 'bad', interval: -1 }),
    /Invalid action input/,
  );
  await assert.rejects(() => callApp(a.id, 'missing', {}), /Unknown app action/);
  await assert.rejects(
    () => tools.execute('set_record', { key: 'bypass', valueJSON: '{}' }),
    /unavailable/,
  );
  assert.equal(storage.records(a.id).length, 1);
});

test('failed generated tests never replace the current app and successful upgrades preserve data', async () => {
  const app = storage.saveApplet(content);
  storage.commitRecords(
    app.id,
    [],
    [{ key: 'old', value: { name: 'Old plant', interval: 7, wateredAt: null } }],
    1,
  );
  await assert.rejects(
    () =>
      publishApp(
        {
          ...content,
          backend: source.replace('assert.equal(rows.length, 1)', 'assert.equal(rows.length, 99)'),
        },
        app.id,
      ),
    /Backend tests failed/,
  );
  assert.equal(storage.revision(app.id).version, 1);
  await publishApp({ ...content, title: 'Updated' }, app.id);
  assert.equal(storage.revision(app.id).version, 2);
  assert.equal(storage.records(app.id)[0].key, 'old');
  storage.saveApplet(storage.revision(app.id, 1), app.id);
  assert.equal((await appActions(app.id)).length, 5);
  assert.equal(storage.records(app.id)[0].key, 'old');
});

test('imports, filesystem reads and process spawning cannot escape the runtime', async () => {
  await assert.rejects(
    () => compileBackend('import fs from "node:fs"; export const actions = fs;'),
    /imports are unavailable/,
  );
  for (const code of [
    "require('node:fs').readFileSync('/etc/passwd')",
    "require('node:child_process').execSync('echo escaped')",
    "Function('return process')()",
  ]) {
    const bundle = `exports.actions={probe:{description:'Probe',readOnly:true,parameters:{type:'object'},run:()=>${code}}};`;
    await assert.rejects(
      () => runBackend(bundle, { mode: 'call', action: 'probe', input: {}, records: [] }),
      /Access|permission|Code generation|not allowed|denied/i,
    );
  }
});

test('OS sandbox independently blocks private files, host writes and host network access', async () => {
  const appDirectory = mkdtempSync(join(tmpdir(), 'little-sandbox-probe-'));
  const secret = join(directory, 'private.txt');
  writeFileSync(secret, 'private host data');
  const server = createServer((socket) => socket.destroy());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address() as { port: number };
    const sandbox = backendSandbox(appDirectory);
    // Intentionally omit Node permissions: these checks exercise the OS boundary.
    const args = sandbox.args.slice(0, sandbox.args.indexOf('--max-old-space-size=64'));
    const probe = `
      const assert = require('node:assert/strict');
      const fs = require('node:fs');
      assert.throws(() => fs.readFileSync(${JSON.stringify(secret)}));
      assert.throws(() => fs.writeFileSync(${JSON.stringify(join(directory, 'escape.txt'))}, 'escaped'));
      // macOS denies subprocesses at the OS layer. Bubblewrap confines them to
      // the same namespaces; Node permissions deny spawning in production.
      const childProbe = ${JSON.stringify(`
        const assert = require('node:assert/strict');
        const fs = require('node:fs');
        assert.throws(() => fs.readFileSync(${JSON.stringify(secret)}));
        assert.throws(() => fs.writeFileSync(${JSON.stringify(join(directory, 'escape.txt'))}, 'escaped'));
        const socket = require('node:net').connect(${address.port}, '127.0.0.1');
        socket.on('connect', () => process.exit(1));
        socket.on('error', () => process.exit(0));
        setTimeout(() => process.exit(2), 1500);
      `)};
      const child = require('node:child_process').spawnSync(process.execPath, ['-e', childProbe], { timeout: 2000 });
      ${process.platform === 'linux' ? 'assert.equal(child.status, 0, String(child.stderr));' : 'assert.notEqual(child.status, 0);'}
      const socket = require('node:net').connect(${address.port}, '127.0.0.1');
      socket.on('connect', () => process.exit(1));
      socket.on('error', () => process.exit(0));
      setTimeout(() => process.exit(2), 1500);
    `;
    const result = spawnSync(
      sandbox.command,
      [...args, '--openssl-config=/dev/null', '-e', probe],
      { cwd: appDirectory, env: {}, encoding: 'utf8', timeout: 3000 },
    );
    assert.equal(
      result.status,
      0,
      `OS sandbox probe failed: ${result.stderr}; ${result.error || result.signal || ''}`,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(appDirectory, { recursive: true, force: true });
  }
});

test('production sandbox flags deny subprocess creation', () => {
  const appDirectory = mkdtempSync(join(tmpdir(), 'little-process-probe-'));
  try {
    const sandbox = backendSandbox(appDirectory);
    const probe = `
      const assert = require('node:assert/strict');
      assert.throws(
        () => require('node:child_process').spawnSync(process.execPath, ['-e', 'process.exit(0)']),
        { code: 'ERR_ACCESS_DENIED' },
      );
    `;
    const result = spawnSync(sandbox.command, [...sandbox.args.slice(0, -1), '-e', probe], {
      cwd: appDirectory,
      env: {},
      encoding: 'utf8',
      timeout: 3000,
    });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(appDirectory, { recursive: true, force: true });
  }
});

test('runaway code is terminated, and read-only actions cannot change records', async () => {
  await assert.rejects(() => runBackend('while(true){}', { mode: 'inspect' }, 250), /timed out/);
  const bundle = `exports.actions={bad:{description:'Bad',readOnly:true,parameters:{type:'object'},run:(_,ctx)=>ctx.db.set('x',1)}};`;
  await assert.rejects(
    () => runBackend(bundle, { mode: 'call', action: 'bad', input: {}, records: [] }),
    /Read-only/,
  );
});

test('atomic commits reject stale data instead of overwriting another action', () => {
  const app = storage.saveApplet(content);
  const snapshot = storage.records(app.id);
  storage.commitRecords(app.id, [], [{ key: 'other', value: 1 }], 1);
  assert.throws(
    () => storage.commitRecords(app.id, snapshot, [{ key: 'mine', value: 2 }], 1),
    /changed during/,
  );
  assert.deepEqual(storage.records(app.id), [{ key: 'other', value: 1 }]);
  assert.throws(
    () =>
      storage.commitRecords(
        app.id,
        storage.records(app.id),
        [
          { key: 'x', value: 1 },
          { key: 'x', value: 2 },
        ],
        1,
      ),
    /Invalid record key/,
  );
});

test('built-in Chat tools cannot mutate another app', async () => {
  const tools = await appTools();
  await assert.rejects(
    () => tools.execute('invoke', { action: 'removePlant', inputJSON: '{}' }),
    /unavailable/,
  );
  assert.ok(Array.isArray(await tools.execute('list_apps', {})));
});

test('backend apps reject legacy writes even when a tool catalog predates an upgrade', async () => {
  const app = storage.saveApplet({ title: 'Legacy', description: '', source: '<p/>', bundle: '' });
  const tools = await appTools(app.id);
  storage.putRecord(app.id, 'keep', 1);
  storage.saveApplet(content, app.id);
  assert.throws(() => storage.putRecord(app.id, 'bypass', 2), /backend actions/);
  assert.throws(() => storage.removeRecord(app.id, 'keep'), /backend actions/);
  await assert.rejects(
    () => tools.execute('set_record', { key: 'bypass', valueJSON: '2' }),
    /backend actions/,
  );
  await assert.rejects(() => tools.execute('remove_record', { key: 'keep' }), /backend actions/);
  assert.deepEqual(storage.records(app.id), [{ key: 'keep', value: 1 }]);
});

test('an action cannot inspect one version and run a newly published version', async () => {
  const app = storage.saveApplet(content);
  const pending = callApp(app.id, 'addPlant', { name: 'Fern', interval: 7 });
  storage.saveApplet({ ...content, title: 'Changed' }, app.id);
  await assert.rejects(() => pending, /changed during this action/);
  assert.deepEqual(storage.records(app.id), []);
});

test('runtime preserves Unicode split across stdout writes', async () => {
  const bundle = `const bytes=Buffer.from(JSON.stringify({ok:true,result:'🌿'}));
    const index=bytes.indexOf(Buffer.from('🌿'))+2;
    process.stdout.write(bytes.subarray(0,index));
    setTimeout(()=>{process.stdout.write(bytes.subarray(index));process.exit(0)},20);`;
  // Supply an actions definition so the runner can finish without an error;
  // instead this fixture exits after writing its deliberately split protocol.
  const output = await runBackend(
    bundle +
      `exports.actions={wait:{description:'Wait',readOnly:true,parameters:{type:'object'},run:()=>new Promise(()=>{})}};`,
    { mode: 'call', action: 'wait', input: {} },
  );
  assert.equal(output.result, '🌿');
});

test('backend process capacity is bounded and released after failures', async () => {
  const pending = Array.from({ length: 4 }, () =>
    runBackend('while(true){}', { mode: 'inspect' }, 300),
  );
  const settled = Promise.allSettled(pending);
  await assert.rejects(() => runBackend('', { mode: 'inspect' }), /server is busy/);
  assert.ok((await settled).every((result) => result.status === 'rejected'));
  const output = await runBackend(validated.bundle, { mode: 'inspect' });
  assert.equal(output.catalog?.length, 5);
  await assert.rejects(() => runBackend('', { input: '🌿'.repeat(1_000_001) }), /4 MB/);
});

test('schema IDs are local to an action and do not collide across app validations', async () => {
  const backend = `export const actions={read:{description:'Read',readOnly:true,
    parameters:{$id:'https://example.test/input',type:'object'},run:()=>true}};
    export const tests=[{name:'Read succeeds',run:async({call,assert})=>assert.equal(await call('read',{}),true)}];`;
  await validateBackend(backend);
  const checked = await validateBackend(backend);
  const app = storage.saveApplet({ ...content, backend, backendBundle: checked.bundle });
  assert.equal(await callApp(app.id, 'read', {}), true);
  assert.equal(await callApp(app.id, 'read', {}), true);
});
