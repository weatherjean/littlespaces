import { test } from 'node:test';
import assert from 'node:assert/strict';
import { consumeResponse, consumeTurn, parseGeneration } from '../src/lib/response-stream';

function stream(events: object[], complete = true) {
  const all = [...events, ...(complete ? [{ type: 'response.completed' }] : [])];
  const bytes = new TextEncoder().encode(all.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join(''));
  return new ReadableStream<Uint8Array>({ start(controller) {
    // One byte per chunk exercises split CRLF boundaries and multibyte Unicode.
    for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
    controller.close();
  } });
}

test('stream parser survives arbitrary UTF-8 and SSE boundaries', async () => {
  const chunks: string[] = [];
  const result = await consumeResponse(stream([{ type: 'response.output_text.delta', delta: 'Hello 🌿' }]), (text) => chunks.push(text));
  assert.equal(result, 'Hello 🌿');
  assert.deepEqual(chunks, ['Hello 🌿']);
});

test('a quota error after text began is a failure, not an applet to save', async () => {
  await assert.rejects(() => consumeResponse(stream([
    { type: 'response.output_text.delta', delta: '{"message":"hi"}' },
    { type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded' } } }
  ], false), () => {}), /subscription_sharing_usage_limit_exceeded/);
});

test('truncated and incomplete responses cannot be accepted', async () => {
  await assert.rejects(() => consumeResponse(stream([{ type: 'response.output_text.delta', delta: '{}' }], false), () => {}), /disconnected/);
  await assert.rejects(() => consumeResponse(stream([{ type: 'response.incomplete' }], false), () => {}), /did not complete/);
});

test('generation validation accepts conversation and rejects malformed applets', () => {
  assert.deepEqual(parseGeneration('```json\n{"message":"Hello"}\n```'), { message: 'Hello' });
  assert.throws(() => parseGeneration('{"message":"Done","applet":{"title":"Test"}}'), /invalid applet/);
  assert.throws(() => parseGeneration('not JSON'), /invalid applet JSON/);
});


test('tool items survive a completed event whose output array is empty', async () => {
  const item = {type:'function_call',name:'list_apps',namespace:'app',call_id:'call1',arguments:'{}'};
  const result = await consumeTurn(stream([
    {type:'response.output_item.done',item},
    {type:'response.completed',response:{output:[]}}
  ],false),()=>{});
  assert.deepEqual(result.output,[item]);
});


test('final message text excludes intermediate commentary', async () => {
  const result = await consumeResponse(stream([
    {type:'response.output_text.delta',delta:'I will inspect this. '},
    {type:'response.output_item.done',item:{type:'message',phase:'commentary',content:[{type:'output_text',text:'I will inspect this.'}]}},
    {type:'response.output_item.done',item:{type:'message',phase:'final_answer',content:[{type:'output_text',text:'{"message":"Done"}'}]}}
  ]),()=>{});
  assert.equal(result,'{"message":"Done"}');
});
