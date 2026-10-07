import { randomUUID } from 'node:crypto';
import {
  createJob,
  completeJob,
  findJob,
  latestJob,
  runningJob,
  fingerprint,
  updateJob,
  registerJob,
  releaseJob,
  stopJob,
  type ChatJob,
} from '$lib/server/chat-jobs';
import { notify } from '$lib/server/notifications';
import { claimBuildPlan, cancelBuildPlan, finishBuild } from '$lib/server/build-plans';
import { buildPlanText, type BuildPlan } from '$lib/build-plan-types';
import { logEvent, trace } from '$lib/server/diagnostics';
import type { ToolCall } from '$lib/types';
import { liveChatContext, validateChatLaunch } from '$lib/server/chat-context';
import type { ChatLaunch } from '$lib/types';
import { json } from '@sveltejs/kit';
import { body } from '$lib/server/security';
import { connectedAccount } from '$lib/server/connection';
import {
  getChat,
  messages,
  revision,
  pendingTools,
  spaceApplets,
  readPhoto,
  saveToolCall,
  activeChatTurns,
  deleteEmptyChats,
} from '$lib/server/storage';
import { launcherChatId } from '$lib/server/storage';
import { generate, models } from '$lib/server/inference';
import type { RequestHandler } from './$types';

export const PATCH: RequestHandler = async (event) => {
  const input = await body(event);
  if (
    typeof input.jobId !== 'string' ||
    typeof input.spaceId !== 'string' ||
    typeof input.chatId !== 'string'
  )
    return json({ error: 'Choose a reply to stop.' }, { status: 400 });
  try {
    getChat(input.spaceId, input.chatId);
    return json({ job: stopJob(input.jobId, input.spaceId, input.chatId) });
  } catch (error) {
    return json(
      { error: error instanceof Error ? error.message : 'Could not stop reply.' },
      { status: 404 },
    );
  }
};

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
  return json({
    messages: messages(chatId),
    tools: pendingTools(chatId),
    job: latestJob(chatId),
    running: runningJob(spaceId),
  });
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
  if (
    input.requestId !== undefined &&
    (typeof input.requestId !== 'string' || !/^[0-9a-f-]{36}$/.test(input.requestId))
  )
    return json({ error: 'Invalid request ID.' }, { status: 400 });
  const requestId = typeof input.requestId === 'string' ? input.requestId : randomUUID();
  const hash = fingerprint(input);
  try {
    const previous = findJob(
      requestId,
      String(input.spaceId || ''),
      String(input.chatId || ''),
      hash,
    );
    if (previous) return json({ job: previous });
  } catch (error) {
    return json(
      { error: error instanceof Error ? error.message : 'Invalid request.' },
      { status: 409 },
    );
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
  let view: ChatLaunch | null | undefined;
  try {
    if (input.appContext !== undefined) {
      const context = input.appContext as { appletId?: unknown; version?: unknown; view?: unknown };
      if (!context || !id || context.appletId !== id || context.version !== current?.version)
        throw Error('The app context changed. Refresh the app before sending.');
      view = context.view === null ? null : validateChatLaunch(spaceId, context.view, true);
    }
  } catch (error) {
    return json(
      { error: error instanceof Error ? error.message : 'Invalid app context.' },
      { status: 400 },
    );
  }
  const existing = findJob(requestId, spaceId, thread, hash);
  if (existing) return json({ job: existing });
  if (runningJob(spaceId))
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
  const job: ChatJob = {
    id: requestId,
    spaceId,
    chatId: thread,
    status: 'running',
    activity: 'Thinking about your request…',
    tools: toolCalls,
  };
  createJob(job, hash, message, photos);
  registerJob(job.id, abort);
  let subscribed = input.requestId === undefined;
  activeChatTurns.add(thread);
  const run = async (controller?: ReadableStreamDefaultController) => {
    return trace('chat', { spaceId, chatId: thread, appletId: id, model, effort }, async () => {
      const send = (type: string, data: unknown) => {
        if (abort.signal.aborted) return;
        if (type === 'status') {
          job.activity = (data as { message: string }).message;
          updateJob(job);
        }
        if (type === 'tool') updateJob(job);
        if (subscribed) {
          try {
            controller!.enqueue(
              encoder.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`),
            );
          } catch {
            subscribed = false;
          }
        }
      };
      try {
        logEvent('chat.input', {
          history,
          context: liveChatContext(id, getChat(spaceId, thread).launch, view),
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
            context: liveChatContext(id, getChat(spaceId, thread).launch, view),
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
        completeJob(job, result.message, toolCalls);
        logEvent('chat.saved', { message: result.message, applet });
        send('done', { message: result.message, applet });
        try {
          notify(spaceId, {
            key: `chat:${thread}`,
            title: 'Your reply is ready',
            body: 'Open the conversation to read your reply.',
          });
        } catch (error) {
          logEvent('chat.notification.error', { error });
        }
      } catch (error) {
        logEvent('chat.error', { error });
        job.status = abort.signal.aborted ? 'stopped' : 'failed';
        job.error = abort.signal.aborted
          ? 'Stopped. Completed app actions may remain saved; check the app before sending again.'
          : error instanceof Error
            ? error.message
            : 'Something went wrong. Please retry.';
        updateJob(job);
        send('error', {
          message: error instanceof Error ? error.message : 'Something went wrong. Please retry.',
        });
      } finally {
        if (approved) finishBuild(spaceId, thread, approved.id);
        if (abort.signal.aborted && job.status === 'running') {
          job.status = 'stopped';
          job.error =
            'Stopped. Completed app actions may remain saved; check the app before sending again.';
          updateJob(job);
        }
        releaseJob(job.id);
        activeChatTurns.delete(thread);
        if (subscribed) controller!.close();
      }
    });
  };
  if (input.requestId !== undefined) {
    void run().catch((error) => logEvent('chat.job.error', { error }));
    return json({ job }, { status: 202 });
  }
  const stream = new ReadableStream({
    start: run,
    cancel() {
      subscribed = false;
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
