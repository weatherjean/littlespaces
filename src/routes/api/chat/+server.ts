import {remoteSpace,remoteInfo} from '$lib/server/connections';
import {remoteRuntime} from '$lib/server/remote-agent';
import { logEvent, trace } from '$lib/server/diagnostics';
import type { ToolCall } from '$lib/types';
import { liveChatContext } from '$lib/server/chat-context';
import { json } from '@sveltejs/kit';
import { body } from '$lib/server/security';
import { account } from '$lib/server/auth';
import { getChat, messages, revision, saveExchange, spaceApplets, readPhoto, saveToolCall } from '$lib/server/storage';
import { launcherChatId } from '$lib/server/storage';
import { generate, models } from '$lib/server/inference';
import type { RequestHandler } from './$types';

const running = new Set<string>();

export const GET: RequestHandler = async ({ url }) => {
  const spaceId = url.searchParams.get('spaceId') || '';
  const chatId = url.searchParams.get('chatId') || '';
  try { const remote=remoteSpace(spaceId);if(remote)await remoteInfo(remote);getChat(spaceId, chatId); } catch { return json({ error: 'Chat not found in this space.' }, { status: 404 }); }
  return json({ messages: messages(chatId) });
};

export const POST: RequestHandler = async (event) => {
  const input = await body(event);
  if (typeof input.message !== 'string' || input.message.length > 12_000 || typeof input.model !== 'string' || input.model.length > 150) {
    return json({ error: 'Enter a message and choose a model.' }, { status: 400 });
  }
  if (!account()?.canUsePlan) return json({ error: 'Connect ChatGPT with plan access before sending a message.' }, { status: 401 });
  const spaceId = typeof input.spaceId === 'string' ? input.spaceId : '';
  const thread = typeof input.chatId === 'string' ? input.chatId : '';
  try { getChat(spaceId, thread); } catch { return json({ error: 'Chat not found in this space.' }, { status: 404 }); }
  const remote=remoteSpace(spaceId);
  const photos = input.photos ?? [];
  if(!Array.isArray(photos)||photos.length>4||photos.some(id=>typeof id!=='string')||(!input.message.trim()&&!photos.length)) return json({error:'Enter a message or attach up to four photos.'},{status:400});
  try { if(!remote)for(const photoId of photos)readPhoto(spaceId,photoId); } catch {return json({error:'An attached photo is not available in this space.'},{status:400});}
  const isLauncher = spaceId === launcherChatId;
  const id = isLauncher || remote ? undefined : spaceApplets(spaceId)[0]?.id;
  const effort = typeof input.effort === 'string' && input.effort !== 'default' ? input.effort : undefined;
  if (effort) {
    const selected = (await models()).find(model => model.slug === input.model);
    if (!selected?.efforts?.includes(effort)) return json({error:'That reasoning effort is not available for this model.'},{status:400});
  }
  let current;
  try { current = id ? revision(id) : undefined; }
  catch { return json({ error: 'Applet not found.' }, { status: 404 }); }
  if (running.has(spaceId)) return json({ error: 'This space is already building. Wait for it to finish.' }, { status: 409 });

  const message = input.message.trim() || 'What is in this photo?';
  const model = input.model;
  const history = [...messages(thread), { role: 'user' as const, content: message, ...(photos.length?{photos}: {}) }];
  let runtime;
  try {runtime=remote?await remoteRuntime(remote,thread,history,getChat(spaceId,thread).launch):undefined;}
  catch(error){return json({error:error instanceof Error?error.message:'Server unavailable.'},{status:403});}
  if(running.has(spaceId))return json({error:'This space is already busy.'},{status:409});
  running.add(spaceId);
  const context=runtime?runtime.context:liveChatContext(id,getChat(spaceId,thread).launch);
  const abort = new AbortController();
  const encoder = new TextEncoder();
  const toolCalls:ToolCall[]=[];
  const stream = new ReadableStream({
    async start(controller) {
      return trace('chat',{spaceId,chatId:thread,appletId:id,model,effort},async()=>{
      logEvent('chat.input',{history,context,version:current?.version});
      const send = (type: string, data: unknown) => {
        if (!abort.signal.aborted) controller.enqueue(encoder.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      try {
        send('status', { message: 'Thinking about your request…' });
        let chars = 0, lastUpdate = 0;
        const result = await generate(model, history, runtime?.source || current?.source, (delta) => {
          chars += delta.length;
          if (Date.now() - lastUpdate > 500) { send('status', { message: `Working on your reply… ${Math.ceil(chars / 1000)}k characters` }); lastUpdate = Date.now(); }
        }, abort.signal, { remote:runtime, spaceId, chatId: thread, appletId: id, context, effort, onTool: call=>{const item={...call,prompt:message};const index=toolCalls.findIndex(old=>old.id===item.id);if(index<0)toolCalls.push(item);else toolCalls[index]=item;saveToolCall(thread,item);send('tool',item);}, onActivity: message => send('status', {message}) });
        const applet = result.published;
        if (abort.signal.aborted) return;
        saveExchange(thread, message, result.message, photos, toolCalls);
        logEvent('chat.saved',{message:result.message,applet});
        send('done', { message: result.message, applet });
      } catch (error) {
        logEvent('chat.error',{error});
        send('error', { message: error instanceof Error ? error.message : 'Something went wrong. Please retry.' });
      } finally {
        running.delete(spaceId);
        if (!abort.signal.aborted) controller.close();
      }
      });
    },
    cancel() { logEvent('chat.cancelled',{spaceId,chatId:thread}); abort.abort(); }
  });
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' } });
};
