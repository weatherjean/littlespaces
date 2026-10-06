import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const directory = mkdtempSync(join(tmpdir(), 'little-codex-test-'));
process.env.APP_DATA_DIR = directory;
const { ownerStore } = await import('../src/lib/server/owner');
ownerStore().configure('test@example.com', 'test-only-owner-password');
const provider = await import('../src/lib/server/codex');
const rpc = await provider.codex();
// Verify the real runtime starts isolated and signed out before mocking its wire API.
assert.equal((await rpc.request('account/read', { refreshToken: false })).account, null);
let email = 'test@example.com';
let lastThread: any;
let lastTurn: any;
let loggedOut = false;
let mode = 'success';
const replies: any[] = [];
const notify = (method: string, params: any) => {
  for (const listener of rpc.listeners) listener({ method, params });
};
const request = rpc.request.bind(rpc);
const send = rpc.send.bind(rpc);
rpc.send = (message) => {
  replies.push(message);
};
rpc.request = async (method, params: any) => {
  if (method === 'account/read') return { account: loggedOut ? null : { type: 'chatgpt', email } };
  if (method === 'account/login/start')
    return {
      type: 'chatgptDeviceCode',
      loginId: 'login-test',
      verificationUrl: 'https://auth.openai.com/codex/device',
      userCode: 'TEST-CODE',
    };
  if (method === 'account/logout') {
    loggedOut = true;
    return {};
  }
  if (
    method === 'account/login/cancel' ||
    method === 'thread/unsubscribe' ||
    method === 'turn/interrupt'
  )
    return {};
  if (method === 'thread/start') {
    lastThread = params;
    return { thread: { id: 'thread-test' } };
  }
  if (method === 'turn/start') {
    lastTurn = params;
    setTimeout(() => {
      notify('turn/started', { threadId: 'thread-test', turn: { id: 'turn-test' } });
      for (const listener of rpc.listeners)
        listener({
          method: 'item/tool/call',
          id: 'tool-request',
          params: {
            threadId: 'thread-test',
            turnId: 'turn-test',
            callId: 'call-test',
            namespace: mode === 'bad-namespace' ? 'other' : 'app',
            tool: 'read_app',
            arguments: {},
          },
        });
      notify('item/agentMessage/delta', { threadId: 'other-thread', delta: 'wrong thread' });
      notify('item/agentMessage/delta', { threadId: 'thread-test', delta: '{"message":"Done"}' });
      notify('turn/completed', {
        threadId: 'thread-test',
        turn: {
          status: mode === 'failure' ? 'failed' : 'completed',
          error: { message: 'Provider failed' },
        },
      });
    }, 0);
    return { turn: { id: 'turn-test' } };
  }
  throw new Error('Unexpected method: ' + method);
};
after(() => {
  rpc.request = request;
  rpc.send = send;
  rpc.close();
  rmSync(directory, { recursive: true, force: true });
});

test('device sign-in is bound to its browser cookie and rejects a different owner', async () => {
  await provider.startDeviceLogin();
  assert.equal((await provider.deviceLoginStatus('wrong')).status, 'expired');
  assert.equal((await provider.deviceLoginStatus('login-test')).status, 'pending');
  email = 'other@example.com';
  notify('account/login/completed', { loginId: 'login-test', success: true });
  assert.equal((await provider.deviceLoginStatus('login-test')).status, 'error');
  assert.equal(loggedOut, true);
  assert.equal(await provider.codexAccount(), null);
  email = 'test@example.com';
  loggedOut = false;
  await provider.startDeviceLogin();
  notify('account/login/completed', { loginId: 'login-test', success: true });
  assert.equal((await provider.deviceLoginStatus('login-test')).status, 'complete');
});

test('Codex tools stay scoped, carry images, and finish only after tool execution', async () => {
  let calls = 0;
  const text = await provider.codexTurn({
    model: 'test',
    instructions: 'test instructions',
    input: [
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'Look' },
          { type: 'input_image', image_url: 'data:image/png;base64,AA==' },
        ],
      },
    ],
    definitions: [
      {
        type: 'namespace',
        name: 'app',
        description: 'app',
        tools: [
          {
            type: 'function',
            name: 'read_app',
            description: 'read',
            parameters: { type: 'object' },
          },
        ],
      },
    ],
    signal: new AbortController().signal,
    onDelta: () => {},
    execute: async () => {
      await new Promise((r) => setTimeout(r, 5));
      calls++;
      return { saved: true };
    },
  });
  assert.equal(text, '{"message":"Done"}');
  assert.equal(calls, 1);
  assert.deepEqual(lastThread.environments, []);
  assert.equal(lastThread.sandbox, 'read-only');
  assert.equal(lastThread.ephemeral, true);
  assert.deepEqual(lastThread.dynamicTools[0].tools[0].inputSchema, { type: 'object' });
  assert.ok(
    lastTurn.input.some((part: any) => part.type === 'image' && part.url.startsWith('data:')),
  );
  assert.equal(replies.at(-1).result.success, true);
});

test('unknown namespaces never invoke app tools and failed turns never report success', async () => {
  mode = 'bad-namespace';
  let calls = 0;
  const options = {
    model: 'test',
    instructions: '',
    input: [],
    signal: new AbortController().signal,
    onDelta: () => {},
    execute: async () => {
      calls++;
      return {};
    },
  };
  await provider.codexTurn(options);
  assert.equal(calls, 0);
  assert.equal(replies.at(-1).result.success, false);
  mode = 'failure';
  await assert.rejects(() => provider.codexTurn(options), /Provider failed/);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(() => provider.codexTurn({ ...options, signal: abort.signal }));
});
