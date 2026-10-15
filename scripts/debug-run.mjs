// Inspect a running isolated evaluation without printing its authentication material.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
const id = process.argv[2];
if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) throw Error('Usage: node scripts/debug-run.mjs RUN_ID');
const key = (await readFile('.data-monolith-rework/testing.key', 'utf8')).trim();
const response = await fetch(`http://127.0.0.1:5175/api/test-runs/${id}/report`, {
  headers: { authorization: `Bearer ${key}` },
});
const report = await response.json();
if (!response.ok)
  throw Error(
    `Debug report unavailable: ${report.error}. Completed runs keep their report in build-rust/evaluations or build-rust/model-e2e.`,
  );
const directory = path.join('build-rust', 'evaluations', id);
await mkdir(directory, { recursive: true, mode: 0o700 });
await writeFile(path.join(directory, 'debug.json'), JSON.stringify(report, null, 2), {
  mode: 0o600,
});
const failures = report.calls.filter(
  (c) =>
    c.result?.error ||
    c.result?.ok?.error ||
    c.result?.ok?.backendTestsPassed === false ||
    c.result?.ok?.passed === false,
);
console.log(
  JSON.stringify(
    {
      run: id,
      jobs: report.jobs.map((j) => ({
        id: j.id,
        state: j.state,
        phase: j.payload.phase,
        tool: j.payload.activeTool,
        error: j.payload.error,
      })),
      toolCalls: report.calls.length,
      failures: failures.map((c) => ({
        job: c.job,
        tool: c.input?.arguments?.tool || c.input?.name,
        error: c.result?.error || c.result?.ok?.error || 'checks_failed',
      })),
      providerErrors: report.requests.filter((r) => r.details.error),
      report: path.join(directory, 'debug.json'),
    },
    null,
    2,
  ),
);
