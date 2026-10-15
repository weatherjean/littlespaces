// Real-model, API-driven product evaluation. No browser controls or private auth exports.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
if (!process.argv.includes('--real')) throw Error('Pass --real to authorize model usage.');
const root = 'http://127.0.0.1:5175';
const key = (await readFile('.data-monolith-rework/testing.key', 'utf8')).trim();
async function management(route, body) {
  const res = await fetch(root + route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = await res.json();
  if (!res.ok) throw Error(`${route}: ${value.error}`);
  return value;
}
const run = await management('/api/test-runs', { allowRealModel: true });
const directory = path.join('build-rust', 'evaluations', run.id);
await mkdir(directory, { recursive: true, mode: 0o700 });
const report = {
  run: run.id,
  isolated: true,
  startedAt: new Date().toISOString(),
  apps: [],
  passed: false,
};
async function save() {
  await writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2), {
    mode: 0o600,
  });
}
async function api(route, body) {
  const res = await fetch(run.origin + route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      cookie: `little_session=${run.cookie}`,
      origin: run.origin,
      'x-csrf-token': run.csrf,
      'content-type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = await res.json();
  if (!res.ok) throw Error(`${route}: ${value.error}`);
  return value;
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let model;
async function turn(entry, conversation, phase, prompt) {
  const started = Date.now();
  const { job } = await api(`/api/conversations/${conversation}/send`, { message: prompt, model });
  const evidence = { phase, conversation, job, prompt, startedAt: new Date(started).toISOString() };
  entry.turns.push(evidence);
  await save();
  console.log(`${entry.name}: ${phase}`);
  let state,
    lastProgress = '';
  const end = started + 20 * 60 * 1000;
  while (Date.now() < end) {
    state = await api(`/api/jobs/${job}`);
    const progress = `${state.state}/${state.payload.phase}/${state.payload.activeTool || ''}/${state.payload.requestAttempt || 0}`;
    if (progress !== lastProgress) {
      console.log(`  ${progress}`);
      lastProgress = progress;
    }
    if (!['queued', 'running'].includes(state.state)) break;
    await delay(1500);
  }
  evidence.elapsedMs = Date.now() - started;
  evidence.jobState = state;
  evidence.messages = await api(`/api/conversations/${conversation}`);
  const lastUser = evidence.messages.findLastIndex((m) => m.role === 'user');
  evidence.answer = evidence.messages
    .slice(lastUser + 1)
    .filter((m) => m.role === 'assistant' && !m.incomplete)
    .map((m) => m.content)
    .join('\n');
  await save();
  assert.equal(
    state.state,
    'completed',
    `${phase} ended ${state.state}: ${state.payload.error || 'deadline'}`,
  );
  return evidence;
}
function verifyAnswer(answer, scenario) {
  const start = answer.indexOf('{'),
    end = answer.lastIndexOf('}');
  assert.ok(start >= 0 && end > start, 'Expected structured factual answer');
  assert.deepEqual(JSON.parse(answer.slice(start, end + 1)), scenario.expectedAnswer);
}
const scenarios = [
  {
    name: 'Pocket Tasks',
    purpose:
      'Build a tiny task checklist named Pocket Tasks with a fitting emoji. Add tasks, mark them complete, and list open or all tasks. Store records with title and done fields. Provide read-only list/summary actions so app chat can answer what is pending. Keep the UI simple and accessible, include backend and browser tests, and publish automatically. No sample data in the live app, no integrations, schedules, or SQL. Please propose this app now; use these requirements without further questions.',
    use: 'Add tasks named Buy oats and Call plumber. Mark Buy oats complete. Leave Call plumber open. Do this now using the app actions.',
    query:
      'Read the stored tasks and return JSON with open_count, done_count, open_titles and done_titles. Do not change anything.',
    verify: (data) => {
      const values = Object.values(data.records);
      assert.ok(values.some((v) => v.title === 'Buy oats' && v.done === true));
      assert.ok(values.some((v) => v.title === 'Call plumber' && v.done === false));
    },
    answer: ['Buy oats', 'Call plumber'],
    expectedAnswer: {
      open_count: 1,
      done_count: 1,
      open_titles: ['Call plumber'],
      done_titles: ['Buy oats'],
    },
  },
  {
    name: 'Reading Shelf',
    purpose:
      'Build a tiny reading list named Reading Shelf with a fitting emoji. Each book has title, pages (positive integer), and read (boolean). Let me add books, mark a book read, and see my unread books and their total pages. Use normal records and read-only query actions for app chat. Build an accessible small UI, backend and browser tests, and publish automatically. Start with no live books. No integrations, schedules, or SQL. Please propose this app now without further questions.',
    use: 'Add The Hobbit with 310 pages and Dune with 412 pages. Mark The Hobbit as read and leave Dune unread. Use the app actions to save these changes.',
    query:
      'Read the actual saved books and return JSON with unread_titles and unread_pages. Do not change anything.',
    verify: (data) => {
      const values = Object.values(data.records);
      assert.ok(values.some((v) => v.title === 'The Hobbit' && v.pages === 310 && v.read === true));
      assert.ok(values.some((v) => v.title === 'Dune' && v.pages === 412 && v.read === false));
    },
    answer: ['Dune', '412'],
    expectedAnswer: { unread_titles: ['Dune'], unread_pages: 412 },
  },
  {
    name: 'Link Finder',
    purpose:
      'Build a tiny searchable bookmark app named Link Finder with a fitting emoji. Save bookmarks with title, url, and notes, and search the notes with SQLite FTS5. Use a bookmarks table with columns id TEXT PRIMARY KEY, title TEXT, url TEXT, notes TEXT; an FTS table can index it. Include an idempotent initialize action, add/list/search actions, and a read-only search action for app chat. Initialize the live schema on release, but do not seed live bookmarks. Simple accessible UI, backend tests and browser tests. Publish automatically. No external requests or schedules. Please propose the app now without further questions.',
    use: 'Save two bookmarks: title SQLite Search, URL https://www.sqlite.org/fts5.html, notes Full text indexes for notes; and title Rhai Guide, URL https://www.rhai.rs/book/, notes Embedded scripting reference. Use the app actions.',
    query:
      'Search saved bookmarks for indexes and return JSON with title and url for the match. Do not change anything.',
    sql: 'SELECT title,url,notes FROM bookmarks ORDER BY title',
    expected: [
      {
        title: 'Rhai Guide',
        url: 'https://www.rhai.rs/book/',
        notes: 'Embedded scripting reference',
      },
      {
        title: 'SQLite Search',
        url: 'https://www.sqlite.org/fts5.html',
        notes: 'Full text indexes for notes',
      },
    ],
    answer: ['SQLite Search', 'https://www.sqlite.org/fts5.html'],
    expectedAnswer: { title: 'SQLite Search', url: 'https://www.sqlite.org/fts5.html' },
  },
];
try {
  const models = await api('/api/models');
  model = models.find((m) => /gpt-6.1.*sol/.test(m.slug))?.slug || models[0]?.slug;
  assert.ok(model);
  report.model = model;
  for (const scenario of scenarios) {
    const entry = { name: scenario.name, turns: [], passed: false };
    report.apps.push(entry);
    try {
      let { conversation } = await api('/api/conversations', {});
      await turn(entry, conversation, 'plan', scenario.purpose);
      const proposals = await api(`/api/conversations/${conversation}/proposals`);
      const proposal = proposals.find((p) => p.state === 'pending' && p.details.kind === 'app');
      assert.ok(proposal, 'Expected app proposal');
      entry.proposal = proposal;
      const approved = await api(`/api/conversations/${conversation}/proposals/${proposal.id}`, {
        confirm: true,
      });
      entry.app = approved.app;
      conversation = approved.conversation;
      await turn(
        entry,
        conversation,
        'build',
        `Build and publish the approved ${scenario.name} app now, following the requirements already in this conversation. This approval is complete; implement the app rather than proposing it again. Start with empty live data.`,
      );
      entry.releases = await api(`/api/apps/${entry.app}/releases`);
      assert.ok(entry.releases.length, 'App was published');
      const apps = await api('/api/apps');
      entry.identity = apps.find((a) => a.id === entry.app);
      assert.ok(entry.identity.emoji, 'App has an emoji');
      const chat = (await api('/api/conversations', { app: entry.app })).conversation;
      await turn(entry, chat, 'use', scenario.use);
      const data = await api(`/api/apps/${entry.app}`);
      if (scenario.verify) scenario.verify(data);
      if (scenario.sql)
        assert.deepEqual(
          await api(`/api/apps/${entry.app}/data/query`, {
            query: { sql: scenario.sql, params: [] },
          }),
          scenario.expected,
        );
      entry.liveDataVerified = true;
      const before = await api(`/api/apps/${entry.app}/data/query`, {});
      const answer = await turn(entry, chat, 'retrieve', scenario.query);
      for (const text of scenario.answer)
        assert.ok(answer.answer.includes(text), `Answer must contain ${text}`);
      verifyAnswer(answer.answer, scenario);
      const after = await api(`/api/apps/${entry.app}/data/query`, {});
      assert.deepEqual(after, before, 'Read-only question must not change data');
      entry.readOnlyVerified = true;
      // A new conversation cannot answer correctly by repeating its earlier write instructions.
      const fresh = (await api('/api/conversations', { app: entry.app })).conversation;
      const recall = await turn(entry, fresh, 'fresh-chat-retrieval', scenario.query);
      for (const text of scenario.answer)
        assert.ok(recall.answer.includes(text), `Fresh chat answer must contain ${text}`);
      verifyAnswer(recall.answer, scenario);
      assert.deepEqual(await api(`/api/apps/${entry.app}/data/query`, {}), before);
      entry.passed = true;
    } catch (error) {
      entry.error = String(error);
      console.error(`${entry.name}: ${error}`);
    }
    await save();
    await writeFile(
      path.join(directory, 'debug.json'),
      JSON.stringify(await management(`/api/test-runs/${run.id}/report`), null, 2),
      { mode: 0o600 },
    );
  }
  const debug = await management(`/api/test-runs/${run.id}/report`);
  for (const entry of report.apps) {
    const jobs = new Set(entry.turns.map((t) => t.job));
    const calls = debug.calls.filter((c) => jobs.has(c.job));
    entry.metrics = {
      elapsedMs: entry.turns.reduce((s, t) => s + (t.elapsedMs || 0), 0),
      toolCalls: calls.length,
      failedTools: calls
        .filter(
          (c) =>
            c.result?.error ||
            c.result?.ok?.error ||
            c.result?.ok?.backendTestsPassed === false ||
            c.result?.ok?.passed === false,
        )
        .map((c) => ({
          tool: c.input?.arguments?.tool || c.input?.name,
          error: c.result?.error || c.result?.ok?.error || 'checks_failed',
        })),
      namingCalls: calls.filter((c) => c.input?.arguments?.tool === 'name_app').length,
      fullEdits: calls.filter((c) => c.input?.arguments?.tool === 'edit_draft').length,
      patches: calls.filter((c) => c.input?.arguments?.tool === 'patch_draft').length,
      providerErrors: debug.requests.filter((r) => jobs.has(r.job) && r.details.error).length,
    };
    const app = debug.apps.find((a) => a.id === entry.app);
    entry.browserVerified = debug.browserChecks.some(
      (c) => c.revision === app?.revision && c.report.passed,
    );
    if (!entry.browserVerified) {
      entry.passed = false;
      entry.error ||= 'No automated browser evidence for published revision';
    }
  }
  report.passed = report.apps.length === 3 && report.apps.every((a) => a.passed);
  await writeFile(path.join(directory, 'debug.json'), JSON.stringify(debug, null, 2), {
    mode: 0o600,
  });
} catch (error) {
  report.error = String(error);
  console.error(report.error);
} finally {
  report.finishedAt = new Date().toISOString();
  await save();
  try {
    await management(`/api/test-runs/${run.id}/stop`, {});
  } catch (error) {
    report.cleanupError = String(error);
    await save();
  }
  console.log(`Report: ${directory}/report.json`);
  console.log(`Passed: ${report.apps.filter((a) => a.passed).length}/3`);
  if (!report.passed) process.exitCode = 1;
}
