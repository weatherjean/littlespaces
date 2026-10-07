#!/usr/bin/env node
import readline from 'node:readline';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const journal = readFileSync(join(root, 'web/applets/journal.js'), 'utf8');
const backend = readFileSync(join(root, 'rust/src/journal.js'), 'utf8');
const marker = join(process.env.CODEX_HOME, 'fixture-connected');
let connected = existsSync(marker),
  sequence = 0;
const threads = new Map(),
  pending = new Map();
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const event = (method, thread, params) => send({ method, params: { threadId: thread, ...params } });
function done(id, message) {
  event('item/completed', id, {
    item: {
      type: 'agentMessage',
      phase: 'final_answer',
      text: threads.get(id)?.instructions.includes('Always format your FINAL reply as ONLY JSON')
        ? JSON.stringify({ message })
        : message,
    },
  });
  event('turn/completed', id, { turn: { id: 'turn-' + id, status: 'completed' } });
}
function call(id, name, args, next) {
  const request = ++sequence;
  pending.set(request, { next, thread: id });
  send({
    id: request,
    method: 'item/tool/call',
    params: {
      threadId: id,
      namespace: 'app',
      tool: name,
      arguments: args,
      callId: 'call-' + request,
    },
  });
}
async function run(id, input) {
  const thread = threads.get(id);
  const last = [...input].reverse().find((part) => part.type === 'text')?.text || '';
  if (thread.instructions.startsWith('Identify the plant in these photos')) {
    done(
      id,
      JSON.stringify({
        identified: true,
        name: 'Monstera',
        scientificName: 'Monstera deliciosa',
        confidence: 'medium',
        explanation: 'Tentative fixture identification.',
        alternatives: [],
        needsAnotherPhoto: false,
        intervalDays: 7,
        wateringAdvice: 'Check the soil before watering.',
      }),
    );
    return;
  }
  if (thread.instructions.includes('This is scheduled read-only work.')) {
    call(id, 'list_records', {}, () => done(id, 'Scheduled check completed.'));
    return;
  }
  if (thread.instructions.includes('The owner approved this exact build plan.')) {
    call(id, 'load_skill', { name: 'build' }, () =>
      call(id, 'read_build_example', { name: 'journal' }, () =>
        call(id, 'read_draft', {}, (draft) =>
          call(
            id,
            'write_draft',
            {
              revision: draft.revision,
              title: 'Little Journal',
              description: 'A place for your ideas',
              source: journal,
              backend,
              chatInstructions: 'Preserve journal records and use list/add actions.',
            },
            (draft) =>
              call(id, 'test_draft', { revision: draft.revision }, (tested) =>
                call(id, 'publish_draft', { revision: tested.revision }, () =>
                  done(id, 'Your app is ready.'),
                ),
              ),
          ),
        ),
      ),
    );
    return;
  }
  if (
    thread.instructions.includes('Voice can read app data and propose exact writes') &&
    /add|save/i.test(last)
  ) {
    call(id, 'list_apps', {}, (apps) =>
      call(
        id,
        'propose_app_action',
        {
          spaceId: apps[0].id,
          action: 'add',
          inputJSON: JSON.stringify({ text: 'A confirmed voice idea' }),
          summary: 'Save a new journal entry: A confirmed voice idea.',
        },
        () => done(id, 'Confirm the suggestion to save your journal entry.'),
      ),
    );
    return;
  }
  if (
    /build|make|create/i.test(last) &&
    thread.tools[0]?.tools.some((tool) => tool.name === 'propose_build')
  ) {
    call(
      id,
      'propose_build',
      {
        title: 'Little Journal',
        emoji: '🌱',
        summary: 'Create a personal journal with saved entries.',
        features: ['Save journal entries', 'Read your journal'],
        caveats: [],
      },
      () => done(id, 'Here is a plan for your journal.'),
    );
    return;
  }
  if (/add|save/i.test(last) && thread.tools[0]?.tools.some((tool) => tool.name === 'invoke')) {
    call(
      id,
      'invoke',
      { action: 'add', inputJSON: JSON.stringify({ text: 'An idea added through chat' }) },
      () => done(id, 'Saved your journal entry.'),
    );
    return;
  }
  done(id, 'A reply from the test ChatGPT connection.');
}
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const value = JSON.parse(line);
  if (!value.method) {
    const pendingCall = pending.get(value.id);
    pending.delete(value.id);
    if (pendingCall) {
      const content = value.result?.contentItems?.find((item) => item.type === 'inputText')?.text;
      const output = content ? JSON.parse(content) : {};
      if (output.error) done(pendingCall.thread, `Tool failed: ${output.error}`);
      else pendingCall.next(output);
    }
    return;
  }
  let result = {};
  switch (value.method) {
    case 'account/read':
      result = { account: connected ? { type: 'chatgpt', email: 'test@example.com' } : null };
      break;
    case 'account/login/start':
      connected = true;
      writeFileSync(marker, 'connected');
      result = {
        type: 'chatgptDeviceCode',
        loginId: 'fixture-login',
        verificationUrl: 'https://auth.openai.com/activate',
        userCode: 'TEST-CODE',
      };
      break;
    case 'account/logout':
      connected = false;
      break;
    case 'model/list':
      result = {
        data: [
          {
            model: 'fixture-model',
            displayName: 'Test ChatGPT',
            hidden: false,
            supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }],
          },
        ],
        nextCursor: null,
      };
      break;
    case 'thread/start': {
      const id = 'thread-' + ++sequence;
      threads.set(id, {
        instructions: value.params.baseInstructions,
        tools: value.params.dynamicTools,
      });
      result = { thread: { id } };
      break;
    }
    case 'turn/start': {
      const id = value.params.threadId;
      result = { turn: { id: 'turn-' + id } };
      setTimeout(() => run(id, value.params.input), 30);
      break;
    }
    case 'turn/interrupt':
      event('turn/completed', value.params.threadId, {
        turn: { id: value.params.turnId, status: 'interrupted' },
      });
      break;
  }
  if (value.id !== undefined) send({ id: value.id, result });
});
