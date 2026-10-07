import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { devClient } from './dev-client.mjs';

const client = devClient();
const command = process.argv[2] || 'status';
if (command === 'status') {
  console.log(JSON.stringify(await client.json('/api/models'), null, 2));
} else if (command === 'request') {
  const data = process.argv[4] === undefined ? undefined : JSON.parse(process.argv[4]);
  console.log(await (await client.request(process.argv[3], data)).text());
} else if (command === 'build') {
  const model = process.argv[3];
  if (!model) throw Error('Choose a model from npm run dev:eval -- status.');
  const suite = process.argv[4] || 'basic';
  const basicCases = [
    {
      name: 'Reading tracker',
      emoji: '📚',
      prompt:
        'Build a reading tracker. I explicitly want a form-first workflow: add books with title and author, track want-to-read/reading/finished status, rate finished books 1–5, search and filter, and delete books. Persist through refresh. No external services or sample records. Include helpful empty states and a responsive polished UI.',
    },
    {
      name: 'Expense tracker',
      emoji: '💸',
      prompt:
        'Build an expense tracker in EUR. I explicitly want a form-first workflow: add expenses with description, positive decimal amount, category and date; show monthly total and category totals; filter by month; delete expenses. Persist through refresh. Reject invalid amounts and dates. No external services or sample records. Include helpful empty states and a responsive polished UI.',
    },
    {
      name: 'Habit tracker',
      emoji: '✅',
      prompt:
        'Build a daily habit tracker. I explicitly want a form-first workflow: create and delete named habits, check or uncheck completion for today, show progress for today and the last 7 days. Store dates as local YYYY-MM-DD calendar dates. Persist through refresh. Reject blank habit names and invalid dates. No external services or sample records. Include helpful empty states and a responsive polished UI.',
    },
  ];
  const extendedCases = [
    {
      name: 'Recipe scaler',
      prompt:
        'Build a recipe notebook and serving scaler. I explicitly want a form-first workflow: create recipes with a name, positive base servings, instructions, and ingredient rows with name, positive decimal quantity and unit; select a recipe and scale ingredient quantities to a positive target serving count without altering the saved base recipe; search recipes; delete recipes with confirmation. Persist saved recipes through refresh. Reject blank names and non-positive or invalid numbers. No external services or sample records. Choose an appropriate visual style, colors and web-safe fonts yourself, with useful empty states and responsive layout.',
    },
    {
      name: 'Project board',
      prompt:
        'Build a personal project task board. I explicitly want a form-first workflow: add tasks with title, optional notes, priority (low/medium/high), optional real calendar due date, and status (todo/doing/done); edit tasks and move them between statuses using buttons or selects (no drag-and-drop dependency); search titles/notes and filter by priority; show status counts; delete tasks with confirmation. Persist through refresh. Reject blank titles and invalid calendar dates. No external services or sample records. Choose an appropriate visual style, colors and web-safe fonts yourself, with useful empty states and responsive layout.',
    },
    {
      name: 'Trip packing checklist',
      prompt:
        'Build a packing checklist for one trip. I explicitly want a form-first workflow: save a trip name and optional real calendar departure date; add packing items with name, category and positive integer quantity; check/uncheck packed items; filter all/packed/unpacked and group items by category; show packed/total item progress; edit item details and delete items with confirmation. Persist the trip and items through refresh. Reject blank names, invalid dates and non-positive/fractional quantities. No external services or sample records. Choose an appropriate visual style, colors and web-safe fonts yourself, with useful empty states and responsive layout.',
    },
  ];
  if (!['basic', 'extended'].includes(suite)) throw Error('Choose basic or extended suite.');
  const cases = suite === 'extended' ? extendedCases : basicCases;
  const directory = join(
    '.data/dev-instance/evaluations',
    new Date().toISOString().replaceAll(':', '-'),
  );
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const builderSource = readFileSync('src/lib/server/build-skill.ts', 'utf8');
  writeFileSync(join(directory, 'builder-source.txt'), builderSource, { mode: 0o600 });
  writeFileSync(
    join(directory, 'metadata.json'),
    JSON.stringify(
      {
        model,
        suite,
        builderHash: createHash('sha256').update(builderSource).digest('hex'),
        startedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  console.log(`Evaluation directory: ${directory}`);
  const results = [];
  async function turn(input, file) {
    const response = await client.request('/api/chat', input);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let stream = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      stream += decoder.decode(value, { stream: true });
    }
    stream += decoder.decode();
    writeFileSync(join(directory, file), stream, { mode: 0o600 });
    if (/event: error\n/.test(stream)) throw Error(stream.slice(-2000));
    if (!/event: done\n/.test(stream)) throw Error('Turn did not finish.');
    return stream;
  }
  for (const item of cases) {
    const started = Date.now();
    const result = { name: item.name, model, suite, prompt: item.prompt };
    try {
      console.log(`Requesting ${item.name}…`);
      const { space } = await client.json('/api/spaces', {
        name: `Eval: ${item.name}`,
        icon: 'grid',
      });
      const { chat } = await client.json(`/api/spaces/${space.id}/chats`, {});
      Object.assign(result, { spaceId: space.id, chatId: chat.id });
      const input = { spaceId: space.id, chatId: chat.id, model, message: item.prompt };
      await turn(input, `${space.id}-proposal.sse`);
      const { plan } = await client.json(`/api/build-plans?spaceId=${space.id}&chatId=${chat.id}`);
      if (!plan || plan.status !== 'pending') throw Error('Model did not propose a build plan.');
      writeFileSync(join(directory, `${space.id}-plan.json`), JSON.stringify(plan, null, 2), {
        mode: 0o600,
      });
      console.log(`Building ${plan.title}: ${plan.features.join('; ')}…`);
      const buildStream = await turn(
        { ...input, message: 'Build the approved plan.', buildPlanId: plan.id },
        `${space.id}-build.sse`,
      );
      const checks = buildStream.split('\n\n').flatMap((block) => {
        if (!block.startsWith('event: tool\n')) return [];
        const call = JSON.parse(block.slice(block.indexOf('data: ') + 6));
        if (call.name.replace(/^app\./, '') !== 'test_draft' || call.status === 'running')
          return [];
        return [
          {
            status: call.status,
            durationMs: call.durationMs,
            error: call.output?.error,
            coverage: call.output?.coverage,
          },
        ];
      });
      result.builderChecks = checks;
      const completed = (
        await client.json(`/api/build-plans?spaceId=${space.id}&chatId=${chat.id}`)
      ).plan;
      if (completed.status !== 'complete' || !completed.publishedId)
        throw Error('App was not published.');
      Object.assign(result, {
        appletId: completed.publishedId,
        status: 'published',
        url: `${client.origin}/spaces/${space.id}/applet`,
      });
      const versions = (await client.json(`/api/applets/${completed.publishedId}`)).versions;
      result.tests = JSON.parse(versions[0].testReport || '[]');
      result.actions = (await client.json(`/api/applets/${completed.publishedId}/actions`)).actions;
      console.log(`Published ${item.name}: ${result.url}`);
    } catch (error) {
      Object.assign(result, { status: 'failed', error: error.message });
      console.log(`${item.name} failed: ${error.message}`);
    }
    result.durationMs = Date.now() - started;
    results.push(result);
    writeFileSync(join(directory, 'results.json'), JSON.stringify(results, null, 2), {
      mode: 0o600,
    });
  }
  console.log(`Results: ${directory}/results.json`);
  if (results.some((result) => result.status === 'failed')) process.exitCode = 1;
} else throw Error('Use status, request <api-path> [json], or build <model>.');
