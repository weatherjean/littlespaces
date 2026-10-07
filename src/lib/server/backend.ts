import { runBackend, type Action } from './backend-process';
import { backendHttp } from './backend-http';
import { logEvent, trace } from './diagnostics';
import { build } from 'esbuild';
import Ajv from 'ajv';
import { revision, records, commitRecords } from './storage';
import type { RecordEntry, Revision } from '../types';
import type { ConnectionProbe, HttpDiagnostic } from '../http-diagnostic-types';

// App-authored schema IDs must not share a registry or accumulate forever.
const schemaValidator = () => new Ajv({ strict: false, allErrors: true, validateFormats: false });

// A connection probe never commits records and never permits external writes.
// Its broker diagnostics survive app-authored catch blocks that hide the cause.
export async function probeBackendConnection(
  bundle: string,
  name: string,
  input: unknown,
  rows: RecordEntry[],
  dependencies?: Parameters<typeof backendHttp>[1],
): Promise<ConnectionProbe> {
  const { catalog = [] } = await runBackend(bundle, { mode: 'inspect' });
  const action = catalog.find((action) => action.name === name);
  if (!action) throw Error('Choose an existing backend action to test.');
  if (!action.readOnly) throw Error('Connection tests can only run read-only actions.');
  const ajv = schemaValidator(),
    validate = ajv.compile(action.parameters);
  if (!validate(input)) throw Error(`Invalid action input: ${ajv.errorsText(validate.errors)}`);
  const requests: HttpDiagnostic[] = [];
  const base = { action: name, checkedAt: new Date().toISOString(), requests };
  try {
    const output = await runBackend(
      bundle,
      { mode: 'call', action: name, input, records: rows },
      30_000,
      backendHttp(true, dependencies, (diagnostic) => requests.push(diagnostic)),
    );
    const canonical = (entries: RecordEntry[]) =>
      JSON.stringify([...entries].sort((a, b) => a.key.localeCompare(b.key)));
    if (!Array.isArray(output.records) || canonical(output.records) !== canonical(rows))
      throw Error('Connection test attempted to change records. No changes were saved.');
    const verified =
      requests.length > 0 && requests.every((request) => request.code === 'http_success');
    return {
      ...base,
      ok: true,
      verified,
      result: output.result,
      ...(!verified
        ? {
            note: requests.length
              ? 'An external request failed; the connection is not verified.'
              : 'This action made no external requests. No connection was verified.',
          }
        : {}),
    };
  } catch (error) {
    return {
      ...base,
      ok: false,
      verified: false,
      error: error instanceof Error ? error.message : 'Connection test failed.',
    };
  }
}

export async function probeAppConnection(id: string, name: string, input: unknown) {
  const current = revision(id);
  if (!current.backendBundle) throw Error('This app has no backend to test.');
  const result = await probeBackendConnection(current.backendBundle, name, input, records(id));
  if (revision(id).version !== current.version)
    throw Error(
      'The app changed during the connection test. Read the current actions before testing again.',
    );
  return { version: current.version, ...result };
}

export async function compileBackend(source: string) {
  if (!source.trim() || source.length > 80_000)
    throw new Error('Backend source must contain 1–80,000 characters.');
  const result = await build({
    stdin: { contents: source, loader: 'ts', sourcefile: 'backend.ts' },
    write: false,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node24',
    logLevel: 'silent',
    plugins: [
      {
        name: 'no-backend-imports',
        setup(builder) {
          builder.onResolve({ filter: /.*/ }, ({ path }) => ({
            errors: [
              { text: `Backend imports are unavailable: ${path}. Use the supplied context.` },
            ],
          }));
        },
      },
    ],
  });
  return result.outputFiles[0].text;
}

export async function validateBackend(source: string) {
  const bundle = await compileBackend(source);
  const { catalog = [], report = [] } = await runBackend(bundle, { mode: 'test' }, 10_000);
  logEvent('backend.tests', { catalog, report });
  for (const action of catalog) schemaValidator().compile(action.parameters);
  if (!report.length || report.some((test) => !test.passed))
    throw new Error(
      `Backend tests failed: ${
        report
          .filter((test) => !test.passed)
          .map((test) => `${test.name}: ${test.error}`)
          .join('; ') || 'No tests ran.'
      }`,
    );
  return { bundle, catalog, report };
}

const catalogs = new Map<string, Action[]>();
export async function appActions(id: string): Promise<Action[]> {
  return actionsForRevision(id, revision(id));
}

async function actionsForRevision(id: string, current: Revision): Promise<Action[]> {
  if (!current.backendBundle) return [];
  const key = `${id}:${current.version}`;
  if (catalogs.has(key)) return catalogs.get(key)!;
  const { catalog = [] } = await runBackend(current.backendBundle, { mode: 'inspect' });
  if (catalogs.size > 100) catalogs.clear();
  catalogs.set(key, catalog);
  return catalog;
}

export async function callApp(
  id: string,
  name: string,
  input: unknown,
  readOnlyOnly = false,
  expectedVersion?: number,
) {
  return trace('action', { appletId: id, action: name }, async () => {
    logEvent('action.input', { input });
    const current = revision(id);
    if (expectedVersion !== undefined && current.version !== expectedVersion)
      throw new Error('The app changed since confirmation. Ask for a fresh suggestion.');
    const actions = await actionsForRevision(id, current);
    if (revision(id).version !== current.version)
      throw new Error('The app changed during this action. Please retry.');
    const action = actions.find((action) => action.name === name);
    if (!action) throw new Error('Unknown app action.');
    if (readOnlyOnly && !action.readOnly) throw new Error('This turn can only read app data.');
    const ajv = schemaValidator();
    const validate = ajv.compile(action.parameters);
    if (!validate(input))
      throw new Error(`Invalid action input: ${ajv.errorsText(validate.errors)}`);
    const before = records(id);
    const output = await runBackend(
      current.backendBundle!,
      {
        mode: 'call',
        action: name,
        input,
        records: before,
      },
      30_000,
      backendHttp(action.readOnly),
    );
    if (!Array.isArray(output.records)) throw new Error('Backend returned invalid records.');
    // A second check in the host prevents a child from bypassing read-only declarations.
    const canonical = (rows: RecordEntry[]) =>
      JSON.stringify([...rows].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)));
    if (action.readOnly && canonical(output.records) !== canonical(before))
      throw new Error('Read-only action attempted to write.');
    if (!action.readOnly) commitRecords(id, before, output.records, current.version);
    logEvent('action.result', {
      result: output.result,
      version: current.version,
      readOnly: action.readOnly,
      changes: output.records.filter(
        (row) => JSON.stringify(before.find((old) => old.key === row.key)) !== JSON.stringify(row),
      ),
      removedKeys: before
        .filter((row) => !output.records!.some((after) => after.key === row.key))
        .map((row) => row.key),
    });
    return output.result;
  });
}
