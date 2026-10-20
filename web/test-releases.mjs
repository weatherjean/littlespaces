import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
export async function testReleases({ api, context, origin, workspace, snapshots }) {
  // A browser failure must remain actionable through release and read_diagnostics.
  const failureApp = await api('/api/apps', { title: 'Browser diagnostics fixture' });
  const failureCode = JSON.parse(
    await readFile(new URL('../examples/tasks-rhai.json', import.meta.url), 'utf8'),
  );
  const checks = [
    { action: 'fill', selector: 'input', value: 'Ready' },
    { action: 'value', selector: 'input', value: 'Ready' },
    { action: 'enabled', selector: 'button[type="submit"]' },
    { action: 'text', selector: 'h1', contains: 'Deliberately missing heading' },
  ];
  failureCode.frontend_tests = checks;
  const failureAuthor = (body) => api(`/api/authoring/${failureApp.conversation}`, body);
  await failureAuthor({ tool: 'edit_draft', expected_version: 1, code: failureCode });
  const failure = await failureAuthor({ tool: 'release', expected_version: 2 });
  assert.equal(failure.released, false);
  assert.equal(failure.error, 'untested');
  const diagnostic = failure.diagnostics.find((d) => d.phase === 'browser');
  assert.equal(diagnostic.details.assertions, 2);
  assert.equal(diagnostic.details.completedSteps, 3);
  assert.deepEqual(diagnostic.details.failedStep, { index: 4, action: 'text', selector: 'h1' });
  const savedDiagnostics = await failureAuthor({
    tool: 'read_diagnostics',
    revision: failure.revision,
  });
  assert.ok(savedDiagnostics.some((d) => d.phase === 'browser'));
  assert.equal((await api(`/api/apps/${failureApp.app}/releases`)).length, 0);
  checks[3].contains = 'Tasks';
  await failureAuthor({
    tool: 'patch_draft',
    expected_version: 2,
    fields: { frontend_tests: checks },
  });
  assert.ok((await failureAuthor({ tool: 'release', expected_version: 3 })).published);

  const created = await api('/api/apps', { title: 'Release fixture' });
  const code = JSON.parse(
    await readFile(new URL('../examples/tasks-rhai.json', import.meta.url), 'utf8'),
  );
  const author = (body) => api(`/api/authoring/${created.conversation}`, body);
  await author({ tool: 'edit_draft', expected_version: 1, code });
  const first = await author({
    tool: 'release',
    expected_version: 2,
    records: { keep: { title: 'Original', done: false } },
  });
  assert.ok(first.published);
  assert.ok(first.release);
  assert.deepEqual((await api(`/api/apps/${created.app}/data/query`, {})).records.keep, {
    title: 'Original',
    done: false,
  });
  const changed = await author({
    tool: 'release',
    expected_version: 2,
    records: { keep: { title: 'Changed', done: true } },
  });
  assert.equal(changed.needsApproval, true);
  assert.deepEqual((await api(`/api/apps/${created.app}/data/query`, {})).records.keep, {
    title: 'Original',
    done: false,
  });
  const page = await context.newPage();
  await page.goto(`${origin}/chat/${created.conversation}`);
  await page.getByRole('button', { name: 'Review data changes', exact: true }).click();
  const review = page.getByRole('dialog', { name: 'Review data changes', exact: true });
  await review
    .getByRole('button', { name: 'Confirm data changes and release', exact: true })
    .click();
  await review.waitFor({ state: 'hidden' });
  assert.deepEqual((await api(`/api/apps/${created.app}/data/query`, {})).records.keep, {
    title: 'Changed',
    done: true,
  });
  await page.goto(`${origin}/apps/${created.app}`);
  await page.getByRole('button', { name: 'More app options' }).click();
  await page.getByRole('button', { name: 'Versions & tests', exact: true }).click();
  await page
    .getByRole('button', { name: 'Restore this release’s data…', exact: true })
    .last()
    .click();
  await review
    .getByRole('button', { name: 'Confirm data changes and release', exact: true })
    .waitFor();
  for (const width of [320, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    const layout = await review.evaluate((node) => ({
      fits: node.scrollWidth <= node.clientWidth,
      gap: parseFloat(getComputedStyle(node.querySelector('.dialog-body')).rowGap),
      heading: node.querySelector('h2').getBoundingClientRect().width,
    }));
    assert.ok(layout.fits && layout.gap >= 16 && layout.heading > 120);
    await page.screenshot({ path: path.join(snapshots, `release-data-review-${width}.png`) });
  }
  await review
    .getByRole('button', { name: 'Confirm data changes and release', exact: true })
    .click();
  await review.waitFor({ state: 'hidden' });
  assert.deepEqual((await api(`/api/apps/${created.app}/data/query`, {})).records.keep, {
    title: 'Original',
    done: false,
  });
  assert.equal((await api(`/api/apps/${created.app}/releases`)).length, 3);
  // Discard a prepared plan through the UI; published data and history must stay intact.
  const pending = await api(`/api/apps/${created.app}/release-plans`, {
    revision: first.published,
  });
  await page.getByRole('button', { name: 'More app options' }).click();
  await page.getByRole('button', { name: 'Versions & tests', exact: true }).click();
  await page.getByRole('button', { name: 'Discard release plan', exact: true }).last().click();
  await page
    .getByRole('button', { name: 'Discard release plan', exact: true })
    .waitFor({ state: 'hidden' });
  assert.ok(
    !(await api(`/api/apps/${created.app}/release-plans`)).some((p) => p.id === pending.plan),
  );
  assert.equal((await api(`/api/apps/${created.app}/releases`)).length, 3);
  assert.equal(
    (await api(`/api/apps/${created.app}/data/query`, {})).records.keep.title,
    'Original',
  );
  await page.close();
  const key = (await readFile(path.join(workspace, 'testing.key'), 'utf8')).trim();
  const denied = await context.request.post(`${origin}/api/test-runs`, {
    data: { allowRealModel: true },
  });
  assert.equal(denied.status(), 401);
  const response = await context.request.post(`${origin}/api/test-runs`, {
    headers: { authorization: `Bearer ${key}` },
    data: { allowRealModel: true },
  });
  assert.ok(response.ok());
  const run = await response.json();
  assert.equal(
    (await context.request.get(`${origin}/api/test-runs/${run.id}/report`)).status(),
    401,
  );
  const debugResponse = await context.request.get(`${origin}/api/test-runs/${run.id}/report`, {
    headers: { authorization: `Bearer ${key}` },
  });
  assert.ok(debugResponse.ok());
  const debug = await debugResponse.json();
  assert.deepEqual(debug.apps, []);
  assert.deepEqual(debug.jobs, []);
  assert.ok(!JSON.stringify(debug).includes(run.cookie));
  assert.ok(!JSON.stringify(debug).includes(run.csrf));
  assert.ok(!JSON.stringify(debug).includes(key));
  try {
    const headers = {
      cookie: `little_session=${run.cookie}`,
      origin: run.origin,
      'x-csrf-token': run.csrf,
    };
    const child = async (route, body) => {
      const r = await context.request.fetch(run.origin + route, {
        method: body === undefined ? 'GET' : 'POST',
        headers,
        data: body,
      });
      assert.ok(r.ok(), route);
      return r.json();
    };
    assert.deepEqual(await child('/api/apps'), []);
    assert.deepEqual(await child('/api/secrets'), []);
    const childApp = await child('/api/apps', { title: 'Isolated' });
    assert.ok(childApp.app);
    assert.equal(
      (await api('/api/apps')).some((a) => a.id === childApp.app),
      false,
    );
    assert.equal((await child('/api/chatgpt')).managementOrigin, origin);
    const disconnect = await context.request.post(`${run.origin}/api/chatgpt/disconnect`, {
      headers,
      data: {},
    });
    assert.equal(disconnect.status(), 403);
    assert.equal((await disconnect.json()).error, 'shared_chatgpt_connection');
    assert.ok((await child('/api/apps')).some((a) => a.id === childApp.app));
  } finally {
    await context.request.post(`${origin}/api/test-runs/${run.id}/stop`, {
      headers: { authorization: `Bearer ${key}` },
      data: {},
    });
  }
  console.log('Automatic releases, owner data review, restore UI and isolated test API passed');
}
