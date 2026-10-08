import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFile, chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium, expect } from '@playwright/test';

// Explicit opt-in: this runs real, metered ChatGPT turns using a private auth cache.
assert(
  process.env.LIVE_CHATGPT_AUTH_FILE,
  'Set LIVE_CHATGPT_AUTH_FILE to a private ChatGPT auth cache.',
);
assert(process.env.LIVE_CHATGPT_EMAIL, 'Set LIVE_CHATGPT_EMAIL to the matching account email.');
const data = await mkdtemp(join(tmpdir(), 'little-spaces-live-'));
const artifacts = resolve(process.env.LIVE_TEST_ARTIFACTS || 'build-rust/live-tests');
await mkdir(join(data, 'codex'), { recursive: true, mode: 0o700 });
await copyFile(process.env.LIVE_CHATGPT_AUTH_FILE, join(data, 'codex/auth.json'));
await chmod(join(data, 'codex/auth.json'), 0o600);
await mkdir(artifacts, { recursive: true });
let child, browser, page;
const report = { startedAt: new Date().toISOString(), realChatGPT: true, checks: [], turns: [] };
async function start() {
  const env = { ...process.env, RUST_LISTEN: '127.0.0.1:0', RUST_DATA_DIR: data };
  delete env.CODEX_BINARY;
  if (process.env.LIVE_CODEX_BINARY) env.CODEX_BINARY = process.env.LIVE_CODEX_BINARY;
  child = spawn(process.env.RUST_BINARY || 'rust/target/debug/little-spaces', [], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // An unset override must let the server discover the real pinned platform binary.
  let output = '',
    errors = '';
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Live test server startup timed out')), 15000);
    child.stderr.on('data', (chunk) => {
      errors = (errors + chunk).slice(-2000);
    });
    child.stdout.on('data', (chunk) => {
      output += chunk;
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+\/setup#token=[A-Za-z0-9_-]+/);
      if (match) {
        clearTimeout(timer);
        resolve(match[0]);
      }
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(Error(`Live test server exited ${code}: ${errors}`));
    });
  });
}
async function api(path, body) {
  return page.evaluate(
    async ({ path, body }) => {
      const response = await fetch(path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const value = await response.json();
      if (!response.ok) throw Error(value.error || `HTTP ${response.status}`);
      return value;
    },
    { path, body },
  );
}
let model;
async function turn(spaceId, chatId, message, extra = {}) {
  const started = Date.now();
  const job = (
    await api('/api/chat', {
      spaceId,
      chatId,
      message,
      model,
      effort: 'default',
      mode: 'knowledge',
      requestId: randomUUID(),
      ...extra,
    })
  ).job;
  console.log(`Real ChatGPT turn ${report.turns.length + 1}: ${message.slice(0, 85)}`);
  while (Date.now() - started < 240000) {
    const state = await api(`/api/chat?spaceId=${spaceId}&chatId=${chatId}`);
    if (state.job?.id === job.id && state.job.status !== 'running') {
      const tools = state.job.tools || [];
      report.turns.push({
        spaceId,
        jobId: job.id,
        status: state.job.status,
        durationMs: Date.now() - started,
        tools: tools.map((tool) => ({
          name: tool.name,
          status: tool.status,
          durationMs: tool.durationMs,
        })),
      });
      assert.equal(
        state.job.status,
        'complete',
        `Real turn failed: ${state.job.error || JSON.stringify(state.job)}`,
      );
      return { state, tools };
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  await page.evaluate(
    async (input) =>
      fetch('/api/chat', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      }),
    { spaceId, chatId, jobId: job.id },
  );
  throw Error('Live turn exceeded four-minute test budget');
}
async function build(home, prompt) {
  const chat = (await api(`/api/spaces/${home}/chats`, {})).chat.id;
  await turn(home, chat, prompt);
  const plan = (await api(`/api/build-plans?chatId=${chat}`)).plan;
  assert.equal(plan.status, 'pending', 'Agent must propose a reviewable build plan');
  await turn(home, chat, 'Build this exact approved test app now.', { buildPlanId: plan.id });
  const completed = (await api(`/api/build-plans?chatId=${chat}`)).plan;
  assert.equal(completed.status, 'complete', 'Agent must test and publish the app');
  const view = await api(`/api/spaces/${completed.publishedSpaceId}/view`);
  assert(JSON.parse(view.applet.actionContract).actions.length > 0);
  report.checks.push({ name: `Built ${view.space.name} through real ChatGPT`, passed: true });
  return { spaceId: completed.publishedSpaceId, applet: view.applet };
}
try {
  const link = await start();
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1200, height: 850 } });
  await page.goto(link);
  const password = `Synthetic test account ${randomUUID()}`;
  await page.getByLabel('Email', { exact: true }).fill(process.env.LIVE_CHATGPT_EMAIL);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByLabel('Confirm password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await page.getByRole('heading', { name: 'Made for your everyday.' }).waitFor();
  const state = await api('/api/state');
  assert(
    state.account?.canUsePlan,
    'Saved ChatGPT login is unavailable; reconnect privately before running live tests.',
  );
  const models = (await api('/api/models')).models;
  model = process.env.LIVE_TEST_MODEL || models[0]?.slug;
  assert(
    models.some((item) => item.slug === model),
    'Requested test model is unavailable',
  );
  report.model = model;
  console.log(`Using real ChatGPT model: ${model}`);
  const tasks = await build(
    state.chatSpaceId,
    'Create a test app called Pocket Tasks. Minimal task list: add tasks, mark complete, list tasks. Use local backend actions and meaningful tests. Accessible UI: input labelled Task, button Add task. Use title Pocket Tasks. No integrations, photos, schedules or notifications. No extra preferences needed. Propose the plan.',
  );
  await page.goto(new URL(`/spaces/${tasks.spaceId}/applet`, link).href);
  const frame = page.frameLocator('iframe');
  await frame.getByRole('textbox', { name: 'Task', exact: true }).fill('Walk the dog');
  await frame.getByRole('button', { name: 'Add task', exact: true }).click();
  await frame.getByText('Walk the dog', { exact: true }).waitFor();
  report.checks.push({
    name: 'Generated frontend persists a task through its real backend',
    passed: true,
  });
  await page.screenshot({ path: join(artifacts, 'tasks-desktop.png'), fullPage: true });
  const chat = (await api(`/api/spaces/${tasks.spaceId}/chats`, {})).chat.id;
  const context = { appletId: tasks.applet.id, version: tasks.applet.version, view: null };
  const added = await turn(
    tasks.spaceId,
    chat,
    'Add a task called Buy bread using this app’s backend action. Do not change code.',
    { appContext: context },
  );
  assert(added.tools.some((tool) => tool.name === 'invoke' && tool.status === 'complete'));
  const beforeDebug = (await api(`/api/applets/${tasks.applet.id}/records`)).records;
  assert(JSON.stringify(beforeDebug).includes('Buy bread'));
  const debug = await turn(
    tasks.spaceId,
    chat,
    'Inspect the frontend snapshot and app diagnostics using inspect_frontend and read_app_diagnostics. Then use debug_action to dry-run adding a task called Dry run only. Do not persist anything or change code.',
    { appContext: context },
  );
  for (const name of ['inspect_frontend', 'read_app_diagnostics', 'debug_action'])
    assert(
      debug.tools.some((tool) => tool.name === name && tool.status === 'complete'),
      `Agent did not successfully use ${name}`,
    );
  assert.deepEqual((await api(`/api/applets/${tasks.applet.id}/records`)).records, beforeDebug);
  report.checks.push({
    name: 'Real scoped chat writes and debugging tools work without dry-run commits',
    passed: true,
  });
  await turn(
    tasks.spaceId,
    chat,
    'Update Pocket Tasks to show a total task count with visible text Total tasks: N. Preserve the existing backend actions and all records. This is the only change. Propose the update plan.',
    { appContext: context },
  );
  const updatePlan = (await api(`/api/build-plans?chatId=${chat}`)).plan;
  assert.equal(updatePlan.status, 'pending');
  await turn(tasks.spaceId, chat, 'Build this exact approved update now.', {
    appContext: context,
    buildPlanId: updatePlan.id,
  });
  const updated = (await api(`/api/spaces/${tasks.spaceId}/view`)).applet;
  assert(updated.version > tasks.applet.version);
  assert.deepEqual((await api(`/api/applets/${tasks.applet.id}/records`)).records, beforeDebug);
  await page.goto(new URL(`/spaces/${tasks.spaceId}/applet`, link).href);
  await page.frameLocator('iframe').getByText('Total tasks: 2', { exact: true }).waitFor();
  await page.screenshot({ path: join(artifacts, 'tasks-updated.png'), fullPage: true });
  report.checks.push({
    name: 'Real ChatGPT publishes a scoped update without losing records',
    passed: true,
  });
  const weather = await build(
    state.chatSpaceId,
    'Create a test app called Ljubljana Weather. Use the public Open-Meteo forecast API for fixed latitude 46.05 and longitude 14.51, current temperature_2m, timezone Europe/Ljubljana. No API key. Backend read-only action weather with empty-object input returns {temperatureC:number,observedAt:string}. Declare GET HTTP capability for https://api.open-meteo.com and output schema. Mock success and failure in tests. Frontend displays temperature and a button labelled Refresh weather. The test owner will grant API access after publication. Propose the plan; no further preferences needed.',
  );
  await api(`/api/applets/${weather.applet.id}/permissions`, {
    grants: [{ origin: 'https://api.open-meteo.com', methods: ['GET', 'HEAD'], secrets: [] }],
  });
  const weatherChat = (await api(`/api/spaces/${weather.spaceId}/chats`, {})).chat.id;
  const weatherContext = {
    appletId: weather.applet.id,
    version: weather.applet.version,
    view: null,
  };
  const probe = await turn(
    weather.spaceId,
    weatherChat,
    'Use test_app_connection for the weather action with {} and report whether its real API response is verified. Do not change code or records.',
    { appContext: weatherContext },
  );
  const check = probe.tools.find((tool) => tool.name === 'test_app_connection');
  assert(
    check && check.status === 'complete' && check.output?.verified === true,
    'Real weather connection was not verified',
  );
  assert(
    Number.isFinite(check.output.result.temperatureC),
    'Weather output must contain a real numeric temperature',
  );
  await page.goto(new URL(`/spaces/${weather.spaceId}/applet`, link).href);
  await page
    .frameLocator('iframe')
    .getByRole('button', { name: 'Refresh weather', exact: true })
    .click();
  await expect
    .poll(async () =>
      (await api(`/api/applets/${weather.applet.id}/diagnostics`)).reports.some(
        (row) => row.kind === 'action' && row.data.phase === 'completion' && row.data.ok,
      ),
    )
    .toBe(true);
  await expect(
    page.frameLocator('iframe').getByRole('button', { name: 'Refresh weather', exact: true }),
  ).toBeEnabled();
  await page
    .frameLocator('iframe')
    .getByText(/\d+(?:\.\d+)?\s*°\s*C/)
    .first()
    .waitFor();
  await page.screenshot({ path: join(artifacts, 'weather-desktop.png'), fullPage: true });
  assert.deepEqual((await api(`/api/applets/${weather.applet.id}/records`)).records, []);
  report.checks.push({
    name: 'Real ChatGPT built and verified a live weather integration',
    passed: true,
  });
  report.passed = true;
  console.log('Real ChatGPT and live applet tests passed.');
} catch (error) {
  report.passed = false;
  report.error = String(error.message).slice(0, 4000);
  if (page)
    await page.screenshot({ path: join(artifacts, 'failure.png'), fullPage: true }).catch(() => {});
  process.exitCode = 1;
  console.error(report.error);
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(join(artifacts, 'report.json'), JSON.stringify(report, null, 2));
  await browser?.close();
  if (child && child.exitCode === null) {
    const stopped = new Promise((resolve) => child.once('exit', resolve));
    child.kill();
    await stopped;
  }
  await rm(data, { recursive: true, force: true });
}
