import { fileURLToPath } from 'node:url';
import { testHistoryAndStorage } from './test-history.mjs';
// Focused development fixture: actual streamed Rust agent/tools/backend/Preact/browser path.
// This does not establish real-model generation or real ChatGPT sign-in.
import { startHarness } from './browser-harness.mjs';
import { testMobileReview } from './test-mobile.mjs';
import { testPwa } from './test-pwa.mjs';
import { testImages } from './test-images.mjs';
import { testReleases } from './test-releases.mjs';
import { testChatLifecycle } from './test-chat.mjs';
import { chromium } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const root = fileURLToPath(new URL('../', import.meta.url));
const token = randomBytes(32).toString('hex');
const harness = await startHarness({ token });
let code = JSON.parse(await readFile(path.join(root, 'examples/tasks-rhai.json'), 'utf8'));
let appForVoice = '';
const brokenAttempts = [];
function verifyRetrySchedule() {
  assert.equal(
    brokenAttempts.length,
    5,
    'initial request, three retries, then explicit continuation',
  );
  for (let i = 1; i <= 3; i++)
    assert.ok(
      brokenAttempts[i] - brokenAttempts[i - 1] >= [0, 9500, 19500, 29500][i],
      'retry waits for its scheduled backoff',
    );
}
let turn = 0,
  mode = 'proposal',
  testedRevision;
