import type { Generation } from './types';

type StreamEvent = { type: string; delta?: string; item?: Record<string, unknown>; response?: { output?: Record<string, unknown>[]; error?: { code?: string; message?: string } }; error?: { message?: string } };

export async function consumeTurn(stream: ReadableStream<Uint8Array>, onDelta: (delta: string) => void, onEvent?: (event: unknown) => void): Promise<{ text: string; output: Record<string, unknown>[] }> {
  let output: Record<string, unknown>[] = [];
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = '', text = '', completed = false;
  function event(block: string) {
    const data = block.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') return;
    const item: StreamEvent = JSON.parse(data);
    if(!item.type.endsWith('.delta')) onEvent?.(item);
    if (item.type === 'response.output_text.delta' && item.delta) {
      text += item.delta;
      if (text.length > 160_000) throw new Error('Generated applet exceeded the prototype size limit.');
      onDelta(item.delta);
    }
    if (item.type === 'response.output_item.done' && item.item) output.push(item.item);
    if (item.type === 'response.completed') { completed = true; if (item.response?.output?.length) output = item.response.output; }
    if (['response.failed', 'response.incomplete', 'error'].includes(item.type)) {
      throw new Error(item.response?.error?.code || item.error?.message || 'ChatGPT did not complete the response. Try again.');
    }
  }
  try {
    while (true) {
      const { done, value } = await reader.read();
      pending += done ? decoder.decode() : decoder.decode(value, { stream: true });
      pending = pending.replace(/\r\n/g, '\n');
      let boundary;
      while ((boundary = pending.indexOf('\n\n')) !== -1) {
        event(pending.slice(0, boundary)); pending = pending.slice(boundary + 2);
      }
      if (done) break;
    }
    if (pending.trim()) event(pending);
    if (!completed) throw new Error('ChatGPT disconnected before completing the response. Nothing was saved.');
    // Some models emit commentary before their final answer. Use the final
    // completed message for parsing, while retaining streamed deltas for progress.
    const final = output.filter(item => item.type === 'message' && (!item.phase || item.phase === 'final_answer'))
      .flatMap(item => Array.isArray(item.content) ? item.content : [])
      .filter(part => part.type === 'output_text' && typeof part.text === 'string').map(part => part.text).join('');
    return { text: final || text, output };
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export async function consumeResponse(stream: ReadableStream<Uint8Array>, onDelta: (delta: string) => void): Promise<string> {
  return (await consumeTurn(stream, onDelta)).text;
}

export function parseGeneration(text: string): Generation {
  const clean = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let result: Generation;
  try { result = JSON.parse(clean); } catch { throw new Error('The model returned invalid applet JSON. Please retry.'); }
  if (!result || typeof result.message !== 'string' || result.message.length > 20_000) throw new Error('The model returned an invalid reply.');
  if (result.applet) {
    const a = result.applet;
    if (a.chatInstructions !== undefined && (typeof a.chatInstructions !== "string" || a.chatInstructions.length > 12000)) throw new Error("Invalid app chat instructions.");
    if (a.backend !== undefined && (typeof a.backend !== 'string' || a.backend.length > 80_000)) throw new Error('Invalid backend source.');
    if (typeof a.title !== 'string' || !a.title.trim() || a.title.length > 80 || typeof a.description !== 'string' || a.description.length > 300 || typeof a.source !== 'string' || !a.source.trim()) {
      throw new Error('The model returned an invalid applet.');
    }
  }
  return result;
}

