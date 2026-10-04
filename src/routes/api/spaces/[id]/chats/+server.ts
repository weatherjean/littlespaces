import { json } from '@sveltejs/kit';
import { createChat } from '$lib/server/storage';
import { body } from '$lib/server/security';
import { validateChatLaunch } from '$lib/server/chat-context';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async (event) => {
  const input = await body(event);
  try {
    const launch = input.launch === undefined ? undefined : validateChatLaunch(event.params.id, input.launch);
    return json({ chat: createChat(event.params.id, launch) });
  } catch (error) { return json({ error: error instanceof Error ? error.message : 'Could not create chat.' }, { status: 400 }); }
};
