import { logEvent, trace } from './diagnostics';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import Ajv from 'ajv';
import { runtimeSource } from './backend-runtime';
import { backendSandbox } from './backend-sandbox';
import { revision, records, commitRecords } from './storage';
import type { RecordEntry } from '../types';

export type Action = { name: string; description: string; parameters: Record<string, unknown>; readOnly: boolean };
export type TestResult = { name: string; passed: boolean; error?: string };
type RuntimeResult = { ok: boolean; error?: string; catalog?: Action[]; report?: TestResult[]; result?: unknown; records?: RecordEntry[] };
const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });

export async function compileBackend(source: string) {
  if (!source.trim() || source.length > 80_000) throw new Error('Backend source must contain 1–80,000 characters.');
  const result = await build({ stdin: { contents: source, loader: 'ts', sourcefile: 'backend.ts' }, write: false, bundle: true, format: 'cjs', platform: 'node', target: 'node24', logLevel: 'silent',
    plugins: [{ name: 'no-backend-imports', setup(builder) { builder.onResolve({ filter: /.*/ }, ({ path }) => ({ errors: [{ text: `Backend imports are unavailable: ${path}. Use the supplied context.` }] })); } }] });
  return result.outputFiles[0].text;
}

export async function runBackend(bundle: string, request: object, timeout = 5000): Promise<RuntimeResult> {
  const directory = await mkdtemp(join(tmpdir(), 'little-app-runtime-'));
  try {
    await writeFile(join(directory, 'backend.cjs'), bundle, { mode: 0o600 });
    await writeFile(join(directory, 'runner.cjs'), runtimeSource, { mode: 0o600 });
    const sandbox = backendSandbox(directory);
    return await new Promise((resolve, reject) => {
      const child = spawn(sandbox.command, sandbox.args, { cwd: directory, env: {}, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '', stderr = '', failure = '';
      const timer = setTimeout(() => { failure = 'Backend execution timed out.'; child.kill('SIGKILL'); }, timeout);
      child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 5_000_000) { failure = 'Backend output is too large.'; child.kill('SIGKILL'); } });
      child.stderr.on('data', chunk => { if (stderr.length < 2000) stderr += chunk; });
      child.on('error', () => { clearTimeout(timer); reject(new Error(sandbox.requirement)); });
      child.on('close', code => {
        clearTimeout(timer);
        if (failure) return reject(new Error(failure));
        try {
          const value = JSON.parse(stdout) as RuntimeResult;
          if (!value.ok || code !== 0) return reject(new Error(value.error || 'Backend execution failed.'));
          resolve(value);
        } catch { reject(new Error(`Backend runtime failed: ${stderr.slice(0,500) || 'invalid output'}`)); }
      });
      child.stdin.on('error', () => {});
      const payload = JSON.stringify(request);
      if (payload.length > 4_000_000) { failure = 'App data exceeds the backend execution limit (4 MB).'; child.kill('SIGKILL'); }
      else child.stdin.end(payload);
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export async function validateBackend(source: string) {
  const bundle = await compileBackend(source);
  const { catalog = [], report = [] } = await runBackend(bundle, { mode: 'test' }, 10_000);
  logEvent('backend.tests',{catalog,report});
  for (const action of catalog) ajv.compile(action.parameters);
  if (!report.length || report.some(test => !test.passed)) throw new Error(`Backend tests failed: ${report.filter(test => !test.passed).map(test => `${test.name}: ${test.error}`).join('; ') || 'No tests ran.'}`);
  return { bundle, catalog, report };
}

const catalogs = new Map<string, Action[]>();
export async function appActions(id: string): Promise<Action[]> {
  const current = revision(id);
  if (!current.backendBundle) return [];
  const key = `${id}:${current.version}`;
  if (catalogs.has(key)) return catalogs.get(key)!;
  const { catalog = [] } = await runBackend(current.backendBundle, { mode: 'inspect' });
  if (catalogs.size > 100) catalogs.clear();
  catalogs.set(key, catalog);
  return catalog;
}

export async function callApp(id: string, name: string, input: unknown) {
  return trace('action',{appletId:id,action:name},async()=>{
  logEvent('action.input',{input});
  const actions = await appActions(id);
  const action = actions.find(action => action.name === name);
  if (!action) throw new Error('Unknown app action.');
  const validate = ajv.compile(action.parameters);
  if (!validate(input)) throw new Error(`Invalid action input: ${ajv.errorsText(validate.errors)}`);
  const current = revision(id), before = records(id);
  const output = await runBackend(current.backendBundle!, { mode: 'call', action: name, input, records: before });
  if (!Array.isArray(output.records)) throw new Error('Backend returned invalid records.');
  // A second check in the host prevents a child from bypassing read-only declarations.
  const canonical = (rows: RecordEntry[]) => JSON.stringify([...rows].sort((a,b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  if (action.readOnly && canonical(output.records) !== canonical(before)) throw new Error('Read-only action attempted to write.');
  if (!action.readOnly) commitRecords(id, before, output.records, current.version);
  logEvent('action.result',{result:output.result,version:current.version,readOnly:action.readOnly,changes:output.records.filter(row=>JSON.stringify(before.find(old=>old.key===row.key))!==JSON.stringify(row)),removedKeys:before.filter(row=>!output.records!.some(after=>after.key===row.key)).map(row=>row.key)});
  return output.result;
  });
}
