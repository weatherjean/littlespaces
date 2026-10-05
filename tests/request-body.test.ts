import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isHttpError } from '@sveltejs/kit';
import { boundedBytes, boundedText } from '../src/lib/server/security';

function request(chunks: Uint8Array[], length?: string) {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks.shift();
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  return {
    value: new Request('http://localhost/', {
      method: 'POST',
      body,
      duplex: 'half',
      headers: length === undefined ? {} : { 'content-length': length },
    } as RequestInit),
    cancelled: () => cancelled,
  };
}

test('body limits count actual bytes without trusting Content-Length', async () => {
  for (const length of [undefined, '1']) {
    const input = request([new Uint8Array(3), new Uint8Array(3), new Uint8Array(3)], length);
    await assert.rejects(
      () => boundedBytes(input.value, 4),
      (error) => isHttpError(error, 413),
    );
    assert.equal(input.cancelled(), false, 'the response socket must remain available for the 413');
    assert.equal(input.value.body?.locked, false);
  }
});

test('bounded bodies preserve binary uploads and split UTF-8 text', async () => {
  const bytes = Uint8Array.of(0, 255, 128, 1);
  assert.deepEqual(await boundedBytes(request([bytes]).value, 4), Buffer.from(bytes));
  const encoded = new TextEncoder().encode('🌿');
  assert.equal(await boundedText(request([encoded.slice(0, 2), encoded.slice(2)]).value, 4), '🌿');
  await assert.rejects(
    () => boundedText(request([encoded]).value, 3),
    (error) => isHttpError(error, 413),
  );
});
