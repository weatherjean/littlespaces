import { runBackend, type Action } from './backend-process';
import { logEvent, trace } from './diagnostics';
import { build } from 'esbuild';
import Ajv from 'ajv';
import { revision, records, commitRecords } from './storage';
import type { RecordEntry, Revision } from '../types';

// App-authored schema IDs must not share a registry or accumulate forever.
const schemaValidator = () => new Ajv({ strict: false, allErrors: true, validateFormats: false });

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

export async function callApp(id: string, name: string, input: unknown) {
  return trace('action', { appletId: id, action: name }, async () => {
    logEvent('action.input', { input });
    const current = revision(id);
    const actions = await actionsForRevision(id, current);
    if (revision(id).version !== current.version)
      throw new Error('The app changed during this action. Please retry.');
    const action = actions.find((action) => action.name === name);
    if (!action) throw new Error('Unknown app action.');
    const ajv = schemaValidator();
    const validate = ajv.compile(action.parameters);
    if (!validate(input))
      throw new Error(`Invalid action input: ${ajv.errorsText(validate.errors)}`);
    const before = records(id);
    const output = await runBackend(current.backendBundle!, {
      mode: 'call',
      action: name,
      input,
      records: before,
    });
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
