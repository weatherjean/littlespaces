import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const directory = mkdtempSync(join(tmpdir(), 'little-backend-test-'));
process.env.APP_DATA_DIR = directory;
const { compileBackend, validateBackend, runBackend, callApp, appActions } = await import('../src/lib/server/backend');
const storage = await import('../src/lib/server/storage');
const { publishApp } = await import('../src/lib/server/publish');
const { appTools } = await import('../src/lib/server/app-tools');
after(() => rmSync(directory, {recursive:true,force:true}));
const source = readFileSync(new URL('../src/lib/templates/plants-backend.ts.txt', import.meta.url), 'utf8');
const validated = await validateBackend(source);
const content = {title:'Plants',description:'Test',source:'<p>Plants</p>',bundle:'test',backend:source,backendBundle:validated.bundle,testReport:JSON.stringify(validated.report)};

test('real backend suite runs in isolation and uses no production records', () => {
  assert.equal(validated.report.length, 5);
  assert.ok(validated.report.every(test => test.passed));
});

test('UI and agent call the same actions and persist only to the scoped app', async () => {
  const a = storage.saveApplet(content), b = storage.saveApplet(content);
  const tools = await appTools(a.id);
  const plant = await tools.execute('invoke',{action:'addPlant',inputJSON:JSON.stringify({name:'Fern',interval:7})}) as {key:string};
  await callApp(a.id,'waterPlant',{key:plant.key});
  const rows = await callApp(a.id,'listPlants',{}) as {key:string;value:{name:string;wateredAt:string}}[];
  assert.equal(rows[0].value.name,'Fern'); assert.ok(rows[0].value.wateredAt);
  assert.deepEqual(await callApp(b.id,'listPlants',{}),[]);
  await assert.rejects(() => callApp(a.id,'addPlant',{name:'bad',interval:-1}),/Invalid action input/);
  await assert.rejects(() => callApp(a.id,'missing',{}),/Unknown app action/);
  await assert.rejects(() => tools.execute('set_record',{key:'bypass',valueJSON:'{}'}),/unavailable/);
  assert.equal(storage.records(a.id).length,1);
});

test('failed generated tests never replace the current app and successful upgrades preserve data', async () => {
  const app = storage.saveApplet(content);
  storage.putRecord(app.id,'old',{name:'Old plant',interval:7,wateredAt:null});
  await assert.rejects(() => publishApp({...content,backend:source.replace("assert.equal(rows.length, 1)","assert.equal(rows.length, 99)")},app.id),/Backend tests failed/);
  assert.equal(storage.revision(app.id).version,1);
  await publishApp({...content,title:'Updated'},app.id);
  assert.equal(storage.revision(app.id).version,2);
  assert.equal(storage.records(app.id)[0].key,'old');
  storage.saveApplet(storage.revision(app.id,1),app.id);
  assert.equal((await appActions(app.id)).length,5);
  assert.equal(storage.records(app.id)[0].key,'old');
});

test('imports, filesystem reads and process spawning cannot escape the runtime', async () => {
  await assert.rejects(() => compileBackend('import fs from "node:fs"; export const actions = fs;'), /imports are unavailable/);
  for (const code of ["require('node:fs').readFileSync('/etc/passwd')", "require('node:child_process').execSync('echo escaped')", "Function('return process')()"] ) {
    const bundle = `exports.actions={probe:{description:'Probe',readOnly:true,parameters:{type:'object'},run:()=>${code}}};`;
    await assert.rejects(() => runBackend(bundle,{mode:'call',action:'probe',input:{},records:[]}), /Access|permission|Code generation|not allowed|denied/i);
  }
});

test('runaway code is terminated, and read-only actions cannot change records', async () => {
  await assert.rejects(() => runBackend('while(true){}',{mode:'inspect'},250),/timed out/);
  const bundle = `exports.actions={bad:{description:'Bad',readOnly:true,parameters:{type:'object'},run:(_,ctx)=>ctx.db.set('x',1)}};`;
  await assert.rejects(() => runBackend(bundle,{mode:'call',action:'bad',input:{},records:[]}),/Read-only/);
});

test('atomic commits reject stale data instead of overwriting another action', () => {
  const app = storage.saveApplet(content);
  const snapshot = storage.records(app.id);
  storage.putRecord(app.id,'other',1);
  assert.throws(() => storage.commitRecords(app.id,snapshot,[{key:'mine',value:2}],1),/changed during/);
  assert.deepEqual(storage.records(app.id),[{key:'other',value:1}]);
  assert.throws(() => storage.commitRecords(app.id,storage.records(app.id),[{key:'x',value:1},{key:'x',value:2}],1),/Invalid record key/);
});

test('built-in Chat tools cannot mutate another app', async () => {
  const tools = await appTools();
  await assert.rejects(() => tools.execute('invoke',{action:'removePlant',inputJSON:'{}'}),/unavailable/);
  assert.ok(Array.isArray(await tools.execute('list_apps',{})));
});
