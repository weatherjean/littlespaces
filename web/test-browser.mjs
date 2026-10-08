// Focused development fixture: actual streamed Rust agent/tools/backend/Preact/browser path.
// This does not establish real-model generation or real ChatGPT sign-in.
import { startHarness } from './browser-harness.mjs';
import { chromium } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const root = new URL('../', import.meta.url).pathname;
const token = randomBytes(32).toString('hex');
const harness = await startHarness({ token });
let code = JSON.parse(await readFile(path.join(root, 'examples/tasks-rhai.json'), 'utf8'));
let turn = 0,
  mode = 'build',
  testedRevision;
const provider = http.createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const request = JSON.parse(Buffer.concat(chunks));
    assert.equal(request.store, false);
    assert.equal(request.stream, true);
    assert.equal(request.model, 'fixture');
    if (turn === 0) await new Promise((resolve) => setTimeout(resolve, 3000));
    let output;
    const previous = request.input.filter((v) => v.type === 'function_call_output').at(-1);
    const report = previous ? JSON.parse(previous.output) : null;
    if (mode === 'chat')
      output =
        turn++ === 0
          ? [call('app_info', {})]
          : turn === 2
            ? [call('invoke_action', { action: 'list', input: {} })]
            : [
                {
                  type: 'message',
                  role: 'assistant',
                  content: [{ type: 'output_text', text: 'Listed your tasks.' }],
                },
              ];
    else {
      const actions = [
        () => call('authoring', { tool: 'read_sdk' }),
        () => call('authoring', { tool: 'read_draft' }),
        () =>
          call('authoring', {
            tool: 'edit_draft',
            expected_version: 1,
            code: {
              ...code,
              backend: 'fn add(input) { 42 } fn list(input) { [] } fn complete(input) { [] }',
            },
          }),
        () => call('authoring', { tool: 'test_draft', expected_version: 2 }),
        () => {
          assert.equal(report.ok.backendTestsPassed, false);
          assert.ok(report.ok.diagnostics.length);
          return call('authoring', { tool: 'edit_draft', expected_version: 2, code });
        },
        () => call('authoring', { tool: 'test_draft', expected_version: 3 }),
        () => {
          assert.equal(report.ok.backendTestsPassed, true);
          testedRevision = report.ok.revision;
          return call('authoring', { tool: 'test_frontend', revision: testedRevision });
        },
        () => {
          assert.equal(report.ok.passed, true, JSON.stringify(report));
          assert.ok(report.ok.assertions >= 2);
          assert.ok(report.ok.snapshot.includes('Browser task'));
          return call('authoring', {
            tool: 'publish',
            revision: testedRevision,
            expected_version: 3,
          });
        },
      ];
      if (turn < actions.length) output = [actions[turn++]()];
      else {
        assert.equal(report.ok.published, testedRevision);
        turn++;
        output = [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'The task app is tested and published.' }],
          },
        ];
      }
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(
      `data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output } })}\n\n`,
    );
  } catch (error) {
    console.error(String(error));
    res.writeHead(500).end(String(error));
  }
});
function call(name, args) {
  return {
    type: 'function_call',
    call_id: `fixture-${mode}-${turn}-${Date.now()}`,
    name,
    arguments: JSON.stringify(args),
  };
}
await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
const providerUrl = `http://127.0.0.1:${provider.address().port}`;
const temporary = await mkdtemp(path.join(os.tmpdir(), 'littlespaces-browser-'));
const workspace = path.join(temporary, 'workspace');
let server, browser;
async function child(command, args) {
  await new Promise((resolve, reject) => {
    const p = spawn(command, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let error = '';
    p.stderr.on('data', (b) => (error += b));
    p.on('exit', (code) => (code === 0 ? resolve() : reject(Error(error))));
  });
}
try {
  const binary = path.join(root, 'rust/target/debug/little-spaces');
  await child(binary, ['init', workspace]);
  server = spawn(binary, ['serve', workspace, '0'], {
    cwd: root,
    env: {
      ...process.env,
      LITTLESPACES_BROWSER_HARNESS: harness.url,
      LITTLESPACES_BROWSER_TOKEN: token,
      LITTLESPACES_TEST_PROVIDER: providerUrl,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const address = await new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(Error('Server startup timed out')), 15000);
    server.stdout.on('data', (b) => {
      output += b;
      const match = output.match(/Owner setup: (http:\/\/127\.0\.0\.1:\d+)\/#setup=(\S+)/);
      if (match) {
        clearTimeout(timeout);
        resolve({ origin: match[1], setup: match[2] });
      }
    });
    server.on('exit', () => {
      clearTimeout(timeout);
      reject(Error('Server exited'));
    });
  });
  const { origin, setup } = address;
  browser = await chromium.launch({ headless: true });
  const snapshots = path.join(root, 'build-rust/screenshots');
  await mkdir(snapshots, { recursive: true });
  const signedOut = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const authPage = await signedOut.newPage();
  await authPage.goto(origin);
  await authPage.getByRole('heading', { name: 'Set up LittleSpaces' }).waitFor();
  assert.equal(
    await authPage.locator('body').evaluate((n) => getComputedStyle(n).backgroundColor),
    'rgba(0, 0, 0, 0)',
  );
  assert.equal(
    await authPage.locator('html').evaluate((n) => getComputedStyle(n).backgroundColor),
    'rgb(20, 27, 48)',
  );
  await authPage.screenshot({ path: path.join(snapshots, 'monolith-orbit-setup.png') });

  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  let csrf = '';
  async function api(route, body) {
    const response = await context.request.fetch(`${origin}${route}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : { origin, 'x-csrf-token': csrf },
      data: body,
    });
    const value = await response.json();
    assert.ok(response.ok(), `${route}: ${JSON.stringify(value)}`);
    return value;
  }
  assert.equal((await context.request.get(`${origin}/api/apps`)).status(), 401);
  await api('/api/setup', { token: setup, password: 'synthetic owner password' });
  csrf = (await api('/api/login', { password: 'synthetic owner password' })).csrf;
  await authPage.reload();
  await authPage.getByRole('button', { name: 'Sign in', exact: true }).waitFor();
  await authPage.screenshot({ path: path.join(snapshots, 'monolith-orbit-login.png') });
  await signedOut.close();
  assert.equal(
    (
      await context.request.post(`${origin}/api/apps`, { data: { title: 'CSRF attempt' } })
    ).status(),
    401,
  );
  const creating = await context.newPage();
  await creating.goto(origin);
  await creating.getByRole('button', { name: 'Create your first app', exact: true }).click();
  await creating.getByRole('dialog', { name: 'Create an app', exact: true }).waitFor();
  await creating.getByLabel('App name', { exact: true }).fill('Task app');
  await creating.getByRole('button', { name: 'Create and build', exact: true }).click();
  await creating.waitForURL(/\/chat\//);
  const app = {
    app: (await api('/api/apps')).find((a) => a.title === 'Task app').id,
    conversation: new URL(creating.url()).pathname.slice(6),
  };
  await creating.getByRole('button', { name: 'New chat', exact: true }).click();
  await creating.waitForURL(
    (url) => url.pathname.startsWith('/chat/') && url.pathname.slice(6) !== app.conversation,
  );
  const builds = await api('/api/conversations');
  assert.equal(builds.find((c) => c.id === new URL(creating.url()).pathname.slice(6)).build, true);
  await creating.close();

  async function runAgent(conversation) {
    const { job } = await api(`/api/conversations/${conversation}/send`, {
      message: mode === 'chat' ? 'List my tasks' : 'Create and test the task app',
      model: 'fixture',
    });
    if (conversation === app.conversation && mode === 'build') {
      const live = await context.newPage();
      await live.goto(origin);
      await live.getByRole('link', { name: 'Chat', exact: true }).click();
      await live.getByRole('button', { name: /Choose conversation:/ }).click();
      await live.getByRole('button', { name: 'Create and test the task app', exact: true }).click();
      await live.getByRole('status').filter({ hasText: 'Working…' }).first().waitFor();
      await live.close();
    }
    for (let n = 0; n < 250; n++) {
      await new Promise((r) => setTimeout(r, 100));
      const status = await api(`/api/jobs/${job}`);
      if (status.state === 'completed') return;
      if (['failed', 'cancelled', 'interrupted'].includes(status.state))
        throw Error(JSON.stringify(status));
    }
    throw Error('Agent fixture timed out');
  }
  await runAgent(app.conversation);
  console.log('Fixture author/test/browser/publish passed');
  const detail = await api(`/api/apps/${app.app}`);
  assert.ok(detail.revision);
  assert.deepEqual(detail.records, {});
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(origin);
  await page.getByRole('heading', { name: 'Made for your everyday.' }).waitFor();
  assert.equal(
    await page
      .locator('.app-grid')
      .evaluate((n) => getComputedStyle(n).gridTemplateColumns.split(' ').length),
    5,
  );
  assert.equal(
    await page.locator('.primary-nav').evaluate((n) => getComputedStyle(n).position),
    'fixed',
  );
  await page.screenshot({
    path: path.join(snapshots, 'monolith-orbit-launcher.png'),
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Task app', exact: true }).click();
  const frame = page.frameLocator('iframe[title="Applet"]');
  await frame.getByLabel('Task title').fill('Owner task');
  await frame.getByRole('button', { name: 'Add task' }).click();
  await frame.locator('li').filter({ hasText: 'Owner task' }).waitFor();
  await frame.getByRole('button', { name: 'Complete', exact: true }).click();
  await frame.locator('li').filter({ hasText: 'done' }).waitFor();
  await page.screenshot({ path: path.join(snapshots, 'monolith-orbit-app.png') });
  await page.getByRole('button', { name: 'Chat with app', exact: true }).click();
  await page.getByRole('dialog', { name: 'Task app', exact: true }).waitFor();
  await page.screenshot({ path: path.join(snapshots, 'monolith-orbit-app-chat.png') });
  await page.getByRole('button', { name: 'Chat options', exact: true }).click();
  await page.getByRole('dialog', { name: 'Chat options', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  assert.ok(await page.getByRole('dialog', { name: 'Task app', exact: true }).isVisible());
  await page.getByRole('button', { name: 'Close chat', exact: true }).click();
  await page.getByRole('button', { name: 'More app options' }).click();
  await page.getByRole('button', { name: 'Versions & tests', exact: true }).click();
  await page.getByRole('dialog', { name: 'Versions & tests', exact: true }).waitFor();
  assert.ok(await page.getByText('Automated browser checks passed', { exact: true }).count());
  await page.getByRole('button', { name: 'Close versions' }).click();
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
  await page.screenshot({
    path: path.join(snapshots, 'monolith-orbit-settings.png'),
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Add secret', exact: true }).click();
  await page.getByRole('dialog', { name: 'Add secret', exact: true }).waitFor();
  await page.getByLabel('Name', { exact: true }).fill('SYNTHETIC');
  await page.getByLabel('Value', { exact: true }).fill('synthetic-browser-value');
  await page.getByRole('button', { name: 'Save secret', exact: true }).click();
  await page.getByText('SYNTHETIC', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Delete secret SYNTHETIC' }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('link', { name: 'Apps', exact: true }).click();
  await page.getByRole('heading', { name: 'Made for your everyday.' }).waitFor();
  assert.equal(
    await page
      .locator('.app-grid')
      .evaluate((n) => getComputedStyle(n).gridTemplateColumns.split(' ').length),
    3,
  );
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({
    path: path.join(snapshots, 'monolith-orbit-phone-launcher.png'),
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Task app', exact: true }).click();
  await page.getByRole('button', { name: 'Chat with app', exact: true }).click();
  await page.getByRole('dialog', { name: 'Task app', exact: true }).waitFor();
  await page.screenshot({ path: path.join(snapshots, 'monolith-orbit-phone-chat.png') });
  const dimensions = await page
    .getByRole('dialog', { name: 'Task app', exact: true })
    .boundingBox();
  assert.ok(dimensions.width >= 389 && dimensions.height <= 844);
  await page.evaluate(() => {
    Object.defineProperty(visualViewport, 'height', { value: 470, configurable: true });
    visualViewport.dispatchEvent(new Event('resize'));
  });
  await page.waitForTimeout(50);
  const keyboard = await page.getByRole('dialog', { name: 'Task app', exact: true }).boundingBox();
  assert.ok(keyboard.y + keyboard.height <= 471);
  await page.screenshot({ path: path.join(snapshots, 'monolith-orbit-phone-keyboard.png') });
  await page.getByRole('button', { name: /Choose conversation:/ }).click();
  await page.getByRole('dialog', { name: 'Conversations', exact: true }).waitFor();
  await page.screenshot({ path: path.join(snapshots, 'monolith-orbit-phone-picker.png') });
  await page.keyboard.press('Escape');
  assert.ok(await page.getByRole('dialog', { name: 'Task app', exact: true }).isVisible());
  await page.getByRole('button', { name: 'Close chat', exact: true }).click();
  await page.evaluate(() => {
    delete visualViewport.height;
    visualViewport.dispatchEvent(new Event('resize'));
  });
  console.log(
    'Binding Orbit launcher, full canvas/dock, nested dialogs, settings, mobile keyboard and owner UI actions passed',
  );

  const saved = (await api(`/api/apps/${app.app}`)).records;
  assert.equal(Object.values(saved)[0].done, true);
  console.log('Checking record-preserving update');
  code = { ...code, frontend: code.frontend.replace('<h1>Tasks</h1>', '<h1>Tasks updated</h1>') };
  turn = 0;
  const update = await api(`/api/build/${app.app}`, {});
  await runAgent(update.conversation);
  assert.deepEqual((await api(`/api/apps/${app.app}`)).records, saved);
  mode = 'chat';
  turn = 0;
  const chat = await api('/api/conversations', { app: app.app });
  await runAgent(chat.conversation);
  await page.route('**/api/chatgpt', (route) =>
    route.fulfill({ json: { connected: true, planUsage: true, email: 'synthetic@example.test' } }),
  );
  await page.route('**/api/models', (route) =>
    route.fulfill({ json: [{ slug: 'fixture', display_name: 'Fixture model' }] }),
  );
  await page.goto(`${origin}/chat/${chat.conversation}`);
  await page.getByRole('button', { name: 'Send message', exact: true }).waitFor();
  await page.getByLabel('Message', { exact: true }).fill('List my tasks again');
  mode = 'chat';
  turn = 0;
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Working…' }).waitFor();
  await page.screenshot({ path: path.join(snapshots, 'monolith-orbit-phone-conversation.png') });
  for (let i = 0; i < 150; i++) {
    if (!(await page.getByRole('button', { name: 'Stop reply', exact: true }).count())) break;
    await page.waitForTimeout(100);
  }
  await page.getByLabel('Message', { exact: true }).waitFor();
  const history = await api(`/api/conversations/${chat.conversation}`);
  assert.ok(history.some((m) => m.name === 'invoke_action' && m.result.ok.result.length === 1));
  assert.deepEqual(errors, []);
  const ownerBuild = await api(`/api/build/${app.app}`, {});
  const ownerCode = { ...code, frontend: code.frontend.replace('Tasks updated', 'Owner preview') };
  await api(`/api/authoring/${ownerBuild.conversation}`, {
    tool: 'edit_draft',
    expected_version: 1,
    code: ownerCode,
  });
  const ownerTest = await api(`/api/authoring/${ownerBuild.conversation}`, {
    tool: 'test_draft',
    expected_version: 2,
  });
  assert.equal(ownerTest.backendTestsPassed, true);
  const unverified = await context.request.post(
    `${origin}/api/authoring/${ownerBuild.conversation}`,
    {
      headers: { origin, 'x-csrf-token': csrf },
      data: { tool: 'publish', revision: ownerTest.revision, expected_version: 2 },
    },
  );
  assert.equal(unverified.status(), 409);
  const isolated = await api(`/api/owner-preview/${app.app}/${ownerTest.revision}`, {});
  await page.goto(origin + isolated.url);
  const preview = page.frameLocator('#frame');
  await preview.getByLabel('Task title').fill('Isolated owner preview');
  await preview.getByRole('button', { name: 'Add task' }).click();
  await preview.locator('li').filter({ hasText: 'Isolated owner preview' }).waitFor();
  assert.deepEqual((await api(`/api/apps/${app.app}`)).records, saved);
  await api(`/api/owner-publish/${ownerBuild.conversation}`, {
    confirmed: true,
    revision: ownerTest.revision,
    expected_version: 2,
  });
  assert.deepEqual((await api(`/api/apps/${app.app}`)).records, saved);
  console.log(
    'Rust agent fixture, failure/fix, browser-tested and owner-reviewed publication, real UI/chat invocation and record-preserving updates passed. No real-model milestone claimed.',
  );
} finally {
  await browser?.close();
  if (server) {
    server.kill('SIGINT');
    await new Promise((resolve) => {
      server.once('exit', resolve);
      setTimeout(() => {
        server.kill('SIGKILL');
        resolve();
      }, 3000).unref();
    });
  }
  provider.closeAllConnections();
  await new Promise((resolve) => provider.close(resolve));
  await harness.close();
  await rm(temporary, { recursive: true, force: true });
}
