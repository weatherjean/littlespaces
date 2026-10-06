import { mkdirSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { dataDir } from './config';
import { ownerStore } from './owner';
import { normalizeEmail } from '../../../scripts/owner-store.mjs';
import type { Account, Model } from '../types';
import { CodexRpc, type RpcMessage } from './codex-rpc';

let connection: Promise<CodexRpc> | undefined;
const home = join(dataDir, 'codex');
const cwd = join(home, 'workspace');
export async function codex(): Promise<CodexRpc> {
  if (!connection)
    connection = (async () => {
      mkdirSync(cwd, { recursive: true, mode: 0o700 });
      chmodSync(home, 0o700);
      const rpc = new CodexRpc(
        process.execPath,
        [
          resolve('node_modules/@openai/codex/bin/codex.js'),
          'app-server',
          '--listen',
          'stdio://',
          '-c',
          'cli_auth_credentials_store="file"',
          '-c',
          'analytics.enabled=false',
          '-c',
          'features.shell_tool=false',
          '-c',
          'features.unified_exec=false',
          '-c',
          'features.apply_patch_freeform=false',
          '-c',
          'features.multi_agent=false',
          '-c',
          'features.apps=false',
          '-c',
          'tools.view_image=false',
          '-c',
          'web_search="live"',
          '-c',
          'approval_policy="never"',
          '-c',
          'sandbox_mode="read-only"',
        ],
        { cwd, env: { PATH: process.env.PATH, CODEX_HOME: home } },
      );
      rpc.listeners.add((message) => {
        if (message.method === 'connection/closed') {
          connection = undefined;
          login = undefined;
        }
        if (
          message.method === 'account/login/completed' &&
          login &&
          login.id === message.params?.loginId
        ) {
          login.status = message.params.success ? 'complete' : 'error';
          login.error = message.params.success
            ? undefined
            : 'Sign-in did not complete. Try again; device-code login may need enabling in ChatGPT Settings → Security.';
        }
        // Never approve unexpected built-in tools, shell commands, or permission requests.
        if (message.id !== undefined && message.method && message.method !== 'item/tool/call') {
          rpc.send({
            id: message.id,
            error: { message: 'This action is unavailable in LittleSpaces.' },
          });
        }
      });
      try {
        await rpc.request('initialize', {
          clientInfo: { name: 'little_spaces', title: 'LittleSpaces', version: '0.1.0' },
          capabilities: { experimentalApi: true },
        });
        rpc.send({ method: 'initialized' });
        return rpc;
      } catch (error) {
        rpc.close();
        throw error;
      }
    })().catch((error) => {
      connection = undefined;
      throw error;
    });
  return connection;
}

export async function codexAccount(): Promise<Account | null> {
  const rpc = await codex();
  const { account } = await rpc.request('account/read', { refreshToken: false });
  if (!account || account.type !== 'chatgpt') return null;
  if (normalizeEmail(account.email || '') !== ownerStore().requireOwner().email) return null;
  return { email: account.email, name: account.email, canUsePlan: true };
}
let login: { id: string; status: string; expiresAt: number; error?: string } | undefined;
let starting = false;
export async function startDeviceLogin() {
  ownerStore().requireOwner();
  if (starting) throw new Error('Sign-in is already starting.');
  starting = true;
  try {
    const rpc = await codex();
    if (login?.status === 'pending')
      await rpc.request('account/login/cancel', { loginId: login.id });
    const value = await rpc.request('account/login/start', { type: 'chatgptDeviceCode' });
    if (
      value.type !== 'chatgptDeviceCode' ||
      new URL(value.verificationUrl).origin !== 'https://auth.openai.com'
    )
      throw new Error('ChatGPT returned an invalid sign-in link.');
    login = { id: value.loginId, status: 'pending', expiresAt: Date.now() + 600_000 };
    return {
      loginId: value.loginId,
      verificationUrl: value.verificationUrl,
      userCode: value.userCode,
    };
  } finally {
    starting = false;
  }
}
export async function deviceLoginStatus(id: string | undefined) {
  if (!id || !login || login.id !== id) return { status: 'expired' };
  if (login.expiresAt < Date.now()) {
    await (await codex()).request('account/login/cancel', { loginId: id });
    login = undefined;
    return { status: 'expired' };
  }
  if (login.status === 'complete') {
    const account = await codexAccount();
    if (!account) {
      await disconnectCodex();
      return { status: 'error', error: 'Use the same ChatGPT email as your LittleSpaces account.' };
    }
    return { status: 'complete', account };
  }
  return { status: login.status, error: login.error };
}
export async function disconnectCodex() {
  const rpc = await codex();
  if (login?.status === 'pending') await rpc.request('account/login/cancel', { loginId: login.id });
  login = undefined;
  await rpc.request('account/logout', {});
}
export async function codexModels(): Promise<Model[]> {
  if (!(await codexAccount())) throw new Error('Connect ChatGPT in Settings.');
  const rpc = await codex();
  const models: Model[] = [];
  let cursor: string | null = null;
  do {
    const result = await rpc.request('model/list', { cursor, limit: 100 });
    for (const item of result.data)
      if (!item.hidden)
        models.push({
          slug: item.model,
          display_name: item.displayName,
          efforts: item.supportedReasoningEfforts.map(
            (v: { reasoningEffort: string }) => v.reasoningEffort,
          ),
        });
    cursor = result.nextCursor;
  } while (cursor);
  return models;
}

export type CodexTurnOptions = {
  model: string;
  instructions: string;
  input: Record<string, unknown>[];
  definitions?: any[];
  effort?: string;
  signal: AbortSignal;
  outputSchema?: unknown;
  onDelta: (delta: string) => void;
  onActivity?: (value: string) => void;
  execute?: (name: string, args: Record<string, unknown>) => Promise<unknown>;
};
export function codexInput(input: Record<string, unknown>[]) {
  const result: Record<string, unknown>[] = [];
  for (const message of input) {
    result.push({ type: 'text', text: `Conversation message (${message.role}):` });
    if (typeof message.content === 'string') result.push({ type: 'text', text: message.content });
    else if (Array.isArray(message.content))
      for (const part of message.content) {
        if (part.type === 'input_image') result.push({ type: 'image', url: part.image_url });
        else if (typeof part.text === 'string') result.push({ type: 'text', text: part.text });
      }
  }
  return result;
}
export async function codexTurn(options: CodexTurnOptions): Promise<string> {
  if (!(await codexAccount())) throw new Error('Connect ChatGPT in Settings.');
  options.signal.throwIfAborted();
  const rpc = await codex();
  const dynamicTools = (options.definitions || []).map((namespace) => ({
    ...namespace,
    tools: namespace.tools.map((tool: any) => ({
      type: 'function',
      name: tool.name,
      description: tool.description,
      inputSchema: tool.parameters,
    })),
  }));
  const { thread } = await rpc.request('thread/start', {
    model: options.model,
    cwd,
    ephemeral: true,
    environments: [],
    sandbox: 'read-only',
    approvalPolicy: 'never',
    baseInstructions: options.instructions,
    dynamicTools,
  });
  let turnId: string | undefined;
  let text = '',
    finalText = '',
    calls = 0;
  const handled = new Set<string>();
  let chain = Promise.resolve();
  let stop: () => void = () => {};
  try {
    return await new Promise<string>((resolveResult, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        error ? reject(error) : resolveResult(finalText || text);
      };
      const interrupt = () => {
        if (turnId)
          void rpc.request('turn/interrupt', { threadId: thread.id, turnId }).catch(() => {});
      };
      const abort = () => {
        interrupt();
        finish(new Error('Stopped.'));
      };
      const timeout = setTimeout(() => {
        interrupt();
        finish(new Error('ChatGPT took too long. Please try again.'));
      }, 300_000);
      const listener = (message: RpcMessage) => {
        if (message.method === 'connection/closed')
          return finish(new Error('ChatGPT connection stopped. Please retry.'));
        if (message.params?.threadId !== thread.id || settled) return;
        const p = message.params;
        if (message.method === 'turn/started') turnId = p.turn.id;
        if (
          message.method === 'item/completed' &&
          p.item?.type === 'agentMessage' &&
          p.item.phase === 'final_answer'
        )
          finalText = p.item.text;
        if (message.method === 'item/agentMessage/delta') {
          text += p.delta;
          options.onDelta(p.delta);
        }
        if (message.method === 'item/started' && p.item?.type === 'webSearch')
          options.onActivity?.('Searching the web…');
        if (message.method === 'item/tool/call' && message.id !== undefined) {
          chain = chain
            .then(async () => {
              let output: any;
              try {
                if (settled || options.signal.aborted) throw new Error('Stopped.');
                if (handled.has(p.callId)) throw new Error('Duplicate tool call.');
                handled.add(p.callId);
                if (++calls > 40) throw new Error('Too many tool calls.');
                if (p.namespace && p.namespace !== 'app')
                  throw new Error('Unknown tool namespace.');
                if (!p.arguments || typeof p.arguments !== 'object' || Array.isArray(p.arguments))
                  throw new Error('Invalid tool arguments.');
                if (!options.execute) throw new Error('Tools unavailable.');
                output = await options.execute(p.tool, p.arguments);
              } catch (error) {
                output = { error: error instanceof Error ? error.message : 'Tool failed.' };
              }
              const contentItems =
                output?.dataUrl && p.tool.replace(/^app\./, '') === 'read_photo'
                  ? [
                      {
                        type: 'inputText',
                        text: JSON.stringify({ id: output.id, name: output.name }),
                      },
                      { type: 'inputImage', imageUrl: output.dataUrl },
                    ]
                  : [{ type: 'inputText', text: JSON.stringify(output).slice(0, 200_000) }];
              rpc.send({ id: message.id, result: { contentItems, success: !output?.error } });
            })
            .catch(() => finish(new Error('ChatGPT tool connection failed.')));
        }
        if (message.method === 'turn/completed')
          void chain.then(() =>
            finish(
              p.turn.status === 'completed'
                ? undefined
                : new Error(p.turn.error?.message || 'ChatGPT could not finish. Please retry.'),
            ),
          );
      };
      const cleanup = () => {
        clearTimeout(timeout);
        rpc.listeners.delete(listener);
        options.signal.removeEventListener('abort', abort);
      };
      stop = cleanup;
      rpc.listeners.add(listener);
      options.signal.addEventListener('abort', abort, { once: true });
      if (options.signal.aborted) return abort();
      void rpc
        .request('turn/start', {
          threadId: thread.id,
          input: codexInput(options.input),
          ...(options.effort ? { effort: options.effort } : {}),
          ...(options.outputSchema ? { outputSchema: options.outputSchema } : {}),
          environments: [],
        })
        .then((result) => {
          turnId = result.turn.id;
          if (settled) interrupt();
        })
        .catch((error) => finish(error));
    });
  } finally {
    stop();
    await rpc.request('thread/unsubscribe', { threadId: thread.id }).catch(() => {});
  }
}
