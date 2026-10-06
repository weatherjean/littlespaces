import { claimBuildPlan, cancelBuildPlan, finishBuild } from '$lib/server/build-plans';
import { buildPlanText, type BuildPlan } from '$lib/build-plan-types';
import { logEvent, trace } from '$lib/server/diagnostics';
import type { ToolCall } from '$lib/types';
import { liveChatContext } from '$lib/server/chat-context';
import { json } from '@sveltejs/kit';
import { body } from '$lib/server/security';
import { connectedAccount } from '$lib/server/connection';
import {
  getChat,
  messages,
  revision,
  saveExchange,
  spaceApplets,
  readPhoto,
  saveToolCall,
  activeChatTurns,
  deleteEmptyChats,
} from '$lib/server/storage';
import { launcherChatId } from '$lib/server/storage';
import { generate, models } from '$lib/server/inference';
import type { RequestHandler } from './$types';

const running = new Set<string>();

export const DELETE: RequestHandler = async (event) => {
  const input = await body(event);
  if (typeof input.chatId !== 'string' || !input.chatId)
    return json({ error: 'Choose a conversation.' }, { status: 400 });
  return json({ deleted: deleteEmptyChats(input.chatId) > 0 });
};

export const GET: RequestHandler = ({ url }) => {
  const spaceId = url.searchParams.get('spaceId') || '';
  const chatId = url.searchParams.get('chatId') || '';
  try {
    getChat(spaceId, chatId);
  } catch {
    return json({ error: 'Chat not found in this space.' }, { status: 404 });
  }
  return json({ messages: messages(chatId) });
};

export const POST: RequestHandler = async (event) => {
  const input = await body(event);
  if (
    typeof input.message !== 'string' ||
    input.message.length > 12_000 ||
    typeof input.model !== 'string' ||
    input.model.length > 150
  ) {
    return json({ error: 'Enter a message and choose a model.' }, { status: 400 });
  }
  if (!(await connectedAccount())?.canUsePlan)
    return json(
      { error: 'Connect ChatGPT with plan access before sending a message.' },
      { status: 401 },
    );
  const spaceId = typeof input.spaceId === 'string' ? input.spaceId : '';
  const thread = typeof input.chatId === 'string' ? input.chatId : '';
  try {
    getChat(spaceId, thread);
  } catch {
    return json({ error: 'Chat not found in this space.' }, { status: 404 });
  }
  const photos = input.photos ?? [];
  if (
    !Array.isArray(photos) ||
    photos.length > 4 ||
    photos.some((id) => typeof id !== 'string') ||
    (!input.message.trim() && !photos.length)
  )
    return json({ error: 'Enter a message or attach up to four photos.' }, { status: 400 });
  try {
    for (const photoId of photos) readPhoto(spaceId, photoId);
  } catch {
    return json({ error: 'An attached photo is not available in this space.' }, { status: 400 });
  }
  const isLauncher = spaceId === launcherChatId;
  const id = isLauncher ? undefined : spaceApplets(spaceId)[0]?.id;
  const effort =
    typeof input.effort === 'string' && input.effort !== 'default' ? input.effort : undefined;
  if (effort) {
    const selected = (await models()).find((model) => model.slug === input.model);
    if (!selected?.efforts?.includes(effort))
      return json(
        { error: 'That reasoning effort is not available for this model.' },
        { status: 400 },
      );
  }
  let current;
  try {
    current = id ? revision(id) : undefined;
  } catch {
    return json({ error: 'Applet not found.' }, { status: 404 });
  }
  if (running.has(spaceId))
    return json(
      { error: 'A reply is already running in this space. Wait for it to finish.' },
      { status: 409 },
    );
  let message = input.message.trim() || 'What is in this photo?';
  const model = input.model;
  const abort = new AbortController();
  // Model discovery can await network I/O; the empty composer may have been
  // discarded in another request in the meantime.
  try {
    getChat(spaceId, thread);
  } catch {
    return json({ error: 'This empty conversation was closed. Open a new chat.' }, { status: 404 });
  }
  let approved: BuildPlan | undefined;
  try {
    if (input.buildPlanId !== undefined) {
      if (typeof input.buildPlanId !== 'string' || input.mode === 'voice')
        throw Error('Choose a build plan in Chat.');
      approved = claimBuildPlan(spaceId, thread, input.buildPlanId);
      message = buildPlanText(approved);
    } else cancelBuildPlan(spaceId, thread);
  } catch (error) {
    return json(
      { error: error instanceof Error ? error.message : 'Could not approve plan.' },
      { status: 409 },
    );
  }
  const history = [
    ...messages(thread),
    { role: 'user' as const, content: message, ...(photos.length ? { photos } : {}) },
  ];
  const encoder = new TextEncoder();
  const toolCalls: ToolCall[] = [];
  running.add(spaceId);
  activeChatTurns.add(thread);
  const stream = new ReadableStream({
    async start(controller) {
      return trace('chat', { spaceId, chatId: thread, appletId: id, model, effort }, async () => {
        const send = (type: string, data: unknown) => {
          if (!abort.signal.aborted)
            controller.enqueue(encoder.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`));
        };
        try {
          logEvent('chat.input', {
            history,
            context: liveChatContext(id, getChat(spaceId, thread).launch),
            version: current?.version,
          });
          send('status', { message: 'Thinking about your request…' });
          let chars = 0,
            lastUpdate = 0;
          const result = await generate(
            model,
            history,
            approved ? current?.source : undefined,
            (delta) => {
              chars += delta.length;
              if (Date.now() - lastUpdate > 500) {
                send('status', {
                  message: `Working on your reply… ${Math.ceil(chars / 1000)}k characters`,
                });
                lastUpdate = Date.now();
              }
            },
            abort.signal,
            {
              mode: input.mode === 'voice' && isLauncher ? 'voice' : 'knowledge',
              buildPlanId: approved?.id,
              spaceId,
              chatId: thread,
              appletId: id,
              context: liveChatContext(id, getChat(spaceId, thread).launch),
              effort,
              onTool: (call) => {
                const item = { ...call, prompt: message };
                const index = toolCalls.findIndex((old) => old.id === item.id);
                if (index < 0) toolCalls.push(item);
                else toolCalls[index] = item;
                saveToolCall(thread, item);
                send('tool', item);
              },
              onActivity: (message) => send('status', { message }),
            },
          );
          const applet = result.published;
          if (abort.signal.aborted) return;
          saveExchange(thread, message, result.message, photos, toolCalls);
          logEvent('chat.saved', { message: result.message, applet });
          send('done', { message: result.message, applet });
        } catch (error) {
          logEvent('chat.error', { error });
          send('error', {
            message: error instanceof Error ? error.message : 'Something went wrong. Please retry.',
          });
        } finally {
          if (approved) finishBuild(spaceId, thread, approved.id);
          running.delete(spaceId);
          activeChatTurns.delete(thread);
          if (!abort.signal.aborted) controller.close();
        }
      });
    },
    cancel() {
      logEvent('chat.cancelled', { spaceId, chatId: thread });
      abort.abort();
    },
  });
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    },
  });
};
