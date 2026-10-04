import { plantChatInstructions } from '$lib/templates/plants-chat';
import { json } from '@sveltejs/kit';
import { listApplets, saveApplet, spaceApplets } from '$lib/server/storage';
import { publishApp } from '$lib/server/publish';
import backend from '$lib/templates/plants-backend.ts.txt?raw';
import { body } from '$lib/server/security';
import plants from '$lib/templates/Plants.svelte?raw';
import type { RequestHandler } from './$types';

export const GET = () => json({ applets: listApplets() });
export const POST: RequestHandler = async (event) => {
  const input = await body(event);
  if (input.template !== 'plants') return json({ error: 'Unknown template.' }, { status: 400 });
  try {
    const spaceId = typeof input.spaceId === 'string' ? input.spaceId : undefined;
    if (spaceId && spaceApplets(spaceId).length) return json({ error: 'This space already has an applet.' }, { status: 409 });
    return json({ applet: await publishApp({ title: 'Plant care', description: 'A watering journal for your indoor jungle.', source: plants, backend, chatInstructions: plantChatInstructions }, undefined, spaceId) });
  } catch (error) { return json({ error: error instanceof Error ? error.message : 'Could not create applet.' }, { status: 500 }); }
};