const provider = http.createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const request = JSON.parse(Buffer.concat(chunks));
    assert.equal(request.store, false);
    assert.equal(request.stream, true);
    assert.equal(request.model, 'fixture');
    assert.ok(request.tools.some((tool) => tool.type === 'web_search'));
    for (const name of ['read_skill', 'read_sdk', 'fetch_docs']) {
      assert.ok(request.tools.some((tool) => tool.name === name));
    }
    if (turn === 0) await new Promise((resolve) => setTimeout(resolve, 3000));
    let output;
    const previous = request.input.filter((v) => v.type === 'function_call_output').at(-1);
    const report = previous ? JSON.parse(previous.output) : null;
    if (mode === 'capabilities') {
      const steps = [
        () => call('read_skill', { name: 'planning' }),
        () => {
          assert.match(report.ok.instructions, /SQLite/);
          return call('read_sdk', {});
        },
        () => {
          assert.match(report.ok.sdk, /sql_query/);
          return call('read_skill', { name: 'updating' });
        },
        () => {
          assert.match(report.ok.instructions, /propose_update/);
          return call('propose_update', {
            app: appForVoice,
            summary: 'Preserve data and add search',
          });
        },
        () => {
          assert.equal(report.ok.status, 'pending');
          return call('read_skill', { name: 'managing' });
        },
        () => {
          assert.match(report.ok.instructions, /propose_archive/);
          return call('propose_archive', {
            app: appForVoice,
            archived: true,
            summary: 'Archive this app and keep its data',
          });
        },
      ];
      output =
        turn < steps.length
          ? [steps[turn++]()]
          : [
              {
                type: 'web_search_call',
                id: 'ws_fixture',
                status: 'completed',
                action: { type: 'search', query: 'Rhai documentation' },
              },
              {
                type: 'message',
                role: 'assistant',
                content: [
                  {
                    type: 'output_text',
                    text: 'Rhai documentation and app changes are ready for review.',
                    annotations: [
                      {
                        type: 'url_citation',
                        url: 'https://rhai.rs/book/',
                        title: 'Rhai Book',
                        start_index: 0,
                        end_index: 18,
                      },
                    ],
                  },
                ],
              },
            ];
    } else if (mode === 'owner')
      output =
        turn++ === 0
          ? [call('authoring', { tool: 'test_draft', expected_version: 2 })]
          : [
              {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'Review the tested owner preview.' }],
              },
            ];
    else if (mode === 'echo') {
      let message = request.input.filter((v) => v.role === 'user').at(-1).content;
      if (Array.isArray(message)) {
        const images = message.filter((part) => part.type === 'input_image');
        assert.ok(images.length > 0);
        assert.ok(images.every((part) => part.image_url.startsWith('data:image/jpeg;base64,')));
        message = `Received ${images.length} image with actual pixel data`;
      }
      if (message === 'first conversation') assert.equal(request.reasoning?.effort, 'high');
      if (message === 'slow reply') await new Promise((resolve) => setTimeout(resolve, 10000));
      output = [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: `Reply: ${message}` }],
        },
      ];
      turn++;
    } else if (mode === 'voice')
      output =
        turn++ === 0
          ? [
              call('invoke_action', {
                app: appForVoice,
                action: 'add',
                input: { key: 'voice-confirm', title: 'Voice requested task' },
                summary: 'Add Voice requested task',
              }),
            ]
          : [
              {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'Review and confirm the task suggestion.' }],
              },
            ];
    else if (mode === 'proposal')
      output =
        turn++ === 0
          ? [
              {
                type: 'message',
                role: 'assistant',
                content: [
                  { type: 'output_text', text: 'I will prepare a clear plan before building.' },
                ],
              },
              call('propose_app', {
                title: 'Task app',
                emoji: '✅',
                purpose: 'Track tasks and mark them complete.',
              }),
            ]
          : [
              {
                type: 'message',
                role: 'assistant',
                content: [
                  {
                    type: 'output_text',
                    text: 'I suggest Task app. Approve the plan to build it.',
                  },
                ],
              },
            ];
    else if (mode === 'chat')
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
    // Exercise the direct-provider envelope: finalized items arrive separately,
    // while the completion event has no duplicate output payload.
    for (const [output_index, item] of output.entries()) {
      for (const part of item.content || []) {
        if (part.type === 'output_text')
          res.write(
            `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: part.text })}\n\n`,
          );
      }
      res.write(
        `data: ${JSON.stringify({ type: 'response.output_item.done', output_index, item })}\n\n`,
      );
    }
    if (
      mode === 'echo' &&
      request.input.filter((v) => v.role === 'user').at(-1)?.content === 'broken model stream'
    ) {
      brokenAttempts.push(Date.now());
      if (brokenAttempts.length <= 4) {
        res.write(
          `data: ${JSON.stringify({ type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', name: 'read_sdk' } })}\n\n`,
        );
        res.end();
        return;
      }
    }
    res.end(
      `data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [] } })}\n\n`,
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
checks: try {
  const binary = path.join(root, 'rust/target/debug/little-spaces');
  await child(binary, ['init', workspace]);
  server = spawn(binary, ['serve', workspace, '0'], {
    cwd: root,
    env: {
      ...process.env,
      LITTLESPACES_BROWSER_HARNESS: harness.url,
      LITTLESPACES_BROWSER_TOKEN: token,
      LITTLESPACES_TEST_PROVIDER: providerUrl,
      LITTLESPACES_ENABLE_LIVE_TESTS: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (chunk) => console.error('Fixture host:', chunk.toString().trim()));
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
  authPage.on('pageerror', (error) => console.error('Setup page error:', error.message));
  authPage.on('requestfailed', (request) =>
    console.error('Setup request failed:', new URL(request.url()).pathname, request.failure()),
  );
  authPage.on('response', (response) => {
    if (response.status() >= 400)
      console.error('Setup HTTP error:', new URL(response.url()).pathname, response.status());
  });
  await authPage.goto(origin);
  await authPage.getByRole('heading', { name: 'Set up LittleSpaces' }).waitFor();
  assert.equal(
    await authPage.locator('body').evaluate((n) => getComputedStyle(n).backgroundColor),
    'rgb(16, 24, 39)',
  );
  assert.equal(
    await authPage.locator('html').evaluate((n) => getComputedStyle(n).backgroundColor),
    'rgb(16, 24, 39)',
  );
  await authPage.screenshot({ path: path.join(snapshots, 'monolith-orbit-setup.png') });
  for (const width of [320, 390]) {
    await authPage.setViewportSize({ width, height: 600 });
    assert.equal(
      await authPage.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await authPage.screenshot({ path: path.join(snapshots, `review-setup-${width}.png`) });
  }

  await authPage.goto(`${origin}/#setup=${setup}`);
  await authPage.reload();
  await authPage.getByRole('heading', { name: 'Create account', exact: true }).waitFor();
  await authPage.getByLabel('Password', { exact: true }).fill('synthetic owner password');
  await authPage
    .getByLabel('Confirm password', { exact: true })
    .fill('different synthetic password');
  await authPage.getByRole('button', { name: 'Create account', exact: true }).click();
  await authPage.getByRole('alert').filter({ hasText: 'do not match' }).waitFor();
  await authPage.screenshot({ path: path.join(snapshots, 'review-registration-error-390.png') });
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
  if (process.env.LITTLESPACES_BROWSER_SUITE === 'appearance') {
    await testReleases({ api, context, origin, workspace, snapshots });
    const app = (await api('/api/apps')).find((value) => value.title === 'Release fixture').id;
    await testMobileReview({ context, origin, app, api, snapshots });
    await testHistoryAndStorage({ context, origin, api, workspace, snapshots });
    break checks;
  }
  if (process.env.LITTLESPACES_BROWSER_SUITE === 'releases') {
    await testReleases({ api, context, origin, workspace, snapshots });
    break checks;
  }
  if (process.env.LITTLESPACES_BROWSER_SUITE === 'chat') {
    mode = 'echo';
    turn = 1;
    await testChatLifecycle({ context, origin, api, snapshots });
    verifyRetrySchedule();
    break checks;
  }
  if (process.env.LITTLESPACES_BROWSER_SUITE === 'pwa') {
    await testPwa({ context, origin, api });
    break checks;
  }
  await authPage.reload();
  await authPage.getByRole('button', { name: 'Sign in', exact: true }).waitFor();
  await authPage.screenshot({ path: path.join(snapshots, 'monolith-orbit-login.png') });
  for (const width of [320, 390]) {
    await authPage.setViewportSize({ width, height: 600 });
    assert.equal(
      await authPage.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await authPage.screenshot({ path: path.join(snapshots, `review-login-${width}.png`) });
  }

  await signedOut.close();
  assert.equal(
    (
      await context.request.post(`${origin}/api/apps`, { data: { title: 'CSRF attempt' } })
    ).status(),
    401,
  );
  const creating = await context.newPage();
  await creating.route('**/api/chatgpt', (route) =>
    route.fulfill({ json: { connected: true, planUsage: true, email: 'synthetic@example.test' } }),
  );
  await creating.route('**/api/models', (route) =>
    route.fulfill({ json: [{ slug: 'fixture', display_name: 'Fixture model' }] }),
  );
  await creating.goto(origin);
  await creating.getByRole('button', { name: 'Create your first app', exact: true }).click();
  await creating.waitForURL(/\/chat\//);
  assert.equal(await creating.getByLabel('App name', { exact: true }).count(), 0);
  await creating.getByLabel('Message', { exact: true }).fill('Create a task tracker');
  await creating.getByRole('button', { name: 'Send message', exact: true }).click();
  await creating.getByRole('button', { name: 'Build this app', exact: true }).waitFor();
  assert.equal(await creating.locator('.proposal-emoji').innerText(), '✅');
  await creating
    .getByText('I will prepare a clear plan before building.', { exact: true })
    .waitFor();
  await creating.reload();
  await creating
    .getByText('I will prepare a clear plan before building.', { exact: true })
    .waitFor();
  assert.equal(
    await creating
      .getByText('I will prepare a clear plan before building.', { exact: true })
      .count(),
    1,
  );
  await creating.setViewportSize({ width: 320, height: 700 });
  assert.equal(
    await creating.evaluate(() => document.documentElement.scrollWidth > innerWidth),
    false,
  );
  await creating.screenshot({ path: path.join(snapshots, 'review-build-confirmation-320.png') });
  await creating.setViewportSize({ width: 1280, height: 900 });

  for (
    let i = 0;
    i < 100 &&
    !(await creating.getByRole('button', { name: 'Build this app', exact: true }).isEnabled());
    i++
  )
    await creating.waitForTimeout(100);
  assert.equal((await api('/api/apps')).length, 0);
  mode = 'build';
  turn = 0;
  const proposalConversation = new URL(creating.url()).pathname.slice(6);
  await creating.getByRole('button', { name: 'Build this app', exact: true }).click();
  await creating.getByRole('heading', { name: 'Build Task app', exact: true }).waitFor();
  assert.equal(new URL(creating.url()).pathname, `/chat/${proposalConversation}`);
  const app = {
    app: (await api('/api/apps')).find((a) => a.title === 'Task app').id,
    conversation: new URL(creating.url()).pathname.slice(6),
  };
  let firstJob;
  for (let i = 0; i < 100 && !firstJob; i++) {
    firstJob = (await api('/api/conversations')).find((c) => c.id === app.conversation).job;
    if (!firstJob) await creating.waitForTimeout(100);
  }
  assert.ok(firstJob, 'Approved build did not start');
  for (let i = 0; i < 250; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const j = await api(`/api/jobs/${firstJob}`);
    if (j.state === 'completed') break;
    if (j.state === 'failed') throw Error(JSON.stringify(j));
  }
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
      await live.locator('.streaming-message [role="status"]').waitFor();
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
  assert.ok((await api(`/api/apps/${app.app}`)).revision);
  assert.equal((await api('/api/apps')).find((a) => a.id === app.app).emoji, '✅');
  console.log('Fixture author/test/browser/publish passed');
  const detail = await api(`/api/apps/${app.app}`);
  assert.ok(detail.revision);
  assert.deepEqual(detail.records, {});
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => {
    errors.push(String(e));
    console.error('Browser page error:', String(e));
  });
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
  let inFlightActions = 0;
  let maxInFlightActions = 0;
  await page.route('**/api/action', async (route) => {
    inFlightActions++;
    maxInFlightActions = Math.max(maxInFlightActions, inFlightActions);
    const response = await route.fetch();
    // Keep the initial read pending while the owner starts the first write.
    await new Promise((resolve) => setTimeout(resolve, 150));
    inFlightActions--;
    await route.fulfill({ response });
  });
  await page.getByRole('button', { name: 'Task app', exact: true }).click();
  const frame = page.frameLocator('iframe[title="Applet"]');
  await frame.getByLabel('Task title').fill('Owner task');
  await frame.getByRole('button', { name: 'Add task' }).click();
  await frame.locator('li').filter({ hasText: 'Owner task' }).waitFor();
  await frame
    .locator('body')
    .evaluate(() => Promise.all([window.applet.call('list', {}), window.applet.call('list', {})]));
  assert.equal(
    maxInFlightActions,
    1,
    'One iframe must serialize app actions, including initial reads',
  );
  await page.unroute('**/api/action');
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
  await page.locator('.streaming-message [role="status"]').waitFor();
  await page.getByRole('button', { name: 'Stop reply', exact: true }).waitFor();
  await page.screenshot({ path: path.join(snapshots, 'monolith-orbit-phone-conversation.png') });
  for (let i = 0; i < 150; i++) {
    if (!(await page.getByRole('button', { name: 'Stop reply', exact: true }).count())) break;
    await page.waitForTimeout(100);
  }
  await page.getByLabel('Message', { exact: true }).waitFor();
  const history = await api(`/api/conversations/${chat.conversation}`);
  assert.ok(history.some((m) => m.name === 'invoke_action' && m.result.ok.result.length === 1));
  assert.ok(history.some((m) => m.role === 'assistant' && m.content === 'Listed your tasks.'));
  await page.getByText('Listed your tasks.', { exact: true }).last().waitFor();
  assert.equal(await page.locator('.message:not(.streaming-message) p:empty').count(), 0);
  assert.deepEqual(errors, []);
  appForVoice = app.app;
  mode = 'voice';
  turn = 0;
  await page.addInitScript(() => {
    window.SpeechRecognition = class {
      start() {
        setTimeout(() => {
          this.onresult?.({
            results: [[{ transcript: 'Add a task called Voice requested task' }]],
          });
          this.onend?.();
        }, 20);
      }
      stop() {
        this.onend?.();
      }
    };
  });
  await page.goto(`${origin}/voice`);
  await page.getByRole('button', { name: 'Tap to talk', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Tap to talk', exact: true }).click();
  await page
    .getByRole('button', { name: 'Confirm change', exact: true })
    .waitFor()
    .catch(async (error) => {
      console.error(await page.locator('body').innerText());
      console.error('Browser errors:', errors);
      throw error;
    });
  assert.equal((await api(`/api/apps/${app.app}`)).records['voice-confirm'], undefined);
  for (
    let i = 0;
    i < 100 &&
    !(await page.getByRole('button', { name: 'Confirm change', exact: true }).isEnabled());
    i++
  )
    await page.waitForTimeout(100);
  await page.getByRole('button', { name: 'Confirm change', exact: true }).click();
  await page.getByText('Done.', { exact: true }).waitFor();
  assert.equal(
    (await api(`/api/apps/${app.app}`)).records['voice-confirm'].title,
    'Voice requested task',
  );
  const afterVoice = (await api(`/api/apps/${app.app}`)).records;
  await page.screenshot({ path: path.join(snapshots, 'monolith-glass-voice.png') });
  await page.unroute('**/api/models');
  await page.route('**/api/models', (route) =>
    route.fulfill({ status: 400, json: { error: 'limit' } }),
  );
  await page.goto(`${origin}/chat`);
  await page.getByRole('alert').filter({ hasText: 'workspace safety limit' }).waitFor();
  await page
    .getByLabel('Message', { exact: true })
    .fill('Keep my draft after the model-list error');
  assert.equal(
    await page.getByLabel('Message', { exact: true }).inputValue(),
    'Keep my draft after the model-list error',
  );
  await page.getByRole('button', { name: 'Chat options', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Chat options', exact: true })
    .getByRole('alert')
    .waitFor();
  await page.keyboard.press('Escape');
  assert.equal(
    await page.getByLabel('Message', { exact: true }).inputValue(),
    'Keep my draft after the model-list error',
  );
  await page.unroute('**/api/models');
  await page.route('**/api/models', (route) =>
    route.fulfill({ json: [{ slug: 'fixture', display_name: 'Fixture model' }] }),
  );
  const ownerBuild = await api(`/api/build/${app.app}`, {});
  const ownerCode = { ...code, frontend: code.frontend.replace('Tasks updated', 'Owner preview') };
  await api(`/api/authoring/${ownerBuild.conversation}`, {
    tool: 'edit_draft',
    expected_version: 1,
    code: ownerCode,
  });
  mode = 'owner';
  turn = 0;
  await runAgent(ownerBuild.conversation);
  const ownerTest = (await api(`/api/conversations/${ownerBuild.conversation}`)).find(
    (m) => m.result?.ok?.backendTestsPassed,
  )?.result.ok;
  assert.equal(ownerTest.backendTestsPassed, true);
  const unverified = await context.request.post(
    `${origin}/api/authoring/${ownerBuild.conversation}`,
    {
      headers: { origin, 'x-csrf-token': csrf },
      data: { tool: 'publish', revision: ownerTest.revision, expected_version: 2 },
    },
  );
  assert.equal(unverified.status(), 409);
  await page.goto(`${origin}/chat/${ownerBuild.conversation}`);
  await page.getByRole('button', { name: 'Preview app', exact: true }).click();
  await page.getByRole('button', { name: 'Use this app', exact: true }).waitFor();
  const preview = page.frameLocator('iframe[title="Applet"]');
  assert.equal(
    await page.locator('iframe[title="Applet"]').getAttribute('sandbox'),
    'allow-scripts allow-forms',
  );
  await preview.getByLabel('Task title').fill('Isolated owner preview');
  await preview.getByRole('button', { name: 'Add task' }).click();
  await preview.locator('li').filter({ hasText: 'Isolated owner preview' }).waitFor();
  await page.getByRole('button', { name: 'Reload preview', exact: true }).click();
  await preview.locator('li').filter({ hasText: 'Isolated owner preview' }).waitFor();
  assert.deepEqual((await api(`/api/apps/${app.app}`)).records, afterVoice);
  await page.screenshot({ path: path.join(snapshots, 'monolith-glass-owner-preview.png') });
  await page.getByRole('button', { name: 'Use this app', exact: true }).click();
  await page
    .getByRole('button', { name: 'Use this app', exact: true })
    .waitFor({ state: 'hidden' });
  await preview.locator('li').filter({ hasText: 'Owner task' }).waitFor();
  assert.equal(
    await preview.locator('li').filter({ hasText: 'Isolated owner preview' }).count(),
    0,
  );
  assert.deepEqual((await api(`/api/apps/${app.app}`)).records, afterVoice);
  mode = 'capabilities';
  turn = 0;
  appForVoice = app.app;
  const research = await api('/api/conversations', {});
  await runAgent(research.conversation);
  await page.goto(`${origin}/chat/${research.conversation}`);
  await page.getByRole('link', { name: 'Source 1', exact: true }).waitFor();
  assert.equal(
    await page.getByRole('link', { name: 'Source 1', exact: true }).getAttribute('href'),
    'https://rhai.rs/book/',
  );
  await page.getByRole('button', { name: 'Archive app', exact: true }).click();
  await page.getByRole('button', { name: 'Archive app', exact: true }).waitFor({ state: 'hidden' });
  assert.equal((await api('/api/apps')).find((item) => item.id === app.app).archived, true);
  assert.deepEqual((await api(`/api/apps/${app.app}`)).records, afterVoice);
  await api(`/api/apps/${app.app}/archive`, { archived: false });
  const proposals = await api(`/api/conversations/${research.conversation}/proposals`);
  const updateProposal = proposals.find((p) => p.details.kind === 'update');
  const updateResult = await api(
    `/api/conversations/${research.conversation}/proposals/${updateProposal.id}`,
    { confirm: true },
  );
  const updateDraft = await api(`/api/authoring/${updateResult.conversation}`, {
    tool: 'read_draft',
  });
  assert.equal(updateDraft.code.backend, ownerCode.backend);
  assert.deepEqual((await api(`/api/apps/${app.app}`)).records, afterVoice);
  mode = 'echo';
  turn = 1;
  await testChatLifecycle({ context, origin, api, snapshots });
  await testReleases({ api, context, origin, workspace, snapshots });
  verifyRetrySchedule();
  await testImages({ context, origin, api, snapshots, app: app.app });
  await testPwa({ context, origin, api });
  await testMobileReview({ context, origin, app: app.app, api, snapshots });
  await testHistoryAndStorage({ context, origin, api, workspace, snapshots });
  const sharedSettings = await context.newPage();
  for (const connected of [true, false]) {
    await sharedSettings.unroute('**/api/chatgpt');
    await sharedSettings.route('**/api/chatgpt', (route) =>
      route.fulfill({ json: { connected, planUsage: true, managementOrigin: origin } }),
    );
    await sharedSettings.goto(`${origin}/settings`);
    const manage = sharedSettings.getByRole('link', { name: 'Manage in main workspace' });
    await manage.waitFor();
    assert.equal(await manage.getAttribute('href'), `${origin}/settings`);
    assert.equal(await sharedSettings.getByRole('button', { name: 'Disconnect' }).count(), 0);
    assert.equal(
      await sharedSettings.getByRole('button', { name: 'Continue with ChatGPT' }).count(),
      0,
    );
  }
  await sharedSettings.close();
  assert.deepEqual(errors, []);
  console.log(
    'Rust agent fixture, failure/fix, browser-tested and owner-reviewed publication, real UI/chat invocation and record-preserving updates passed. No real-model milestone claimed.',
  );
} catch (error) {
  // This driver owns only synthetic accounts. Preserve useful failure evidence
  // before disposing of its browser and temporary workspace.
  const snapshots = path.join(root, 'build-rust/screenshots');
  await mkdir(snapshots, { recursive: true });
  for (const [index, page] of (browser?.contexts().flatMap((c) => c.pages()) || []).entries()) {
    try {
      console.error('Failed fixture page:', index, new URL(page.url()).pathname);
      console.error((await page.locator('body').innerText()).slice(0, 4000));
      await page.screenshot({ path: path.join(snapshots, `failure-${index}.png`) });
    } catch (diagnosticError) {
      console.error('Could not capture fixture page:', String(diagnosticError));
    }
  }
  throw error;
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
