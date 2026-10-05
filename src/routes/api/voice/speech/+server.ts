import { json } from '@sveltejs/kit';
import { body } from '$lib/server/security';
import { speechAvailable, SpeechError, synthesizeSpeech } from '$lib/server/speech';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = () => json({ available: speechAvailable(), engine: 'piper' });
export const POST: RequestHandler = async (event) => {
  const input = await body(event);
  try {
    const wav = await synthesizeSpeech(input.text, event.request.signal);
    return new Response(new Uint8Array(wav), {
      headers: { 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    return json(
      { error: error instanceof Error ? error.message : 'Speech failed.' },
      { status: error instanceof SpeechError ? error.status : 503 },
    );
  }
};
