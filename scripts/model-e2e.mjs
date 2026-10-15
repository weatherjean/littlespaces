// Explicit opt-in API tests using the actual signed-in model in an isolated app workspace.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const argv = process.argv.slice(2);
if (!argv.includes('--real'))
  throw Error('Real-model usage requires --real. Start scripts/dev.mjs with --live-tests first.');
const option = (key, fallback) => {
  const i = argv.indexOf(key);
  return i < 0 ? fallback : argv[i + 1];
};
const root = option('--origin', 'http://127.0.0.1:5175');
const workspace = option('--workspace', '.data-monolith-rework');
const scenario = JSON.parse(
  await readFile(option('--scenario', 'scripts/scenarios/releases.json'), 'utf8'),
);
const key = (await readFile(path.join(workspace, 'testing.key'), 'utf8')).trim();
async function management(route, body) {
  const res = await fetch(root + route, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw Error(`${route}: ${data.error}`);
  return data;
}
const run = await management('/api/test-runs', { allowRealModel: true });
const artifactDir = path.join('build-rust', 'model-e2e', run.id);
await mkdir(artifactDir, { recursive: true, mode: 0o700 });
const report = {
  id: run.id,
  isolated: run.isolated,
  scenario: scenario.name,
  steps: [],
  passed: false,
};
async function api(route, body) {
  const res = await fetch(run.origin + route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      cookie: `little_session=${run.cookie}`,
      origin: run.origin,
      'x-csrf-token': run.csrf,
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw Error(`${route}: ${data.error}`);
  return data;
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  const models = await api('/api/models');
  const model = option(
    '--model',
    models.find((m) => /gpt-6.1.*sol/.test(m.slug))?.slug || models[0]?.slug,
  );
  assert.ok(
    models.some((m) => m.slug === model),
    'Requested model is available',
  );
  report.model = model;
  const app = await api('/api/apps', { title: `API test: ${scenario.name}` });
  report.app = app.app;
  let conversation = app.conversation;
  let firstRelease, firstRevision;
  for (const [i, step] of scenario.steps.entries()) {
    if (i > 0) conversation = (await api(`/api/build/${app.app}`, {})).conversation;
    const prompt = step.prompt
      .replaceAll('$FIRST_RELEASE', firstRelease || '')
      .replaceAll('$FIRST_REVISION', firstRevision || '');
    const { job } = await api(`/api/conversations/${conversation}/send`, {
      message: prompt,
      model,
    });
    console.log(`Step ${i + 1}/${scenario.steps.length}: ${step.name} (${model})`);
    const end = Date.now() + Number(option('--timeout-seconds', '1800')) * 1000;
    let state;
    while (Date.now() < end) {
      state = await api(`/api/jobs/${job}`);
      if (!['queued', 'running'].includes(state.state)) break;
      await delay(1000);
    }
    const evidence = {
      name: step.name,
      job,
      state: state?.state,
      messages: await api(`/api/conversations/${conversation}`),
    };
    report.steps.push(evidence);
    assert.equal(
      state.state,
      'completed',
      `Model job ended with ${state.state}: ${state.payload?.error || 'test deadline reached'}`,
    );
    if (step.approveDataChanges) {
      const plans = await api(`/api/apps/${app.app}/release-plans`);
      const pending = plans.find((p) => p.current && !p.appliedRelease && p.needsApproval);
      assert.ok(pending, 'Model prepared a reviewable data change');
      evidence.approvedPlan = pending;
      await api(`/api/apps/${app.app}/release-plans/${pending.id}/apply`, { confirm: true });
    }
    for (const tool of step.requiredTools || []) {
      assert.ok(
        evidence.messages.some((m) => m.tool?.tool === tool),
        `Expected actual ${tool} use`,
      );
    }
    if (step.expectReleaseFailure) {
      assert.ok(
        evidence.messages.some(
          (m) =>
            m.result?.ok?.released === false &&
            m.result.ok.diagnostics?.some((d) => d.phase === 'browser'),
        ),
        'Expected actionable browser failure before repair',
      );
    }
    const releases = await api(`/api/apps/${app.app}/releases`);
    evidence.releases = releases;
    if (step.minReleases)
      assert.ok(releases.length >= step.minReleases, 'Expected a real published release');
    if (!firstRelease && releases.length) {
      firstRelease = releases.at(-1).id;
      firstRevision = releases.at(-1).revision;
    }
    for (const check of step.queries || []) {
      const result = await api(`/api/apps/${app.app}/data/query`, {
        query: { sql: check.sql, params: check.params || [] },
      });
      assert.deepEqual(result, check.expected);
    }
    if (step.recordChecks) {
      const result = await api(`/api/apps/${app.app}/data/query`, {});
      for (const [k, v] of Object.entries(step.recordChecks))
        assert.deepEqual(result.records[k], v);
    }
    if (step.expectPending) {
      const plans = await api(`/api/apps/${app.app}/release-plans`);
      assert.ok(plans.some((p) => p.current && !p.appliedRelease && p.needsApproval));
    }
    console.log(`Step ${i + 1} passed`);
  }
  report.passed = true;
} catch (error) {
  report.error = String(error);
  process.exitCode = 1;
  console.error(report.error);
} finally {
  try {
    await management(`/api/test-runs/${run.id}/stop`, {});
  } catch (error) {
    report.cleanupError = String(error);
    process.exitCode = 1;
  }
  await writeFile(path.join(artifactDir, 'report.json'), JSON.stringify(report, null, 2), {
    mode: 0o600,
  });
  console.log(`Evidence: ${artifactDir}/report.json`);
}
